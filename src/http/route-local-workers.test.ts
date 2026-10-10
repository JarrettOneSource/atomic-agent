import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { startTestHarness, type Harness } from "./test-harness.js";
import { LocalWorkerJobs } from "../local-workers/worker-jobs.js";
import { writeWorkerConnection } from "../local-workers/worker-connection.js";
import { callWorkerTool } from "../local-workers/worker-mcp.js";
import { getConfig } from "../config/index.js";
let harness: Harness, root: string, queue: LocalWorkerJobs, gateway: Server, release: (() => void) | undefined;
let requests: string[] = [];
const headers = { authorization: "Bearer test-key", "content-type": "application/json" };
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worker-http-"));
    requests = [];
    queue = new LocalWorkerJobs({ root: join(root, "jobs"), maxWorkers: 2, run: async (job, signal) => {
            if (job.task === "wait")
                return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
            await writeFile(join(job.workingDir, "answer.txt"), "42\n");
            return { status: "ok", reply: "Wrote answer.txt" };
        } });
    await queue.open();
    harness = await startTestHarness({ apiKey: "test-key", localWorkers: queue });
    gateway = createServer((req, res) => { requests.push(req.url ?? ""); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "chat", meta: { llamaswap: { kind: "llm", parallelSlots: 2 } } }] } : { running: [] })); });
    await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
    const address = gateway.address();
    if (!address || typeof address === "string")
        throw Error("No address");
    const config = await fetch(harness.baseUrl + "/api/config", { method: "PATCH", headers, body: JSON.stringify({ localModels: { mode: "external", url: `http://127.0.0.1:${address.port}/upstream/chat`, gateways: [{ id: "m5", name: "M5", url: `http://127.0.0.1:${address.port}` }] } }) });
    expect(config.status).toBe(200);
    release = writeWorkerConnection(getConfig().paths.stateDir, { pid: process.pid, host: "127.0.0.1", port: harness.handle.port, apiKey: "test-key" });
});
afterEach(async () => { release?.(); await harness?.cleanup(); await queue?.close(); await rm(root, { recursive: true, force: true }); gateway?.closeAllConnections(); await new Promise<void>(resolve => gateway?.close(() => resolve())); });
it("requires authentication and model discovery never starts a model", async () => {
    expect((await fetch(harness.baseUrl + "/api/local-workers/models")).status).toBe(401);
    const models = await callWorkerTool(getConfig().paths.stateDir, "local_worker_models", {});
    expect(models).toMatchObject({ maxWorkers: 2, hosts: [{ online: true, models: [{ parallelSlots: 2 }] }] });
    expect(requests.every(path => ["/v1/models", "/running"].includes(path))).toBe(true);
});
it("the MCP bridge submits a real file job and retrieves its durable result through the authenticated controller", async () => {
    const response = await callWorkerTool(getConfig().paths.stateDir, "local_worker_run", { task: "write", workingDir: root, isolate: false });
    expect(response).toMatchObject({ hostId: "m5", modelId: "chat" });
    const id = (response as {
        id: string;
    }).id;
    await vi.waitFor(() => expect(queue.get(id)?.state).toBe("completed"));
    expect(await readFile(join(root, "answer.txt"), "utf8")).toBe("42\n");
    expect(await callWorkerTool(getConfig().paths.stateDir, "local_worker_result", { jobId: id })).toMatchObject({ state: "completed", result: { status: "ok" } });
});
it("Stop all cancels external worker processes before returning", async () => {
    const response = await callWorkerTool(getConfig().paths.stateDir, "local_worker_run", { task: "wait", workingDir: root, isolate: false });
    const id = (response as {
        id: string;
    }).id;
    await vi.waitFor(() => expect(queue.activeCount).toBe(1));
    const stop = await fetch(harness.baseUrl + "/api/model-gateways", { method: "POST", headers, body: JSON.stringify({ action: "stop-all" }) });
    expect(stop.status).toBe(200);
    expect(queue.get(id)?.state).toBe("cancelled");
    expect(queue.activeCount).toBe(0);
});
