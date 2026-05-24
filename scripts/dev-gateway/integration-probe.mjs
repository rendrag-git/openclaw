#!/usr/bin/env node
/**
 * Picker-rewrite integration probe — runs the real `ProviderModels` +
 * `Picker` + `ModelSwitch` chain end-to-end against the live vLLM
 * endpoint that the dev gateway is configured for.
 *
 * Plain node (not vitest) so the `VITEST=true` test-environment guard
 * inside `discoverOpenAICompatibleLocalModels` doesn't short-circuit the
 * HTTP call.
 *
 * Asserts:
 *   - ProviderModels first call returns `missing` immediately
 *   - background refresh persists real vllm models to models.json
 *   - secrets (apiKey) NEVER appear in the persisted file
 *   - subsequent calls serve cached as `fresh`
 *   - Picker.dispatch(selectProvider) hydrates from the cache
 *   - ModelSwitch.applySelection records the resolved runtime
 *
 * Run inside the dev gateway container:
 *
 *   docker exec openclaw-picker-dev node /app/scripts/dev-gateway/integration-probe.mjs
 *
 * Or against the host worktree directly (requires reachable vllm endpoint):
 *
 *   node scripts/dev-gateway/integration-probe.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VLLM_BASE_URL = process.env.PICKER_E2E_VLLM_BASE_URL ?? "http://10.68.198.1:31080/v1";
const VLLM_API_KEY = process.env.PICKER_E2E_VLLM_API_KEY ?? "vllm-local";

// The picker is bundled into hashed dist chunks (rollup), not separate
// files. Import the .ts source files directly via Node 22's type stripping
// (--experimental-strip-types — defaults on for `.ts` since 22.6 / 23).
const { createPickerRuntime } = await import("../../src/picker/runtime.ts");
const { createModelSwitch } = await import("../../src/picker/model-switch.ts");

const vllmPluginEntry = await import("../../extensions/vllm/index.ts");

function makeContext() {
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
      agents: { defaults: { models: { "vllm/*": {} } } },
    },
    env: { ...process.env, VITEST: undefined, NODE_ENV: "development" },
    resolveProviderApiKey: () => ({
      apiKey: VLLM_API_KEY,
      discoveryApiKey: VLLM_API_KEY,
    }),
    resolveProviderAuth: () => ({
      apiKey: VLLM_API_KEY,
      discoveryApiKey: VLLM_API_KEY,
      mode: "api_key",
      source: "env",
    }),
  };
}

async function loadVllmPlugin() {
  let captured;
  vllmPluginEntry.default.register({
    registerProvider: (p) => {
      captured = p;
    },
  });
  if (!captured) throw new Error("vllm plugin did not register");
  return captured;
}

async function main() {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "picker-probe-"));
  let failed = 0;
  let passed = 0;
  const log = (status, label, extra) => {
    const symbol = status === "OK" ? "✓" : "✗";
    const out = extra ? `${label} — ${extra}` : label;
    console.log(`${symbol} [${status}] ${out}`);
  };
  const check = async (label, fn) => {
    try {
      await fn();
      log("OK", label);
      passed += 1;
    } catch (err) {
      log("FAIL", label, err?.message ?? String(err));
      failed += 1;
    }
  };

  try {
    const plugin = await loadVllmPlugin();
    const runtime = createPickerRuntime({
      getRuntimeConfig: () => makeContext().config,
      getAgentDir: () => agentDir,
      getProviderPlugin: (id) => (id === "vllm" ? plugin : undefined),
      buildProviderCatalogContext: () => makeContext(),
      persistOverride: async () => undefined,
      resolveRuntime: (ref) => (ref.provider === "openai" ? "codex" : "pi"),
    });

    await check("First call returns missing without persisted snapshot", async () => {
      const first = await runtime.providerModels.getProviderModels("vllm", {
        agentId: "main",
      });
      assert.equal(first.freshness, "missing");
    });

    // Let background refresh + writePersisted settle.
    await new Promise((r) => setTimeout(r, 1500));

    let raw;
    await check("Background refresh persists vllm slice", async () => {
      raw = await readFile(path.join(agentDir, "models.json"), "utf8");
      const parsed = JSON.parse(raw);
      assert.equal(parsed.providers?.vllm?.baseUrl, VLLM_BASE_URL);
      assert.equal(parsed.providers?.vllm?.api, "openai-completions");
      assert.equal(typeof parsed.providers?.vllm?.__pickerFetchedAt, "number");
      assert.ok(
        Array.isArray(parsed.providers?.vllm?.models) &&
          parsed.providers.vllm.models.length >= 1,
        `expected at least 1 model, got ${parsed.providers?.vllm?.models?.length ?? "(none)"}`,
      );
    });

    await check("Persisted file does NOT contain plaintext apiKey", async () => {
      assert.ok(
        !raw.includes(VLLM_API_KEY),
        `apiKey '${VLLM_API_KEY}' leaked into models.json`,
      );
    });

    await check("Subsequent call serves fresh from memory cache", async () => {
      const second = await runtime.providerModels.getProviderModels("vllm", {
        agentId: "main",
      });
      assert.equal(second.freshness, "fresh");
      assert.ok(second.models.length >= 1);
    });

    await check("Picker.dispatch(selectProvider) hydrates session catalog", async () => {
      const picker = runtime.pickers.openPicker({
        channel: "probe",
        accountId: "default",
        userId: "probe-user",
        interactionRoot: "probe-interaction",
      });
      await picker.dispatch({ kind: "selectProvider", provider: "vllm" });
      const snap = picker.snapshot();
      assert.equal(snap.selection.provider, "vllm");
      assert.ok(
        (snap.catalog.get("vllm")?.length ?? 0) >= 1,
        `expected catalog to be hydrated, got ${snap.catalog.get("vllm")?.length ?? 0} entries`,
      );
    });

    await check("ModelSwitch.applySelection records resolved target runtime", async () => {
      let captured;
      const ms = createModelSwitch({
        persistOverride: async (p) => {
          captured = p;
        },
        resolveRuntime: (ref) => (ref.provider === "openai" ? "codex" : "pi"),
      });
      const result = await ms.applySelection({
        sessionKey: {
          channel: "probe",
          accountId: "default",
          userId: "probe-user",
          interactionRoot: "probe-interaction",
        },
        fromRef: { provider: "openai", model: "gpt-5.5" },
        toRef: { provider: "vllm", model: "qwen3-5-122b-a10b-nvfp4" },
      });
      assert.equal(result.result, "applied");
      assert.deepEqual(result.harnessesAffected, ["pi", "codex"]);
      assert.equal(captured?.runtime, "pi");
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(2);
});
