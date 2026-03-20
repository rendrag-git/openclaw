import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorControlRuntime } from "./runtime.js";

function createBackendStub() {
  const runtime = {
    ensureSession: vi.fn(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "openagent-acp",
      runtimeSessionName: input.sessionKey,
      cwd: input.cwd,
    })),
    runTurn: vi.fn(async function* () {
      yield {
        type: "text_delta" as const,
        text: "Planned the work.",
        stream: "output" as const,
      };
      yield {
        type: "done" as const,
        stopReason: "end_turn",
      };
    }),
    getStatus: vi.fn(async ({ handle }) => ({
      summary: "OpenAgent plan turn completed.",
      agentSessionId: "sess_runtime_1",
      details: {
        state: "completed",
        worker: "plan",
      },
    })),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };

  return {
    id: "openagent-acp",
    runtime,
    healthy: () => true,
  };
}

function createMemoryJobStateStore() {
  let snapshot: unknown[] = [];

  return {
    loadJobs() {
      return JSON.parse(JSON.stringify(snapshot)) as unknown[];
    },
    saveJobs(jobs: unknown[]) {
      snapshot = JSON.parse(JSON.stringify(jobs)) as unknown[];
    },
  };
}

function buildStartJobRequest() {
  return {
    source: "orchestra-intake" as const,
    sourceRef: {
      intakeId: "intake_123",
      linearIssueId: "REN-999",
    },
    request: {
      title: "Implement first orchestrator-backed loop",
      requestedOutcome: "Prove the first direct orchestrator-backed engineering loop.",
      workType: "Implementation",
      summary: "Controller validated the issue.",
    },
    routing: {
      lane: "engineering" as const,
      runtime: "openagent" as const,
      workspaceHint: {
        cwd: "/tmp/example-repo",
      },
    },
  };
}

describe("orchestrator-control runtime", () => {
  it("dispatches an engineering job through the openagent ACP backend and exposes linkage", async () => {
    const backend = createBackendStub();
    const runtime = createOrchestratorControlRuntime({
      requireRuntimeBackend: vi.fn(() => backend),
      jobStateStore: createMemoryJobStateStore() as never,
    });

    const start = await runtime.startJob(buildStartJobRequest());

    expect(start.ok).toBe(true);
    if (!start.ok) {
      throw new Error("expected job creation to succeed");
    }

    await vi.waitFor(async () => {
      const status = await runtime.getJobStatus(start.job.jobId);
      expect(status).toMatchObject({
        ok: true,
        job: {
          jobId: start.job.jobId,
          status: "completed",
          runtimeLinkage: {
            backend: "openagent-acp",
            sessionKey: expect.stringContaining(start.job.jobId),
            agentSessionId: "sess_runtime_1",
          },
          summary: "OpenAgent plan turn completed.",
        },
      });
    });
  });

  it("reloads accepted jobs after restart and resumes the planning dispatch", async () => {
    const backend = createBackendStub();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-control-runtime-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const runtime = createOrchestratorControlRuntime({
        requireRuntimeBackend: vi.fn(() => backend),
        scheduleDispatch: () => {},
      });

      const start = await runtime.startJob(buildStartJobRequest());
      expect(start.ok).toBe(true);
      if (!start.ok) {
        throw new Error("expected job creation to succeed");
      }

      const restarted = createOrchestratorControlRuntime({
        requireRuntimeBackend: vi.fn(() => backend),
      });

      await vi.waitFor(async () => {
        const status = await restarted.getJobStatus(start.job.jobId);
        expect(status).toMatchObject({
          ok: true,
          job: {
            jobId: start.job.jobId,
            status: "completed",
            runtimeLinkage: {
              backend: "openagent-acp",
              sessionKey: expect.stringContaining(start.job.jobId),
              agentSessionId: "sess_runtime_1",
            },
            summary: "OpenAgent plan turn completed.",
          },
        });
      });

      expect(backend.runtime.ensureSession).toHaveBeenCalledTimes(1);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
