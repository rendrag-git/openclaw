import { describe, expect, it } from "vitest";
import { assertConfigSetPathAllowed, isConfigSetPathAllowed } from "./config-set-policy.js";

describe("isConfigSetPathAllowed", () => {
  it("allows ordinary config paths", () => {
    expect(
      isConfigSetPathAllowed(["tools", "experimental", "planTool"], { source: "cli" }),
    ).toEqual({ ok: true });
    expect(
      isConfigSetPathAllowed(["agents", "defaults", "experimental", "localModelLean"], {
        source: "experimental",
      }),
    ).toEqual({ ok: true });
  });

  it("blocks plugins.installs (managed by OpenClaw)", () => {
    const result = isConfigSetPathAllowed(["plugins", "installs", "telegram"], {
      source: "experimental",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("plugins.installs");
      expect(result.reason).toContain("experimental");
    }
  });

  it("blocks paths with reserved prototype keys", () => {
    const result = isConfigSetPathAllowed(["__proto__"], { source: "cli" });
    expect(result.ok).toBe(false);
  });

  it("assertConfigSetPathAllowed throws on blocked paths", () => {
    expect(() =>
      assertConfigSetPathAllowed(["plugins", "installs", "x"], { source: "rpc" }),
    ).toThrow(/plugins\.installs/);
  });

  it("assertConfigSetPathAllowed is silent on allowed paths", () => {
    expect(() =>
      assertConfigSetPathAllowed(["tools", "experimental", "planTool"], { source: "cli" }),
    ).not.toThrow();
  });
});
