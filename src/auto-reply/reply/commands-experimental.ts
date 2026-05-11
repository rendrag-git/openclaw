import {
  applyExperimentalToggles,
  ExperimentalConfigUnavailableError,
  ExperimentalValidationError,
  listExperimentalFlagsForUi,
  type ExperimentalToggle,
} from "../../config/experimental.js";
import { rejectNonOwnerCommand, rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

type ParsedExperimentalCommand =
  | { kind: "list" }
  | { kind: "toggle"; action: "enable" | "disable"; key: string }
  | { kind: "error"; message: string };

function parseExperimentalCommand(raw: string): ParsedExperimentalCommand | null {
  const trimmed = raw.trim();
  if (trimmed !== "/experimental" && !trimmed.startsWith("/experimental ")) {
    return null;
  }
  const tail = trimmed.slice("/experimental".length).trim();
  if (tail === "" || tail === "list") {
    return { kind: "list" };
  }
  const [action, ...rest] = tail.split(/\s+/);
  if (action === "enable" || action === "disable") {
    const key = rest.join(" ").trim();
    if (!key) {
      return {
        kind: "error",
        message: `Provide a flag path. Try \`/experimental ${action} tools.experimental.planTool\`.`,
      };
    }
    return { kind: "toggle", action, key };
  }
  return {
    kind: "error",
    message:
      "Unknown action. Use `/experimental` (list), `/experimental enable <key>`, or `/experimental disable <key>`.",
  };
}

function formatList(result: Awaited<ReturnType<typeof listExperimentalFlagsForUi>>): {
  text: string;
} {
  if (result.configMissing) {
    return { text: `⚠️ Config not found at ${result.configPath}.` };
  }
  if (!result.configValid) {
    return {
      text: [`⚠️ Config invalid at ${result.configPath}:`, ...result.issueLines].join("\n"),
    };
  }
  if (result.flags.length === 0) {
    return { text: "No experimental flags are exposed by the current schema." };
  }
  const lines = result.flags.map((flag) => {
    const marker = flag.enabled ? "✅" : "▫️";
    const help = flag.help ? `\n    ${flag.help}` : "";
    return `${marker} \`${flag.path}\` — ${flag.label}${help}`;
  });
  return {
    text: [
      "**Experimental flags**",
      ...lines,
      "",
      "Use `/experimental enable <key>` to toggle.",
    ].join("\n"),
  };
}

export const handleExperimentalCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseExperimentalCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (parsed.kind === "error") {
    return { shouldContinue: false, reply: { text: `⚠️ ${parsed.message}` } };
  }

  const unauthorized = rejectUnauthorizedCommand(params, "/experimental");
  if (unauthorized) {
    return unauthorized;
  }
  // Toggling experimental flags writes the user's config file. Restrict to
  // the same authorization tier as `/allowlist add` and similar config-write
  // commands.
  if (parsed.kind === "toggle") {
    const nonOwner = rejectNonOwnerCommand(params, "/experimental");
    if (nonOwner) {
      return nonOwner;
    }
  }

  if (parsed.kind === "list") {
    const result = await listExperimentalFlagsForUi();
    return { shouldContinue: false, reply: formatList(result) };
  }

  const list = await listExperimentalFlagsForUi();
  if (list.configMissing || !list.configValid) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Refusing to write — config is not in a writable state.` },
    };
  }
  const descriptor = list.flags.find((flag) => flag.path === parsed.key);
  if (!descriptor) {
    const known = list.flags.map((flag) => `\`${flag.path}\``).join(", ") || "(none)";
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Unknown experimental flag: \`${parsed.key}\`. Known: ${known}.` },
    };
  }

  const toggles: ExperimentalToggle[] = [
    { path: descriptor.path, enabled: parsed.action === "enable" },
  ];
  try {
    const result = await applyExperimentalToggles(toggles);
    if (result.applied.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: `▫️ \`${descriptor.path}\` is already ${parsed.action}d.` },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: `${parsed.action === "enable" ? "✅" : "▫️"} ${parsed.action === "enable" ? "Enabled" : "Disabled"} \`${descriptor.path}\`. Restart the gateway to apply.`,
      },
    };
  } catch (err) {
    if (err instanceof ExperimentalValidationError) {
      return {
        shouldContinue: false,
        reply: {
          text: [
            "⚠️ Refusing to write — toggle would produce an invalid config:",
            ...err.issueLines,
          ].join("\n"),
        },
      };
    }
    if (err instanceof ExperimentalConfigUnavailableError) {
      return { shouldContinue: false, reply: { text: `⚠️ ${err.message}` } };
    }
    throw err;
  }
};
