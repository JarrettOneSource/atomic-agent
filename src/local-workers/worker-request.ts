import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkerJob, WorkerRequest, WorkerState } from "./worker-jobs.js";
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function text(value: unknown, field: string, max = 80000): string {
    if (typeof value !== "string" || !value.trim() || value.length > max)
        throw new Error(`${field} must be a non-empty string of at most ${max} characters`);
    return value;
}
function integer(value: unknown, fallback: number, field: string, min: number, max: number): number {
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
        throw new Error(`${field} must be an integer from ${min} to ${max}`);
    return value;
}
export function parseWorkerRequest(value: unknown, defaults: {
    hostId?: string;
    modelId?: string;
    parallelSlots?: number;
    group?: string | null;
} = {}): WorkerRequest {
    if (!record(value))
        throw new Error("Expected a worker task object");
    const workingDir = text(value.workingDir, "workingDir", 4096);
    if (!isAbsolute(workingDir))
        throw new Error("workingDir must be an absolute directory on the hub");
    if (value.isolate !== undefined && typeof value.isolate !== "boolean")
        throw new Error("isolate must be a boolean");
    const files = value.files ?? [];
    if (!Array.isArray(files) || files.length > 64 || !files.every(file => typeof file === "string" && file.length > 0 && file.length <= 4096))
        throw new Error("files must contain at most 64 file paths");
    return { task: text(value.task, "task"), workingDir, hostId: text(value.hostId ?? defaults.hostId, "hostId", 100), modelId: text(value.modelId ?? defaults.modelId, "modelId", 300), parallelSlots: integer(defaults.parallelSlots, 1, "parallelSlots", 1, 32), group: defaults.group ?? null, isolate: value.isolate !== false, files: [...files], maxSteps: integer(value.maxSteps, 40, "maxSteps", 1, 200), timeoutSeconds: integer(value.timeoutSeconds, 1800, "timeoutSeconds", 30, 7200) };
}
export function parseWorkerJob(value: unknown): WorkerJob {
    if (!record(value))
        throw new Error("Invalid worker job record");
    const states: WorkerState[] = ["queued", "running", "completed", "failed", "cancelled", "interrupted"];
    if (typeof value.state !== "string" || !states.includes(value.state as WorkerState))
        throw new Error("Invalid worker job state");
    const id = text(value.id, "id", 36);
    if (!/^[0-9a-f-]{36}$/.test(id))
        throw new Error("Invalid worker job id");
    const request = parseWorkerRequest(value, { parallelSlots: integer(value.parallelSlots, 1, "parallelSlots", 1, 32), group: typeof value.group === "string" ? value.group : null });
    const nullable = (key: string): string | null => value[key] === null || value[key] === undefined ? null : text(value[key], key);
    return { ...request, id, sourceDir: text(value.sourceDir, "sourceDir", 4096), directory: text(value.directory, "directory", 4096), state: value.state as WorkerState, createdAt: text(value.createdAt, "createdAt", 100), startedAt: nullable("startedAt"), finishedAt: nullable("finishedAt"), pid: value.pid === null || value.pid === undefined ? null : integer(value.pid, 0, "pid", 1, Number.MAX_SAFE_INTEGER), progress: nullable("progress"), result: value.result ?? null, error: nullable("error") };
}
export function workerOutputPaths(job: WorkerJob): string[] {
    return job.files.map(path => {
        const rel = relative(job.sourceDir, resolve(job.sourceDir, path));
        if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
            throw new Error("Declared output files must be inside the worker workspace");
        return resolve(job.workingDir, rel);
    });
}
