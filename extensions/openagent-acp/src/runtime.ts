import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  PluginLogger,
} from "openclaw/plugin-sdk/acpx";
import { AcpRuntimeError } from "openclaw/plugin-sdk/acpx";
import type { ResolvedOpenAgentAcpPluginConfig } from "./config.js";

export const OPENAGENT_ACP_BACKEND_ID = "openagent-acp";

const OPENAGENT_RUNTIME_HANDLE_PREFIX = "openagent-acp:v1:";
const OPENAGENT_ACP_CAPABILITIES: AcpRuntimeCapabilities = {
  controls: ["session/status"],
};

type OpenAgentWorker = "plan" | "execute" | "check" | "act";

type OpenAgentRuntimeLinkage = {
  backend: string;
  sessionKey: string;
  agentSessionId?: string;
};

type OpenAgentRuntimeTurnResult = {
  state: "completed" | "parked" | "failed";
  summary: string;
  result: {
    output: string;
    sessionId: string;
    stopReason: string;
  };
  runtimeLinkage: OpenAgentRuntimeLinkage;
  question?: {
    id: string;
    text: string;
    timestamp: string;
    answered: boolean;
  };
};

type OpenAgentRuntimeSessionStatus = {
  state: "parked" | "not_found";
  summary: string;
  sessionId: string;
  worker?: string;
  jobId?: string;
  jobDir?: string;
  question?: {
    id: string;
    text: string;
    timestamp: string;
    answered: boolean;
  };
};

type OpenAgentRuntimeHandleShape = {
  sessionKey: string;
  worker: OpenAgentWorker;
  cwd: string;
  jobDir?: string;
  jobId?: string;
  context?: string;
};

type OpenAgentRuntimeAdapter = {
  ensureSession(input: OpenAgentRuntimeHandleShape): OpenAgentRuntimeHandleShape;
  runTurn(input: {
    handle: OpenAgentRuntimeHandleShape;
    text: string;
  }): Promise<OpenAgentRuntimeTurnResult>;
  resumeTurn(input: { sessionId: string; answer: string }): Promise<OpenAgentRuntimeTurnResult>;
  getSessionStatus(sessionId: string): Promise<OpenAgentRuntimeSessionStatus>;
};

type OpenAgentRuntimeState = {
  sessionKey: string;
  agent: string;
  mode: "persistent" | "oneshot";
  cwd: string;
  worker: OpenAgentWorker;
  jobId: string;
  jobDir: string;
  parkedSessionId?: string;
  summary: string;
  turnState: "idle" | "running" | "parked" | "completed" | "failed";
  question?: OpenAgentRuntimeSessionStatus["question"];
};

type OpenAgentAdapterModule = {
  createOpenAgentRuntimeAdapter?: (params?: {
    parkedSessionDir?: string;
  }) => OpenAgentRuntimeAdapter;
};

type OpenAgentAcpRuntimeDeps = {
  loadAdapter?: () => Promise<OpenAgentRuntimeAdapter>;
};

export function encodeOpenAgentRuntimeHandleState(state: OpenAgentRuntimeState): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${OPENAGENT_RUNTIME_HANDLE_PREFIX}${payload}`;
}

export function decodeOpenAgentRuntimeHandleState(
  runtimeSessionName: string,
): OpenAgentRuntimeState | null {
  const trimmed = runtimeSessionName.trim();
  if (!trimmed.startsWith(OPENAGENT_RUNTIME_HANDLE_PREFIX)) {
    return null;
  }
  try {
    const raw = Buffer.from(
      trimmed.slice(OPENAGENT_RUNTIME_HANDLE_PREFIX.length),
      "base64url",
    ).toString("utf8");
    const parsed = JSON.parse(raw) as Partial<OpenAgentRuntimeState>;
    if (
      !parsed ||
      typeof parsed.sessionKey !== "string" ||
      typeof parsed.agent !== "string" ||
      typeof parsed.cwd !== "string" ||
      typeof parsed.worker !== "string" ||
      typeof parsed.jobId !== "string" ||
      typeof parsed.jobDir !== "string" ||
      typeof parsed.mode !== "string" ||
      typeof parsed.summary !== "string" ||
      typeof parsed.turnState !== "string"
    ) {
      return null;
    }
    if (!isWorker(parsed.worker)) {
      return null;
    }
    if (parsed.mode !== "persistent" && parsed.mode !== "oneshot") {
      return null;
    }
    return parsed as OpenAgentRuntimeState;
  } catch {
    return null;
  }
}

export class OpenAgentAcpRuntime implements AcpRuntime {
  private healthy = false;
  private adapterPromise: Promise<OpenAgentRuntimeAdapter> | null = null;
  private readonly sessions = new Map<string, OpenAgentRuntimeState>();

  constructor(
    private readonly config: ResolvedOpenAgentAcpPluginConfig,
    private readonly deps: OpenAgentAcpRuntimeDeps = {},
    private readonly logger?: PluginLogger,
  ) {}

  isHealthy(): boolean {
    return this.healthy;
  }

  async probeAvailability(): Promise<void> {
    try {
      await this.getAdapter();
      this.healthy = true;
    } catch (error) {
      this.healthy = false;
      this.logger?.warn?.(
        `openagent-acp runtime probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const sessionKey = input.sessionKey.trim();
    const agent = input.agent.trim();
    const cwd = input.cwd?.trim() || process.cwd();
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    if (!agent) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP agent id is required.");
    }
    const worker = resolveWorkerFromSessionKey(sessionKey, this.config.defaultWorker);
    const jobId = resolveJobIdFromSessionKey(sessionKey);
    const jobDir = path.join(this.config.jobRootDir, sanitizePathSegment(jobId));
    await fs.mkdir(jobDir, { recursive: true });

    const adapter = await this.getAdapter();
    const normalizedHandle = adapter.ensureSession({
      sessionKey,
      worker,
      cwd,
      jobDir,
      jobId,
    });

    const state: OpenAgentRuntimeState = {
      sessionKey,
      agent,
      mode: input.mode,
      cwd: normalizedHandle.cwd,
      worker: normalizedHandle.worker,
      jobId: normalizedHandle.jobId ?? jobId,
      jobDir: normalizedHandle.jobDir ?? jobDir,
      summary: `${normalizedHandle.worker} ready`,
      turnState: "idle",
    };
    this.sessions.set(sessionKey, state);

    return {
      sessionKey,
      backend: OPENAGENT_ACP_BACKEND_ID,
      runtimeSessionName: encodeOpenAgentRuntimeHandleState(state),
      cwd: state.cwd,
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const state = await this.resolveState(input.handle);
    const adapter = await this.getAdapter();

    state.turnState = "running";
    state.summary = `${state.worker} running`;

    const result =
      state.parkedSessionId && state.turnState !== "failed"
        ? await adapter.resumeTurn({
            sessionId: state.parkedSessionId,
            answer: input.text,
          })
        : await adapter.runTurn({
            handle: {
              sessionKey: state.sessionKey,
              worker: state.worker,
              cwd: state.cwd,
              jobDir: state.jobDir,
              jobId: state.jobId,
            },
            text: input.text,
          });

    this.applyTurnResult(state, result);

    yield {
      type: "status",
      text: result.summary,
    };
    if (result.result.output) {
      yield {
        type: "text_delta",
        text: result.result.output,
        stream: "output",
      };
    }
    if (result.state === "failed") {
      yield {
        type: "error",
        message: result.summary,
      };
      return;
    }
    yield {
      type: "done",
      stopReason: result.state === "parked" ? "parked" : result.result.stopReason || "end_turn",
    };
  }

  getCapabilities(): AcpRuntimeCapabilities {
    return OPENAGENT_ACP_CAPABILITIES;
  }

  async getStatus(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus> {
    const state = await this.resolveState(input.handle);
    const adapter = await this.getAdapter();

    if (state.parkedSessionId) {
      const parked = await adapter.getSessionStatus(state.parkedSessionId);
      if (parked.state === "parked") {
        state.summary = parked.summary;
        state.question = parked.question;
        state.turnState = "parked";
      }
    }

    return {
      summary: state.summary,
      agentSessionId: state.parkedSessionId,
      details: {
        state: state.turnState,
        worker: state.worker,
        jobId: state.jobId,
        jobDir: state.jobDir,
        question: state.question,
      },
    };
  }

  async cancel(_input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    // OpenAgent adapter runs are discrete turn calls for this first cut; no live process cancellation yet.
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    this.sessions.delete(input.handle.sessionKey);
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    try {
      await this.getAdapter();
      return {
        ok: true,
        message: "openagent ACP runtime backend is available.",
      };
    } catch (error) {
      return {
        ok: false,
        code: "OPENAGENT_ACP_IMPORT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async getAdapter(): Promise<OpenAgentRuntimeAdapter> {
    if (this.adapterPromise) {
      return await this.adapterPromise;
    }

    this.adapterPromise = (async () => {
      if (this.deps.loadAdapter) {
        return await this.deps.loadAdapter();
      }
      const imported = (await import(
        pathToFileURL(this.config.modulePath).href
      )) as OpenAgentAdapterModule;
      if (typeof imported.createOpenAgentRuntimeAdapter !== "function") {
        throw new AcpRuntimeError(
          "ACP_BACKEND_UNAVAILABLE",
          `OpenAgent adapter module did not export createOpenAgentRuntimeAdapter: ${this.config.modulePath}`,
        );
      }
      return imported.createOpenAgentRuntimeAdapter({
        parkedSessionDir: this.config.parkedSessionDir,
      });
    })();

    return await this.adapterPromise;
  }

  private async resolveState(handle: AcpRuntimeHandle): Promise<OpenAgentRuntimeState> {
    const cached = this.sessions.get(handle.sessionKey);
    if (cached) {
      return cached;
    }
    const decoded = decodeOpenAgentRuntimeHandleState(handle.runtimeSessionName);
    if (!decoded) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `Invalid openagent runtime handle: ${handle.runtimeSessionName}`,
      );
    }
    this.sessions.set(handle.sessionKey, decoded);
    return decoded;
  }

  private applyTurnResult(state: OpenAgentRuntimeState, result: OpenAgentRuntimeTurnResult): void {
    state.summary = result.summary;
    state.parkedSessionId = result.runtimeLinkage.agentSessionId || undefined;
    state.question = result.question;
    state.turnState = result.state;
    if (result.state !== "parked") {
      state.parkedSessionId = undefined;
      state.question = undefined;
    }
  }
}

function isWorker(value: string): value is OpenAgentWorker {
  return value === "plan" || value === "execute" || value === "check" || value === "act";
}

function resolveWorkerFromSessionKey(
  sessionKey: string,
  fallback: OpenAgentWorker,
): OpenAgentWorker {
  const match = sessionKey.match(/:(plan|execute|check|act):[^:]+$/);
  return match && isWorker(match[1]) ? match[1] : fallback;
}

function resolveJobIdFromSessionKey(sessionKey: string): string {
  const match = sessionKey.match(/:(plan|execute|check|act):([^:]+)$/);
  return match?.[2]?.trim() || sanitizePathSegment(sessionKey);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}
