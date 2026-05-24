import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPlugin,
} from "../plugins/types.js";
import { createPickerRuntime } from "./runtime.js";

/**
 * Test fixture builder for `ProviderCatalogResult`. The picker code paths
 * only require the shape they actually read (id, name, plus optional fields
 * carried forward verbatim). The full `ModelDefinitionConfig` shape adds
 * required runtime fields that are irrelevant here — building it inline
 * forces verbose noise that doesn't help readers, so the cast is contained
 * to this one helper.
 */
function discoveryProvider(params: {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models: Array<Record<string, unknown>>;
}): ProviderCatalogResult {
  return {
    provider: {
      baseUrl: params.baseUrl ?? "http://test.local/v1",
      api: (params.api ?? "openai-completions") as "openai-completions",
      ...(params.apiKey ? { apiKey: params.apiKey } : {}),
      ...(params.headers ? { headers: params.headers } : {}),
      models: params.models,
    } as unknown as NonNullable<Extract<ProviderCatalogResult, { provider: unknown }>>["provider"],
  };
}

function makeContext(): ProviderCatalogContext {
  return {
    config: {} as OpenClawConfig,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    resolveProviderAuth: () => ({
      apiKey: "test-key",
      mode: "api_key",
      source: "env",
    }),
  };
}

function makeVllmPlugin(
  runOne: () => Promise<ProviderCatalogResult>,
): ProviderPlugin {
  return {
    id: "vllm",
    register: () => undefined,
    catalog: {
      order: "late",
      run: runOne,
      runOne,
    },
  } as unknown as ProviderPlugin;
}

describe("createPickerRuntime", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(path.join(os.tmpdir(), "picker-runtime-test-"));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it("fetches from the plugin's runOne and persists to models.json on first call", async () => {
    const runOne = vi.fn(async () =>
      discoveryProvider({
        baseUrl: "http://10.68.198.1:31080/v1",
        models: [
          { id: "qwen3-5-122b-a10b-nvfp4", name: "qwen3-5-122b-a10b-nvfp4" },
          { id: "qwen3-vl-embedding-2b", name: "qwen3-vl-embedding-2b" },
        ],
      }),
    );
    const plugin = makeVllmPlugin(runOne);
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: (id) => (id === "vllm" ? plugin : undefined),
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    const first = await runtime.providerModels.getProviderModels("vllm", {
      agentId: "main",
    });

    // No persisted state → returns "missing" immediately; refresh fires in background.
    expect(first.freshness).toBe("missing");

    // Allow the in-flight refresh to settle. The refresh defers its
    // runOne call past the current task and then awaits writePersisted,
    // so we need a comfortable wait here.
    await new Promise((r) => setTimeout(r, 25));
    expect(runOne).toHaveBeenCalledOnce();

    // Persisted file should now exist.
    const raw = await readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      providers: { vllm?: { models: { id: string }[]; __pickerFetchedAt?: number } };
    };
    expect(parsed.providers.vllm?.models.map((m) => m.id)).toEqual([
      "qwen3-5-122b-a10b-nvfp4",
      "qwen3-vl-embedding-2b",
    ]);
    expect(typeof parsed.providers.vllm?.__pickerFetchedAt).toBe("number");

    // Subsequent call serves from cache as fresh.
    const second = await runtime.providerModels.getProviderModels("vllm", {
      agentId: "main",
    });
    expect(second.freshness).toBe("fresh");
    expect(second.models).toHaveLength(2);
    // Still only one runOne call — coalesced via in-memory cache.
    expect(runOne).toHaveBeenCalledOnce();
  });

  it("returns missing when the plugin is not registered", async () => {
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: () => undefined,
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });
    const result = await runtime.providerModels.getProviderModels("unknown", {
      agentId: "main",
    });
    expect(result.freshness).toBe("missing");
  });

  it("returns missing and surfaces classified error on transient endpoint failure", async () => {
    const onError = vi.fn();
    const runOne = vi.fn(async (): Promise<ProviderCatalogResult> => {
      throw new Error("fetch failed: ECONNREFUSED 10.68.198.1:31080");
      // eslint-disable-next-line no-unreachable
      return discoveryProvider({ models: [] });
    });
    const plugin = makeVllmPlugin(runOne);
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: () => plugin,
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
      onError,
    });

    const result = await runtime.providerModels.getProviderModels("vllm", {
      agentId: "main",
    });
    expect(result.freshness).toBe("missing");
    await new Promise((r) => setTimeout(r, 30));
    // Classified errors do NOT propagate to onError (they're expected
    // transient conditions; the resolver preserves stale on retry).
    expect(onError).not.toHaveBeenCalled();
  });

  it("wires modelSwitch through to the persistOverride dep", async () => {
    const persistOverride = vi.fn(async () => undefined);
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: () => undefined,
      buildProviderCatalogContext: () => makeContext(),
      persistOverride,
    });

    const result = await runtime.modelSwitch.applySelection({
      sessionKey: {
        channel: "discord",
        accountId: "default",
        userId: "u1",
        interactionRoot: "i1",
      },
      fromRef: { provider: "openai", model: "gpt-5.5" },
      toRef: { provider: "vllm", model: "qwen3-vl" },
    });
    expect(result.result).toBe("applied");
    expect(persistOverride).toHaveBeenCalledOnce();
  });

  it("serializes concurrent provider writes through the shared models.json lock", async () => {
    // Regression: two providers refreshing simultaneously read the same
    // models.json, update their own slice, and overwrite. Last write
    // dropped the other refresh's models. Now goes through
    // withModelsJsonWriteLock so writes serialize per file. (Codex review P2.)
    function pluginForProvider(providerId: string, modelId: string): ProviderPlugin {
      const fn = async () => {
        // Yield enough that both refreshes are mid-flight before either writes.
        await new Promise((r) => setTimeout(r, 30));
        return discoveryProvider({
          baseUrl: `http://${providerId}.local/v1`,
          models: [{ id: modelId, name: modelId }],
        });
      };
      return {
        id: providerId,
        register: () => undefined,
        catalog: { order: "late", run: fn, runOne: fn },
      } as unknown as ProviderPlugin;
    }
    const plugins: Record<string, ProviderPlugin> = {
      vllm: pluginForProvider("vllm", "vllm-model"),
      ollama: pluginForProvider("ollama", "ollama-model"),
    };
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: (id) => plugins[id],
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    // Kick off concurrent refreshes for two different providers.
    await Promise.all([
      runtime.providerModels.getProviderModels("vllm", { agentId: "main" }),
      runtime.providerModels.getProviderModels("ollama", { agentId: "main" }),
    ]);

    // Drain both background refreshes (each adds a macrotask deferral +
    // its own ~30ms intentional delay + writePersisted file ops); the lock
    // guarantees neither slice is dropped, regardless of completion order.
    await new Promise((r) => setTimeout(r, 150));

    const raw = await readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      providers: {
        vllm?: { models: { id: string }[] };
        ollama?: { models: { id: string }[] };
      };
    };
    expect(parsed.providers.vllm?.models.map((m) => m.id)).toEqual(["vllm-model"]);
    expect(parsed.providers.ollama?.models.map((m) => m.id)).toEqual(["ollama-model"]);
  });

  it("tracks freshness per-provider so one provider's refresh does not fake-fresh another", async () => {
    // Regression: a single top-level __pickerWrittenAt meant any provider
    // write made all other slices look fresh on the next read, suppressing
    // intended stale-while-revalidate refreshes for other providers in
    // multi-provider wildcard configs. (Codex review P2.)
    function pluginForProvider(providerId: string, modelId: string): ProviderPlugin {
      const fn = async () =>
        discoveryProvider({
          baseUrl: `http://${providerId}.local/v1`,
          models: [{ id: modelId, name: modelId }],
        });
      return {
        id: providerId,
        register: () => undefined,
        catalog: { order: "late", run: fn, runOne: fn },
      } as unknown as ProviderPlugin;
    }
    const plugins: Record<string, ProviderPlugin> = {
      vllm: pluginForProvider("vllm", "qwen3-vl"),
      ollama: pluginForProvider("ollama", "llama-3"),
    };

    // Manually seed an old persisted slice for ollama, then refresh vllm
    // and verify ollama's freshness marker is preserved (not bumped).
    const oldOllamaTimestamp = 1000;
    const seeded = {
      providers: {
        ollama: {
          baseUrl: "http://ollama.local/v1",
          api: "openai-completions",
          models: [{ id: "llama-3", name: "llama-3" }],
          __pickerFetchedAt: oldOllamaTimestamp,
        },
      },
    };
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify(seeded, null, 2)),
    );

    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: (id) => plugins[id],
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    await runtime.providerModels.getProviderModels("vllm", { agentId: "main" });
    await new Promise((r) => setTimeout(r, 30));

    const raw = await readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      providers: {
        vllm?: { models: { id: string }[]; __pickerFetchedAt?: number };
        ollama?: { models: { id: string }[]; __pickerFetchedAt?: number };
      };
    };

    // vllm got a fresh timestamp post-refresh.
    expect(typeof parsed.providers.vllm?.__pickerFetchedAt).toBe("number");
    expect(parsed.providers.vllm?.__pickerFetchedAt).toBeGreaterThan(oldOllamaTimestamp);
    // ollama's old timestamp is preserved — it was not touched by vllm's refresh.
    expect(parsed.providers.ollama?.__pickerFetchedAt).toBe(oldOllamaTimestamp);
  });

  it("preserves arbitrary discovery fields (cost, maxTokens, agentRuntime, params) on writes", async () => {
    // Regression: the writer narrowed model entries to the ModelCatalogEntry
    // shape, dropping per-model runtime fields the discovery emitted. After
    // a picker refresh, downstream model-auth/runtime/cost surfaces saw
    // degraded data. (Codex review P2.)
    const runOne = vi.fn(async () =>
      discoveryProvider({
        models: [
          {
            id: "qwen3-vl",
            name: "qwen3-vl",
            maxTokens: 8192,
            cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0 },
            params: { temperature: 0.7 },
            agentRuntime: { id: "pi" },
          },
        ],
      }),
    );
    const plugin = makeVllmPlugin(runOne);
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: () => plugin,
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    await runtime.providerModels.getProviderModels("vllm", { agentId: "main" });
    await new Promise((r) => setTimeout(r, 30));

    const raw = await readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      providers: {
        vllm?: {
          models: {
            id: string;
            maxTokens?: number;
            cost?: { input: number };
            params?: { temperature: number };
            agentRuntime?: { id: string };
          }[];
        };
      };
    };
    const persisted = parsed.providers.vllm?.models[0];
    expect(persisted?.maxTokens).toBe(8192);
    expect(persisted?.cost?.input).toBe(0.5);
    expect(persisted?.params?.temperature).toBe(0.7);
    expect(persisted?.agentRuntime?.id).toBe("pi");
  });

  it("preserves model metadata (reasoning/input/contextTokens/compat) on writes", async () => {
    // Regression: the picker writer only persisted id/name/contextWindow;
    // reasoning/input/compat/contextTokens were dropped, silently degrading
    // model behavior for downstream runtime/auth paths. (Codex review P2.)
    const runOne = vi.fn(async () =>
      discoveryProvider({
        models: [
          {
            id: "qwen3-vl",
            name: "qwen3-vl",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 128000,
            contextTokens: 96000,
            // compat is plugin-shaped opaque metadata; the picker only
            // carries it through to persistence.
            compat: { copilot: { reasoning: { effort: "medium" } } },
          },
        ],
      }),
    );
    const plugin = makeVllmPlugin(runOne);
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: () => plugin,
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    await runtime.providerModels.getProviderModels("vllm", { agentId: "main" });
    await new Promise((r) => setTimeout(r, 30));

    const raw = await readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      providers: {
        vllm?: {
          models: {
            id: string;
            reasoning?: boolean;
            input?: string[];
            contextWindow?: number;
            contextTokens?: number;
            compat?: unknown;
          }[];
        };
      };
    };
    const persisted = parsed.providers.vllm?.models[0];
    expect(persisted?.reasoning).toBe(true);
    expect(persisted?.input).toEqual(["text", "image"]);
    expect(persisted?.contextWindow).toBe(128000);
    expect(persisted?.contextTokens).toBe(96000);
    expect(persisted?.compat).toEqual({ copilot: { reasoning: { effort: "medium" } } });
  });

  it("creates the agent dir on first-time write when it does not exist yet", async () => {
    // Regression: writeFile threw ENOENT when discovery for a fresh agent
    // raced ahead of the canonical writer that normally creates the dir.
    // (Codex review P2.)
    const fs = await import("node:fs/promises");
    const freshAgentDir = path.join(agentDir, "agents", "freshly-spawned", "agent");
    // Confirm the dir does NOT exist yet.
    await expect(fs.stat(freshAgentDir)).rejects.toThrow();

    const runOne = vi.fn(async () =>
      discoveryProvider({ models: [{ id: "qwen3-vl", name: "qwen3-vl" }] }),
    );
    const plugin = makeVllmPlugin(runOne);
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => freshAgentDir,
      getProviderPlugin: () => plugin,
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    await runtime.providerModels.getProviderModels("vllm", { agentId: "fresh" });
    await new Promise((r) => setTimeout(r, 30));

    const raw = await readFile(path.join(freshAgentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      providers: { vllm?: { models: { id: string }[] } };
    };
    expect(parsed.providers.vllm?.models[0]?.id).toBe("qwen3-vl");
  });

  it("persists baseUrl/api on first-time slice writes but never persists secrets", async () => {
    // First-time slice writes carry forward the discovered baseUrl/api so
    // downstream model-runtime resolution still works.
    //
    // Regression: extras formerly included the discovered plaintext apiKey
    // and headers, which would bypass SecretRef/marker handling and trip
    // the secret-scanning audit's PLAINTEXT_FOUND check. The picker is
    // never authorized to write credentials — only the canonical writer
    // (`ensureOpenClawModelsJson`) is. (Codex review P1.)
    const runOne = vi.fn(async () =>
      discoveryProvider({
        baseUrl: "http://10.68.198.1:31080/v1",
        apiKey: "vllm-secret",
        headers: { "x-custom": "secret-token" },
        models: [{ id: "qwen3-vl", name: "qwen3-vl" }],
      }),
    );
    const plugin = makeVllmPlugin(runOne);
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: () => plugin,
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    await runtime.providerModels.getProviderModels("vllm", { agentId: "main" });
    await new Promise((r) => setTimeout(r, 30));

    const raw = await readFile(path.join(agentDir, "models.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      providers: {
        vllm?: {
          baseUrl?: string;
          api?: string;
          apiKey?: unknown;
          headers?: unknown;
          models: { id: string }[];
        };
      };
    };

    expect(parsed.providers.vllm?.baseUrl).toBe("http://10.68.198.1:31080/v1");
    expect(parsed.providers.vllm?.api).toBe("openai-completions");
    // Secrets are NOT persisted by the picker. The canonical writer owns
    // apiKey/SecretRef writes.
    expect(parsed.providers.vllm?.apiKey).toBeUndefined();
    expect(parsed.providers.vllm?.headers).toBeUndefined();
    expect(raw).not.toContain("vllm-secret");
    expect(raw).not.toContain("secret-token");
  });

  it("preserves an explicit empty catalog across restarts (does not re-probe)", async () => {
    // Regression: after a successful discovery returns [], writePersisted
    // records models: [] + __pickerFetchedAt. The read path used to treat
    // that as missing and re-probe on every picker open — contradicting
    // the null-vs-empty contract. (Codex review P3.)
    const fs = await import("node:fs/promises");
    const seeded = {
      providers: {
        vllm: {
          baseUrl: "http://vllm.local/v1",
          api: "openai-completions",
          models: [],
          __pickerFetchedAt: Date.now(),
        },
      },
    };
    await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify(seeded, null, 2));

    const runOne = vi.fn(async () =>
      discoveryProvider({ models: [{ id: "should-not-appear", name: "should-not-appear" }] }),
    );
    const plugin = makeVllmPlugin(runOne);
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: () => plugin,
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    const result = await runtime.providerModels.getProviderModels("vllm", { agentId: "main" });
    // The persisted empty catalog is fresh — no refresh kicks off.
    expect(result.freshness).toBe("fresh");
    expect(result.models).toEqual([]);

    await new Promise((r) => setTimeout(r, 30));
    expect(runOne).not.toHaveBeenCalled();
  });

  it("hydrates a picker session via the runtime", async () => {
    const runOne = vi.fn(async () =>
      discoveryProvider({
        baseUrl: "http://10.68.198.1:31080/v1",
        models: [{ id: "qwen3-vl", name: "qwen3-vl" }],
      }),
    );
    const plugin = makeVllmPlugin(runOne);
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => ({}) as OpenClawConfig,
      getAgentDir: () => agentDir,
      getProviderPlugin: () => plugin,
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
    });

    const picker = runtime.pickers.openPicker({
      channel: "discord",
      accountId: "default",
      userId: "u1",
      interactionRoot: "i1",
    });
    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });
    // First dispatch sees "missing" — catalog merges empty array.
    // Second dispatch (after refresh settles) sees populated catalog.
    await new Promise((r) => setTimeout(r, 30));
    await picker.dispatch({ kind: "refreshCatalog", providerId: "vllm" });

    expect(picker.snapshot().catalog.get("vllm")?.map((m) => m.id)).toEqual([
      "qwen3-vl",
    ]);
  });
});
