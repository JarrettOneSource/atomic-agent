import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { readWorkerConnection } from "./worker-connection.js";
import { record } from "./worker-request.js";
const idSchema = { type: "string", description: "Job id returned by local_worker_run" };
export const workerTools: Tool[] = [
    { name: "local_worker_models", description: "List local model hosts, context windows, inference slots and the shared queue limit. Does not load models.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
    { name: "local_worker_run", description: "Delegate a bounded task to a local Atomic agent. workingDir is an absolute path on the M2 hub. By default create a detached git worktree from HEAD, preserving the source checkout; uncommitted source changes are not copied. Use isolate:false for an existing separate workspace. All clients share one queue. The job may write files and run commands inside its workspace. Returns a job id immediately; poll status, inspect results and actual changes before integrating, then cleanup the job.", inputSchema: { type: "object", required: ["task", "workingDir"], properties: { task: { type: "string", maxLength: 80000 }, workingDir: { type: "string" }, hostId: { type: "string" }, modelId: { type: "string" }, isolate: { type: "boolean", default: true }, files: { type: "array", items: { type: "string" }, maxItems: 64 }, maxSteps: { type: "integer", minimum: 1, maximum: 200, default: 40 }, timeoutSeconds: { type: "integer", minimum: 30, maximum: 7200, default: 1800 } } }, annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: "local_worker_status", description: "Inspect a worker job, or list the shared queue when jobId is omitted. waitSeconds waits up to 20 seconds for a job to finish. Closing this MCP connection leaves submitted jobs with Atomic.", inputSchema: { type: "object", properties: { jobId: idSchema, waitSeconds: { type: "number", minimum: 0, maximum: 20 } } }, annotations: { readOnlyHint: true } },
    { name: "local_worker_result", description: "Read a worker's result, tool statistics, errors and worktree path. A completed job still requires review of its actual changes and checks.", inputSchema: { type: "object", required: ["jobId"], properties: { jobId: idSchema } }, annotations: { readOnlyHint: true } },
    { name: "local_worker_cancel", description: "Cancel a queued or active local worker job and stop its child process. Existing changes remain available for review.", inputSchema: { type: "object", required: ["jobId"], properties: { jobId: idSchema } }, annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: "local_worker_cleanup", description: "Remove a finished job's private state and owned git worktree after integrating its changes. A dirty worktree is refused unless discardChanges:true explicitly authorizes discarding it. Never removes the original workspace.", inputSchema: { type: "object", required: ["jobId"], properties: { jobId: idSchema, discardChanges: { type: "boolean", default: false } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
];
export async function callWorkerTool(stateDir: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    let method = "GET", path = "/api/local-workers", body: unknown;
    const id = () => { if (typeof args.jobId !== "string" || !/^[0-9a-f-]{36}$/.test(args.jobId))
        throw new Error("A valid jobId is required"); return encodeURIComponent(args.jobId); };
    switch (name) {
        case "local_worker_models":
            path += "/models";
            break;
        case "local_worker_run":
            method = "POST";
            body = args;
            break;
        case "local_worker_status":
            if (args.jobId !== undefined) {
                path += "/" + id();
                if (args.waitSeconds !== undefined) {
                    if (typeof args.waitSeconds !== "number" || args.waitSeconds < 0 || args.waitSeconds > 20)
                        throw new Error("waitSeconds must be from 0 to 20");
                    path += "?waitSeconds=" + args.waitSeconds;
                }
            }
            break;
        case "local_worker_result":
            path += "/" + id();
            break;
        case "local_worker_cancel":
            path += "/" + id() + "/cancel";
            method = "POST";
            body = {};
            break;
        case "local_worker_cleanup":
            path += "/" + id() + "/cleanup";
            method = "POST";
            body = { discardChanges: args.discardChanges ?? false };
            break;
        default: throw new Error("Unknown local worker tool");
    }
    let connection;
    try {
        connection = readWorkerConnection(stateDir);
    }
    catch (error) {
        throw new Error(`Open Atomic on the hub to connect the worker bridge: ${error instanceof Error ? error.message : String(error)}`);
    }
    const host = connection.host === "::1" ? "[::1]" : connection.host;
    const response = await fetch(`http://${host}:${connection.port}${path}`, { method, headers: { authorization: `Bearer ${connection.apiKey}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const result: unknown = await response.json();
    if (!response.ok) {
        const error = record(result) && record(result.error) ? result.error.message : null;
        throw new Error(typeof error === "string" ? error : `Worker request failed (${response.status})`);
    }
    return result;
}
export async function startWorkerMcp(stateDir: string): Promise<void> {
    const server = new Server({ name: "atomic-workers", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: "Delegate bounded coding, tests or review to local_worker_run. Use isolated worktrees for parallel edits. Poll jobs; verify actual changes and tests, integrate them, then cleanup. Jobs run on the M2 hub and inference stays on its configured hosts. Respect reported concurrency/context limits. Atomic Stop all cancels these jobs too." });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: workerTools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            const result = await callWorkerTool(stateDir, request.params.name, request.params.arguments ?? {});
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: { result } };
        }
        catch (error) {
            return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
        }
    });
    const stop = () => { void server.close(); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    let finish = () => { };
    const closed = new Promise<void>(resolve => { finish = resolve; });
    server.onclose = () => { process.off("SIGTERM", stop); process.off("SIGINT", stop); finish(); };
    await server.connect(new StdioServerTransport());
    await closed;
}
