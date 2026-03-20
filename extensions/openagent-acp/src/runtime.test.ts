import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runAcpRuntimeAdapterContract } from "../../../src/acp/runtime/adapter-contract.testkit.js";
import { OpenAgentAcpRuntime } from "./runtime.js";

function createAdapterStub() {
  const ensureSession = vi.fn((input) => input);
  const runTurn = vi.fn(async ({ handle, text }) => ({
    state: "completed" as const,
    summary: `${handle.worker} completed`,
    result: {
      success: true,
      output: `echo:${text}`,
      filesChanged: [],
      questions: [],
      sessionId: `sess-${randomUUID()}`,
      stopReason: "end_turn" as const,
      costUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
      },
    },
    runtimeLinkage: {
      backend: "openagent",
      sessionKey: handle.sessionKey,
      agentSessionId: `sess-${randomUUID()}`,
    },
  }));
  const resumeTurn = vi.fn(async ({ sessionId, answer }) => ({
    state: "completed" as const,
    summary: "plan completed",
    result: {
      success: true,
      output: `resumed:${answer}`,
      filesChanged: [],
      questions: [],
      sessionId,
      stopReason: "end_turn" as const,
      costUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
      },
    },
    runtimeLinkage: {
      backend: "openagent",
      sessionKey: `agent:orchestrator:acp:openagent:plan:${sessionId}`,
      agentSessionId: sessionId,
    },
  }));
  const getSessionStatus = vi.fn(async (sessionId: string) => ({
    state: "parked" as const,
    summary: "plan waiting for orchestrator feedback: Need approval",
    sessionId,
    worker: "plan",
    jobId: "orch_test_job",
    jobDir: "/tmp/openagent-job",
    question: {
      id: "q_1",
      text: "Need approval",
      timestamp: "2026-03-18T00:00:00.000Z",
      answered: false,
    },
  }));
  return {
    ensureSession,
    runTurn,
    resumeTurn,
    getSessionStatus,
  };
}

describe("OpenAgentAcpRuntime", () => {
  it("passes the shared ACP adapter contract suite", async () => {
    const adapter = createAdapterStub();
    const runtime = new OpenAgentAcpRuntime(
      {
        modulePath: "/tmp/openagent/src/acp-runtime.ts",
        parkedSessionDir: "/tmp/openagent-parked",
        jobRootDir: "/tmp/openagent-jobs",
      },
      {
        loadAdapter: async () => adapter,
      },
    );

    await runAcpRuntimeAdapterContract({
      createRuntime: async () => runtime,
      agentId: "orchestrator",
      successPrompt: "contract-pass",
      includeControlChecks: true,
      assertSuccessEvents: (events) => {
        expect(events.some((event) => event.type === "text_delta")).toBe(true);
        expect(events.some((event) => event.type === "done")).toBe(true);
      },
    });
  });

  it("uses parked session state to resume the next ACP turn and reports status linkage", async () => {
    const adapter = createAdapterStub();
    adapter.runTurn.mockResolvedValueOnce({
      state: "parked",
      summary: "plan parked for orchestrator feedback",
      result: {
        success: false,
        output: "Plan parked for feedback: Need approval",
        filesChanged: [],
        questions: [
          {
            id: "q_1",
            text: "Need approval",
            timestamp: "2026-03-18T00:00:00.000Z",
            answered: false,
          },
        ],
        parkedQuestion: {
          id: "q_1",
          text: "Need approval",
          timestamp: "2026-03-18T00:00:00.000Z",
          answered: false,
        },
        sessionId: "sess_parked_1",
        stopReason: "parked",
        costUsd: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 1,
        },
      },
      runtimeLinkage: {
        backend: "openagent",
        sessionKey: "agent:orchestrator:acp:openagent:plan:orch_test_job",
        agentSessionId: "sess_parked_1",
      },
      question: {
        id: "q_1",
        text: "Need approval",
        timestamp: "2026-03-18T00:00:00.000Z",
        answered: false,
      },
    });

    const runtime = new OpenAgentAcpRuntime(
      {
        modulePath: "/tmp/openagent/src/acp-runtime.ts",
        parkedSessionDir: "/tmp/openagent-parked",
        jobRootDir: "/tmp/openagent-jobs",
      },
      {
        loadAdapter: async () => adapter,
      },
    );

    const handle = await runtime.ensureSession({
      sessionKey: "agent:orchestrator:acp:openagent:plan:orch_test_job",
      agent: "orchestrator",
      mode: "persistent",
      cwd: "/tmp/repo",
    });

    const firstTurnEvents = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "Plan the work",
      mode: "prompt",
      requestId: "req_1",
    })) {
      firstTurnEvents.push(event);
    }

    expect(firstTurnEvents).toContainEqual({
      type: "done",
      stopReason: "parked",
    });

    const status = await runtime.getStatus?.({ handle });
    expect(status).toMatchObject({
      summary: "plan waiting for orchestrator feedback: Need approval",
      agentSessionId: "sess_parked_1",
      details: {
        state: "parked",
        worker: "plan",
      },
    });

    const secondTurnEvents = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "Approve approach A",
      mode: "prompt",
      requestId: "req_2",
    })) {
      secondTurnEvents.push(event);
    }

    expect(adapter.resumeTurn).toHaveBeenCalledWith({
      sessionId: "sess_parked_1",
      answer: "Approve approach A",
    });
    expect(secondTurnEvents).toContainEqual({
      type: "done",
      stopReason: "end_turn",
    });
  });
});
