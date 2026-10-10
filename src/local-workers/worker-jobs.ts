import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { realpath, stat, rm } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseWorkerJob } from "./worker-request.js";
const exec = promisify(execFile);
export type WorkerState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface WorkerRequest {
    task: string;
    workingDir: string;
    hostId: string;
    modelId: string;
    parallelSlots: number;
    group: string | null;
    isolate: boolean;
    files: string[];
    maxSteps: number;
    timeoutSeconds: number;
}
export interface WorkerJob extends WorkerRequest {
    id: string;
    sourceDir: string;
    directory: string;
    state: WorkerState;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    pid: number | null;
    progress: string | null;
    result: unknown;
    error: string | null;
}
export interface WorkerProgress {
    pid?: number;
    message?: string;
}
interface WorkerJobsOptions {
    root: string;
    maxWorkers: number;
    run(job: WorkerJob, signal: AbortSignal, publish: (progress: WorkerProgress) => void): Promise<unknown>;
}
const overlaps = (a: string, b: string) => {
    const inside = (parent: string, child: string) => {
        const path = relative(parent, child);
        return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
    };
    return inside(a, b) || inside(b, a);
};
const terminal = (state: WorkerState) => state !== "queued" && state !== "running";
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** One controller-owned queue shared by every MCP client. */
export class LocalWorkerJobs {
    private readonly jobs = new Map<string, WorkerJob>();
    private readonly active = new Map<string, {
        controller: AbortController;
        done: Promise<void>;
    }>();
    private closed = false;
    private stopRevision = 0;
    readonly warnings: string[] = [];
    constructor(private readonly options: WorkerJobsOptions) {
        if (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1 || options.maxWorkers > 8)
            throw new Error("maxWorkers must be an integer from 1 to 8");
    }
    get maxWorkers(): number { return this.options.maxWorkers; }
    get activeCount(): number { return this.active.size; }
    get pendingCount(): number { return [...this.jobs.values()].filter(job => job.state === "queued").length; }
    async open(): Promise<void> {
        mkdirSync(this.options.root, { recursive: true, mode: 0o700 });
        for (const name of readdirSync(this.options.root)) {
            if (!/^[0-9a-f-]{36}$/.test(name))
                continue;
            try {
                const value: unknown = JSON.parse(readFileSync(join(this.options.root, name, "job.json"), "utf8"));
                if (!isRecord(value) || value.id !== name || typeof value.task !== "string" || typeof value.workingDir !== "string" || typeof value.sourceDir !== "string" || typeof value.hostId !== "string" || typeof value.modelId !== "string" || !["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(String(value.state)))
                    throw new Error("Invalid job record");
                const job = parseWorkerJob(value);
                job.directory = join(this.options.root, name);
                if (!terminal(job.state)) {
                    job.state = "interrupted";
                    job.finishedAt = new Date().toISOString();
                    job.error = "The controller restarted before this job finished; changes were not replayed";
                    job.pid = null;
                    this.save(job);
                }
                this.jobs.set(job.id, job);
            }
            catch (error) {
                this.warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    get(id: string): WorkerJob | undefined {
        const job = this.jobs.get(id);
        return job ? structuredClone(job) : undefined;
    }
    list(): WorkerJob[] { return [...this.jobs.values()].map(job => structuredClone(job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
    async submit(request: WorkerRequest): Promise<WorkerJob> {
        const revision = this.stopRevision;
        if (this.closed)
            throw new Error("The worker queue is closing");
        if (this.pendingCount >= 50)
            throw new Error("The worker queue is full");
        const sourceDir = await realpath(request.workingDir);
        if (!(await stat(sourceDir)).isDirectory())
            throw new Error("workingDir must be an existing directory on the hub");
        if (request.isolate)
            await exec("git", ["rev-parse", "--show-toplevel"], { cwd: sourceDir });
        const id = randomUUID(), directory = join(this.options.root, id);
        const job: WorkerJob = { ...request, id, sourceDir, directory, workingDir: request.isolate ? join(directory, "worktree") : sourceDir, state: "queued", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, pid: null, progress: null, result: null, error: null };
        if (this.closed || revision !== this.stopRevision)
            throw new Error("The worker submission was cancelled by Stop all");
        if (this.pendingCount >= 50)
            throw new Error("The worker queue is full");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.jobs.set(id, job);
        this.save(job);
        this.pump();
        return this.get(id)!;
    }
    async cancel(id: string): Promise<void> {
        const job = this.jobs.get(id);
        if (!job)
            throw new Error("No such worker job");
        if (terminal(job.state))
            return;
        const active = this.active.get(id);
        if (active) {
            active.controller.abort(new Error("Worker job cancelled"));
            await active.done;
        }
        else {
            job.state = "cancelled";
            job.finishedAt = new Date().toISOString();
            this.save(job);
        }
    }
    async cancelFor(hostId: string, modelId?: string): Promise<void> {
        const matching = [...this.jobs.values()].filter(job => job.hostId === hostId && (modelId === undefined || job.modelId === modelId));
        await Promise.all(matching.map(job => this.cancel(job.id)));
    }
    async cancelAll(): Promise<void> {
        this.stopRevision++;
        // Remove waiting jobs first so a cancelled runner cannot start another.
        for (const job of this.jobs.values())
            if (job.state === "queued") {
                job.state = "cancelled";
                job.finishedAt = new Date().toISOString();
                this.save(job);
            }
        await Promise.all([...this.active.keys()].map(id => this.cancel(id)));
    }
    async cleanup(id: string, discardChanges: boolean): Promise<void> {
        const job = this.jobs.get(id);
        if (!job)
            throw new Error("No such worker job");
        if (!terminal(job.state))
            throw new Error("Cancel or finish the job before cleanup");
        if (job.isolate) {
            const exists = await stat(job.workingDir).then(() => true, error => { if (error.code === "ENOENT")
                return false; throw error; });
            if (exists)
                await exec("git", ["worktree", "remove", ...(discardChanges ? ["--force"] : []), job.workingDir], { cwd: job.sourceDir });
        }
        await rm(job.directory, { recursive: true, force: true });
        this.jobs.delete(id);
    }
    async close(): Promise<void> { this.closed = true; await this.cancelAll(); }
    private save(job: WorkerJob): void {
        const path = join(job.directory, "job.json"), temporary = path + ".tmp";
        writeFileSync(temporary, JSON.stringify(job, null, 2) + "\n", { mode: 0o600 });
        renameSync(temporary, path);
    }
    private pump(): void {
        if (this.closed)
            return;
        for (const job of this.jobs.values()) {
            if (this.active.size >= this.maxWorkers)
                break;
            if (job.state !== "queued")
                continue;
            const active = [...this.active.keys()].map(id => this.jobs.get(id)!);
            if (active.filter(other => other.hostId === job.hostId && other.modelId === job.modelId).length >= job.parallelSlots)
                continue;
            if (active.some(other => (!job.isolate && !other.isolate && overlaps(other.sourceDir, job.sourceDir)) || (other.hostId === job.hostId && other.modelId !== job.modelId && job.group && job.group === other.group)))
                continue;
            const controller = new AbortController();
            job.state = "running";
            job.startedAt = new Date().toISOString();
            this.save(job);
            const done = Promise.resolve().then(() => this.options.run(job, controller.signal, progress => {
                if (progress.pid !== undefined)
                    job.pid = progress.pid;
                if (progress.message !== undefined)
                    job.progress = progress.message;
                this.save(job);
            })).then(result => {
                job.result = result;
                job.state = controller.signal.aborted ? "cancelled" : isRecord(result) && result.status !== "ok" ? "failed" : "completed";
            }, error => { job.state = controller.signal.aborted ? "cancelled" : "failed"; job.error = error instanceof Error ? error.message : String(error); }).finally(() => {
                job.finishedAt = new Date().toISOString();
                job.pid = null;
                this.save(job);
                this.active.delete(job.id);
                this.pump();
            });
            this.active.set(job.id, { controller, done });
        }
    }
}
