// Single seam that decides whether a given config path is writable.
// Both `openclaw config set` (`src/cli/config-cli.ts`) and the experimental
// picker (`src/experimental/experimental-core.ts`) consult this seam, so the
// picker is provably a subset of what `config set` will accept and any future
// env-var or policy-file gate plugged in here takes effect on every surface.

import { MANAGED_CONFIG_UNSET_PATHS } from "./io.write-prepare.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

export type ConfigSetPolicySource = "cli" | "experimental" | "rpc";

export type ConfigSetPolicyDecision = { ok: true } | { ok: false; reason: string };

const MANAGED_PREFIXES: ReadonlyArray<readonly string[]> = MANAGED_CONFIG_UNSET_PATHS;

function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > path.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (path[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

export function isConfigSetPathAllowed(
  path: readonly string[],
  ctx: { source: ConfigSetPolicySource },
): ConfigSetPolicyDecision {
  for (const segment of path) {
    if (isBlockedObjectKey(segment)) {
      return { ok: false, reason: `path segment "${segment}" is reserved` };
    }
  }
  for (const prefix of MANAGED_PREFIXES) {
    if (pathStartsWith(path, prefix)) {
      return {
        ok: false,
        reason: `${prefix.join(".")} is managed by OpenClaw and cannot be set via ${ctx.source}`,
      };
    }
  }
  return { ok: true };
}

export function assertConfigSetPathAllowed(
  path: readonly string[],
  ctx: { source: ConfigSetPolicySource },
): void {
  const decision = isConfigSetPathAllowed(path, ctx);
  if (!decision.ok) {
    throw new Error(decision.reason);
  }
}
