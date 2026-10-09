import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ModelGatewayClient } from "./model-gateway-client.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function gateway(options: { stuck?: boolean; loadError?: boolean; ttl?: number; competing?: boolean } = {}) {
  const requests: string[] = [];
  let state: "starting" | "ready" | null = null;
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{
        id: "muse", name: "Muse Glimmer", description: "Existing SSD model",
        status: { value: state ? "loaded" : "unloaded" },
        meta: { llamaswap: {
          kind: "llm", group: "large", nativeModel: "Muse-Glimmer-30B", contextSize: 32768,
          supportsVision: true, sizeBytes: 19653960832, ttlSeconds: 600,
        } },
      }, ...(options.competing ? [{ id: "render", name: "Video render", meta: { llamaswap: { kind: "video", group: "large" } } }] : [])] }));
    } else if (request.url === "/running") {
      response.end(JSON.stringify({ running: [
        ...(state ? [{ model: "muse", state, ttl: options.ttl ?? 600 }] : []),
        ...(options.competing ? [{ model: "render", state: "ready", ttl: 0 }] : []),
      ] }));
    } else if (request.url === "/upstream/muse/") {
      if (options.loadError) {
        response.writeHead(502).end(JSON.stringify({ error: "model could not start" }));
      } else {
        state = "ready";
        // An inference server need not provide an HTML root page.
        response.writeHead(404).end(JSON.stringify({ error: "no root page" }));
      }
    } else if (request.method === "POST" && request.url?.startsWith("/api/models/unload")) {
      if (!options.stuck) state = null;
      response.end("{}");
    } else {
      response.writeHead(404).end("{}");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const url = `http://127.0.0.1:${address.port}`;
  const client = new ModelGatewayClient({ id: "m5", name: "M5", url, apiKeyEnv: null }, {
    pollIntervalMs: 1, stopTimeoutMs: 30, loadTimeoutMs: 200, requestTimeoutMs: 200,
  });
  return { client, requests, url, setState: (next: typeof state) => { state = next; } };
}

describe("remote model lifecycle", () => {
  it("lists installed models without waking inference servers", async () => {
    const { client, requests } = await gateway();
    const models = await client.list();
    expect(models).toEqual([expect.objectContaining({
      id: "muse", name: "Muse Glimmer", kind: "llm", state: "stopped",
      nativeModel: "Muse-Glimmer-30B", contextSize: 32768, supportsVision: true,
    })]);
    expect(requests.sort()).toEqual(["GET /running", "GET /v1/models"]);
  });

  it("does not confuse a loaded-but-starting model with ready", async () => {
    const { client, setState } = await gateway();
    setState("starting");
    expect((await client.list())[0]?.state).toBe("starting");
  });

  it("shows a runtime's job-aware idle policy when the generic gateway timer is disabled", async () => {
    const { client, setState } = await gateway({ ttl: 0 });
    setState("ready");
    expect((await client.list())[0]?.ttlSeconds).toBe(600);
  });

  it("does not evict another running model from a mutually exclusive group", async () => {
    const { client, requests } = await gateway({ competing: true });
    await expect(client.start("muse")).rejects.toThrow(/Stop Video render/);
    expect(requests.some((path) => path.startsWith("GET /upstream/"))).toBe(false);
  });

  it("loads explicitly and verifies readiness even when the model has no root page", async () => {
    const { client, requests, url } = await gateway();
    await client.start("muse");
    expect((await client.list())[0]?.state).toBe("ready");
    expect(client.inferenceUrl("muse")).toBe(`${url}/upstream/muse`);
    expect(requests.filter((path) => path.startsWith("GET /upstream/")))
      .toEqual(["GET /upstream/muse/"]);
  });

  it("stops the model and keeps later status refreshes from restarting it", async () => {
    const { client, requests } = await gateway();
    await client.start("muse");
    await client.stop("muse");
    expect((await client.list())[0]?.state).toBe("stopped");
    expect((await client.list())[0]?.state).toBe("stopped");
    expect(requests.filter((path) => path.startsWith("GET /upstream/"))).toHaveLength(1);
  });

  it("reports a failed start instead of selecting an unavailable model", async () => {
    const { client } = await gateway({ loadError: true });
    await expect(client.start("muse")).rejects.toThrow(/start|502|ready/i);
    expect((await client.list())[0]?.state).toBe("stopped");
  });

  it("does not report Stop all success while a model is still running", async () => {
    const { client, setState } = await gateway({ stuck: true });
    setState("ready");
    await expect(client.stopAll()).rejects.toThrow(/still|stop|unload/i);
  });

  it("reports an unreachable host instead of returning an empty stopped catalog", async () => {
    const client = new ModelGatewayClient({
      id: "offline", name: "Offline host", url: "http://127.0.0.1:1", apiKeyEnv: null,
    }, { requestTimeoutMs: 30 });
    await expect(client.list()).rejects.toThrow();
  });
});
