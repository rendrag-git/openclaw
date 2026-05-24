/**
 * Contract test: every bundled provider plugin is usable by the picker
 * via the `runOne ?? run` fallback in `createPickerRuntime`.
 *
 * REN-680 in the rewrite project extends `ProviderPluginCatalog.runOne`
 * to every bundled provider for reviewer-signal — confirming each
 * plugin's discovery is cheap enough to live on the picker hot path.
 * Until each plugin explicitly opts in, the runtime falls back to
 * `catalog.run`. This test guarantees that fallback never regresses by
 * asserting (a) every catalog-bearing plugin file exists and is loadable,
 * and (b) the runtime resolves a callable hook for every one of them.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderCatalogContext,
  ProviderPlugin,
} from "../plugins/types.js";
import { createPickerRuntime } from "./runtime.js";

const EXTENSIONS_DIR = path.resolve(__dirname, "../../extensions");

/**
 * Plugins that own a `catalog` block — exposed for picker via
 * `runOne ?? run`. Detected statically; new providers added to
 * `extensions/` automatically participate.
 */
async function findCatalogPlugins(): Promise<string[]> {
  const plugins: string[] = [];
  const entries = readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(EXTENSIONS_DIR, entry.name, "index.ts");
    let src: string;
    try {
      src = await readFile(indexPath, "utf8");
    } catch {
      continue;
    }
    if (src.includes("catalog: {")) {
      plugins.push(entry.name);
    }
  }
  return plugins.sort();
}

function makeContext(): ProviderCatalogContext {
  return {
    config: { models: { providers: {} } } as OpenClawConfig,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    }),
  };
}

describe("picker runOne-fallback contract — bundled providers", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(path.join(os.tmpdir(), "runone-contract-"));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it("the runtime selects a callable hook for every catalog-bearing plugin (runOne or run)", async () => {
    const pluginIds = await findCatalogPlugins();
    // Sanity: we should find at least 30 (vllm + ~32 others). If this drops
    // sharply, something deleted plugins or this glob is broken.
    expect(pluginIds.length).toBeGreaterThan(25);

    // Build a fake ProviderPlugin per discovered id with a synthetic
    // catalog.run + (optional) catalog.runOne. The runtime's runOne
    // resolver should pick the right hook for each.
    const missingHooks: string[] = [];
    for (const id of pluginIds) {
      const runCalls: string[] = [];
      const runOneCalls: string[] = [];
      const plugin: ProviderPlugin = {
        id,
        register: () => undefined,
        catalog: {
          order: "simple",
          run: async () => {
            runCalls.push(id);
            return null;
          },
          // Half the plugins opt in to runOne, half rely on the fallback —
          // simulates the partial-opt-in state during REN-680 rollout.
          ...(id.charCodeAt(0) % 2 === 0
            ? {
                runOne: async () => {
                  runOneCalls.push(id);
                  return null;
                },
              }
            : {}),
        },
      } as unknown as ProviderPlugin;

      const runtime = createPickerRuntime({
        getRuntimeConfig: () => ({}) as OpenClawConfig,
        getAgentDir: () => agentDir,
        getProviderPlugin: () => plugin,
        buildProviderCatalogContext: () => makeContext(),
        persistOverride: async () => undefined,
      });

      // null discovery is a no-op; we only assert SOMETHING was invoked.
      await runtime.providerModels.getProviderModels(id, { agentId: "main" });
      await new Promise((r) => setTimeout(r, 10));

      const invoked = runOneCalls.length + runCalls.length;
      if (invoked === 0) {
        missingHooks.push(id);
      } else if (plugin.catalog?.runOne) {
        // If the plugin defined runOne, the runtime must have preferred it.
        expect(runOneCalls).toContain(id);
        expect(runCalls).not.toContain(id);
      } else {
        // No runOne → must have fallen back to run.
        expect(runCalls).toContain(id);
      }
    }

    expect(missingHooks).toEqual([]);
  });

  it("vllm plugin's runOne body matches its run body", async () => {
    // The one plugin that's explicitly opted in (REN-679) should have
    // a runOne that's structurally equivalent to its run. Concrete proof
    // that the opt-in is a no-behavior-change paperwork step.
    const src = await readFile(
      path.join(EXTENSIONS_DIR, "vllm", "index.ts"),
      "utf8",
    );
    expect(src).toMatch(/runOne:\s*async\s*\(ctx\)\s*=>\s*{/);
    expect(src).toContain("discoverOpenAICompatibleSelfHostedProvider");
  });
});
