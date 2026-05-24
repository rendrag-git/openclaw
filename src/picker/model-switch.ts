import type { ModelRef, ModelSwitchRequest, ModelSwitchResult } from "./types.js";

/**
 * ModelSwitch module per ADR-0001 §"Module 3".
 *
 * REN-679 ships a thin skeleton: it persists the session override via the
 * injected `persistOverride` and returns synchronously. Cross-runtime harness
 * lifecycle decoupling — keeping codex warm when switching to vllm+pi —
 * lands in REN-683 with full unit-test coverage on the decision matrix.
 *
 * The same dispatcher serves `/model <ref>` text commands (per ADR-0001 user
 * story 30). Channel adapters and the text-command handler both consume this
 * single surface.
 */

export type ModelSwitchDeps = {
  persistOverride: (params: {
    sessionKey: ModelSwitchRequest["sessionKey"];
    toRef: ModelRef;
    runtime?: string;
  }) => Promise<void>;
  /** Resolve the current effective runtime for a model ref, if known. */
  resolveRuntime?: (ref: ModelRef) => string | undefined;
  onSwitch?: (params: { request: ModelSwitchRequest; result: ModelSwitchResult }) => void;
};

export type ModelSwitch = {
  applySelection: (request: ModelSwitchRequest) => Promise<ModelSwitchResult>;
};

function sameRuntime(
  fromRuntime: string | undefined,
  toRuntime: string | undefined,
): boolean {
  if (!fromRuntime && !toRuntime) {
    return true;
  }
  return fromRuntime === toRuntime;
}

export function createModelSwitch(deps: ModelSwitchDeps): ModelSwitch {
  return {
    async applySelection(request) {
      const { sessionKey, fromRef, toRef, runtime } = request;
      const toRuntime = runtime ?? deps.resolveRuntime?.(toRef);
      const fromRuntime = deps.resolveRuntime?.(fromRef);

      const harnessesAffected = sameRuntime(fromRuntime, toRuntime)
        ? []
        : [toRuntime, fromRuntime].filter((value): value is string => Boolean(value));

      try {
        // Persist whatever runtime we actually intend to use, whether the
        // caller passed it explicitly or `resolveRuntime` derived it from
        // the model ref. Otherwise the next agent turn would replay the
        // previous/default harness even though we just acknowledged the
        // runtime change in `harnessesAffected`.
        const persistedRuntime = runtime ?? toRuntime;
        await deps.persistOverride({
          sessionKey,
          toRef,
          ...(persistedRuntime ? { runtime: persistedRuntime } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: ModelSwitchResult = {
          result: "rejected",
          harnessesAffected: [],
          message: `Failed to persist model override: ${message}`,
        };
        deps.onSwitch?.({ request, result });
        return result;
      }

      const result: ModelSwitchResult = {
        result: "applied",
        harnessesAffected,
        message:
          harnessesAffected.length === 0
            ? `Model set to ${toRef.provider}/${toRef.model}.`
            : `Model set to ${toRef.provider}/${toRef.model}; runtime change deferred to next agent turn.`,
      };
      deps.onSwitch?.({ request, result });
      return result;
    },
  };
}
