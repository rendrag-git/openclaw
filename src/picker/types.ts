import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";

/**
 * Per-ADR-0001 module shared types for the cross-channel model picker.
 *
 * Channels never own state. They consume `picker.snapshot()` (a `PickerState`)
 * and emit `PickerMutation`s via `picker.dispatch()`. Catalog hydration goes
 * through `ProviderModels`. Submit goes through `ModelSwitch`.
 */

/**
 * Picker session identity. `interactionRoot` is the slash-command invocation
 * that opened the picker — two simultaneous pickers from the same user in the
 * same channel get distinct sessions.
 */
export type PickerKey = {
  channel: string;
  accountId: string;
  userId: string;
  interactionRoot: string;
};

export type ModelRef = {
  provider: string;
  model: string;
};

export type Freshness = "fresh" | "stale" | "missing";

export type ProviderModelsResult = {
  models: ModelCatalogEntry[];
  /** epoch ms of the persisted-or-fetched data, or 0 if `missing`. */
  fetchedAt: number;
  freshness: Freshness;
};

export type ProviderModelsRequestOptions = {
  agentId?: string;
  /** ms; entries older than this are reported as `stale`. Defaults to 5 min. */
  maxStaleness?: number;
  signal?: AbortSignal;
};

export type PickerSelection = {
  provider?: string;
  model?: string;
  runtime?: string;
};

export type PickerPagination = {
  providerPage: number;
  modelPage: number;
};

export type PickerState = {
  catalog: Map<string, ModelCatalogEntry[]>;
  selection: PickerSelection;
  pagination: PickerPagination;
  allowlist: Set<string>;
  recents: string[];
  openedAt: number;
  lastTouched: number;
};

export type PickerMutation =
  | { kind: "selectProvider"; provider: string }
  | { kind: "selectModel"; provider: string; model: string }
  | { kind: "selectRuntime"; runtime: string }
  | { kind: "paginateProvider"; delta: 1 | -1 }
  | { kind: "paginateModel"; delta: 1 | -1 }
  | { kind: "back"; to: "providers" | "models" }
  | { kind: "submit" }
  | { kind: "reset" }
  | { kind: "refreshCatalog"; providerId: string };

export type ModelSwitchRequest = {
  sessionKey: PickerKey;
  fromRef: ModelRef;
  toRef: ModelRef;
  runtime?: string;
};

export type ModelSwitchResult = {
  result: "applied" | "queued" | "rejected";
  harnessesAffected: string[];
  message: string;
};

/**
 * Per-provider on-demand discovery contract added to every bundled provider
 * plugin's existing `catalog` hook. See ADR-0001 §"Plugin contract".
 *
 * Implementations MUST be cheap (p95 ≤ 1 s under healthy auth + reachable
 * endpoint). They MUST NOT load auth storage, manifest snapshot, or other
 * providers' state. Errors are thrown as structured classes from
 * `./errors.ts`.
 */
export type RunOneContext = {
  providerId: string;
  agentId?: string;
  hint?: "force-refresh" | "background";
  signal?: AbortSignal;
};
