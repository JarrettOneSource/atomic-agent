import { ensureUserConfigFileSync, getConfig, parseUserConfigFile, resetConfigCache, writeUserConfigFileSync } from "../../config/index.js";
import { readLlmBlockOrDefault, upsertLlmProvider } from "../../config/llm-provider-commands.js";
import { findGatewayTarget } from "./gateway-target.js";
import { gatewayWorkerProvider } from "./gateway-worker-provider.js";
import type { GatewayModel, ModelGatewayDefinition } from "./model-gateway-types.js";

/** Persist the route together with its provider and Fusion seats. */
export function selectGatewayModel(gateway: ModelGatewayDefinition, model: GatewayModel, role: "main" | "worker"): void {
  if (role === "worker") upsertLlmProvider(gatewayWorkerProvider(gateway, model));
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  const url = `${gateway.url}/upstream/${encodeURIComponent(model.id)}`;
  if (role === "main") {
    file.localModels = { ...file.localModels, mode: "external", url };
    const old = llm.providers.find(provider => provider.id === "local-llama");
    llm.providers = [...llm.providers.filter(provider => provider.id !== "local-llama"), { ...old, id: "local-llama", kind: "llama-server", url, model: model.nativeModel }];
    const worker = llm.providers.find(provider => provider.id === llm.runMode?.fusion?.workerProvider);
    const workerHost = worker?.baseUrl ? findGatewayTarget(worker.baseUrl, file.localModels.gateways) : null;
    if (llm.runMode?.mode === "fusion" && workerHost?.gateway.id === gateway.id) llm.runMode = { ...llm.runMode, mode: "local" };
    else if (llm.runMode?.mode === "fusion") llm.runMode = { ...llm.runMode, fusion: { ...llm.runMode.fusion, orchestratorProvider: "local-llama" } };
  } else {
    llm.runMode = { mode: "fusion", fusion: { orchestratorProvider: "local-llama", workerProvider: "gateway-worker", workers: 1, cloudWorkers: 1 } };
  }
  llm.activeTextProvider = "local-llama";
  file.llm = llm;
  writeUserConfigFileSync(path, parseUserConfigFile(file));
  resetConfigCache();
}

export function selectGatewaySolo(): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  llm.activeTextProvider = "local-llama";
  llm.runMode = { ...llm.runMode, mode: "local" };
  file.llm = llm;
  writeUserConfigFileSync(path, parseUserConfigFile(file));
  resetConfigCache();
}
