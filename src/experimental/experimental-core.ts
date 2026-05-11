// Single shared core for the `openclaw experimental` CLI command, the TUI
// `/experimental` overlay, and the chat `/experimental` slash command.
//
// All three surfaces enumerate flags via `listExperimentalFlagsForUi` and
// commit toggles via `applyExperimentalToggles`. Both helpers route through
// the same validation primitives `openclaw config set` uses
// (validateConfigObjectRaw, collectUnsupportedSecretRefPolicyIssues,
// replaceConfigFile with `baseHash` for optimistic concurrency) and the
// shared `isConfigSetPathAllowed` policy seam, so the picker is provably a
// subset of what `config set` would accept.

import { assertConfigSetPathAllowed } from "../config/config-set-policy.js";
import { readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import {
  listExperimentalFlagDescriptors,
  readBoolAtPath,
  setBoolAtPath,
  type ExperimentalFlagDescriptor,
} from "../config/experimental-flags.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectUnsupportedSecretRefPolicyIssues,
  validateConfigObjectRaw,
} from "../config/validation.js";

export type ExperimentalFlagState = ExperimentalFlagDescriptor & {
  enabled: boolean;
};

export type ExperimentalToggle = {
  path: string;
  enabled: boolean;
};

export type ExperimentalListResult = {
  configPath: string;
  configValid: boolean;
  configMissing: boolean;
  issueLines: string[];
  flags: ExperimentalFlagState[];
};

export type ExperimentalApplyResult = {
  configPath: string;
  applied: ExperimentalToggle[];
  noOp: ExperimentalToggle[];
  unknown: string[];
};

export class ExperimentalConfigUnavailableError extends Error {
  readonly configPath: string;
  readonly missing: boolean;
  readonly issueLines: string[];

  constructor(params: { configPath: string; missing: boolean; issueLines: string[] }) {
    super(
      params.missing
        ? `Config not found at ${params.configPath}`
        : `Config invalid at ${params.configPath}`,
    );
    this.configPath = params.configPath;
    this.missing = params.missing;
    this.issueLines = params.issueLines;
  }
}

export class ExperimentalValidationError extends Error {
  readonly issueLines: string[];
  constructor(issueLines: string[]) {
    super(`Experimental toggle would produce an invalid config:\n${issueLines.join("\n")}`);
    this.issueLines = issueLines;
  }
}

function descriptorsWithState(
  descriptors: ExperimentalFlagDescriptor[],
  resolvedRoot: unknown,
): ExperimentalFlagState[] {
  return descriptors.map((descriptor) => ({
    ...descriptor,
    enabled: readBoolAtPath(resolvedRoot, descriptor.segments),
  }));
}

export async function listExperimentalFlagsForUi(): Promise<ExperimentalListResult> {
  const snapshot = await readConfigFileSnapshot();
  const issueLines = snapshot.exists
    ? formatConfigIssueLines(snapshot.issues, "-", { normalizeRoot: true })
    : [];
  const descriptors = listExperimentalFlagDescriptors();
  const root = snapshot.resolved ?? snapshot.config ?? {};
  return {
    configPath: snapshot.path,
    configValid: snapshot.valid,
    configMissing: !snapshot.exists,
    issueLines,
    flags: descriptorsWithState(descriptors, root),
  };
}

export async function applyExperimentalToggles(
  toggles: ReadonlyArray<ExperimentalToggle>,
): Promise<ExperimentalApplyResult> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    throw new ExperimentalConfigUnavailableError({
      configPath: snapshot.path,
      missing: !snapshot.exists,
      issueLines: snapshot.exists
        ? formatConfigIssueLines(snapshot.issues, "-", { normalizeRoot: true })
        : [],
    });
  }

  const descriptors = listExperimentalFlagDescriptors();
  const byPath = new Map(descriptors.map((descriptor) => [descriptor.path, descriptor]));
  const resolvedRoot = snapshot.resolved ?? snapshot.config ?? {};

  const applied: ExperimentalToggle[] = [];
  const noOp: ExperimentalToggle[] = [];
  const unknown: string[] = [];
  const wantedByPath = new Map<string, ExperimentalToggle>();

  for (const toggle of toggles) {
    const descriptor = byPath.get(toggle.path);
    if (!descriptor) {
      unknown.push(toggle.path);
      continue;
    }
    // Defence-in-depth: even though listExperimentalFlagDescriptors already
    // filters via the policy seam, re-check here so RPC callers cannot bypass
    // the picker by sending an arbitrary path that isn't in the descriptor
    // list.
    assertConfigSetPathAllowed(descriptor.segments, { source: "experimental" });
    const current = readBoolAtPath(resolvedRoot, descriptor.segments);
    if (current === toggle.enabled) {
      noOp.push(toggle);
      continue;
    }
    applied.push(toggle);
    wantedByPath.set(descriptor.path, toggle);
  }

  if (applied.length === 0) {
    return {
      configPath: snapshot.path,
      applied,
      noOp,
      unknown,
    };
  }

  const next = structuredClone(resolvedRoot) as Record<string, unknown>;
  const touchedPaths: string[][] = [];
  for (const toggle of applied) {
    const descriptor = byPath.get(toggle.path);
    if (!descriptor) {
      continue;
    }
    setBoolAtPath(next, descriptor.segments, toggle.enabled);
    touchedPaths.push([...descriptor.segments]);
  }

  // Same validation chain `runConfigSet` applies before writing.
  const policyIssues = collectUnsupportedSecretRefPolicyIssues(next as OpenClawConfig);
  if (policyIssues.length > 0) {
    throw new ExperimentalValidationError(
      formatConfigIssueLines(policyIssues, "-", { normalizeRoot: true }),
    );
  }
  const validation = validateConfigObjectRaw(next, { touchedPaths });
  if (!validation.ok) {
    throw new ExperimentalValidationError(
      formatConfigIssueLines(validation.issues, "-", { normalizeRoot: true }),
    );
  }

  await replaceConfigFile({
    nextConfig: next as OpenClawConfig,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
  });

  return {
    configPath: snapshot.path,
    applied,
    noOp,
    unknown,
  };
}
