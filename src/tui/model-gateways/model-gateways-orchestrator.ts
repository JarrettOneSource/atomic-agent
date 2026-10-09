import { getConfig } from "../../config/index.js";
import { upsertLlmProvider } from "../../config/llm-provider-commands.js";
import { resolveLlmConfig } from "../../llm/provider/registry/provider-registry.js";
import { resolveRunMode } from "../../llm/run-mode/index.js";
import { ModelGatewayClient } from "../../local-llm/gateways/model-gateway-client.js";
import { findGatewayTarget } from "../../local-llm/gateways/gateway-target.js";
import type { GatewayModel, ModelGatewayDefinition, ModelGatewaySnapshot } from "../../local-llm/gateways/model-gateway-types.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiAction } from "../tui-action.js";
import { ModelOperationQueue } from "../local-models/model-operation-queue.js";
import type { RunModeOrchestrator } from "../run-mode/run-mode-orchestrator.js";

const WORKER_PROVIDER = "gateway-worker";

export interface ModelGatewaysHooks {
  activate(url: string): Promise<boolean>;
  isBusy(): boolean;
  abortTasks(): void;
  runtime: Pick<AgentRuntime, "reloadLlmProvider" | "reloadLlmProviders" | "refreshLocalModelProfile"> & {
    providerRegistry: Pick<AgentRuntime["providerRegistry"], "listIds">;
    gatewayTasks: Pick<AgentRuntime["gatewayTasks"], "cancelAll" | "cancelModel" | "activeCount">;
  };
  runMode: Pick<RunModeOrchestrator, "setMode">;
  refreshProviders(): void;
}

export class ModelGatewaysOrchestrator {
  private readonly operations = new ModelOperationQueue();
  private timer: NodeJS.Timeout | null = null;
  private snapshots: readonly ModelGatewaySnapshot[] = [];
  private refreshing: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly bus: { emit(action: TuiAction): void },
    private readonly hooks: ModelGatewaysHooks,
  ) {}

  start(): void {
    if (this.timer || !getConfig().localModels.gateways.length) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 3_000);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.operations.close();
    // Gateways keep their idle policy; closing a browser or TUI does not kill another client's work.
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshHosts();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }

  private async refreshHosts(): Promise<void> {
    const hosts = await Promise.all(getConfig().localModels.gateways.map(async (gateway): Promise<ModelGatewaySnapshot> => {
      try {
        return { gateway, online: true, models: await new ModelGatewayClient(gateway).list(), error: null };
      } catch (error) {
        return {
          gateway, online: false,
          models: this.snapshots.find((host) => host.gateway.id === gateway.id)?.models ?? [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    if (this.closed) return;
    this.snapshots = hosts;
    this.bus.emit({ type: "llm_gateways_refreshed", hosts });
  }

  async use(hostId: string, modelId: string): Promise<void> {
    if (this.rejectBusySwitch()) return;
    await this.perform(async (signal) => {
      const { gateway, model, client } = await this.lookup(hostId, modelId, signal);
      this.status(`Starting ${model.name} on ${gateway.name}…`);
      await client.start(modelId, signal);
      signal.throwIfAborted();
      let solo = false;
      if (model.kind === "llm") {
        if (!await this.hooks.activate(client.inferenceUrl(modelId))) {
          throw new Error("The model started, but Atomic could not activate its inference endpoint.");
        }
        await this.hooks.runtime.refreshLocalModelProfile();
        const config = resolveLlmConfig(getConfig());
        const mode = resolveRunMode(config);
        const worker = config.providers.find((provider) => provider.id === mode.workerProviderId);
        const workerTarget = worker?.baseUrl
          ? findGatewayTarget(worker.baseUrl, getConfig().localModels.gateways) : null;
        if (mode.effective === "fusion" && workerTarget?.gateway.id === gateway.id) {
          await this.hooks.runMode.setMode("local");
          solo = true;
        }
      }
      this.status(`${model.name} is ready on ${gateway.name}${model.kind === "llm" ? " · main model" : ""}.${solo ? " Solo mode: the worker used this host." : ""}`);
    });
  }

  async useWorker(hostId: string, modelId: string): Promise<void> {
    if (this.rejectBusySwitch()) return;
    await this.perform(async (signal) => {
      const { gateway, model, client } = await this.lookup(hostId, modelId, signal);
      if (model.kind !== "llm") throw new Error("Choose a chat model for the worker.");
      const main = findGatewayTarget(getConfig().localModels.url, getConfig().localModels.gateways);
      if (!main) throw new Error("Choose a gateway main model first.");
      if (main.gateway.id === gateway.id) {
        throw new Error("Choose a worker on another host so it cannot unload the main model.");
      }
      this.status(`Starting worker ${model.name} on ${gateway.name}…`);
      await client.start(modelId, signal);
      signal.throwIfAborted();
      upsertLlmProvider({
        id: WORKER_PROVIDER,
        kind: "openai-compatible",
        baseUrl: client.inferenceUrl(modelId),
        defaultChatModel: model.nativeModel,
        ...(gateway.apiKeyEnv ? { apiKeyEnv: gateway.apiKeyEnv } : {}),
        supportsTools: true,
        userModels: [{
          id: model.nativeModel,
          kind: "chat",
          supportsTools: "parallel",
          ...(model.chatParams ? { params: model.chatParams } : {}),
          ...(model.contextSize ? { contextWindow: model.contextSize } : {}),
        }],
      });
      if (this.hooks.runtime.providerRegistry.listIds().includes(WORKER_PROVIDER)) {
        await this.hooks.runtime.reloadLlmProvider(WORKER_PROVIDER);
      } else {
        await this.hooks.runtime.reloadLlmProviders();
      }
      await this.hooks.runMode.setMode("fusion", { fusion: {
        orchestratorProvider: "local-llama", workerProvider: WORKER_PROVIDER,
        workers: 1, cloudWorkers: 1,
      } });
      this.hooks.refreshProviders();
      this.status(`Fusion enabled · worker ${model.name} on ${gateway.name}.`);
    });
  }

  async toggleFusion(): Promise<void> {
    if (this.rejectBusySwitch()) return;
    const config = resolveLlmConfig(getConfig());
    if (resolveRunMode(config).effective === "fusion") {
      await this.hooks.runMode.setMode("local");
      const worker = config.providers.find((provider) => provider.id === WORKER_PROVIDER);
      const target = worker?.baseUrl ? findGatewayTarget(worker.baseUrl, getConfig().localModels.gateways) : null;
      if (target) await this.stop(target.gateway.id, target.modelId);
      this.status("Solo mode · only the main model will run.");
      return;
    }
    const worker = config.providers.find((provider) => provider.id === WORKER_PROVIDER);
    const target = worker?.baseUrl ? findGatewayTarget(worker.baseUrl, getConfig().localModels.gateways) : null;
    if (!target) { this.status("Select a model and press w to choose a worker."); return; }
    await this.useWorker(target.gateway.id, target.modelId);
  }

  async stop(hostId: string, modelId: string): Promise<void> {
    this.hooks.runtime.gatewayTasks.cancelModel(hostId, modelId);
    await this.perform(async (signal) => {
      const { gateway, client } = await this.lookup(hostId, modelId, signal);
      this.status(`Stopping ${modelId} on ${gateway.name}…`);
      await client.stop(modelId, signal);
      this.status(`${modelId} stopped on ${gateway.name}.`);
    });
  }

  async stopAll(): Promise<void> {
    this.hooks.runtime.gatewayTasks.cancelAll();
    this.hooks.abortTasks();
    await this.perform(async (signal) => {
      this.status("Stopping models on all hosts…");
      const results = await Promise.allSettled(getConfig().localModels.gateways.map(
        (gateway) => new ModelGatewayClient(gateway).stopAll(signal),
      ));
      const failures = results.flatMap((result) => result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
      if (failures.length) throw new Error(`Stop all incomplete: ${failures.join("; ")}`);
      this.status("All model processes stopped. The gateways remain available.");
    });
  }

  private rejectBusySwitch(): boolean {
    if (!this.hooks.isBusy()) return false;
    this.status("Stop the running task before changing its model or worker.");
    return true;
  }

  private async lookup(hostId: string, modelId: string, signal: AbortSignal): Promise<{
    gateway: ModelGatewayDefinition; model: GatewayModel; client: ModelGatewayClient;
  }> {
    const gateway = getConfig().localModels.gateways.find((host) => host.id === hostId);
    if (!gateway) throw new Error(`Unknown gateway: ${hostId}`);
    const client = new ModelGatewayClient(gateway);
    const model = (await client.list(signal)).find((row) => row.id === modelId);
    if (!model) throw new Error(`${gateway.name}: model ${modelId} is not installed`);
    return { gateway, model, client };
  }

  private async perform(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    try {
      await this.operations.run(async (signal) => {
        this.bus.emit({ type: "llm_gateways_busy", busy: true });
        try { await action(signal); }
        finally {
          this.bus.emit({ type: "llm_gateways_busy", busy: false });
          await this.refresh();
        }
      }, undefined);
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    }
  }

  private status(message: string): void {
    if (this.closed) return;
    this.bus.emit({ type: "llm_gateways_status", message });
    this.bus.emit({ type: "runtime_info", line: `models: ${message}` });
  }
}
