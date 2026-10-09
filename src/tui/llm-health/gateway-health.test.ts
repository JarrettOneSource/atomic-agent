import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { getUserConfigPath, resetConfigCache, USER_CONFIG_DEFAULTS, writeUserConfigFileSync } from "../../config/index.js";
import type { TuiAction } from "../tui-action.js";
import { LlmHealthPoller } from "./llm-health-poller.js";

it("projects gateway readiness without waking models or renewing their idle timer", async () => {
  const previous = process.env.ATOMIC_AGENT_STATE_DIR;
  const root = mkdtempSync(join(tmpdir(), "atomic-gateway-health-"));
  const requests: string[] = [];
  let ready = true;
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/running") {
      response.end(JSON.stringify({ running: ready ? [{ model: "muse", state: "ready", ttl: 600 }] : [] }));
    } else if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "muse", name: "Muse", meta: { llamaswap: { nativeModel: "Muse", contextSize: 32768 } } }] }));
    } else response.writeHead(503).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const url = `http://127.0.0.1:${address.port}`;
  process.env.ATOMIC_AGENT_STATE_DIR = root;
  resetConfigCache();
  const config = structuredClone(USER_CONFIG_DEFAULTS);
  config.localModels.url = `${url}/upstream/muse`;
  config.localModels.gateways = [{ id: "m5", name: "M5", url, apiKeyEnv: null }];
  writeUserConfigFileSync(getUserConfigPath(root), config);
  resetConfigCache();
  const events: TuiAction[] = [];
  const poller = new LlmHealthPoller({ emit: (event) => events.push(event) }, config.localModels.url, 20);
  try {
    poller.start();
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "llm_health_updated", status: "healthy" })));
    ready = false;
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "llm_health_updated", error: expect.stringMatching(/stopped/i) })));
    expect(events).toContainEqual(expect.objectContaining({ type: "llm_model_updated", model: "Muse", contextWindow: 32768 }));
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((path) => path === "/running" || path === "/v1/models")).toBe(true);
  } finally {
    poller.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
    else process.env.ATOMIC_AGENT_STATE_DIR = previous;
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});
