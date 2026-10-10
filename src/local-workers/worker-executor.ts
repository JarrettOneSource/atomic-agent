import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import type { AtomicAgentConfig } from "../config/index.js";
import { ModelGatewayClient } from "../local-llm/gateways/model-gateway-client.js";
import { gatewayWorkerProvider } from "../local-llm/gateways/gateway-worker-provider.js";
import { record } from "./worker-request.js";
import type { WorkerJob, WorkerProgress } from "./worker-jobs.js";
const exec = promisify(execFile);
export function createWorkerExecutor(config: () => AtomicAgentConfig) {
    return async (job: WorkerJob, signal: AbortSignal, publish: (progress: WorkerProgress) => void): Promise<unknown> => {
        signal.throwIfAborted();
        const gateway = config().localModels.gateways.find(host => host.id === job.hostId);
        if (!gateway)
            throw new Error("The worker host is no longer configured");
        const model = (await new ModelGatewayClient(gateway).list(signal)).find(model => model.id === job.modelId);
        if (!model || model.kind !== "llm")
            throw new Error("Choose an installed chat model for this worker");
        if (job.isolate) {
            const root = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: job.sourceDir })).stdout.trim();
            if (root !== job.sourceDir)
                throw new Error("An isolated job must name the repository root as workingDir");
            await exec("git", ["worktree", "add", "--detach", job.workingDir, "HEAD"], { cwd: job.sourceDir });
        }
        signal.throwIfAborted();
        const state = join(job.directory, "state");
        await mkdir(state, { recursive: true, mode: 0o700 });
        const provider = gatewayWorkerProvider(gateway, model);
        provider.id = "local-worker";
        const childConfig = {
            localModels: { mode: "external", url: new ModelGatewayClient(gateway).inferenceUrl(model.id), gateways: [gateway], completionMaxTokens: 4096 },
            llm: { activeTextProvider: provider.id, providers: [provider], runMode: { mode: "cloud" } },
            agent: { approvalLevel: 1, readScope: "working-dir", nameSessions: false, conversationMaxTokens: 0 },
            memory: { recall: { enabled: false }, reflection: { enabled: false } },
            analytics: { enabled: false }, log: { level: "warn" }, tracing: { trace: { enabled: false } },
        };
        await writeFile(join(state, "config.json"), JSON.stringify(childConfig) + "\n", { mode: 0o600 });
        const input = join(job.directory, "input.json");
        await writeFile(input, JSON.stringify(job) + "\n", { mode: 0o600 });
        const env: NodeJS.ProcessEnv = { ATOMIC_AGENT_STATE_DIR: state, ATOMIC_AGENT_UPDATE_CHECK_ON_STARTUP: "false" };
        for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TERM", ...(gateway.apiKeyEnv ? [gateway.apiKeyEnv] : [])])
            if (process.env[key] !== undefined)
                env[key] = process.env[key];
        const cli = fileURLToPath(new URL("../cli/index.js", import.meta.url));
        const child = spawn(process.execPath, [cli, "worker-run", "--job", input], { cwd: job.workingDir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
        if (child.pid)
            publish({ pid: child.pid, message: "Starting worker" });
        let stderr = "";
        child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
        const lines = createInterface({ input: child.stdout! });
        lines.on("line", line => { try {
            const event: unknown = JSON.parse(line);
            if (record(event) && event.type === "progress" && typeof event.message === "string")
                publish({ message: event.message.slice(0, 500) });
        }
        catch { /* Non-protocol stdout is not a worker result. */ } });
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const kill = (force = false) => {
            if (!child.pid)
                return;
            try {
                if (process.platform !== "win32")
                    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
                else
                    child.kill(force ? "SIGKILL" : "SIGTERM");
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                    throw error;
            }
        };
        const abort = () => { kill(); killTimer = setTimeout(() => kill(true), 3000); killTimer.unref(); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted)
            abort();
        try {
            const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
            signal.throwIfAborted();
            if (code !== 0)
                throw new Error(`Worker exited ${code}: ${stderr.trim() || "no result"}`);
            const result: unknown = JSON.parse(await readFile(join(job.directory, "result.json"), "utf8"));
            if (!record(result) || typeof result.status !== "string" || typeof result.reply !== "string")
                throw new Error("The worker returned an invalid result");
            if (job.isolate) {
                const diff = (await exec("git", ["diff", "--stat"], { cwd: job.workingDir })).stdout;
                const untracked = (await exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: job.workingDir })).stdout;
                return { ...result, worktree: job.workingDir, changes: diff, untracked: untracked.split("\n").filter(Boolean) };
            }
            return result;
        }
        finally {
            signal.removeEventListener("abort", abort);
            if (killTimer)
                clearTimeout(killTimer);
            lines.close();
        }
    };
}
