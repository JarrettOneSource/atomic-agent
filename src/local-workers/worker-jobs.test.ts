import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalWorkerJobs, type WorkerJob } from "./worker-jobs.js";
let root: string;
const queues: LocalWorkerJobs[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "atomic-workers-")); });
afterEach(async () => { await Promise.all(queues.map(queue => queue.close())); queues.length = 0; await rm(root, { recursive: true, force: true }); });
async function queue(run: (job: WorkerJob, signal: AbortSignal) => Promise<unknown>, maxWorkers = 2) {
    const result = new LocalWorkerJobs({ root: join(root, "jobs"), maxWorkers, run });
    queues.push(result);
    await result.open();
    return result;
}
async function spec(name: string) {
    const workingDir = join(root, name);
    await mkdir(workingDir, { recursive: true });
    return { task: "Write and check a function", workingDir, hostId: "m5", modelId: "qwen", parallelSlots: 2, group: "large", isolate: false, files: [], maxSteps: 20, timeoutSeconds: 60 };
}
function pending(signal: AbortSignal): Promise<unknown> {
    return new Promise((_resolve, reject) => { if (signal.aborted)
        reject(signal.reason);
    else
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
}
it("one queue caps concurrent jobs across clients and starts the next after a completion", async () => {
    const ends = new Map<string, () => void>();
    let active = 0, peak = 0;
    const q = await queue(async (job, signal) => { active++; peak = Math.max(peak, active); try {
        return await new Promise((resolve, reject) => { ends.set(job.id, () => resolve({ status: "ok", reply: job.task })); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    }
    finally {
        active--;
    } });
    const a = await q.submit(await spec("a")), b = await q.submit(await spec("b")), c = await q.submit(await spec("c"));
    await vi.waitFor(() => expect(active).toBe(2));
    expect(q.get(c.id)?.state).toBe("queued");
    ends.get(a.id)!();
    await vi.waitFor(() => expect(q.get(c.id)?.state).toBe("running"));
    expect(peak).toBe(2);
    ends.get(b.id)!();
    ends.get(c.id)!();
    await vi.waitFor(() => expect(q.list().every(job => job.state === "completed")).toBe(true));
});
it("cancellation removes queued work and aborts matching active jobs without cancelling other hosts", async () => {
    const q = await queue(async (_job, signal) => pending(signal));
    const a = await q.submit(await spec("a")), b = await q.submit({ ...await spec("b"), hostId: "wsl" }), c = await q.submit(await spec("c"));
    await vi.waitFor(() => expect(q.activeCount).toBe(2));
    await q.cancelFor("m5", "qwen");
    expect(q.get(a.id)?.state).toBe("cancelled");
    expect(q.get(c.id)?.state).toBe("cancelled");
    expect(q.get(b.id)?.state).toBe("running");
});
it("directory jobs in the same workspace serialize and cancelled queued jobs never execute", async () => {
    const seen: string[] = [];
    const q = await queue(async (job, signal) => { seen.push(job.id); return pending(signal); });
    const shared = await spec("shared"), a = await q.submit(shared), b = await q.submit(shared);
    await vi.waitFor(() => expect(q.activeCount).toBe(1));
    expect(q.get(b.id)?.state).toBe("queued");
    await q.cancel(b.id);
    await q.cancel(a.id);
    expect(seen).toEqual([a.id]);
});
it("completed results survive reopening and interrupted jobs are reported without replaying writes", async () => {
    const q = await queue(async () => ({ status: "ok", reply: "done" }));
    const a = await q.submit(await spec("a"));
    await vi.waitFor(() => expect(q.get(a.id)?.state).toBe("completed"));
    await q.close();
    const reopened = await queue(async () => { throw Error("must not replay"); });
    expect(reopened.get(a.id)?.result).toEqual({ status: "ok", reply: "done" });
});

it("serializes directory jobs when one workspace contains the other", async () => {
  const q = await queue(async (_job, signal) => pending(signal));
  const outer = await spec("tree");
  const inner = await spec("tree/src");
  const a = await q.submit(outer), b = await q.submit(inner);
  await vi.waitFor(() => expect(q.activeCount).toBe(1));
  expect(q.get(b.id)?.state).toBe("queued");
  await q.cancel(b.id); await q.cancel(a.id);
});

it("rejects cleanup while running and retains finished work until explicit cleanup", async () => {
  const q = await queue(async (_job, signal) => pending(signal));
  const job = await q.submit(await spec("cleanup"));
  await expect(q.cleanup(job.id, false)).rejects.toThrow("Cancel or finish");
  await q.cancel(job.id);
  await q.cleanup(job.id, false);
  expect(q.get(job.id)).toBeUndefined();
});

it("Stop all cancels a submission still validating its workspace", async () => {
  const q = await queue(async () => ({ status: "ok" }));
  const input = await spec("validating");
  const submitted = q.submit(input);
  await q.cancelAll();
  await expect(submitted).rejects.toThrow("cancelled by Stop all");
  expect(q.list()).toEqual([]);
});

it("marks a recovered running record interrupted without replaying the task", async () => {
  const q = await queue(async (_job, signal) => pending(signal));
  const job = await q.submit(await spec("interrupted"));
  await q.close();
  const path = join(job.directory, "job.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.state = "running";
  saved.finishedAt = null;
  await writeFile(path, JSON.stringify(saved));
  let calls = 0;
  const reopened = await queue(async () => { calls++; return { status: "ok" }; });
  expect(reopened.get(job.id)?.state).toBe("interrupted");
  expect(reopened.get(job.id)?.error).toContain("not replayed");
  expect(calls).toBe(0);
});
