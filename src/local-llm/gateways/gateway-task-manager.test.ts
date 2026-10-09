import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayTaskManager } from "./gateway-task-manager.js";

const servers: Server[] = [];
const managers: GatewayTaskManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

async function fixture() {
  let loaded = false;
  let keepalives = 0;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    response.setHeader("Content-Type", "application/json");
    if (path === "/v1/models") response.end(JSON.stringify({ data: [{ id: "chat", name: "Chat" }] }));
    else if (path === "/running") response.end(JSON.stringify({ running: loaded ? [{ model: "chat", state: "ready", ttl: 1 }] : [] }));
    else if (path === "/upstream/chat/") { loaded = true; response.writeHead(404).end("{}"); }
    else if (path === "/upstream/chat/health") { keepalives++; response.writeHead(loaded ? 200 : 409).end("{}"); }
    else response.writeHead(404).end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const url = `http://127.0.0.1:${address.port}`;
  const gateway = { id: "host", name: "Host", url, apiKeyEnv: null };
  const manager = new GatewayTaskManager({ gateways: () => [gateway] });
  managers.push(manager);
  return { manager, url, requests, loaded: () => loaded, keepalives: () => keepalives };
}

it("does not contact or load a model until a task is prepared", async () => {
  const app = await fixture();
  expect(app.requests).toEqual([]);
  expect(app.manager.activeCount).toBe(0);
  const lease = await app.manager.prepare([app.url + "/upstream/chat"]);
  expect(app.loaded()).toBe(true);
  expect(app.manager.activeCount).toBe(1);
  lease.release();
  expect(app.manager.activeCount).toBe(0);
});

it("keeps a model warm only for the lifetime of the task", async () => {
  const app = await fixture();
  const first = await app.manager.prepare([app.url + "/upstream/chat"]);
  first.release();
  // An already loaded model exposes its effective one-second idle policy.
  const lease = await app.manager.prepare([app.url + "/upstream/chat"]);
  await vi.waitFor(() => expect(app.keepalives()).toBeGreaterThan(0));
  lease.release();
  const count = app.keepalives();
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(app.keepalives()).toBe(count);
  expect(app.requests.filter((path) => path === "/upstream/chat/")).toHaveLength(1);
});

it("cancels model tasks without affecting tasks on a different model host", async () => {
  const app = await fixture();
  const lease = await app.manager.prepare([app.url + "/upstream/chat"]);
  app.manager.cancelModel("other-host", "chat");
  expect(lease.signal.aborted).toBe(false);
  app.manager.cancelModel("host", "chat");
  expect(lease.signal.aborted).toBe(true);
  lease.release();
});

it("honors cancellation before any model can start", async () => {
  const app = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(app.manager.prepare([app.url + "/upstream/chat"], controller.signal)).rejects.toThrow();
  expect(app.requests).toEqual([]);
  expect(app.manager.activeCount).toBe(0);
});

it("leaves unrelated external model endpoints under their existing owner", async () => {
  const app = await fixture();
  const lease = await app.manager.prepare(["http://127.0.0.1:9/custom"]);
  expect(app.requests).toEqual([]);
  expect(app.manager.activeCount).toBe(0);
  lease.release();
});
