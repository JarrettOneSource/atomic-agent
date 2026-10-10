import { getConfig } from "../config/index.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-registry.js";
import { resolveRunMode } from "../llm/run-mode/index.js";
import { ModelGatewayClient } from "../local-llm/gateways/model-gateway-client.js";
import { findGatewayTarget } from "../local-llm/gateways/gateway-target.js";
import { gatewayWorkerProvider } from "../local-llm/gateways/gateway-worker-provider.js";
import { selectGatewayModel, selectGatewaySolo } from "../local-llm/gateways/gateway-selection.js";
import { readJsonBody, sendJson, type HttpHandler } from "./request-context.js";
import type { GatewayModel } from "../local-llm/gateways/model-gateway-types.js";
import type { UserLlmProviderEntry } from "../config/llm-config.js";

type ActionResult = { cancelled: true } | { ok: false; errors: string[] } | {
  ok: true; model?: GatewayModel; url?: string; workerProvider?: UserLlmProviderEntry | null;
};

export function createModelGatewayHandlers(): { list: HttpHandler; action: HttpHandler } {
  const list: HttpHandler = async (_req, res, ctx) => {
    const config = getConfig();
    const providers = resolveLlmConfig(config);
    const mode = resolveRunMode(providers);
    const active = providers.providers.find(provider => provider.id === providers.activeTextProvider);
    const worker = providers.providers.find(provider => provider.id === mode.workerProviderId);
    const main = findGatewayTarget(active?.kind === "llama-server" ? config.localModels.url : active?.baseUrl ?? "", config.localModels.gateways);
    const workerTarget = findGatewayTarget(worker?.baseUrl ?? "", config.localModels.gateways);
    const hosts = await Promise.all(config.localModels.gateways.map(async gateway => {
      try { return { gateway, online: true, models: await new ModelGatewayClient(gateway).list(), error: null }; }
      catch (error) { return { gateway, online: false, models: [], error: error instanceof Error ? error.message : String(error) }; }
    }));
    sendJson(res, 200, {
      hosts, mode: mode.effective, busy: ctx.runtime.gatewayTasks.controlsBusy,
      main: main ? { hostId: main.gateway.id, modelId: main.modelId } : null,
      worker: workerTarget ? { hostId: workerTarget.gateway.id, modelId: workerTarget.modelId } : null,
    });
  };
  const action: HttpHandler = async (req, res, ctx) => {
    const body = await readJsonBody<unknown>(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) { sendJson(res, 400, { error: { message: "Expected a model action" } }); return; }
    const { action, hostId, modelId, role } = body as Record<string, unknown>;
    if (!["start", "stop", "stop-all", "solo"].includes(String(action))) { sendJson(res, 400, { error: { message: "Unknown model action" } }); return; }
    const config = getConfig();
    if (action === "stop-all") {
      ctx.completionRegistry.cancelAll();
      ctx.runtime.gatewayTasks.cancelAll();
      const result = await ctx.runtime.gatewayTasks.changeModels<ActionResult>(async signal => {
        const results = await Promise.allSettled(config.localModels.gateways.map(gateway => new ModelGatewayClient(gateway).stopAll(signal)));
        const failures = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
        return failures.length ? { ok: false, errors: failures } : { ok: true };
      }, { cancelled: true });
      sendJson(res, 200, result); return;
    }
    if (action === "solo") {
      if (ctx.runtime.gatewayTasks.activeCount > 0 || ctx.completionRegistry.size() > 0) { sendJson(res, 409, { error: { message: "Stop the running task before changing modes" } }); return; }
      const result = await ctx.runtime.gatewayTasks.changeModels<ActionResult>(async signal => {
        const providers = resolveLlmConfig(getConfig());
        const worker = providers.providers.find(provider => provider.id === resolveRunMode(providers).workerProviderId);
        const target = worker?.baseUrl ? findGatewayTarget(worker.baseUrl, getConfig().localModels.gateways) : null;
        selectGatewaySolo();
        await ctx.runtime.reloadLlmProviders();
        if (target) await new ModelGatewayClient(target.gateway).stop(target.modelId, signal);
        return { ok: true };
      }, { cancelled: true });
      sendJson(res, 200, result); return;
    }
    const gateway = config.localModels.gateways.find(host => host.id === hostId);
    if (!gateway || typeof modelId !== "string") { sendJson(res, 400, { error: { message: "Choose a configured host and model" } }); return; }
    if (action === "start" && (ctx.completionRegistry.size() > 0 || ctx.runtime.gatewayTasks.activeCount > 0)) {
      sendJson(res, 409, { error: { message: "Stop the running task before changing its models" } }); return;
    }
    if (action === "stop") ctx.runtime.gatewayTasks.cancelModel(gateway.id, modelId);
    const result = await ctx.runtime.gatewayTasks.changeModels<ActionResult>(async signal => {
      const client = new ModelGatewayClient(gateway);
      const model = (await client.list(signal)).find(row => row.id === modelId);
      if (!model) throw new Error("The model is not installed on this host");
      if (action === "stop") { await client.stop(modelId, signal); return { ok: true }; }
      if (role === "worker") {
        if (model.kind !== "llm") throw new Error("Choose a chat model for the worker");
        const main = findGatewayTarget(config.localModels.url, config.localModels.gateways);
        if (!main || main.gateway.id === gateway.id) throw new Error("Choose a worker on another host");
      }
      await client.start(modelId, signal); signal.throwIfAborted();
      if (model.kind === "llm") {
        selectGatewayModel(gateway, model, role === "worker" ? "worker" : "main");
        await ctx.runtime.reloadLlmProviders();
        if (role !== "worker") await ctx.runtime.refreshLocalModelProfile();
        signal.throwIfAborted();
      }
      return { ok: true, model, url: client.inferenceUrl(modelId), workerProvider: model.kind === "llm" ? gatewayWorkerProvider(gateway, model) : null };
    }, { cancelled: true });
    sendJson(res, 200, result);
  };
  return { list, action };
}
