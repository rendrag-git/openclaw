import { describe, expect, it, vi } from "vitest";
import { createPickerRegistry } from "./picker.js";
import type { ProviderModels } from "./provider-models.js";
import type { PickerKey } from "./types.js";

function fakeProviderModels(
  byProvider: Record<string, { models: string[]; freshness?: "fresh" | "stale" | "missing" }>,
): { providerModels: ProviderModels; getCalls: { providerId: string }[] } {
  const getCalls: { providerId: string }[] = [];
  const providerModels: ProviderModels = {
    async getProviderModels(providerId) {
      getCalls.push({ providerId });
      const entry = byProvider[providerId];
      if (!entry) {
        return { models: [], fetchedAt: 0, freshness: "missing" };
      }
      return {
        models: entry.models.map((id) => ({ provider: providerId, id, name: id })),
        fetchedAt: 1_000_000,
        freshness: entry.freshness ?? "fresh",
      };
    },
    invalidate: vi.fn(),
  };
  return { providerModels, getCalls };
}

function key(extra: Partial<PickerKey> = {}): PickerKey {
  return {
    channel: "discord",
    accountId: "default",
    userId: "u1",
    interactionRoot: "i1",
    ...extra,
  };
}

describe("PickerRegistry", () => {
  it("hydrates a provider's catalog on selectProvider", async () => {
    const { providerModels, getCalls } = fakeProviderModels({
      vllm: { models: ["qwen3-vl", "qwen3-5"] },
    });
    const reg = createPickerRegistry({ providerModels });

    const picker = reg.openPicker(key(), { agentId: "main" });
    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });

    expect(getCalls).toEqual([{ providerId: "vllm" }]);
    expect(picker.snapshot().selection.provider).toBe("vllm");
    expect(picker.snapshot().catalog.get("vllm")?.map((m) => m.id)).toEqual([
      "qwen3-vl",
      "qwen3-5",
    ]);
    expect(picker.snapshot().pagination.modelPage).toBe(1);
  });

  it("reuses cached catalog across clicks within the same session", async () => {
    const { providerModels, getCalls } = fakeProviderModels({
      vllm: { models: ["qwen3-vl"] },
    });
    const reg = createPickerRegistry({ providerModels });
    const picker = reg.openPicker(key());

    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });
    await picker.dispatch({ kind: "selectModel", provider: "vllm", model: "qwen3-vl" });
    await picker.dispatch({ kind: "back", to: "models" });
    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });

    // Second selectProvider serves from the in-session catalog, no extra fetch.
    expect(getCalls).toHaveLength(1);
  });

  it("isolates sessions by key", async () => {
    const { providerModels, getCalls } = fakeProviderModels({
      vllm: { models: ["qwen3-vl"] },
    });
    const reg = createPickerRegistry({ providerModels });

    const a = reg.openPicker(key({ userId: "u1" }));
    const b = reg.openPicker(key({ userId: "u2" }));
    await a.dispatch({ kind: "selectProvider", provider: "vllm" });
    await b.dispatch({ kind: "selectProvider", provider: "vllm" });

    expect(getCalls).toHaveLength(2);
    expect(a.snapshot()).not.toBe(b.snapshot());
  });

  it("reset clears state but keeps the session entry alive", async () => {
    const { providerModels } = fakeProviderModels({ vllm: { models: ["qwen3-vl"] } });
    const reg = createPickerRegistry({ providerModels });
    const picker = reg.openPicker(key());

    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });
    await picker.dispatch({ kind: "reset" });

    expect(picker.snapshot().selection.provider).toBeUndefined();
    expect(picker.snapshot().catalog.size).toBe(0);
  });

  it("refreshCatalog invalidates and re-hydrates even when session has cached models", async () => {
    // Regression: hydrateProvider short-circuited when state.catalog already
    // had a non-empty slice for the provider. The refresh button became a
    // no-op for users who'd already opened that provider's page. (Codex P2.)
    const { providerModels, getCalls } = fakeProviderModels({
      vllm: { models: ["qwen3-vl"] },
    });
    const reg = createPickerRegistry({ providerModels });
    const picker = reg.openPicker(key());

    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });
    expect(getCalls).toHaveLength(1);
    expect(picker.snapshot().catalog.get("vllm")).toHaveLength(1);

    // Cached slice is present. Refresh must still re-fetch.
    await picker.dispatch({ kind: "refreshCatalog", providerId: "vllm" });
    expect(providerModels.invalidate).toHaveBeenCalledWith("vllm", undefined);
    expect(getCalls).toHaveLength(2);
  });

  it("paginateProvider/paginateModel adjust pagination, never below 1", async () => {
    const { providerModels } = fakeProviderModels({ vllm: { models: ["qwen3-vl"] } });
    const reg = createPickerRegistry({ providerModels });
    const picker = reg.openPicker(key());

    await picker.dispatch({ kind: "paginateProvider", delta: -1 });
    expect(picker.snapshot().pagination.providerPage).toBe(1);

    await picker.dispatch({ kind: "paginateProvider", delta: 1 });
    expect(picker.snapshot().pagination.providerPage).toBe(2);

    await picker.dispatch({ kind: "paginateModel", delta: 1 });
    expect(picker.snapshot().pagination.modelPage).toBe(2);
  });

  it("snapshot returns a defensive copy so renderers cannot mutate session state", async () => {
    // Regression: snapshot() used to expose the live state. Channel renderers
    // sorting/clearing/annotating in place could corrupt subsequent
    // interactions on the same session. (Codex review P2.)
    const { providerModels } = fakeProviderModels({ vllm: { models: ["qwen3-vl"] } });
    const reg = createPickerRegistry({ providerModels });
    const picker = reg.openPicker(key());

    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });
    const snap = picker.snapshot();

    // Hostile renderer behavior: mutate the snapshot's collections.
    snap.catalog.clear();
    snap.allowlist.add("hacker/model");
    snap.recents.push("hacker/recent");
    snap.selection.provider = "wrong";

    // The session state remains intact.
    const fresh = picker.snapshot();
    expect(fresh.catalog.get("vllm")?.map((m) => m.id)).toEqual(["qwen3-vl"]);
    expect(fresh.allowlist.has("hacker/model")).toBe(false);
    expect(fresh.recents).toEqual([]);
    expect(fresh.selection.provider).toBe("vllm");
  });

  it("snapshot deep-clones per-provider model arrays so renderers can't mutate them in place", async () => {
    // Regression: shallow Map clone still shared the inner arrays — a
    // renderer sorting/annotating in place corrupted the live session.
    // (Codex review P2.)
    const { providerModels } = fakeProviderModels({
      vllm: { models: ["b-model", "a-model"] },
    });
    const reg = createPickerRegistry({ providerModels });
    const picker = reg.openPicker(key());
    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });

    const snap = picker.snapshot();
    const arr = snap.catalog.get("vllm");
    arr?.sort((a, b) => a.id.localeCompare(b.id));
    arr?.splice(0, arr.length);

    const fresh = picker.snapshot();
    expect(fresh.catalog.get("vllm")?.map((m) => m.id)).toEqual(["b-model", "a-model"]);
  });

  it("snapshot also deep-clones individual model entry objects", async () => {
    // Regression: cloning only the outer Map+array still shared the
    // ModelCatalogEntry objects. Channel renderers that added UI-only
    // fields or normalized labels in place would corrupt the live session.
    // (Codex review P2.)
    const { providerModels } = fakeProviderModels({ vllm: { models: ["qwen3-vl"] } });
    const reg = createPickerRegistry({ providerModels });
    const picker = reg.openPicker(key());
    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });

    const snap = picker.snapshot();
    const entry = snap.catalog.get("vllm")?.[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    // Hostile renderer mutates the entry.
    (entry as { decorated?: string }).decorated = "ui-label";
    entry.name = "renamed-in-place";

    const fresh = picker.snapshot();
    const liveEntry = fresh.catalog.get("vllm")?.[0];
    expect(liveEntry?.name).toBe("qwen3-vl");
    expect((liveEntry as { decorated?: string }).decorated).toBeUndefined();
  });

  it("sweepExpired drops sessions past TTL", async () => {
    let nowVal = 0;
    const { providerModels } = fakeProviderModels({ vllm: { models: ["qwen3-vl"] } });
    const reg = createPickerRegistry({ providerModels, now: () => nowVal });

    const picker = reg.openPicker(key());
    await picker.dispatch({ kind: "selectProvider", provider: "vllm" });

    nowVal = 4 * 60 * 1000; // within TTL
    expect(reg.sweepExpired()).toBe(0);

    nowVal = 6 * 60 * 1000; // past TTL
    expect(reg.sweepExpired()).toBe(1);
    expect(reg.sweepExpired()).toBe(0);
  });
});
