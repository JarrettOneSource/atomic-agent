import { describe, expect, it } from "vitest";
import { parseUserConfigFile } from "../config-schema.js";

describe("remote gateway configuration", () => {
  it("keeps existing installs gateway-free until a host is configured", () => {
    expect(parseUserConfigFile({}).localModels.gateways).toEqual([]);
  });

  it("preserves host settings through the normal config parser", () => {
    const gateways = [{
      id: "m5", name: "M5 Pro", url: "http://127.0.0.1:18990", apiKeyEnv: "M5_GATEWAY_KEY",
    }];
    expect(parseUserConfigFile({ localModels: { gateways } }).localModels.gateways)
      .toEqual(gateways);
  });

  it.each([
    [{ id: "m5", name: "M5", url: "file:///tmp/models" }],
    [{ id: "m5", name: "M5", url: "http://user:secret@localhost:8990" }],
    [{ id: "m5", name: "M5", url: "http://localhost:8990?token=secret" }],
    [{ id: "../m5", name: "M5", url: "http://localhost:8990" }],
    [{ id: "m5", name: "M5", url: "http://localhost:8990", apiKeyEnv: "invalid key" }],
    [
      { id: "m5", name: "M5", url: "http://localhost:8990" },
      { id: "m5", name: "Other M5", url: "http://localhost:8991" },
    ],
  ])("rejects invalid or ambiguous gateway definitions", (...gateways) => {
    expect(() => parseUserConfigFile({ localModels: { gateways } })).toThrow();
  });
});
