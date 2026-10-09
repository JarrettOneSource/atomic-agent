import { ModelGatewayClient } from "./model-gateway-client.js";
import { findGatewayTarget } from "./gateway-target.js";
import type { ModelGatewayDefinition } from "./model-gateway-types.js";

export interface GatewayTaskLease {
  signal: AbortSignal;
  release(): void;
}

interface GatewayTarget {
  gateway: ModelGatewayDefinition;
  modelId: string;
}

interface GatewayTask extends GatewayTaskLease {
  controller: AbortController;
  targets: readonly GatewayTarget[];
}

export interface GatewayTaskManagerOptions {
  gateways(): readonly ModelGatewayDefinition[];
  onLoading?(host: string, model: string): void;
  onUnavailable?(message: string): void;
}

/** Task leases belong to the runtime, so chat, API, CLI and scheduled turns agree. */
export class GatewayTaskManager {
  private readonly tasks = new Set<GatewayTask>();
  private closed = false;

  constructor(private readonly options: GatewayTaskManagerOptions) {}

  get activeCount(): number { return this.tasks.size; }

  async prepare(urls: readonly string[], parentSignal?: AbortSignal): Promise<GatewayTaskLease> {
    if (this.closed) throw new Error("Gateway task manager is closed");
    parentSignal?.throwIfAborted();
    const found = urls.flatMap((url) => {
      const target = findGatewayTarget(url, this.options.gateways());
      return target ? [target] : [];
    });
    const targets = [...new Map(found.map((target) =>
      [`${target.gateway.id}/${target.modelId}`, target],
    )).values()];
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    if (!targets.length) return { signal, release: () => {} };

    let timer: NodeJS.Timeout | null = null;
    const task: GatewayTask = {
      controller, signal, targets,
      release: () => {
        if (timer) clearInterval(timer);
        timer = null;
        controller.abort();
        this.tasks.delete(task);
      },
    };
    this.tasks.add(task);
    try {
      const policies = await Promise.all(targets.map(async (target) => {
        const client = new ModelGatewayClient(target.gateway);
        let model = (await client.list(signal)).find((row) => row.id === target.modelId);
        if (!model) throw new Error(`${target.gateway.name}: selected model is not installed`);
        if (model.state !== "ready") {
          this.options.onLoading?.(target.gateway.name, model.name);
          await client.start(target.modelId, signal);
          model = (await client.list(signal)).find((row) => row.id === target.modelId);
        }
        return model?.ttlSeconds;
      }));
      signal.throwIfAborted();
      const positivePolicies = policies.filter((value): value is number => typeof value === "number" && value > 0);
      const interval = Math.max(100, Math.min(60_000, ...positivePolicies.map((seconds) => seconds * 1000 / 3)));
      let refreshing = false;
      let lastError: string | null = null;
      timer = setInterval(() => {
        if (refreshing || signal.aborted) return;
        refreshing = true;
        void Promise.all(targets.map((target) =>
          new ModelGatewayClient(target.gateway).keepAlive(target.modelId, signal),
        )).then(() => { lastError = null; }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!signal.aborted && message !== lastError) {
            lastError = message;
            this.options.onUnavailable?.(message);
          }
        }).finally(() => { refreshing = false; });
      }, interval);
      timer.unref();
      return task;
    } catch (error) {
      task.release();
      throw error;
    }
  }

  cancelModel(hostId: string, modelId: string): void {
    for (const task of this.tasks) {
      if (task.targets.some((target) => target.gateway.id === hostId && target.modelId === modelId)) {
        task.controller.abort(new Error("Model stopped by operator"));
      }
    }
  }

  cancelAll(): void {
    for (const task of this.tasks) task.controller.abort(new Error("Models stopped by operator"));
  }

  close(): void {
    this.closed = true;
    for (const task of this.tasks) task.release();
  }
}
