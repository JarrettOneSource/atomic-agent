import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import type { GatewayModel, ModelGatewayDefinition } from "./model-gateway-types.js";

export function gatewayWorkerProvider(gateway: ModelGatewayDefinition, model: GatewayModel): UserLlmProviderEntry {
  return {
    id: "gateway-worker", kind: "openai-compatible",
    baseUrl: `${gateway.url}/upstream/${encodeURIComponent(model.id)}`,
    defaultChatModel: model.nativeModel,
    ...(gateway.apiKeyEnv ? { apiKeyEnv: gateway.apiKeyEnv } : {}),
    supportsTools: true,
    userModels: [{
      id: model.nativeModel, kind: "chat", supportsTools: "parallel",
      params: { cache_prompt: true, ...model.chatParams },
      ...(model.contextSize ? { contextWindow: model.contextSize } : {}),
    }],
  };
}
