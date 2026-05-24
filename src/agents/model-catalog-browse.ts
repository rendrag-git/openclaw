import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { parseConfiguredModelVisibilityEntries } from "./model-selection-shared.js";

export const DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS = 750;

export type ModelCatalogBrowseView = "default" | "configured" | "all";

export async function loadModelCatalogForBrowse(params: {
  cfg: OpenClawConfig;
  view?: ModelCatalogBrowseView;
  loadCatalog: (params: { readOnly: boolean }) => Promise<ModelCatalogEntry[]>;
  timeoutMs?: number;
  onTimeout?: (timeoutMs: number) => void;
}): Promise<ModelCatalogEntry[]> {
  const view = params.view ?? "default";
  if (view === "all") {
    return await params.loadCatalog({ readOnly: false });
  }
  const hasWildcards =
    parseConfiguredModelVisibilityEntries({ cfg: params.cfg }).providerWildcards.size > 0;
  const timeoutMs = params.timeoutMs ?? DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS;

  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Symbol("model-catalog-browse-timeout");
  const catalogPromise = params.loadCatalog({ readOnly: true });
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(() => resolve(timedOut), timeoutMs);
    timeout.unref?.();
  });

  try {
    const result = await Promise.race([catalogPromise, timeoutPromise]);
    if (result === timedOut) {
      catalogPromise.catch(() => undefined);
      params.onTimeout?.(timeoutMs);
      return [];
    }
    return result;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    // For wildcard configs we still want freshly-discovered provider models
    // to flow into the persisted catalog so the NEXT interaction sees them.
    // Defer the full-discovery refresh past the current task entirely (a
    // macrotask, not a microtask) so the caller's `await` continuation can
    // resume and respond to the channel BEFORE the discovery's synchronous
    // setup work (importPiSdk, ensureOpenClawModelsJson, manifest snapshot,
    // etc.) starts — that's the same failure mode that surfaced as
    // "This interaction failed" against the live `vllm/*` config.
    if (hasWildcards) {
      const timer = setTimeout(() => {
        params.loadCatalog({ readOnly: false }).catch(() => undefined);
      }, 0);
      timer.unref?.();
    }
  }
}
