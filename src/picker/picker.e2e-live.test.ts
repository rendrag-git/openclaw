/**
 * Live end-to-end integration test for the picker rewrite, gated on
 * `OPENCLAW_LIVE_TEST=1` so it does not run in normal unit lanes.
 *
 * Exercises the real picker chain — `ProviderModels` + `Picker` +
 * `ModelSwitch` + runtime glue — against the actual vLLM endpoint at
 * `http://10.68.198.1:31080/v1`. This is what the dev gateway in
 * `scripts/dev-gateway/` boots; the test asserts the modules work
 * end-to-end without needing Discord (or any channel).
 *
 * Run via:
 *
 *   OPENCLAW_LIVE_TEST=1 node scripts/run-vitest.mjs \\
 *     src/picker/picker.e2e-live.test.ts
 *
 * Or inside the dev gateway container (which has the worktree mounted).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderCatalogContext, ProviderPlugin } from "../plugins/types.js";
import { createPickerRuntime } from "./runtime.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";

const VLLM_BASE_URL = process.env.PICKER_E2E_VLLM_BASE_URL ?? "http://10.68.198.1:31080/v1";
const VLLM_API_KEY = process.env.PICKER_E2E_VLLM_API_KEY ?? "vllm-local";

const runIf = LIVE ? describe : describe.skip;

runIf("picker rewrite — live e2e against vllm endpoint", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(path.join(os.tmpdir(), "picker-e2e-"));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  function makeContext(): ProviderCatalogContext {
    return {
      config: {
        models: {
          providers: {
            vllm: {
              baseUrl: VLLM_BASE_URL,
              apiKey: VLLM_API_KEY,
              api: "openai-completions",
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            models: { "vllm/*": {} },
          },
        },
      } as unknown as OpenClawConfig,
      env: process.env,
      resolveProviderApiKey: () => ({
        apiKey: VLLM_API_KEY,
        discoveryApiKey: VLLM_API_KEY,
      }),
      resolveProviderAuth: () => ({
        apiKey: VLLM_API_KEY,
        discoveryApiKey: VLLM_API_KEY,
        mode: "api_key" as const,
        source: "env" as const,
      }),
    };
  }

  async function loadVllmPlugin(): Promise<ProviderPlugin> {
    // Import the real bundled vllm plugin so we hit its actual catalog.runOne
    // hook end-to-end, including the SDK's discoverOpenAICompatibleSelfHostedProvider.
    const mod = (await import("../../extensions/vllm/index.js")) as {
      default: {
        register: (api: { registerProvider: (p: ProviderPlugin) => void }) => void;
      };
    };
    let captured: ProviderPlugin | undefined;
    const api = {
      registerProvider: (provider: ProviderPlugin) => {
        captured = provider;
      },
    };
    mod.default.register(api);
    if (!captured) {
      throw new Error("vllm plugin did not register a provider");
    }
    return captured;
  }

  it("ProviderModels resolves real vllm models from the live endpoint", async () => {
    const plugin = await loadVllmPlugin();
    const runtime = createPickerRuntime({
      getRuntimeConfig: () =>
        ({
          models: {
            providers: {
              vllm: {
                baseUrl: VLLM_BASE_URL,
                apiKey: VLLM_API_KEY,
                api: "openai-completions",
                models: [],
              },
            },
          },
          agents: { defaults: { models: { "vllm/*": {} } } },
        }) as unknown as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: (id) => (id === "vllm" ? plugin : undefined),
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    // First call: no persisted snapshot → missing + kicks off background refresh.
    const first = await runtime.providerModels.getProviderModels("vllm", {
      agentId: "main",
    });
    expect(first.freshness).toBe("missing");

    // Let the refresh + writePersisted settle (real HTTP + file I/O).
    await new Promise((r) => setTimeout(r, 500));

    // models.json now persists with the live-discovered models.
    const raw = await readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      providers: {
        vllm?: {
          baseUrl?: string;
          api?: string;
          models: { id: string }[];
          __pickerFetchedAt?: number;
        };
      };
    };
    expect(parsed.providers.vllm?.baseUrl).toBe(VLLM_BASE_URL);
    expect(parsed.providers.vllm?.api).toBe("openai-completions");
    expect(typeof parsed.providers.vllm?.__pickerFetchedAt).toBe("number");
    expect(parsed.providers.vllm?.models?.length).toBeGreaterThanOrEqual(2);

    // SECRET LEAK GUARD: the picker writer never persists apiKey.
    expect(raw).not.toContain(VLLM_API_KEY);

    // Subsequent call serves from memory as fresh.
    const second = await runtime.providerModels.getProviderModels("vllm", {
      agentId: "main",
    });
    expect(second.freshness).toBe("fresh");
    expect(second.models.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("Picker.dispatch(selectProvider) hydrates with live models", async () => {
    const plugin = await loadVllmPlugin();
    const runtime = createPickerRuntime({
      getRuntimeConfig: () =>
        ({
          models: {
            providers: {
              vllm: {
                baseUrl: VLLM_BASE_URL,
                apiKey: VLLM_API_KEY,
                api: "openai-completions",
                models: [],
              },
            },
          },
          agents: { defaults: { models: { "vllm/*": {} } } },
        }) as unknown as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: (id) => (id === "vllm" ? plugin : undefined),
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    const picker = runtime.pickers.openPicker({
      channel: "e2e",
      accountId: "default",
      userId: "test-user",
      interactionRoot: "test-interaction",
    });

    // First selectProvider: catalog is missing, refresh fires in background.
    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });
    await new Promise((r) => setTimeout(r, 500));

    // refreshCatalog forces a re-hydrate from the now-persisted snapshot.
    await picker.dispatch({ kind: "refreshCatalog", providerId: "vllm" });
    const snapshot = picker.snapshot();
    expect(snapshot.catalog.get("vllm")?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(snapshot.selection.provider).toBe("vllm");
  }, 30_000);

  it("ModelSwitch.applySelection records override and reports harnesses", async () => {
    let captured:
      | {
          sessionKey: { interactionRoot: string };
          toRef: { provider: string; model: string };
          runtime?: string;
        }
      | undefined;
    const plugin = await loadVllmPlugin();
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: (id) => (id === "vllm" ? plugin : undefined),
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async (params) => {
        captured = params;
      },
      resolveRuntime: (ref) => (ref.provider === "openai" ? "codex" : "pi"),
    });

    const result = await runtime.modelSwitch.applySelection({
      sessionKey: {
        channel: "e2e",
        accountId: "default",
        userId: "test-user",
        interactionRoot: "test-interaction",
      },
      fromRef: { provider: "openai", model: "gpt-5.5" },
      toRef: { provider: "vllm", model: "qwen3-vl-embedding-2b" },
    });

    expect(result.result).toBe("applied");
    expect(result.harnessesAffected).toEqual(["pi", "codex"]);
    expect(captured?.toRef).toEqual({
      provider: "vllm",
      model: "qwen3-vl-embedding-2b",
    });
    expect(captured?.runtime).toBe("pi");
  });
});
