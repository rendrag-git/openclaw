---
summary: "What experimental flags mean in OpenClaw and which ones are currently documented"
title: "Experimental features"
read_when:
  - You see an `.experimental` config key and want to know whether it is stable
  - You want to try preview runtime features without confusing them with normal defaults
  - You want one place to find the currently documented experimental flags
---

Experimental features in OpenClaw are **opt-in preview surfaces**. They are
behind explicit flags because they still need real-world mileage before they
deserve a stable default or a long-lived public contract.

Treat them differently from normal config:

- Keep them **off by default** unless the related doc tells you to try one.
- Expect **shape and behavior to change** faster than stable config.
- Prefer the stable path first when one already exists.
- If you are rolling OpenClaw out broadly, test experimental flags in a smaller
  environment before baking them into a shared baseline.

## Quick toggle

Three surfaces share one schema-derived implementation, so the picker stays in
lockstep with whichever experimental flags the schema generator currently
exposes:

- `openclaw experimental` opens an interactive picker. Space selects, Enter
  confirms; selections write back to `openclaw.json`.
- `/experimental` in any chat channel (`whatsapp`, `discord`, `telegram`,
  the TUI, ...) lists current state. Owners can flip a single flag with
  `/experimental enable <key>` or `/experimental disable <key>`.

All three surfaces walk the same config schema (no hand-maintained list) and
write through the same validation primitives that `openclaw config set` uses
(prototype-key guard, schema validation, secret-policy check, hash-based
optimistic concurrency). A path that `config set` would refuse, the picker
will not surface — see [`src/config/config-set-policy.ts`](https://github.com/openclaw/openclaw/blob/main/src/config/config-set-policy.ts)
for the shared seam.

Restart the gateway after toggling.

## Currently documented flags

| Surface                  | Key                                                       | Use it when                                                                                                    | More                                                                                          |
| ------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Local model runtime      | `agents.defaults.experimental.localModelLean`             | A smaller or stricter local backend chokes on OpenClaw's full default tool surface                             | [Local Models](/gateway/local-models)                                                         |
| Memory search            | `agents.defaults.memorySearch.experimental.sessionMemory` | You want `memory_search` to index prior session transcripts and accept the extra storage/indexing cost         | [Memory configuration reference](/reference/memory-config#session-memory-search-experimental) |
| Structured planning tool | `tools.experimental.planTool`                             | You want the structured `update_plan` tool exposed for multi-step work tracking in compatible runtimes and UIs | [Gateway configuration reference](/gateway/config-tools#toolsexperimental)                    |

## Local model lean mode

`agents.defaults.experimental.localModelLean: true` is a pressure-release valve
for weaker local-model setups. It trims heavyweight default tools like
`browser`, `cron`, and `message` so the prompt shape is smaller and less brittle
for small-context or stricter OpenAI-compatible backends.

That is intentionally **not** the normal path. If your backend handles the full
runtime cleanly, leave this off.

## Experimental does not mean hidden

If a feature is experimental, OpenClaw should say so plainly in docs and in the
config path itself. What it should **not** do is smuggle preview behavior into a
stable-looking default knob and pretend that is normal. That's how config
surfaces get messy.

## Related

- [Features](/concepts/features)
- [Release channels](/install/development-channels)
