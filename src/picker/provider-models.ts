import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { RunOneError } from "./errors.js";
import type {
  Freshness,
  ProviderModelsRequestOptions,
  ProviderModelsResult,
  RunOneContext,
} from "./types.js";

/**
 * Per-provider on-demand catalog with stale-while-revalidate.
 *
 * Replaces the global `loadModelCatalog({ readOnly: false })` carve-out for
 * picker hot paths. ADR-0001 §"Module 2: ProviderModels".
 *
 * Cache layers (in order of access):
 *
 *   1. In-memory promise (coalesces concurrent in-flight refreshes)
 *   2. In-memory result (most recent finished refresh)
 *   3. Persisted snapshot via injected `readPersisted`
 *
 * On cache miss or stale, kicks off a single background refresh via the
 * injected `runOne` (the plugin's per-provider discovery hook). Writes through
 * via injected `writePersisted` when the refresh succeeds.
 *
 * All I/O is injected — the module itself is pure cache + refresh-coalescing
 * logic, trivially unit-testable.
 */

export const DEFAULT_MAX_STALENESS_MS = 5 * 60 * 1000;

type PersistedRead = {
  models: ModelCatalogEntry[];
  fetchedAt: number;
} | null;

/**
 * Successful discovery result. `models` is the catalog (possibly empty).
 * `auxiliary` is opaque pass-through data the resolver carries forward
 * to `writePersisted` (e.g. provider config extras, raw entry shape) —
 * `ProviderModels` does not interpret it. Travelling auxiliary data via
 * the promise chain prevents the stale-vs-fresh race that a side-map
 * keyed by `(providerId, agentId)` would suffer.
 */
export type RunOneResult = {
  models: ModelCatalogEntry[];
  auxiliary?: unknown;
};

/**
 * Returns the freshly-discovered models + opaque auxiliary, or `null` to
 * signal "no catalog update" — e.g. a provider hook that decides to
 * preserve the existing snapshot (concrete `models.providers.<id>.models`
 * is configured, the wildcard policy does not include this provider,
 * etc.).
 *
 * ProviderModels treats `null` as a no-op: it does NOT overwrite the
 * persisted slice with an empty array. An empty array INSIDE a non-null
 * result is treated as an explicit empty catalog and IS persisted.
 */
export type RunOneFn = (ctx: RunOneContext) => Promise<RunOneResult | null>;
export type ReadPersistedFn = (params: {
  providerId: string;
  agentId?: string;
}) => Promise<PersistedRead>;
export type WritePersistedFn = (params: {
  providerId: string;
  agentId?: string;
  models: ModelCatalogEntry[];
  fetchedAt: number;
  /** Opaque auxiliary data carried from runOne's result, unchanged. */
  auxiliary?: unknown;
}) => Promise<void>;

export type ProviderModelsDeps = {
  runOne: RunOneFn;
  readPersisted: ReadPersistedFn;
  writePersisted: WritePersistedFn;
  now?: () => number;
  onError?: (params: { providerId: string; error: unknown }) => void;
};

type CacheKey = string;
type CacheEntry = {
  models: ModelCatalogEntry[];
  fetchedAt: number;
};

export type ProviderModels = {
  getProviderModels: (
    providerId: string,
    opts?: ProviderModelsRequestOptions,
  ) => Promise<ProviderModelsResult>;
  /** Drop the in-memory cache for one provider. Test-only / explicit refresh. */
  invalidate: (providerId: string, agentId?: string) => void;
};

function cacheKey(providerId: string, agentId?: string): CacheKey {
  return `${agentId ?? ""}::${providerId}`;
}

function classifyEntryFreshness(
  entry: CacheEntry,
  now: number,
  maxStaleness: number,
): Freshness {
  // `fetchedAt === 0` marks a legacy persisted snapshot written before the
  // picker's freshness marker was introduced. Treat it as `stale` (with
  // models) so a refresh fires, or `missing` (without models) so callers
  // know nothing is available yet.
  if (entry.fetchedAt === 0) {
    return entry.models.length > 0 ? "stale" : "missing";
  }
  return now - entry.fetchedAt <= maxStaleness ? "fresh" : "stale";
}

export function createProviderModels(deps: ProviderModelsDeps): ProviderModels {
  const now = deps.now ?? (() => Date.now());
  const memory = new Map<CacheKey, CacheEntry>();
  const inFlight = new Map<CacheKey, Promise<CacheEntry | null>>();
  // Generation token per cache key. `invalidate` bumps it so any
  // already-in-flight refresh that resolves AFTER a new one cannot commit
  // its (potentially stale) result on top of the fresher generation.
  const generations = new Map<CacheKey, number>();

  const refresh = (providerId: string, agentId: string | undefined, signal?: AbortSignal) => {
    const key = cacheKey(providerId, agentId);
    const existing = inFlight.get(key);
    if (existing) {
      return existing;
    }
    const myGeneration = generations.get(key) ?? 0;
    // Holder lets the async IIFE compare its own promise identity against
    // the in-flight slot without TS thinking the reference might be unset
    // — the IIFE only runs after the assignment below settles.
    const ref: { promise?: Promise<CacheEntry | null> } = {};
    ref.promise = (async (): Promise<CacheEntry | null> => {
      try {
        // Macrotask boundary: defer the plugin's `runOne` hook past the
        // current task so its synchronous setup (auth/storage/module
        // initialization) can't block the channel handler that is still
        // returning from `getProviderModels`.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 0);
          timer.unref?.();
        });
        const result = await deps.runOne({
          providerId,
          ...(agentId ? { agentId } : {}),
          ...(signal ? { signal } : {}),
        });
        // `null` means "no catalog update" — preserve existing state.
        if (result === null) {
          return null;
        }
        const { models, auxiliary } = result;
        const fetchedAt = now();
        const entry: CacheEntry = { models, fetchedAt };
        // Only commit if no `invalidate` bumped the generation while
        // discovery was in flight. Stale completions are dropped.
        const currentGeneration = generations.get(key) ?? 0;
        if (currentGeneration !== myGeneration) {
          return null;
        }
        memory.set(key, entry);
        try {
          await deps.writePersisted({
            providerId,
            agentId,
            models,
            fetchedAt,
            ...(auxiliary !== undefined ? { auxiliary } : {}),
          });
        } catch (error) {
          deps.onError?.({ providerId, error });
        }
        return entry;
      } catch (error) {
        if (!(error instanceof RunOneError)) {
          deps.onError?.({ providerId, error });
        }
        // Preserve any stale entry already in memory; don't poison cache.
        return null;
      } finally {
        // Only clear inFlight if it's still pointing at this promise — a
        // newer refresh kicked off after invalidate already owns the slot.
        if (inFlight.get(key) === ref.promise) {
          inFlight.delete(key);
        }
      }
    })();
    inFlight.set(key, ref.promise);
    return ref.promise;
  };

  const getProviderModels: ProviderModels["getProviderModels"] = async (
    providerId,
    opts = {},
  ) => {
    const agentId = opts.agentId;
    const maxStaleness = opts.maxStaleness ?? DEFAULT_MAX_STALENESS_MS;
    const key = cacheKey(providerId, agentId);
    const tNow = now();

    const memoryHit = memory.get(key);
    if (memoryHit) {
      const freshness = classifyEntryFreshness(memoryHit, tNow, maxStaleness);
      if (freshness === "stale" || freshness === "missing") {
        void refresh(providerId, agentId, opts.signal);
      }
      return {
        models: memoryHit.models,
        fetchedAt: memoryHit.fetchedAt,
        freshness,
      };
    }

    let persisted: PersistedRead = null;
    try {
      persisted = await deps.readPersisted({ providerId, agentId });
    } catch (error) {
      deps.onError?.({ providerId, error });
    }

    if (persisted) {
      memory.set(key, persisted);
      const freshness = classifyEntryFreshness(persisted, tNow, maxStaleness);
      if (freshness === "stale" || freshness === "missing") {
        void refresh(providerId, agentId, opts.signal);
      }
      return {
        models: persisted.models,
        fetchedAt: persisted.fetchedAt,
        freshness,
      };
    }

    // Cache and persistence both empty — fire refresh, return missing
    // immediately so the picker can render a placeholder.
    void refresh(providerId, agentId, opts.signal);
    return { models: [], fetchedAt: 0, freshness: "missing" };
  };

  return {
    getProviderModels,
    invalidate(providerId, agentId) {
      const key = cacheKey(providerId, agentId);
      memory.delete(key);
      // Drop any in-flight refresh from the coalesce map so the next call
      // kicks off fresh discovery instead of awaiting the pre-invalidate
      // work. Bump the generation token so even if the pre-invalidate
      // refresh resolves AFTER the new one, it cannot commit its result
      // and overwrite the fresher data.
      inFlight.delete(key);
      generations.set(key, (generations.get(key) ?? 0) + 1);
    },
  };
}
