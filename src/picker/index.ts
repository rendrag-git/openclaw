/**
 * Cross-channel model picker module barrel — see ADR-0001.
 *
 * Consumers (channel plugins, CLI, gateway RPCs) import from this barrel.
 * Direct imports from `provider-models.ts`, `picker.ts`, `model-switch.ts`,
 * and `runtime.ts` are reserved for tests and internal wiring.
 */

export {
  createProviderModels,
  DEFAULT_MAX_STALENESS_MS,
  type ProviderModels,
  type ProviderModelsDeps,
  type ReadPersistedFn,
  type RunOneFn,
  type WritePersistedFn,
} from "./provider-models.js";

export {
  createPickerRegistry,
  type Picker,
  type PickerRegistry,
  type PickerRegistryDeps,
} from "./picker.js";

export {
  createModelSwitch,
  type ModelSwitch,
  type ModelSwitchDeps,
} from "./model-switch.js";

export {
  createPickerRuntime,
  type PickerRuntime,
  type PickerRuntimeDeps,
} from "./runtime.js";

export {
  AuthMissingError,
  AuthInvalidError,
  EndpointUnreachableError,
  ProtocolError,
  RunOneError,
  TimeoutError,
} from "./errors.js";

export type {
  Freshness,
  ModelRef,
  ModelSwitchRequest,
  ModelSwitchResult,
  PickerKey,
  PickerMutation,
  PickerPagination,
  PickerSelection,
  PickerState,
  ProviderModelsRequestOptions,
  ProviderModelsResult,
  RunOneContext,
} from "./types.js";
