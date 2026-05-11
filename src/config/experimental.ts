// Schema-derived enumeration and config-set–compatible writes for
// experimental boolean toggles.
//
// The experimental flag list is never hand-maintained. We walk the merged
// config schema (`buildConfigSchema`) and select boolean leaves whose dotted
// path contains an `experimental` segment, pulling labels and help text from
// the same uiHints map the rest of the config UI uses.
//
// Writes route through the same validation primitives `openclaw config set`
// uses (`validateConfigObjectRaw`, `collectUnsupportedSecretRefPolicyIssues`,
// `replaceConfigFile` with `baseHash` for optimistic concurrency) and the
// shared `isConfigSetPathAllowed` policy seam, so the picker is provably a
// subset of what `config set` would accept.

import { assertConfigSetPathAllowed, isConfigSetPathAllowed } from "./config-set-policy.js";
import { readConfigFileSnapshot, replaceConfigFile } from "./config.js";
import { formatConfigIssueLines } from "./issue-format.js";
import type { ConfigUiHint } from "./schema.hints.js";
import { buildConfigSchema, type ChannelUiMetadata, type PluginUiMetadata } from "./schema.js";
import { asSchemaObject } from "./schema.shared.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { collectUnsupportedSecretRefPolicyIssues, validateConfigObjectRaw } from "./validation.js";

export type ExperimentalFlagDescriptor = {
  path: string;
  segments: readonly string[];
  label: string;
  help?: string;
};

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

type SchemaNode = {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
};

function isBooleanLeaf(node: SchemaNode): boolean {
  const type = node.type;
  if (type === "boolean") {
    return true;
  }
  if (Array.isArray(type) && type.length === 1 && type[0] === "boolean") {
    return true;
  }
  return false;
}

function pathContainsExperimentalSegment(segments: readonly string[]): boolean {
  return segments.some((segment) => segment === "experimental");
}

function readHint(uiHints: Record<string, ConfigUiHint>, path: string): ConfigUiHint | undefined {
  return uiHints[path];
}

function walk(
  node: SchemaNode,
  segments: string[],
  visit: (segments: readonly string[], leaf: SchemaNode) => void,
): void {
  if (isBooleanLeaf(node)) {
    visit(segments, node);
    return;
  }
  const properties = node.properties ?? {};
  for (const [key, child] of Object.entries(properties)) {
    const childNode = asSchemaObject(child) as SchemaNode | null;
    if (!childNode) {
      continue;
    }
    walk(childNode, [...segments, key], visit);
  }
}

export function listExperimentalFlagDescriptors(params?: {
  plugins?: PluginUiMetadata[];
  channels?: ChannelUiMetadata[];
}): ExperimentalFlagDescriptor[] {
  const built = buildConfigSchema({
    ...(params?.plugins ? { plugins: params.plugins } : {}),
    ...(params?.channels ? { channels: params.channels } : {}),
  });
  const root = asSchemaObject(built.schema) as SchemaNode | null;
  if (!root) {
    return [];
  }
  const out: ExperimentalFlagDescriptor[] = [];
  const seen = new Set<string>();
  walk(root, [], (segments) => {
    if (!pathContainsExperimentalSegment(segments)) {
      return;
    }
    const path = segments.join(".");
    if (seen.has(path)) {
      return;
    }
    // Honour the same allowlist `openclaw config set` honours: if the policy
    // seam blocks this path, the picker must not surface it either.
    if (!isConfigSetPathAllowed(segments, { source: "experimental" }).ok) {
      return;
    }
    const hint = readHint(built.uiHints, path);
    seen.add(path);
    out.push({
      path,
      segments: [...segments],
      label: hint?.label ?? path,
      ...(hint?.help ? { help: hint.help } : {}),
    });
  });
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function readBoolAtPath(root: unknown, segments: readonly string[]): boolean {
  let cursor: unknown = root;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor === true;
}

export function setBoolAtPath(
  root: Record<string, unknown>,
  segments: readonly string[],
  value: boolean,
): void {
  if (segments.length === 0) {
    throw new Error("setBoolAtPath requires at least one segment");
  }
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (!segment) {
      throw new Error("setBoolAtPath: empty segment");
    }
    const next = cursor[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  if (!last) {
    throw new Error("setBoolAtPath: empty trailing segment");
  }
  cursor[last] = value;
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
