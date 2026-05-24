import { describe, expect, it, vi } from "vitest";
import { createModelSwitch } from "./model-switch.js";
import type { ModelRef, ModelSwitchRequest } from "./types.js";

function req(overrides: Partial<ModelSwitchRequest> = {}): ModelSwitchRequest {
  return {
    sessionKey: {
      channel: "discord",
      accountId: "default",
      userId: "u1",
      interactionRoot: "i1",
    },
    fromRef: { provider: "openai", model: "gpt-5.5" },
    toRef: { provider: "vllm", model: "qwen3-vl" },
    ...overrides,
  };
}

describe("ModelSwitch.applySelection", () => {
  it("persists the override and returns applied synchronously", async () => {
    let capturedPersist:
      | Parameters<Parameters<typeof createModelSwitch>[0]["persistOverride"]>[0]
      | undefined;
    const persistOverride = vi.fn(async (params: typeof capturedPersist) => {
      capturedPersist = params;
    });
    const ms = createModelSwitch({ persistOverride });

    const result = await ms.applySelection(req());

    expect(result.result).toBe("applied");
    expect(persistOverride).toHaveBeenCalledOnce();
    expect(capturedPersist?.toRef).toEqual({
      provider: "vllm",
      model: "qwen3-vl",
    });
  });

  it("reports cross-runtime harnesses affected when runtimes differ", async () => {
    const ms = createModelSwitch({
      persistOverride: async () => undefined,
      resolveRuntime: (ref: ModelRef) => (ref.provider === "openai" ? "codex" : "pi"),
    });

    const result = await ms.applySelection(req());

    expect(result.result).toBe("applied");
    expect(result.harnessesAffected).toEqual(["pi", "codex"]);
    expect(result.message).toContain("runtime change deferred");
  });

  it("persists the resolved target runtime when caller omits the runtime field", async () => {
    // Regression: when applySelection acknowledged a cross-runtime switch
    // via resolveRuntime, the persist call only included the (undefined)
    // caller-passed runtime. The next agent turn replayed the previous
    // harness even though we'd reported the change. (Codex review P2.)
    let capturedPersist:
      | Parameters<Parameters<typeof createModelSwitch>[0]["persistOverride"]>[0]
      | undefined;
    const persistOverride = vi.fn(async (params: typeof capturedPersist) => {
      capturedPersist = params;
    });
    const ms = createModelSwitch({
      persistOverride,
      resolveRuntime: (ref: ModelRef) => (ref.provider === "openai" ? "codex" : "pi"),
    });

    await ms.applySelection(req()); // omits explicit runtime

    expect(capturedPersist?.runtime).toBe("pi");
  });

  it("reports no harnesses affected when runtimes match", async () => {
    const ms = createModelSwitch({
      persistOverride: async () => undefined,
      resolveRuntime: () => "pi",
    });

    const result = await ms.applySelection(req());
    expect(result.harnessesAffected).toEqual([]);
    expect(result.message).not.toContain("runtime change");
  });

  it("returns rejected when persistOverride throws", async () => {
    const ms = createModelSwitch({
      persistOverride: async () => {
        throw new Error("session store offline");
      },
    });

    const result = await ms.applySelection(req());

    expect(result.result).toBe("rejected");
    expect(result.harnessesAffected).toEqual([]);
    expect(result.message).toContain("session store offline");
  });

  it("invokes onSwitch hook with request and result", async () => {
    let captured:
      | Parameters<NonNullable<Parameters<typeof createModelSwitch>[0]["onSwitch"]>>[0]
      | undefined;
    const onSwitch = vi.fn((payload: typeof captured) => {
      captured = payload;
    });
    const ms = createModelSwitch({
      persistOverride: async () => undefined,
      onSwitch,
    });
    await ms.applySelection(req());

    expect(onSwitch).toHaveBeenCalledOnce();
    expect(captured).toBeDefined();
    expect(captured?.request.toRef).toEqual({ provider: "vllm", model: "qwen3-vl" });
    expect(captured?.result.result).toBe("applied");
  });
});
