import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOpenAgentAcpPluginConfig } from "./config.js";

describe("resolveOpenAgentAcpPluginConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers an explicit modulePath override", () => {
    const resolved = resolveOpenAgentAcpPluginConfig({
      rawConfig: {
        modulePath: "/tmp/custom-openagent.ts",
      },
      workspaceDir: "/tmp/workspace",
      stateDir: "/tmp/state",
    });

    expect(resolved.modulePath).toBe("/tmp/custom-openagent.ts");
  });

  it("falls back to the sibling openagent repo path when workspaceDir is unrelated", () => {
    const siblingRepoModulePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "openagent",
      "src",
      "acp-runtime.ts",
    );
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === siblingRepoModulePath;
    });

    const resolved = resolveOpenAgentAcpPluginConfig({
      rawConfig: {},
      workspaceDir: "/home/ubuntu",
      stateDir: "/tmp/state",
    });

    expect(resolved.modulePath).toBe(siblingRepoModulePath);
  });
});
