import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadModelCatalogForBrowse } from "./model-catalog-browse.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const readOnlyCatalog: ModelCatalogEntry[] = [
  { id: "gpt-readonly", name: "GPT Readonly", provider: "openai" },
];
const fullCatalog: ModelCatalogEntry[] = [{ id: "gpt-full", name: "GPT Full", provider: "openai" }];

function config(params: { providerWildcard?: boolean } = {}): OpenClawConfig {
  return {
    agents: params.providerWildcard
      ? {
          defaults: {
            models: {
              "openai/*": {},
            },
          },
        }
      : undefined,
  } as OpenClawConfig;
}

describe("loadModelCatalogForBrowse", () => {
  it("uses the read-only catalog for default browse views", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(loadModelCatalogForBrowse({ cfg: config(), loadCatalog })).resolves.toBe(
      readOnlyCatalog,
    );

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
  });

  it("uses the full catalog for all views", async () => {
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadModelCatalogForBrowse({ cfg: config(), view: "all", loadCatalog }),
    ).resolves.toBe(fullCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: false });
  });

  it("serves the read-only snapshot under wildcards AND kicks off a background full discovery", async () => {
    // Regression: the wildcard branch used to await full discovery on the
    // hot path. Synchronous-blocking discovery work prevented the
    // setTimeout-based race from firing, stranding channel picker handlers
    // (the original "This interaction failed" symptom). Now the picker is
    // served from the bounded readOnly snapshot and discovery runs in the
    // background after the handler returns. (Codex review P1.)
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
      readOnly ? readOnlyCatalog : fullCatalog,
    );

    await expect(
      loadModelCatalogForBrowse({ cfg: config({ providerWildcard: true }), loadCatalog }),
    ).resolves.toBe(readOnlyCatalog);

    // readOnly fires immediately as the hot-path read.
    expect(loadCatalog).toHaveBeenCalledWith({ readOnly: true });
    // Background refresh is deferred past the current task (macrotask);
    // flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(loadCatalog).toHaveBeenCalledWith({ readOnly: false });
  });

  it("does not run wildcard refresh synchronously on the hot path", async () => {
    // Regression: even a fire-and-forget `loadCatalog({readOnly: false})`
    // dispatched inline ran its synchronous prologue before the hot-path
    // bounded race was even scheduled. (Codex review P1.)
    let syncReadOnlyFalseDispatches = 0;
    const loadCatalog = vi.fn(async ({ readOnly }: { readOnly: boolean }) => {
      if (!readOnly) {
        syncReadOnlyFalseDispatches += 1;
      }
      return readOnly ? readOnlyCatalog : fullCatalog;
    });

    const promise = loadModelCatalogForBrowse({
      cfg: config({ providerWildcard: true }),
      loadCatalog,
    });

    // Before any await yields, the readOnly:false call must not have been
    // dispatched yet — it must be deferred past the current task.
    expect(syncReadOnlyFalseDispatches).toBe(0);
    await promise;
    // The caller's await continuation has resumed; the macrotask-deferred
    // refresh has NOT fired yet either.
    expect(syncReadOnlyFalseDispatches).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(syncReadOnlyFalseDispatches).toBe(1);
  });

  it("returns empty when wildcard read-only snapshot times out — background discovery still runs", async () => {
    const onTimeout = vi.fn();
    const loadCatalog = vi.fn(
      ({ readOnly }: { readOnly: boolean }) =>
        new Promise<ModelCatalogEntry[]>((resolve) => {
          // Both readOnly:true (hot path) and readOnly:false (background)
          // are intentionally slow; the channel handler must never wait
          // for either past its budget.
          setTimeout(() => resolve(readOnly ? readOnlyCatalog : fullCatalog), 50);
        }),
    );

    await expect(
      loadModelCatalogForBrowse({
        cfg: config({ providerWildcard: true }),
        loadCatalog,
        timeoutMs: 5,
        onTimeout,
      }),
    ).resolves.toEqual([]);

    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(5);
    // Background full discovery is still kicked off past the current task.
    await new Promise((r) => setTimeout(r, 0));
    expect(loadCatalog).toHaveBeenCalledWith({ readOnly: false });
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it("returns an empty catalog when read-only catalog loading times out", async () => {
    const onTimeout = vi.fn();
    const loadCatalog = vi.fn(
      () =>
        new Promise<ModelCatalogEntry[]>((_, reject) => {
          setTimeout(() => reject(new Error("late catalog failure")), 10);
        }),
    );

    const resultPromise = loadModelCatalogForBrowse({
      cfg: config(),
      loadCatalog,
      timeoutMs: 5,
      onTimeout,
    });

    await expect(resultPromise).resolves.toEqual([]);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(5);
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
});
