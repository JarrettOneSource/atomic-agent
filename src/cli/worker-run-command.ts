import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { runWorkerTasks } from "../tools/fusion/worker-runner.js";
import { parseWorkerJob, workerOutputPaths } from "../local-workers/worker-request.js";
import { watchForOrphaning } from "./serve-orphan-guard.js";
export async function workerRunCommand(args: string[]): Promise<number> {
    if (args.length !== 2 || args[0] !== "--job") {
        process.stderr.write("Usage: atomic-agent worker-run --job <private job file>\n");
        return 2;
    }
    const job = parseWorkerJob(JSON.parse(await readFile(args[1]!, "utf8")));
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Worker process stopping"));
    process.once("SIGTERM", abort);
    process.once("SIGINT", abort);
    const orphan = watchForOrphaning({ isBusy: () => false, onOrphaned: abort, onOrphanedWhileBusy: abort });
    const deadline = setTimeout(() => controller.abort(new Error("Worker deadline exceeded")), job.timeoutSeconds * 1000);
    deadline.unref();
    const runtime = await createAgentRuntime({ workingDir: job.workingDir, approvalLevel: 1, brokenPipe: "mute", traceDefault: false });
    try {
        const results = await runWorkerTasks({ runTurn: runtime.runTurn, createEphemeralSession: runtime.createEphemeralSession, approvals: runtime.approvals, workingDir: job.workingDir, logger: runtime.logger, emitEvent: (_session, event) => {
                if (event.type === "fusion_worker")
                    process.stdout.write(JSON.stringify({ type: "progress", message: event.phase + (event.tool ? ": " + event.tool : "") }) + "\n");
            } }, { parentSessionId: job.id, tasks: [{ id: job.id, title: job.task.split("\n")[0]!.slice(0, 100), instructions: job.task, files: workerOutputPaths(job) }], maxWorkers: 1, providerId: getConfig().llm!.activeTextProvider, workerModel: job.modelId, workerMaxSteps: job.maxSteps, workerTimeoutMs: job.timeoutSeconds * 1000, workerMaxOutputTokens: 4096, workerReasoning: "low", localLeg: true, writeScope: [job.workingDir], originalRequest: job.task, signal: controller.signal });
        await writeFile(join(job.directory, "result.json"), JSON.stringify(results[0], null, 2) + "\n", { mode: 0o600 });
        return 0;
    }
    finally {
        clearTimeout(deadline);
        orphan();
        process.off("SIGTERM", abort);
        process.off("SIGINT", abort);
        await runtime.shutdown();
    }
}
