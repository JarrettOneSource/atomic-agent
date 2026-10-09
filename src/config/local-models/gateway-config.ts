import type { ModelGatewayDefinition } from "../../local-llm/gateways/model-gateway-types.js";
import { ConfigValidationError } from "../config-validation-error.js";

export function parseModelGateways(raw: unknown): ModelGatewayDefinition[] {
  if (raw === undefined || raw === null) return [];
  const field = "localModels.gateways";
  if (!Array.isArray(raw)) throw new ConfigValidationError(field, "expected a list of hosts");
  const ids = new Set<string>();
  return raw.map((value: unknown, index) => {
    const key = `${field}[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ConfigValidationError(key, "expected a host definition");
    }
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(row.id) || ids.has(row.id)) {
      throw new ConfigValidationError(`${key}.id`, "expected a unique lowercase host id");
    }
    ids.add(row.id);
    if (typeof row.name !== "string" || !row.name.trim()) {
      throw new ConfigValidationError(`${key}.name`, "expected a host name");
    }
    let url: URL;
    try {
      if (typeof row.url !== "string") throw new Error("missing URL");
      url = new URL(row.url);
    } catch {
      throw new ConfigValidationError(`${key}.url`, "expected an HTTP or HTTPS URL");
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ConfigValidationError(`${key}.url`, "use HTTP(S) without credentials, query or fragment");
    }
    if (row.apiKeyEnv !== undefined && row.apiKeyEnv !== null &&
        (typeof row.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.apiKeyEnv))) {
      throw new ConfigValidationError(`${key}.apiKeyEnv`, "expected a credential environment variable name");
    }
    return {
      id: row.id,
      name: row.name.trim(),
      url: url.toString().replace(/\/+$/, ""),
      apiKeyEnv: typeof row.apiKeyEnv === "string" ? row.apiKeyEnv : null,
    };
  });
}
