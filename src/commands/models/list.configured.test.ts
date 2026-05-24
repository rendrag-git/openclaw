import { describe, expect, it, vi } from "vitest";

const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  configFingerprint: "models-list-configured-test-empty-plugin-metadata",
  plugins: [],
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: vi.fn(() => {
    throw new Error("runtime model normalization should not load for models list entries");
  }),
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

import { resolveConfiguredEntries } from "./list.configured.js";

describe("resolveConfiguredEntries", () => {
  it("parses configured models without loading provider-runtime normalization", () => {
    const { entries } = resolveConfiguredEntries({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.5", fallbacks: ["codex/gpt-5.4-mini"] },
          models: {
            "codex/gpt-5.5": { alias: "Codex" },
            "codex/gpt-5.4-mini": {},
          },
        },
      },
      models: { providers: {} },
    });

    expect(entries.map((entry) => entry.key)).toEqual(["codex/gpt-5.5", "codex/gpt-5.4-mini"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
    expect(entries[0]?.aliases).toEqual(["Codex"]);
    expect(entries[1]?.tags).toEqual(new Set(["fallback#1", "configured"]));
  });

  it("normalizes retired nested Gemini ids in configured provider rows", () => {
    const { entries } = resolveConfiguredEntries({
      agents: {
        defaults: {
          model: { primary: "kilocode/google/gemini-3-pro-preview" },
          models: {
            "kilocode/google/gemini-3-pro-preview": { alias: "Kilo Gemini" },
          },
        },
      },
      models: {
        providers: {
          kilocode: {
            api: "openai-completions",
            baseUrl: "https://kilocode.test/v1",
            models: [
              {
                id: "google/gemini-3-pro-preview",
                name: "Gemini 3 Pro",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    });

    expect(entries.map((entry) => entry.key)).toEqual(["kilocode/google/gemini-3.1-pro-preview"]);
    expect(entries[0]?.aliases).toEqual(["Kilo Gemini"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
  });

  it("does NOT surface provider wildcards (e.g. vllm/*) as catalog rows", () => {
    // Regression: agents.defaults.models is a visibility policy, not a
    // catalog — wildcards like `vllm/*` were surfacing as `key: "vllm/*"`,
    // `name: "*"` rows alongside real models. The picker rewrite's
    // null-vs-empty contract treats wildcards as policy filters only.
    // Linear REN-685.
    const { entries } = resolveConfiguredEntries({
      agents: {
        defaults: {
          model: { primary: "vllm/qwen3-5-122b-a10b-nvfp4", fallbacks: [] },
          models: {
            "vllm/*": {},
            "openai/gpt-5.5": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "http://vllm.local/v1",
            apiKey: "vllm-local",
            api: "openai-completions",
            models: [
              {
                id: "qwen3-5-122b-a10b-nvfp4",
                name: "qwen3-5-122b-a10b-nvfp4",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });

    // The literal `vllm/*` row from the policy must NOT appear in the
    // CLI catalog listing — but the explicit `openai/gpt-5.5` policy
    // entry still surfaces (it's a concrete ref).
    expect(entries.map((entry) => entry.key)).not.toContain("vllm/*");
    expect(entries.find((entry) => entry.ref.model === "*")).toBeUndefined();
    expect(entries.some((entry) => entry.key === "vllm/qwen3-5-122b-a10b-nvfp4")).toBe(true);
    expect(entries.some((entry) => entry.key === "openai/gpt-5.5")).toBe(true);
  });
});
