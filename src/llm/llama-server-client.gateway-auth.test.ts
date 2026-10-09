import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getUserConfigPath, resetConfigCache, USER_CONFIG_DEFAULTS, writeUserConfigFileSync } from "../config/index.js";
import { LlamaServerClient } from "./llama-server-client.js";

it("authenticates gateway inference without sending its credential to unrelated routes", async () => {
  const previous = process.env.ATOMIC_AGENT_STATE_DIR;
  const stateDir = mkdtempSync(join(tmpdir(), "atomic-gateway-auth-"));
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    request.resume();
    if (request.url?.startsWith("/upstream/") && request.headers.authorization !== "Bearer test-gateway-key") {
      response.writeHead(401).end('{"error":"missing credential"}');
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end('{"content":"authenticated","stop":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const url = `http://127.0.0.1:${address.port}`;
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  process.env.ATOMIC_TEST_GATEWAY_KEY = "test-gateway-key";
  resetConfigCache();
  const config = structuredClone(USER_CONFIG_DEFAULTS);
  config.localModels.url = `${url}/upstream/chat`;
  config.localModels.gateways = [{ id: "host", name: "Host", url, apiKeyEnv: "ATOMIC_TEST_GATEWAY_KEY" }];
  writeUserConfigFileSync(getUserConfigPath(stateDir), config);
  resetConfigCache();
  try {
    expect((await new LlamaServerClient().complete({ prompt: "Hello" })).content).toBe("authenticated");
    expect((await new LlamaServerClient({ baseUrl: `${url}/unrelated` }).complete({ prompt: "Hello" })).content).toBe("authenticated");
    expect(authorizations).toEqual(["Bearer test-gateway-key", undefined]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.ATOMIC_TEST_GATEWAY_KEY;
    if (previous === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
    else process.env.ATOMIC_AGENT_STATE_DIR = previous;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
