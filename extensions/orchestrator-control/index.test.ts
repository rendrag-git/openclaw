import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayRequestHandler, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../test-utils/plugin-api.js";
import plugin from "./index.js";

describe("orchestrator-control plugin", () => {
  it("registers start_job and get_job_status gateway methods", () => {
    const registerGatewayMethod = vi.fn();

    plugin.register?.(
      createTestPluginApi({
        id: "orchestrator-control",
        name: "Orchestrator Control",
        description: "Orchestrator control surface",
        source: "test",
        config: {},
        runtime: {} as never,
        registerGatewayMethod,
      }),
    );

    expect(registerGatewayMethod.mock.calls.map((call) => call[0])).toEqual([
      "orchestrator-control.start_job",
      "orchestrator-control.get_job_status",
    ]);
  });

  it("creates a job and returns an accepted response before runtime dispatch", async () => {
    const handlers = registerHandlers();

    const start = await invoke(handlers["orchestrator-control.start_job"], {
      source: "orchestra-intake",
      sourceRef: {
        intakeId: "intake_123",
        linearIssueId: "REN-999",
      },
      request: {
        title: "Implement first orchestrator-backed loop",
        requestedOutcome: "Prove the first direct orchestrator-backed engineering loop.",
        workType: "Implementation",
      },
      routing: {
        lane: "engineering",
        runtime: "openagent",
        workspaceHint: {
          cwd: "/tmp/example-repo",
        },
      },
    });

    expect(start.ok).toBe(true);
    expect(start.payload).toMatchObject({
      ok: true,
      job: {
        status: "accepted",
        lane: "engineering",
        runtime: "openagent",
      },
      links: {
        jobRef: expect.stringMatching(/^orch:/),
      },
    });

    const jobId = String((start.payload as { job: { jobId: string } }).job.jobId);
    const status = await invoke(handlers["orchestrator-control.get_job_status"], { jobId });

    expect(status.ok).toBe(true);
    expect(status.payload).toMatchObject({
      ok: true,
      job: {
        jobId,
        sourceRef: {
          intakeId: "intake_123",
          linearIssueId: "REN-999",
        },
      },
    });
  });

  it("rejects engineering jobs without a workspace hint", async () => {
    const handlers = registerHandlers();

    const result = await invoke(handlers["orchestrator-control.start_job"], {
      source: "orchestra-intake",
      sourceRef: {
        intakeId: "intake_123",
        linearIssueId: "REN-999",
      },
      request: {
        title: "Implement first orchestrator-backed loop",
        requestedOutcome: "Prove the first direct orchestrator-backed engineering loop.",
        workType: "Implementation",
      },
      routing: {
        lane: "engineering",
        runtime: "openagent",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.payload).toEqual({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "routing.workspaceHint.cwd is required for engineering lane",
      },
    });
  });

  it("ships an empty config schema so install validation can accept the manifest", async () => {
    const manifestPath = path.join(
      process.cwd(),
      "extensions",
      "orchestrator-control",
      "openclaw.plugin.json",
    );
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      configSchema?: unknown;
    };

    expect(manifest.configSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });
});

function registerHandlers(): Record<string, GatewayRequestHandler> {
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
