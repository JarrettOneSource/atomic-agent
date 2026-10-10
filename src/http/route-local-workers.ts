import { getConfig } from "../config/index.js";
import { ModelGatewayClient } from "../local-llm/gateways/model-gateway-client.js";
import { findGatewayTarget } from "../local-llm/gateways/gateway-target.js";
import { parseWorkerRequest, record } from "../local-workers/worker-request.js";
import { readWorkerSettings } from "../local-workers/worker-settings.js";
import { readJsonBody, sendJson, type HttpHandler, type HandlerContext } from "./request-context.js";
import type { LocalWorkerJobs, WorkerJob } from "../local-workers/worker-jobs.js";
const summary = (job: WorkerJob) => { const { task, result, directory, ...view } = job; return { ...view, title: task.split("\n")[0]!.slice(0, 120), hasResult: result !== null }; };
function manager(ctx: HandlerContext): LocalWorkerJobs {
    if (!ctx.apiKey)
        throw new Error("Worker jobs require bearer authentication");
    if (!ctx.localWorkers)
        throw new Error("The worker bridge is not enabled in this controller");
    return ctx.localWorkers;
}
export function createLocalWorkerHandlers(): {
    submit: HttpHandler;
    list: HttpHandler;
    get: HttpHandler;
    cancel: HttpHandler;
    cleanup: HttpHandler;
    models: HttpHandler;
} {
    return {
        submit: async (req, res, ctx) => {
            try {
                const queue = manager(ctx), raw = await readJsonBody<unknown>(req), config = getConfig(), settings = readWorkerSettings(config.paths.stateDir);
                if (!record(raw))
                    throw new Error("Expected a worker task object");
                const allowed = new Set(["task", "workingDir", "hostId", "modelId", "isolate", "files", "maxSteps", "timeoutSeconds"]);
                if (Object.keys(raw).some(key => !allowed.has(key)))
                    throw new Error("Unknown worker task field");
                const current = findGatewayTarget(config.localModels.url, config.localModels.gateways);
                const input = parseWorkerRequest(raw, { hostId: settings.defaultHostId ?? current?.gateway.id, modelId: settings.defaultModelId ?? current?.modelId });
                const gateway = config.localModels.gateways.find(host => host.id === input.hostId);
                if (!gateway)
                    throw new Error("Choose a configured worker host");
                const model = (await new ModelGatewayClient(gateway).list()).find(model => model.id === input.modelId);
                if (!model || model.kind !== "llm")
                    throw new Error("Choose an installed chat model for the worker");
                if (ctx.runtime.gatewayTasks.controlsBusy)
                    throw new Error("Wait for the model operation to finish before submitting a worker job");
                if (ctx.completionRegistry.size() > 0)
                    throw new Error("Finish or stop the active GUI task before submitting external worker jobs");
                const job = await queue.submit({ ...input, parallelSlots: model.parallelSlots ?? 1, group: model.group });
                sendJson(res, 202, summary(job));
            }
            catch (error) {
                sendJson(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
            }
        },
        list: (_req, res, ctx) => { const queue = manager(ctx); sendJson(res, 200, { maxWorkers: queue.maxWorkers, active: queue.activeCount, queued: queue.pendingCount, warnings: queue.warnings, jobs: queue.list().slice(0, 50).map(summary) }); },
        get: async (req, res, ctx) => {
            const queue = manager(ctx), id = ctx.params.id!, wait = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("waitSeconds") ?? 0);
            if (!Number.isFinite(wait) || wait < 0 || wait > 20) {
                sendJson(res, 400, { error: { message: "waitSeconds must be from 0 to 20" } });
                return;
            }
            const deadline = Date.now() + wait * 1000;
            let job = queue.get(id);
            while (job && ["queued", "running"].includes(job.state) && Date.now() < deadline && !res.destroyed) {
                await new Promise(resolve => setTimeout(resolve, 200));
                job = queue.get(id);
            }
            if (!job) {
                sendJson(res, 404, { error: { message: "No such worker job" } });
                return;
            }
            sendJson(res, 200, job);
        },
        cancel: async (_req, res, ctx) => { const queue = manager(ctx); if (!queue.get(ctx.params.id!)) {
            sendJson(res, 404, { error: { message: "No such worker job" } });
            return;
        } await queue.cancel(ctx.params.id!); sendJson(res, 200, queue.get(ctx.params.id!)); },
        cleanup: async (req, res, ctx) => { try {
            const raw = await readJsonBody<unknown>(req);
            if (!record(raw) || (raw.discardChanges !== undefined && typeof raw.discardChanges !== "boolean"))
                throw new Error("discardChanges must be a boolean");
            await manager(ctx).cleanup(ctx.params.id!, raw.discardChanges === true);
            sendJson(res, 200, { ok: true });
        }
        catch (error) {
            sendJson(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
        } },
        models: async (_req, res, ctx) => {
            const queue = manager(ctx), config = getConfig();
            const hosts = await Promise.all(config.localModels.gateways.map(async (gateway) => {
                try {
                    return { id: gateway.id, name: gateway.name, online: true, models: (await new ModelGatewayClient(gateway).list()).filter(model => model.kind === "llm") };
                }
                catch (error) {
                    return { id: gateway.id, name: gateway.name, online: false, error: error instanceof Error ? error.message : String(error), models: [] };
                }
            }));
            sendJson(res, 200, { ...readWorkerSettings(config.paths.stateDir), maxWorkers: queue.maxWorkers, active: queue.activeCount, queued: queue.pendingCount, hosts });
        },
    };
}
