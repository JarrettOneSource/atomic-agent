import { readFileSync } from "node:fs";
import { join } from "node:path";
import { record } from "./worker-request.js";
export interface WorkerSettings {
    maxWorkers: number;
    defaultHostId?: string;
    defaultModelId?: string;
}
export function readWorkerSettings(stateDir: string): WorkerSettings {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(join(stateDir, "local-workers.json"), "utf8"));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { maxWorkers: 1 };
        throw error;
    }
    if (!record(raw) || typeof raw.maxWorkers !== "number" || !Number.isInteger(raw.maxWorkers) || raw.maxWorkers < 1 || raw.maxWorkers > 8)
        throw new Error("local-workers.json: maxWorkers must be an integer from 1 to 8");
    for (const key of ["defaultHostId", "defaultModelId"])
        if (raw[key] !== undefined && (typeof raw[key] !== "string" || !raw[key]))
            throw new Error(`local-workers.json: invalid ${key}`);
    return { maxWorkers: raw.maxWorkers, ...(typeof raw.defaultHostId === "string" ? { defaultHostId: raw.defaultHostId } : {}), ...(typeof raw.defaultModelId === "string" ? { defaultModelId: raw.defaultModelId } : {}) };
}
