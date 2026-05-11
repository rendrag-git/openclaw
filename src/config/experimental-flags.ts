// Schema-derived enumeration of experimental boolean toggles.
//
// We never hand-maintain a list of experimental flags. Instead we walk the
// merged config schema (`buildConfigSchema`) and select boolean leaves whose
// dotted path contains an `experimental` segment. Labels and help text come
// from the same uiHints map the rest of the config UI uses, so toggles in
// `openclaw experimental` / `/experimental` (chat) / `/experimental` (TUI)
// stay in lockstep with the schema generator.

import { isConfigSetPathAllowed } from "./config-set-policy.js";
import type { ConfigUiHint } from "./schema.hints.js";
import { buildConfigSchema, type ChannelUiMetadata, type PluginUiMetadata } from "./schema.js";
import { asSchemaObject } from "./schema.shared.js";

export type ExperimentalFlagDescriptor = {
  path: string;
  segments: readonly string[];
  label: string;
  help?: string;
};

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
