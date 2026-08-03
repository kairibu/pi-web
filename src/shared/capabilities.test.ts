import { describe, expect, it } from "vitest";
import { effectivePiWebCapabilities, isPiWebCapability, PI_WEB_CAPABILITIES, SESSIOND_RUNTIME_CAPABILITIES, WEB_RUNTIME_CAPABILITIES, parseKnownPiWebCapabilities } from "./capabilities";

describe("PI WEB capabilities", () => {
  it("advertises no capabilities while the registry has no entries", () => {
    expect(PI_WEB_CAPABILITIES).toEqual({});
    expect(WEB_RUNTIME_CAPABILITIES).toEqual([]);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toEqual([]);

    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [] },
    })).toEqual([]);
  });

  it("drops every current capability string when parsing runtime data", () => {
    expect(parseKnownPiWebCapabilities(["piPackages.manage", "future.capability"])).toEqual([]);
    expect(parseKnownPiWebCapabilities(["future.capability", 1])).toBeUndefined();
    expect(isPiWebCapability("piPackages.manage")).toBe(false);
    expect(isPiWebCapability("future.capability")).toBe(false);
  });
});
