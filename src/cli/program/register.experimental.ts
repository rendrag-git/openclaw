import type { Command } from "commander";
import { runExperimental } from "../../commands/experimental.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerExperimentalCommand(program: Command) {
  program
    .command("experimental")
    .description("Toggle experimental config flags interactively")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/concepts/experimental-features",
          "docs.openclaw.ai/concepts/experimental-features",
        )}\n`,
    )
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await runExperimental(defaultRuntime);
      });
    });
}
