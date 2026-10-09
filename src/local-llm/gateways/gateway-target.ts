import type { ModelGatewayDefinition } from "./model-gateway-types.js";

/** Recognize only configured gateway routes; arbitrary external servers stay external. */
export function findGatewayTarget(url: string, gateways: readonly ModelGatewayDefinition[]) {
  for (const gateway of gateways) {
    const prefix = `${gateway.url.replace(/\/+$/, "")}/upstream/`;
    if (!url.startsWith(prefix)) continue;
    const suffix = url.slice(prefix.length).replace(/\/+$/, "");
    if (!suffix || suffix.includes("/") || suffix.includes("?") || suffix.includes("#")) continue;
    try {
      return { gateway, modelId: decodeURIComponent(suffix) };
    } catch {
      return null;
    }
  }
  return null;
}
