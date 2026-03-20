import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireAcpRuntimeBackend } from "../../../src/acp/runtime/registry.js";
import type { AcpRuntimeBackend } from "../../../src/acp/runtime/registry.js";
import { resolveStateDir } from "../../../src/config/paths.js";

export type OrchestratorJobStatus =
  | "accepted"
  | "planning"
  | "executing"
  | "waiting_approval"
  | "blocked"
  | "completed"
  | "failed";

export type StartJobRequest = {
  source?: string;
  sourceRef?: {
    intakeId?: string;
    linearIssueId?: string;
  };
  request?: {
    title?: string;
    requestedOutcome?: string;
    workType?: string;
    priority?: number;
    summary?: string;
  };
  routing?: {
    lane?: string;
    runtime?: string;
    workspaceHint?: {
      cwd?: string;
    };
  };
};

type JobRecord = {
  jobId: string;
  status: OrchestratorJobStatus;
  lane: string;
  runtime: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  sourceRef: {
    intakeId: string;
    linearIssueId: string;
  };
  runtimeLinkage?: {
    backend?: string;
    sessionKey?: string;
    agentSessionId?: string;
  };
  runtimeHandle?: {
    sessionKey: string;
    backend: string;
    runtimeSessionName: string;
    cwd?: string;
  };
};

type StoredJobRecord = JobRecord & {
  dispatchInput?: StartJobRequest;
};

type JobStateStore = {
  loadJobs: () => StoredJobRecord[];
  saveJobs: (jobs: StoredJobRecord[]) => void;
};

type RuntimeResult =
  | {
      ok: true;
      job: JobRecord;
      links?: { jobRef: string };
    }
  | {
      ok: false;
      error: {
        code: "INVALID_REQUEST" | "NOT_FOUND" | "RUNTIME_UNAVAILABLE";
        message: string;
      };
    };

type OrchestratorControlRuntimeDeps = {
  requireRuntimeBackend?: (id?: string) => AcpRuntimeBackend;
  scheduleDispatch?: (dispatch: () => void) => void;
  jobStateStore?: JobStateStore;
};

export function createOrchestratorControlRuntime(deps: OrchestratorControlRuntimeDeps = {}) {
  const jobStateStore = deps.jobStateStore ?? createFileBackedJobStateStore();
  const jobsById = new Map<string, StoredJobRecord>(
    jobStateStore.loadJobs().map((job) => [job.jobId, job]),
  );
  const requireRuntimeBackendImpl = deps.requireRuntimeBackend ?? requireAcpRuntimeBackend;
  const scheduleDispatch =
    deps.scheduleDispatch ?? ((dispatch: () => void) => queueMicrotask(dispatch));
  const persistJobs = () => {
    jobStateStore.saveJobs(
      [...jobsById.values()].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId),
      ),
    );
  };
  const upsertJob = (job: StoredJobRecord) => {
    jobsById.set(job.jobId, job);
    persistJobs();
  };
  const scheduleDispatchForJob = (job: StoredJobRecord, input: StartJobRequest) => {
    scheduleDispatch(() => {
      void prepareAndDispatchOpenAgentPlanTurn({
        job,
        input,
        requireRuntimeBackend: requireRuntimeBackendImpl,
        upsertJob,
      });
    });
  };

  for (const job of jobsById.values()) {
    if (job.status === "accepted" && !job.runtimeHandle && job.dispatchInput) {
      scheduleDispatchForJob(job, job.dispatchInput);
    }
  }

  return {
    async startJob(input: StartJobRequest): Promise<RuntimeResult> {
      const validationError = validateStartJob(input);
      if (validationError) {
        return invalidRequest(validationError);
      }

      const createdAt = new Date().toISOString();
      const jobId = `orch_${randomUUID().replace(/-/g, "")}`;
      const job: StoredJobRecord = {
        jobId,
        status: "accepted",
        lane: input.routing!.lane!,
        runtime: input.routing!.runtime ?? "openagent",
        createdAt,
        updatedAt: createdAt,
        summary: input.request?.summary ?? "Job accepted by orchestrator-control.",
        sourceRef: {
          intakeId: input.sourceRef!.intakeId!,
          linearIssueId: input.sourceRef!.linearIssueId!,
        },
        dispatchInput: cloneStartJobRequest(input),
      };
      upsertJob(job);
      scheduleDispatchForJob(job, job.dispatchInput!);

      return {
        ok: true,
        job: toPublicJobRecord(job),
        links: {
          jobRef: `orch:${jobId}`,
        },
      };
    },

    async getJobStatus(jobId: string): Promise<RuntimeResult> {
      if (!jobId) {
        return invalidRequest("jobId is required");
      }

      const job = jobsById.get(jobId);
      if (!job) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `job not found: ${jobId}`,
          },
        };
      }

      if (job.runtimeHandle && job.runtimeLinkage?.backend === "openagent-acp") {
        try {
          const backend = requireRuntimeBackendImpl("openagent-acp");
          const status = await backend.runtime.getStatus?.({
            handle: job.runtimeHandle,
          });
          if (status) {
            job.runtimeLinkage = {
              backend: "openagent-acp",
              sessionKey: job.runtimeLinkage?.sessionKey,
              agentSessionId: status.agentSessionId ?? job.runtimeLinkage?.agentSessionId,
            };
            job.summary = status.summary ?? job.summary;
            job.status = mapRuntimeStatusToJobStatus(
              status.details?.state,
              job.runtimeHandle.sessionKey,
            );
            job.updatedAt = new Date().toISOString();
            upsertJob(job);
          }
        } catch {
          // Preserve last known job state if status refresh fails.
        }
      }

      return {
        ok: true,
        job: toPublicJobRecord(job),
      };
    },
  };
}

function createFileBackedJobStateStore(
  filePath: string = path.join(
    resolveStateDir(process.env, os.homedir),
    "orchestrator-control",
    "jobs.json",
  ),
): JobStateStore {
  return {
    loadJobs() {
      if (!fs.existsSync(filePath)) {
        return [];
      }

      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) {
          return [];
        }

        return parsed.filter(isStoredJobRecord);
      } catch {
        return [];
      }
    },
    saveJobs(jobs) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(jobs, null, 2), "utf-8");
      fs.renameSync(tempPath, filePath);
    },
  };
}

function validateStartJob(input: StartJobRequest): string | null {
  if (input.source !== "orchestra-intake") {
    return "source must be orchestra-intake";
  }
  if (!input.sourceRef?.intakeId) {
    return "sourceRef.intakeId is required";
  }
  if (!input.sourceRef?.linearIssueId) {
    return "sourceRef.linearIssueId is required";
  }
  if (!input.request?.title) {
    return "request.title is required";
  }
  if (!input.request?.requestedOutcome) {
    return "request.requestedOutcome is required";
  }
  if (!input.request?.workType) {
    return "request.workType is required";
  }
  if (input.routing?.lane !== "engineering") {
    return "routing.lane must be engineering";
  }
  if (!input.routing?.workspaceHint?.cwd) {
    return "routing.workspaceHint.cwd is required for engineering lane";
  }
  return null;
}

function invalidRequest(message: string): RuntimeResult {
  return {
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message,
    },
  };
}

function isStoredJobRecord(value: unknown): value is StoredJobRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const job = value as Partial<StoredJobRecord>;
  return (
    typeof job.jobId === "string" &&
    typeof job.status === "string" &&
    typeof job.lane === "string" &&
    typeof job.runtime === "string" &&
    typeof job.createdAt === "string" &&
    typeof job.updatedAt === "string" &&
    typeof job.summary === "string" &&
    typeof job.sourceRef?.intakeId === "string" &&
    typeof job.sourceRef?.linearIssueId === "string"
  );
}

function cloneStartJobRequest(input: StartJobRequest): StartJobRequest {
  return JSON.parse(JSON.stringify(input)) as StartJobRequest;
}

function toPublicJobRecord(job: StoredJobRecord): JobRecord {
  const { dispatchInput: _dispatchInput, ...publicJob } = job;
  return { ...publicJob };
}

async function dispatchOpenAgentPlanTurn(params: {
  job: StoredJobRecord;
  input: StartJobRequest;
  upsertJob: (job: StoredJobRecord) => void;
  runtime: AcpRuntimeBackend["runtime"];
}): Promise<void> {
  const { job, input, upsertJob, runtime } = params;
  if (!job.runtimeHandle) {
    return;
  }

  job.status = "planning";
  job.summary = "OpenAgent planning phase started.";
  job.updatedAt = new Date().toISOString();
  upsertJob(job);

  try {
    for await (const _event of runtime.runTurn({
      handle: job.runtimeHandle,
      text: buildPlanningPrompt(input),
      mode: "prompt",
      requestId: `orch-start-${job.jobId}`,
    })) {
      // Status refresh happens after the turn completes.
    }

    const status = await runtime.getStatus?.({
      handle: job.runtimeHandle,
    });
    job.runtimeLinkage = {
      backend: "openagent-acp",
      sessionKey: job.runtimeHandle.sessionKey,
      agentSessionId: status?.agentSessionId ?? job.runtimeLinkage?.agentSessionId,
    };
    job.summary = status?.summary ?? "OpenAgent plan turn completed.";
    job.status = mapRuntimeStatusToJobStatus(status?.details?.state, job.runtimeHandle.sessionKey);
    job.updatedAt = new Date().toISOString();
    upsertJob(job);
  } catch (error) {
    job.status = "failed";
    job.summary = error instanceof Error ? error.message : String(error);
    job.updatedAt = new Date().toISOString();
    upsertJob(job);
  }
}

async function prepareAndDispatchOpenAgentPlanTurn(params: {
  job: StoredJobRecord;
  input: StartJobRequest;
  upsertJob: (job: StoredJobRecord) => void;
  requireRuntimeBackend: (id?: string) => AcpRuntimeBackend;
}): Promise<void> {
  const { job, input, upsertJob, requireRuntimeBackend } = params;

  try {
    const backend = requireRuntimeBackend("openagent-acp");
    const sessionKey = `agent:orchestrator:acp:openagent:plan:${job.jobId}`;
    const handle = await backend.runtime.ensureSession({
      sessionKey,
      agent: "orchestrator",
      mode: "persistent",
      cwd: input.routing!.workspaceHint!.cwd,
    });
    job.runtimeLinkage = {
      backend: handle.backend,
      sessionKey,
      agentSessionId: handle.agentSessionId,
    };
    job.runtimeHandle = handle;
    job.updatedAt = new Date().toISOString();
    upsertJob(job);

    await dispatchOpenAgentPlanTurn({
      job,
      input,
      upsertJob,
      runtime: backend.runtime,
    });
  } catch (error) {
    job.status = "failed";
    job.summary = error instanceof Error ? error.message : String(error);
    job.updatedAt = new Date().toISOString();
    upsertJob(job);
  }
}

function buildPlanningPrompt(input: StartJobRequest): string {
  return [
    `Title: ${input.request?.title ?? ""}`,
    `Requested outcome: ${input.request?.requestedOutcome ?? ""}`,
    `Work type: ${input.request?.workType ?? ""}`,
    `Summary: ${input.request?.summary ?? ""}`,
    `Linear issue: ${input.sourceRef?.linearIssueId ?? ""}`,
    "",
    "Start the engineering planning turn for this orchestrator-owned job.",
  ].join("\n");
}

function mapRuntimeStatusToJobStatus(
  runtimeState: unknown,
  sessionKey: string,
): OrchestratorJobStatus {
  if (runtimeState === "parked") {
    return "waiting_approval";
  }
  if (runtimeState === "completed") {
    return "completed";
  }
  if (runtimeState === "failed") {
    return "failed";
  }
  return sessionKey.includes(":plan:") ? "planning" : "executing";
}
