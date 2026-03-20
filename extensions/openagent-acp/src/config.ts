import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/acpx";

export type OpenAgentAcpPluginConfig = {
  modulePath?: string;
  jobRootDir?: string;
  parkedSessionDir?: string;
  defaultWorker?: "plan" | "execute" | "check" | "act";
};

export type ResolvedOpenAgentAcpPluginConfig = {
  modulePath: string;
  jobRootDir: string;
  parkedSessionDir: string;
  defaultWorker: "plan" | "execute" | "check" | "act";
};

const DEFAULT_WORKER: ResolvedOpenAgentAcpPluginConfig["defaultWorker"] = "plan";
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));

export function createOpenAgentAcpPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      modulePath: {
        type: "string",
      },
      jobRootDir: {
        type: "string",
      },
      parkedSessionDir: {
        type: "string",
      },
      defaultWorker: {
        type: "string",
        enum: ["plan", "execute", "check", "act"],
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveOpenAgentAcpPluginConfig(params: {
  rawConfig?: unknown;
  workspaceDir: string;
  stateDir: string;
}): ResolvedOpenAgentAcpPluginConfig {
  const config = isRecord(params.rawConfig) ? params.rawConfig : {};
  const modulePath =
    normalizeString(config.modulePath) ?? resolveDefaultModulePath(params.workspaceDir);
  const jobRootDir =
    normalizeString(config.jobRootDir) ?? path.join(params.stateDir, "openagent-acp", "jobs");
  const parkedSessionDir =
    normalizeString(config.parkedSessionDir) ??
    path.join(params.stateDir, "openagent-acp", "parked");
  const defaultWorker = normalizeWorker(config.defaultWorker) ?? DEFAULT_WORKER;

  return {
    modulePath,
    jobRootDir,
    parkedSessionDir,
    defaultWorker,
  };
}

function resolveDefaultModulePath(workspaceDir: string): string {
  const candidates = [
    path.resolve(workspaceDir, "..", "openagent", "src", "acp-runtime.ts"),
    path.resolve(CONFIG_DIR, "..", "..", "..", "..", "openagent", "src", "acp-runtime.ts"),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeWorker(
  value: unknown,
): ResolvedOpenAgentAcpPluginConfig["defaultWorker"] | undefined {
  return value === "plan" || value === "execute" || value === "check" || value === "act"
    ? value
    : undefined;
}
