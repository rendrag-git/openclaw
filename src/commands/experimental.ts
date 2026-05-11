import {
  applyExperimentalToggles,
  ExperimentalConfigUnavailableError,
  ExperimentalValidationError,
  listExperimentalFlagsForUi,
  type ExperimentalFlagState,
  type ExperimentalToggle,
} from "../experimental/experimental-core.js";
import { danger, info, success } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";

function formatFlagSummary(flags: ExperimentalFlagState[]): string {
  if (flags.length === 0) {
    return theme.muted("No experimental flags are exposed by the current schema.");
  }
  return flags
    .map((flag) => {
      const state = flag.enabled ? success("on") : info("off");
      const help = flag.help ? `\n    ${theme.muted(flag.help)}` : "";
      return `  [${state}] ${flag.label}\n    ${theme.muted(flag.path)}${help}`;
    })
    .join("\n");
}

export async function runExperimental(runtime: RuntimeEnv): Promise<void> {
  const list = await listExperimentalFlagsForUi();
  if (list.configMissing || !list.configValid) {
    runtime.error(
      danger(
        `Config ${list.configMissing ? "not found" : "invalid"} at ${shortenHomePath(list.configPath)}.`,
      ),
    );
    for (const line of list.issueLines) {
      runtime.error(`  ${line}`);
    }
    runtime.error(`Run ${theme.accent("openclaw doctor")} to repair, then retry.`);
    runtime.exit(1);
    return;
  }

  if (list.flags.length === 0) {
    runtime.log(theme.muted("No experimental flags are exposed by the current schema."));
    return;
  }

  const prompter = createClackPrompter();
  await prompter.intro("OpenClaw experimental flags");

  let selected: string[];
  try {
    selected = await prompter.multiselect<string>({
      message: "Toggle experimental features (space to select, enter to confirm)",
      options: list.flags.map((flag) => ({
        value: flag.path,
        label: flag.label,
        ...(flag.help ? { hint: flag.help } : {}),
      })),
      initialValues: list.flags.filter((flag) => flag.enabled).map((flag) => flag.path),
    });
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      await prompter.outro(theme.muted("Cancelled — no changes written."));
      return;
    }
    throw err;
  }

  const wanted = new Set(selected);
  const toggles: ExperimentalToggle[] = list.flags.map((flag) => ({
    path: flag.path,
    enabled: wanted.has(flag.path),
  }));

  try {
    const result = await applyExperimentalToggles(toggles);
    if (result.applied.length === 0) {
      await prompter.outro(theme.muted("No changes."));
      return;
    }
    const summary = result.applied
      .map((toggle) => {
        const state = toggle.enabled ? success("enabled") : info("disabled");
        return `  ${state}  ${theme.muted(toggle.path)}`;
      })
      .join("\n");
    await prompter.note(summary, "Updated config");
    await prompter.outro(`Restart the gateway to apply. (${shortenHomePath(result.configPath)})`);
  } catch (err) {
    if (err instanceof ExperimentalValidationError) {
      runtime.error(danger("Refusing to write — toggle would produce an invalid config:"));
      for (const line of err.issueLines) {
        runtime.error(`  ${line}`);
      }
      runtime.exit(1);
      return;
    }
    if (err instanceof ExperimentalConfigUnavailableError) {
      runtime.error(danger(err.message));
      runtime.exit(1);
      return;
    }
    throw err;
  }
}

export async function listExperimentalFlagsAsText(): Promise<string> {
  const list = await listExperimentalFlagsForUi();
  return formatFlagSummary(list.flags);
}
