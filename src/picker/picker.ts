import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { ProviderModels } from "./provider-models.js";
import type {
  PickerKey,
  PickerMutation,
  PickerState,
} from "./types.js";

/**
 * Picker module per ADR-0001 §"Module 1".
 *
 * REN-679 ships a minimal skeleton sufficient to demonstrate the vllm tracer
 * flow end-to-end. The full reducer (every mutation kind, pagination methods,
 * TTL eviction, key isolation, concurrent mutation serialization) lands in
 * REN-681. New mutations / fields can be added without breaking the surface
 * the channel adapters consume.
 */

const SESSION_TTL_MS = 5 * 60 * 1000;

export type Picker = {
  readonly key: PickerKey;
  snapshot: () => PickerState;
  dispatch: (mutation: PickerMutation) => Promise<void>;
};

export type PickerRegistry = {
  openPicker: (key: PickerKey, opts?: { agentId?: string }) => Picker;
  closePicker: (key: PickerKey) => void;
  /** Drop sessions whose `lastTouched` is older than the TTL. */
  sweepExpired: (now?: number) => number;
};

export type PickerRegistryDeps = {
  providerModels: ProviderModels;
  now?: () => number;
  /** Optional hook for observability — fires on every mutation. */
  onMutation?: (params: { key: PickerKey; mutation: PickerMutation }) => void;
};

function serializeKey(key: PickerKey): string {
  return `${key.channel}|${key.accountId}|${key.userId}|${key.interactionRoot}`;
}

function emptyState(now: number): PickerState {
  return {
    catalog: new Map<string, ModelCatalogEntry[]>(),
    selection: {},
    pagination: { providerPage: 1, modelPage: 1 },
    allowlist: new Set<string>(),
    recents: [],
    openedAt: now,
    lastTouched: now,
  };
}

export function createPickerRegistry(deps: PickerRegistryDeps): PickerRegistry {
  const now = deps.now ?? (() => Date.now());
  const sessions = new Map<string, { key: PickerKey; state: PickerState; agentId?: string }>();

  function getOrCreate(key: PickerKey, agentId?: string) {
    const id = serializeKey(key);
    let entry = sessions.get(id);
    if (!entry) {
      entry = { key, state: emptyState(now()), agentId };
      sessions.set(id, entry);
    } else {
      entry.state.lastTouched = now();
    }
    return entry;
  }

  async function hydrateProvider(
    state: PickerState,
    providerId: string,
    agentId?: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (!opts.force) {
      const cached = state.catalog.get(providerId);
      if (cached && cached.length > 0) {
        return;
      }
    }
    const result = await deps.providerModels.getProviderModels(providerId, { agentId });
    state.catalog.set(providerId, result.models);
  }

  async function dispatchInternal(
    entry: { key: PickerKey; state: PickerState; agentId?: string },
    mutation: PickerMutation,
  ): Promise<void> {
    deps.onMutation?.({ key: entry.key, mutation });
    const state = entry.state;
    state.lastTouched = now();

    switch (mutation.kind) {
      case "selectProvider": {
        state.selection = { ...state.selection, provider: mutation.provider, model: undefined };
        state.pagination = { ...state.pagination, modelPage: 1 };
        await hydrateProvider(state, mutation.provider, entry.agentId);
        return;
      }
      case "selectModel": {
        state.selection = {
          ...state.selection,
          provider: mutation.provider,
          model: mutation.model,
        };
        return;
      }
      case "selectRuntime": {
        state.selection = { ...state.selection, runtime: mutation.runtime };
        return;
      }
      case "paginateProvider": {
        state.pagination = {
          ...state.pagination,
          providerPage: Math.max(1, state.pagination.providerPage + mutation.delta),
        };
        return;
      }
      case "paginateModel": {
        state.pagination = {
          ...state.pagination,
          modelPage: Math.max(1, state.pagination.modelPage + mutation.delta),
        };
        return;
      }
      case "back": {
        if (mutation.to === "providers") {
          state.selection = { ...state.selection, provider: undefined, model: undefined };
        } else {
          state.selection = { ...state.selection, model: undefined };
        }
        return;
      }
      case "reset": {
        entry.state = emptyState(now());
        return;
      }
      case "refreshCatalog": {
        deps.providerModels.invalidate(mutation.providerId, entry.agentId);
        await hydrateProvider(state, mutation.providerId, entry.agentId, { force: true });
        return;
      }
      case "submit": {
        // ModelSwitch consumes `snapshot().selection` — the picker doesn't
        // know about runtimes/harnesses. Channel adapter calls ModelSwitch
        // after `dispatch({kind: "submit"})` returns.
        return;
      }
      default: {
        const _exhaustive: never = mutation;
        void _exhaustive;
      }
    }
  }

  function snapshotOf(state: PickerState): PickerState {
    // Defensive copy: channel renderers must not mutate session state
    // outside of `dispatch`. Maps/Sets/arrays — and the ModelCatalogEntry
    // objects inside each provider's model array — are cloned so accidental
    // in-place edits (UI annotations, label normalization, etc.) in
    // renderers can't corrupt subsequent interactions on the same session.
    const catalog = new Map<string, ModelCatalogEntry[]>();
    for (const [providerId, models] of state.catalog) {
      catalog.set(
        providerId,
        models.map((entry) => ({ ...entry })),
      );
    }
    return {
      catalog,
      selection: { ...state.selection },
      pagination: { ...state.pagination },
      allowlist: new Set(state.allowlist),
      recents: [...state.recents],
      openedAt: state.openedAt,
      lastTouched: state.lastTouched,
    };
  }

  return {
    openPicker(key, opts = {}) {
      const entry = getOrCreate(key, opts.agentId);
      return {
        key,
        snapshot: () => snapshotOf(entry.state),
        dispatch: (mutation) => dispatchInternal(entry, mutation),
      };
    },
    closePicker(key) {
      sessions.delete(serializeKey(key));
    },
    sweepExpired(tNow?) {
      const cutoff = (tNow ?? now()) - SESSION_TTL_MS;
      let dropped = 0;
      for (const [id, entry] of sessions) {
        if (entry.state.lastTouched < cutoff) {
          sessions.delete(id);
          dropped += 1;
        }
      }
      return dropped;
    },
  };
}
