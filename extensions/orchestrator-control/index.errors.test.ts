import type { GatewayRequestHandler, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../test-utils/plugin-api.js";

describe("orchestrator-control plugin error handling", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns a structured error when start_job throws", async () => {
    const plugin = await importPluginWithRuntime({
      startJob: vi.fn(async () => {
        throw new Error("start exploded");
      }),
      getJobStatus: vi.fn(async () => ({ ok: true, job: { jobId: "ignored" } })),
    });
    const handlers = registerHandlers(plugin);

    const result = await invoke(handlers["orchestrator-control.start_job"], {});

    expect(result.ok).toBe(false);
    expect(result.payload).toEqual({
      ok: false,
      error: {
        code: "RUNTIME_UNAVAILABLE",
        message: "start exploded",
      },
    });
  });

  it("returns a structured error when get_job_status throws", async () => {
    const plugin = await importPluginWithRuntime({
      startJob: vi.fn(async () => ({ ok: true, job: { jobId: "ignored" } })),
      getJobStatus: vi.fn(async () => {
        throw new Error("status exploded");
      }),
    });
    const handlers = registerHandlers(plugin);

    const result = await invoke(handlers["orchestrator-control.get_job_status"], {
      jobId: "orch_test",
    });

    expect(result.ok).toBe(false);
    expect(result.payload).toEqual({
      ok: false,
      error: {
        code: "RUNTIME_UNAVAILABLE",
        message: "status exploded",
      },
    });
  });
});

async function importPluginWithRuntime(runtime: {
  startJob: (input: unknown) => Promise<unknown>;
  getJobStatus: (jobId: string) => Promise<unknown>;
}) {
  vi.doMock("./src/runtime.js", () => ({
    createOrchestratorControlRuntime: () => runtime,
  }));

  return (await import("./index.js")).default;
}

function registerHandlers(plugin: { register?: OpenClawPluginApi["register"] }) {
  const handlers: Record<string, GatewayRequestHandler> = {};

  plugin.register?.(
    createTestPluginApi({
      id: "orchestrator-control",
      name: "Orchestrator Control",
      description: "Orchestrator control surface",
      source: "test",
      config: {},
      runtime: {} as never,
      registerGatewayMethod(method: string, handler: GatewayRequestHandler) {
        handlers[method] = handler;
      },
    }) as unknown as OpenClawPluginApi,
  );

  return handlers;
}

async function invoke(handler: GatewayRequestHandler | undefined, params: Record<string, unknown>) {
  expect(handler).toBeDefined();

  let payload: unknown;
  let ok = false;

  await handler?.({
    req: { id: "req_1", method: "test", params } as never,
    params,
    client: null,
    isWebchatConnect: () => false,
    respond(nextOk, nextPayload) {
      ok = nextOk;
      payload = nextPayload;
    },
    context: {} as never,
  });

  return { ok, payload };
}
