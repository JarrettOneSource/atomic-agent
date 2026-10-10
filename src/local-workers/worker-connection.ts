import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { record } from "./worker-request.js";
export interface WorkerConnection {
    pid: number;
    host: string;
    port: number;
    apiKey: string;
}
export const workerConnectionPath = (stateDir: string) => join(stateDir, "worker-connection.json");
export function writeWorkerConnection(stateDir: string, connection: WorkerConnection): () => void {
    if (!["127.0.0.1", "::1", "localhost"].includes(connection.host))
        return () => { };
    const path = workerConnectionPath(stateDir), temp = path + `.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(connection) + "\n", { mode: 0o600 });
    renameSync(temp, path);
    return () => { try {
        const current = readWorkerConnection(stateDir, false);
        if (current.pid === connection.pid && current.apiKey === connection.apiKey)
            unlinkSync(path);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
    } };
}
export function readWorkerConnection(stateDir: string, checkOwner = true): WorkerConnection {
    const path = workerConnectionPath(stateDir), info = statSync(path);
    if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))
        throw new Error("The worker connection file must be private to its owner");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!record(value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid < 1 || typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.host !== "string" || !["127.0.0.1", "::1", "localhost"].includes(value.host) || typeof value.apiKey !== "string" || !value.apiKey)
        throw new Error("Invalid worker connection file");
    if (checkOwner)
        process.kill(value.pid, 0);
    return { pid: value.pid, host: value.host, port: value.port, apiKey: value.apiKey };
}
