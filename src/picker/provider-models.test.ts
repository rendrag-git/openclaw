import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { AuthMissingError, EndpointUnreachableError } from "./errors.js";
import {
  createProviderModels,
  DEFAULT_MAX_STALENESS_MS,
  type ReadPersistedFn,
  type RunOneFn,
  type WritePersistedFn,
} from "./provider-models.js";

function model(provider: string, id: string): ModelCatalogEntry {
  return { provider, id, name: id };
}

function fakeDeps(overrides: {
  runOne?: RunOneFn;
  readPersisted?: ReadPersistedFn;
  writePersisted?: WritePersistedFn;
  now?: () => number;
  onError?: (params: { providerId: string; error: unknown }) => void;
} = {}) {
  let nowVal = 1_000_000;
  return {
    runOne: overrides.runOne ?? vi.fn(async ({ providerId }) => ({ models: [model(providerId, "x")] })),
    readPersisted: overrides.readPersisted ?? vi.fn(async () => null),
    writePersisted: overrides.writePersisted ?? vi.fn(async () => undefined),
    now: overrides.now ?? (() => nowVal),
    onError: overrides.onError ?? vi.fn(),
    advance: (delta: number) => {
      nowVal += delta;
    },
  };
}

describe("ProviderModels.getProviderModels", () => {
  it("returns persisted snapshot as fresh when within maxStaleness", async () => {
    const deps = fakeDeps({
      readPersisted: vi.fn(async () => ({
        models: [model("vllm", "qwen3-vl")],
        fetchedAt: 999_000,
      })),
    });
    const pm = createProviderModels(deps);

    const result = await pm.getProviderModels("vllm", { agentId: "main" });

    expect(result.freshness).toBe("fresh");
    expect(result.fetchedAt).toBe(999_000);
    expect(result.models.map((m) => m.id)).toEqual(["qwen3-vl"]);
    expect(deps.runOne).not.toHaveBeenCalled();
  });

  it("returns persisted snapshot as stale beyond maxStaleness and fires background refresh", async () => {
    const deps = fakeDeps({
      readPersisted: vi.fn(async () => ({
        models: [model("vllm", "qwen3-vl")],
        fetchedAt: 1_000_000 - DEFAULT_MAX_STALENESS_MS - 1,
      })),
      runOne: vi.fn(async ({ providerId }) => ({ models: [model(providerId, "qwen3-vl"), model(providerId, "qwen3-5")] })),
    });
    const pm = createProviderModels(deps);

    const result = await pm.getProviderModels("vllm", { agentId: "main" });

    expect(result.freshness).toBe("stale");
    expect(result.models).toHaveLength(1);

    // Background refresh kicked off; let it settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.runOne).toHaveBeenCalledExactlyOnceWith({
      providerId: "vllm",
      agentId: "main",
    });
    expect(deps.writePersisted).toHaveBeenCalledOnce();
  });

  it("returns missing when no persisted snapshot and kicks off discovery", async () => {
    const deps = fakeDeps({
      readPersisted: vi.fn(async () => null),
      runOne: vi.fn(async ({ providerId }) => ({ models: [model(providerId, "qwen3-vl")] })),
    });
    const pm = createProviderModels(deps);

    const result = await pm.getProviderModels("vllm", { agentId: "main" });

    expect(result.freshness).toBe("missing");
    expect(result.models).toEqual([]);
    expect(result.fetchedAt).toBe(0);

    await new Promise((r) => setTimeout(r, 0));
    expect(deps.runOne).toHaveBeenCalledOnce();
    expect(deps.writePersisted).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent refreshes onto a single runOne call", async () => {
    function deferredResult() {
      let resolve!: (models: ModelCatalogEntry[]) => void;
      const promise = new Promise<{ models: ModelCatalogEntry[] }>((res) => {
        resolve = (models) => res({ models });
      });
      return { promise, resolve };
    }
    const deferred = deferredResult();
    const runOne = vi.fn(() => deferred.promise);
    const deps = fakeDeps({ runOne, readPersisted: vi.fn(async () => null) });
    const pm = createProviderModels(deps);

    // Two concurrent callers — both should see "missing" immediately.
    const [a, b] = await Promise.all([
      pm.getProviderModels("vllm", { agentId: "main" }),
      pm.getProviderModels("vllm", { agentId: "main" }),
    ]);
    expect(a.freshness).toBe("missing");
    expect(b.freshness).toBe("missing");

    // runOne is deferred past the current task; flush the macrotask.
    await new Promise((r) => setTimeout(r, 0));
    expect(runOne).toHaveBeenCalledOnce();

    deferred.resolve([model("vllm", "qwen3-vl")]);
    await new Promise((r) => setTimeout(r, 0));

    // After refresh settles, next call serves from memory as fresh.
    const after = await pm.getProviderModels("vllm", { agentId: "main" });
    expect(after.freshness).toBe("fresh");
    expect(after.models).toHaveLength(1);
  });

  it("preserves stale snapshot when refresh throws a structured RunOneError", async () => {
    const deps = fakeDeps({
      readPersisted: vi.fn(async () => ({
        models: [model("vllm", "qwen3-vl")],
        fetchedAt: 1_000_000 - DEFAULT_MAX_STALENESS_MS - 1,
      })),
      runOne: vi.fn(async () => {
        throw new EndpointUnreachableError("vllm endpoint unreachable");
      }),
    });
    const pm = createProviderModels(deps);

    const result = await pm.getProviderModels("vllm", { agentId: "main" });
    expect(result.freshness).toBe("stale");
    expect(result.models).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 0));

    // Structured errors are NOT reported via onError.
    expect(deps.onError).not.toHaveBeenCalled();

    // Stale snapshot is still served on subsequent calls.
    const again = await pm.getProviderModels("vllm", { agentId: "main" });
    expect(again.freshness).toBe("stale");
    expect(again.models).toHaveLength(1);
  });

  it("does not crash on persistence write failure; future reads still serve memory", async () => {
    const onError = vi.fn();
    const deps = fakeDeps({
      readPersisted: vi.fn(async () => null),
      runOne: vi.fn(async () => ({ models: [model("vllm", "qwen3-vl")] })),
      writePersisted: vi.fn(async () => {
        throw new Error("disk full");
      }),
      onError,
    });
    const pm = createProviderModels(deps);

    await pm.getProviderModels("vllm", { agentId: "main" });
    await new Promise((r) => setTimeout(r, 0));

    expect(onError).toHaveBeenCalledOnce();
    const next = await pm.getProviderModels("vllm", { agentId: "main" });
    // Memory hit — refresh ran, populated in-memory entry, write failure was non-fatal.
    expect(next.freshness).toBe("fresh");
    expect(next.models).toHaveLength(1);
  });

  it("isolates cache by agentId", async () => {
    const reads: string[] = [];
    const deps = fakeDeps({
      readPersisted: vi.fn(async ({ agentId }) => {
        reads.push(agentId ?? "");
        return {
          models: [model("vllm", `for-${agentId}`)],
          fetchedAt: 999_000,
        };
      }),
    });
    const pm = createProviderModels(deps);

    const a = await pm.getProviderModels("vllm", { agentId: "main" });
    const b = await pm.getProviderModels("vllm", { agentId: "pearson" });

    expect(a.models[0].id).toBe("for-main");
    expect(b.models[0].id).toBe("for-pearson");
    expect(reads).toEqual(["main", "pearson"]);
  });

  it("defers the plugin runOne hook past the current task on refresh", async () => {
    // Regression: refresh used to invoke deps.runOne synchronously in the
    // same task as the caller. Plugin hooks with synchronous setup work
    // would still block channel ACK paths. (Codex review P2.)
    let syncRunOneStarts = 0;
    const runOne = vi.fn(async () => {
      syncRunOneStarts += 1;
      return { models: [model("vllm", "qwen3-vl")] };
    });
    const deps = fakeDeps({ readPersisted: vi.fn(async () => null), runOne });
    const pm = createProviderModels(deps);

    // Kick off discovery; the caller awaits getProviderModels but runOne
    // must NOT have been invoked yet (deferred past current task).
    const promise = pm.getProviderModels("vllm", { agentId: "main" });
    expect(syncRunOneStarts).toBe(0);
    await promise;
    expect(syncRunOneStarts).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(syncRunOneStarts).toBe(1);
  });

  it("ignores stale in-flight refresh results that resolve after invalidate", async () => {
    // Regression: invalidate dropped the inFlight slot, but the old refresh
    // promise kept running. If it resolved AFTER the new refresh, it would
    // overwrite memory + persisted with the stale result. (Codex review P2.)
    function deferred() {
      let resolve!: (m: ModelCatalogEntry[]) => void;
      const promise = new Promise<{ models: ModelCatalogEntry[] }>((res) => {
        resolve = (m) => res({ models: m });
      });
      return { promise, resolve };
    }
    const first = deferred();
    const second = deferred();
    let callIndex = 0;
    const runOne = vi.fn(() => {
      callIndex += 1;
      return callIndex === 1 ? first.promise : second.promise;
    });
    const writePersisted = vi.fn(async () => undefined);
    const deps = fakeDeps({
      readPersisted: vi.fn(async () => null),
      runOne,
      writePersisted,
    });
    const pm = createProviderModels(deps);

    // First call starts the first (stale) refresh.
    await pm.getProviderModels("vllm", { agentId: "main" });

    // User clicks refresh — invalidate bumps generation.
    pm.invalidate("vllm", "main");
    // Second call starts the new refresh.
    await pm.getProviderModels("vllm", { agentId: "main" });

    // Both refresh promises are in flight. Resolve the new one first.
    second.resolve([model("vllm", "fresh")]);
    await new Promise((r) => setTimeout(r, 5));

    // Now resolve the stale one — it MUST NOT overwrite.
    first.resolve([model("vllm", "stale")]);
    await new Promise((r) => setTimeout(r, 5));

    // Final state: only the fresh result was persisted.
    const final = await pm.getProviderModels("vllm", { agentId: "main" });
    expect(final.models[0]?.id).toBe("fresh");
    // writePersisted was called exactly once (by the fresh refresh; stale
    // was dropped because the generation had bumped).
    expect(writePersisted).toHaveBeenCalledTimes(1);
  });

  it("invalidate() drops any in-flight refresh so a follow-up call starts fresh", async () => {
    // Regression: invalidate() used to only drop the memory cache; if the
    // first-load refresh was still in flight, the follow-up getProviderModels
    // coalesced onto the pre-invalidate work and the visible refresh action
    // silently no-oped during the common first-load window. (Codex review P2.)
    function deferred() {
      let resolve!: (m: ModelCatalogEntry[]) => void;
      const promise = new Promise<{ models: ModelCatalogEntry[] }>((res) => {
        resolve = (m) => res({ models: m });
      });
      return { promise, resolve };
    }
    const first = deferred();
    const second = deferred();
    let callIndex = 0;
    const runOne = vi.fn(() => {
      callIndex += 1;
      return callIndex === 1 ? first.promise : second.promise;
    });
    const deps = fakeDeps({ readPersisted: vi.fn(async () => null), runOne });
    const pm = createProviderModels(deps);

    // First call kicks off the first refresh.
    await pm.getProviderModels("vllm", { agentId: "main" });
    await new Promise((r) => setTimeout(r, 0));
    expect(runOne).toHaveBeenCalledTimes(1);

    // User clicks refresh BEFORE the first discovery settles.
    pm.invalidate("vllm", "main");
    await pm.getProviderModels("vllm", { agentId: "main" });
    await new Promise((r) => setTimeout(r, 0));
    expect(runOne).toHaveBeenCalledTimes(2);

    // Tidy up to avoid an unhandled rejection.
    first.resolve([model("vllm", "stale")]);
    second.resolve([model("vllm", "fresh")]);
    await new Promise((r) => setTimeout(r, 0));
  });

  it("invalidate() drops the in-memory entry and re-reads from persistence", async () => {
    const readPersisted = vi.fn(async () => ({
      models: [model("vllm", "v1")],
      fetchedAt: 999_000,
    }));
    const deps = fakeDeps({ readPersisted });
    const pm = createProviderModels(deps);

    await pm.getProviderModels("vllm", { agentId: "main" });
    expect(readPersisted).toHaveBeenCalledOnce();

    // Second call hits memory.
    await pm.getProviderModels("vllm", { agentId: "main" });
    expect(readPersisted).toHaveBeenCalledOnce();

    pm.invalidate("vllm", "main");

    // After invalidate, falls back to persistence again.
    await pm.getProviderModels("vllm", { agentId: "main" });
    expect(readPersisted).toHaveBeenCalledTimes(2);
  });

  it("passes agentId through to the runOne refresh", async () => {
    // Regression: multi-agent gateways share provider ids across agents with
    // distinct credentials. Refresh must thread agentId so discovery resolves
    // the right agent's auth and workspace. (Codex review P2.)
    const runOne = vi.fn(async () => ({ models: [model("vllm", "qwen3-vl")] }));
    const deps = fakeDeps({ readPersisted: vi.fn(async () => null), runOne });
    const pm = createProviderModels(deps);

    await pm.getProviderModels("vllm", { agentId: "pearson" });
    await new Promise((r) => setTimeout(r, 0));

    expect(runOne).toHaveBeenCalledExactlyOnceWith({
      providerId: "vllm",
      agentId: "pearson",
    });
  });

  it("retries refresh on next call when memory-cached snapshot has fetchedAt: 0 after a prior failure", async () => {
    // Regression: after a legacy snapshot loads (fetchedAt: 0) and its first
    // refresh fails, the memory entry kept fetchedAt: 0. The memory-hit
    // branch classified it as "missing" and skipped the retry path (only
    // "stale" used to trigger refresh), stranding the user until process
    // restart. (Codex review P2.)
    let runOneShouldFail = true;
    const runOne = vi.fn(async () => {
      if (runOneShouldFail) {
        throw new (await import("./errors.js")).EndpointUnreachableError("transient");
      }
      return { models: [model("vllm", "qwen3-vl-fresh")] };
    });
    const deps = fakeDeps({
      readPersisted: vi.fn(async () => ({
        models: [model("vllm", "qwen3-vl-legacy")],
        fetchedAt: 0,
      })),
      runOne,
    });
    const pm = createProviderModels(deps);

    // First call: persisted-branch fires refresh; refresh fails.
    const first = await pm.getProviderModels("vllm", { agentId: "main" });
    expect(first.freshness).toBe("stale");
    await new Promise((r) => setTimeout(r, 0));
    expect(runOne).toHaveBeenCalledTimes(1);

    // Second call hits memory (also fetchedAt: 0). Without the fix, refresh
    // is never re-attempted. With the fix, refresh runs again.
    runOneShouldFail = false;
    await pm.getProviderModels("vllm", { agentId: "main" });
    await new Promise((r) => setTimeout(r, 0));
    expect(runOne).toHaveBeenCalledTimes(2);

    // After successful retry, the entry has a real fetchedAt and is fresh.
    const final = await pm.getProviderModels("vllm", { agentId: "main" });
    expect(final.freshness).toBe("fresh");
    expect(final.models[0]?.id).toBe("qwen3-vl-fresh");
  });

  it("treats persisted snapshot with fetchedAt: 0 as stale and triggers refresh", async () => {
    // Regression: pre-existing models.json files written by the canonical
    // writer do not carry the picker's __pickerWrittenAt marker, so they
    // surface with fetchedAt=0. Without this behavior, the persisted-branch
    // refresh check skipped them as "missing" and wildcard users on legacy
    // snapshots never re-discovered. (Codex review P2.)
    const deps = fakeDeps({
      readPersisted: vi.fn(async () => ({
        models: [model("vllm", "qwen3-vl")],
        fetchedAt: 0,
      })),
      runOne: vi.fn(async ({ providerId }) => ({ models: [model(providerId, "qwen3-vl"), model(providerId, "qwen3-5")] })),
    });
    const pm = createProviderModels(deps);

    const result = await pm.getProviderModels("vllm", { agentId: "main" });
    expect(result.freshness).toBe("stale");
    expect(result.models).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 0));
    expect(deps.runOne).toHaveBeenCalledOnce();
    expect(deps.writePersisted).toHaveBeenCalledOnce();
  });

  it("null runOne result is a no-op: preserves persisted snapshot, does not write empty", async () => {
    // Regression: provider hooks that return null (e.g.
    // discoverOpenAICompatibleSelfHostedProvider for explicit configs
    // without a wildcard) used to surface as empty model arrays here, and
    // writePersisted overwrote the persisted slice with an empty `models`.
    // The persisted catalog was erased. (Codex review P1.)
    const writePersisted = vi.fn(async () => undefined);
    const deps = fakeDeps({
      readPersisted: vi.fn(async () => ({
        models: [model("vllm", "qwen3-vl")],
        fetchedAt: 1_000_000 - DEFAULT_MAX_STALENESS_MS - 1,
      })),
      runOne: vi.fn(async () => null),
      writePersisted,
    });
    const pm = createProviderModels(deps);

    const result = await pm.getProviderModels("vllm", { agentId: "main" });
    expect(result.freshness).toBe("stale");
    expect(result.models).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 5));
    // null result is treated as no-op: no persist, persisted snapshot kept.
    expect(writePersisted).not.toHaveBeenCalled();

    // Subsequent calls keep serving the original persisted snapshot.
    const again = await pm.getProviderModels("vllm", { agentId: "main" });
    expect(again.models[0]?.id).toBe("qwen3-vl");
  });

  it("does not propagate structured RunOneError to onError when discovery fails", async () => {
    const onError = vi.fn();
    const deps = fakeDeps({
      readPersisted: vi.fn(async () => null),
      runOne: vi.fn(async () => {
        throw new AuthMissingError("no key");
      }),
      onError,
    });
    const pm = createProviderModels(deps);
    const result = await pm.getProviderModels("vllm", { agentId: "main" });

    expect(result.freshness).toBe("missing");
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).not.toHaveBeenCalled();
  });
});
