import { expect, it } from "vitest";
import { gatewayWorkerProvider } from "./gateway-worker-provider.js";
import type { GatewayModel } from "./model-gateway-types.js";
const model: GatewayModel = { id: "qwen", name: "Qwen", description: "", kind: "llm", group: null, nativeModel: "Qwen", state: "stopped", contextSize: 262144, parallelSlots: 4, supportsVision: true, sizeBytes: null, workspacePath: null, ttlSeconds: 600 };
const host = { id: "m5", name: "M5", url: "http://127.0.0.1:8990", apiKeyEnv: null };
it("explicitly enables prompt caching for gateway workers while preserving model parameters", () => {
    expect(gatewayWorkerProvider(host, { ...model, chatParams: { temperature: .6 } }).userModels?.[0]?.params).toEqual({ cache_prompt: true, temperature: .6 });
    expect(gatewayWorkerProvider(host, { ...model, chatParams: { cache_prompt: false } }).userModels?.[0]?.params).toEqual({ cache_prompt: false });
});
