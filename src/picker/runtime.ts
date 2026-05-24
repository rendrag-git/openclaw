import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { withModelsJsonWriteLock } from "../agents/models-config.js";
import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPlugin,
} from "../plugins/types.js";
import {
  AuthInvalidError,
  AuthMissingError,
  EndpointUnreachableError,
  ProtocolError,
  TimeoutError,
} from "./errors.js";
import { createModelSwitch, type ModelSwitch } from "./model-switch.js";
import { createPickerRegistry, type PickerRegistry } from "./picker.js";
import {
  createProviderModels,
  type ProviderModels,
  type RunOneFn,
} from "./provider-models.js";

/**
 * Gateway-side factory wiring the picker modules to real cfg + plugin lookup.
 *
 * Per ADR-0001 the picker hot path never touches global loadModelCatalog or
 * ensureOpenClawModelsJson directly. This module provides the per-call glue:
 *
 *   - `runOne` resolves the requested provider plugin and invokes its
 *     `catalog.runOne` hook (falling back to `catalog.run` for plugins that
 *     have not been migrated to REN-680 yet).
 *   - `readPersisted` / `writePersisted` read and write a single provider's
 *     slice of the per-agent `models.json` — no manifest snapshot, no
 *     auth-storage init, no other providers touched.
 */

export type PickerRuntime = {
  providerModels: ProviderModels;
  pickers: PickerRegistry;
  modelSwitch: ModelSwitch;
};

export type PickerRuntimeDeps = {
  getRuntimeConfig: () => OpenClawConfig;
  getAgentDir: (agentId?: string) => string;
  getProviderPlugin: (providerId: string) => ProviderPlugin | undefined;
  /**
   * Build a per-call provider catalog context. The picker passes through the
   * `agentId` so discovery resolves auth, workspace, and base URL from the
   * correct agent's scope — critical for multi-agent gateways where two
   * agents may share a provider id with different credentials.
   */
  buildProviderCatalogContext: (params: {
    providerId: string;
    agentId?: string;
    signal?: AbortSignal;
  }) => ProviderCatalogContext;
  persistOverride: Parameters<typeof createModelSwitch>[0]["persistOverride"];
  resolveRuntime?: Parameters<typeof createModelSwitch>[0]["resolveRuntime"];
  onError?: (params: { providerId: string; error: unknown }) => void;
};

function modelsJsonPathForAgent(agentDir: string): string {
  return path.join(agentDir, "models.json");
}

const MODEL_CATALOG_FIELDS = [
  "alias",
  "contextWindow",
  "contextTokens",
  "reasoning",
  "input",
  "compat",
] as const;

function carryModelCatalogFields(
  entry: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  for (const key of MODEL_CATALOG_FIELDS) {
    if (entry[key] !== undefined) {
      target[key] = entry[key];
    }
  }
}

function readModelCatalogEntry(
  entry: Record<string, unknown>,
  providerId: string,
): ModelCatalogEntry | null {
  const id = entry.id;
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  const name = entry.name;
  const out: Record<string, unknown> = {
    provider: providerId,
    id,
    name: typeof name === "string" && name.length > 0 ? name : id,
  };
  carryModelCatalogFields(entry, out);
  return out as ModelCatalogEntry;
}

function extractProviderEntry(
  parsed: unknown,
  providerId: string,
):
  | {
      models: ModelCatalogEntry[];
      writtenAt?: number;
    }
  | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const providers = (parsed as { providers?: Record<string, unknown> }).providers;
  if (!providers || typeof providers !== "object") {
    return null;
  }
  const slice = providers[providerId];
  if (!slice || typeof slice !== "object") {
    return null;
  }
  const models = (slice as { models?: unknown[] }).models;
  if (!Array.isArray(models)) {
    return null;
  }
  // Freshness is tracked per-provider so a refresh of one slice doesn't
  // fake-fresh the others.
  const writtenAt = (slice as { __pickerFetchedAt?: number }).__pickerFetchedAt;
  return {
    models: models.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const parsedEntry = readModelCatalogEntry(entry as Record<string, unknown>, providerId);
      return parsedEntry ? [parsedEntry] : [];
    }),
    ...(typeof writtenAt === "number" ? { writtenAt } : {}),
  };
}

function pickProviderFromResult(
  result: ProviderCatalogResult,
  providerId: string,
): { models?: unknown; baseUrl?: unknown; api?: unknown; apiKey?: unknown; headers?: unknown } | undefined {
  if (!result) {
    return undefined;
  }
  if ("provider" in result) {
    return result.provider as Record<string, unknown>;
  }
  if ("providers" in result) {
    const slice = result.providers[providerId];
    return slice as Record<string, unknown> | undefined;
  }
  return undefined;
}

function extractProviderExtras(
  result: ProviderCatalogResult,
  providerId: string,
): Record<string, unknown> | undefined {
  const provider = pickProviderFromResult(result, providerId);
  if (!provider) {
    return undefined;
  }
  // ONLY carry forward non-secret structural fields. `apiKey` from the
  // discovery result is the resolved plaintext credential — persisting it
  // here would bypass SecretRef/marker handling and trip secret scanning
  // (`PLAINTEXT_FOUND`). Existing `apiKey`/SecretRef in the models.json
  // slice is preserved by the `existing` spread in writePersisted; the
  // canonical writer (`ensureOpenClawModelsJson`) is the only path
  // authorized to write credentials.
  const extras: Record<string, unknown> = {};
  if (typeof provider.baseUrl === "string" && provider.baseUrl.length > 0) {
    extras.baseUrl = provider.baseUrl;
  }
  if (typeof provider.api === "string" && provider.api.length > 0) {
    extras.api = provider.api;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

function extractRawModelsById(
  result: ProviderCatalogResult,
  providerId: string,
): Map<string, Record<string, unknown>> | undefined {
  const provider = pickProviderFromResult(result, providerId);
  const rawModels = provider?.models;
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    return undefined;
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const entry of rawModels) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    out.set(id, entry as Record<string, unknown>);
  }
  return out.size > 0 ? out : undefined;
}

function extractResultModels(
  result: ProviderCatalogResult,
  providerId: string,
): ModelCatalogEntry[] | null {
  // A null/undefined plugin result means "no catalog update" — surface that
  // to ProviderModels so it doesn't overwrite the persisted slice with an
  // empty array. discoverOpenAICompatibleSelfHostedProvider returns null
  // for explicitly configured providers without a matching wildcard, so
  // erasing the slice would lose the maintainer's persisted catalog.
  const provider = pickProviderFromResult(result, providerId);
  if (!provider) {
    return null;
  }
  const rawModels = provider.models;
  if (!Array.isArray(rawModels)) {
    return null;
  }
  return rawModels.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const parsedEntry = readModelCatalogEntry(entry as Record<string, unknown>, providerId);
    return parsedEntry ? [parsedEntry] : [];
  });
}

function classifyDiscoveryError(error: unknown): Error {
  if (error instanceof Error) {
    if (
      error instanceof AuthMissingError ||
      error instanceof AuthInvalidError ||
      error instanceof EndpointUnreachableError ||
      error instanceof ProtocolError ||
      error instanceof TimeoutError
    ) {
      return error;
    }
    const msg = error.message ?? "";
    if (/unauth|auth|api[ _-]?key/i.test(msg)) {
      return new AuthMissingError(msg);
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) {
      return new EndpointUnreachableError(msg);
    }
    return new ProtocolError(msg);
  }
  return new ProtocolError(String(error));
}

export function createPickerRuntime(deps: PickerRuntimeDeps): PickerRuntime {
  // Discovery extras (provider-config fields + raw model entries) travel
  // with the refresh promise as `auxiliary` so stale completions from an
  // invalidated refresh can't race onto fresher writes via a side-map.
  type DiscoveryAuxiliary = {
    extras?: Record<string, unknown>;
    rawModelsById?: Map<string, Record<string, unknown>>;
  };

  const runOne: RunOneFn = async ({ providerId, agentId, signal }) => {
    const plugin = deps.getProviderPlugin(providerId);
    if (!plugin?.catalog) {
      throw new AuthMissingError(
        `Provider ${providerId} is not registered or has no catalog hook`,
      );
    }
    const ctx = deps.buildProviderCatalogContext({
      providerId,
      ...(agentId ? { agentId } : {}),
      ...(signal ? { signal } : {}),
    });
    const hook = plugin.catalog.runOne ?? plugin.catalog.run;
    try {
      const result = await hook(ctx);
      const models = extractResultModels(result, providerId);
      // `null` from extractResultModels means "no catalog update" — surface
      // that to ProviderModels as null so the persisted slice is preserved.
      if (models === null) {
        return null;
      }
      const auxiliary: DiscoveryAuxiliary = {};
      const extras = extractProviderExtras(result, providerId);
      if (extras) auxiliary.extras = extras;
      const rawModelsById = extractRawModelsById(result, providerId);
      if (rawModelsById) auxiliary.rawModelsById = rawModelsById;
      return {
        models,
        ...(Object.keys(auxiliary).length > 0 ? { auxiliary } : {}),
      };
    } catch (error) {
      throw classifyDiscoveryError(error);
    }
  };

  const providerModels = createProviderModels({
    runOne,
    readPersisted: async ({ providerId, agentId }) => {
      const filePath = modelsJsonPathForAgent(deps.getAgentDir(agentId));
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const slice = extractProviderEntry(parsed, providerId);
        if (!slice) {
          return null;
        }
        // An explicit empty `models: []` with a `__pickerFetchedAt` marker
        // is a successful discovery that legitimately returned zero models
        // — preserve it as fresh data. Empty slices WITHOUT a freshness
        // marker (legacy-empty) still fall through to refresh.
        if (slice.models.length === 0 && slice.writtenAt === undefined) {
          return null;
        }
        return {
          models: slice.models,
          fetchedAt: slice.writtenAt ?? 0,
        };
      } catch {
        return null;
      }
    },
    writePersisted: async ({ providerId, agentId, models, fetchedAt, auxiliary }) => {
      const agentDir = deps.getAgentDir(agentId);
      const filePath = modelsJsonPathForAgent(agentDir);
      const aux = (auxiliary ?? undefined) as DiscoveryAuxiliary | undefined;
      // Share the canonical models.json write lock so concurrent picker
      // refreshes for different providers, and any concurrent
      // ensureOpenClawModelsJson rewrite, can't drop each other's slices.
      await withModelsJsonWriteLock(filePath, async () => {
        // Agent dir may not exist yet (first discovery for a fresh agent).
        // Use the same 0o700 mode the canonical writer applies.
        try {
          await mkdir(agentDir, { recursive: true, mode: 0o700 });
        } catch {
          // mkdir recursive is idempotent; nothing to do on benign races.
        }
        let parsed: Record<string, unknown> = {};
        try {
          const raw = await readFile(filePath, "utf8");
          parsed = JSON.parse(raw);
        } catch {
          // Fresh file; we'll create it.
        }
        const providers =
          parsed.providers && typeof parsed.providers === "object"
            ? (parsed.providers as Record<string, unknown>)
            : {};
        const existing =
          providers[providerId] && typeof providers[providerId] === "object"
            ? (providers[providerId] as Record<string, unknown>)
            : {};
        // Merge auxiliary fields and raw model entries received from runOne
        // via the promise chain (no side-map race).
        // - extras: baseUrl/api/apiKey/headers from the discovered provider
        //   config so first-time slice writes don't drop auth-relevant info.
        // - rawModelsById: full raw model entries from the discovery result
        //   so per-model runtime fields (cost, maxTokens, params,
        //   agentRuntime, ...) survive picker refreshes. The picker's
        //   internal catalog uses the narrowed shape; persistence keeps
        //   the wider one.
        const extras = aux?.extras ?? {};
        const rawById = aux?.rawModelsById;
        providers[providerId] = {
          ...existing,
          ...extras,
          models: models.map((entry) => {
            const raw = rawById?.get(entry.id);
            if (raw) {
              // Carry forward every field the discovery emitted.
              return { ...raw, id: entry.id, name: entry.name };
            }
            // Fallback for callers that bypass the runtime's runOne
            // (tests, future direct injectors) — write the narrow shape.
            const out: Record<string, unknown> = {
              id: entry.id,
              name: entry.name,
            };
            carryModelCatalogFields(entry as unknown as Record<string, unknown>, out);
            return out;
          }),
          // Per-provider freshness marker; other slices keep their own.
          __pickerFetchedAt: fetchedAt,
        };
        parsed.providers = providers;
        // Atomic write via tmp + rename so concurrent read-only loads can't
        // observe a truncated file. Chmod after the rename so existing 0o644
        // permissions on legacy files are repaired in place.
        const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
        const tmpPath = `${filePath}.picker.tmp`;
        try {
          await writeFile(tmpPath, serialized, { encoding: "utf8", mode: 0o600 });
          await rename(tmpPath, filePath);
        } catch (renameError) {
          // Clean up the tmp file on failure so we don't leave litter.
          try {
            await unlink(tmpPath);
          } catch {
            // best-effort
          }
          throw renameError;
        }
        await chmod(filePath, 0o600).catch(() => {
          // best-effort permission repair; not fatal.
        });
      });
    },
    ...(deps.onError ? { onError: deps.onError } : {}),
  });

  const pickers = createPickerRegistry({ providerModels });

  const modelSwitch = createModelSwitch({
    persistOverride: deps.persistOverride,
    ...(deps.resolveRuntime ? { resolveRuntime: deps.resolveRuntime } : {}),
  });

  return { providerModels, pickers, modelSwitch };
}
