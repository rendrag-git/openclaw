# ADR 0001: Model Picker Rewrite

- **Status**: Accepted (2026-05-23, Pearson)
- **Date**: 2026-05-23
- **Linear**: REN-678 — see project description at https://linear.app/rendrag/project/openclaw-model-picker-rewrite-07d0a9624c05 for the full PRD content (problem statement, user stories, scope).

## Context

The cross-channel model picker breaks under `provider/*` wildcard configs in Discord, Telegram, Slack, WhatsApp, and Mattermost. The symptoms compound — interaction failures, stale component state, Discord 25-option truncation, 60–120 s submit blocks killing the WS heartbeat, fresh provider models never surfacing without a manual `openclaw models list --all`. Five issues stack on top of each other; fixing one only exposes the next.

PR #84735 ("Speed up /models browse replies", 2026-05-22) bounded the catalog load for non-wildcard configs but explicitly carved out wildcards to keep "freshness." That carve-out is what's biting now: forced `loadModelCatalog({readOnly: false})` blocks the event loop on every picker click for wildcard users.

The picker design assumes every component interaction completes its handler in <3 s, that catalog refreshes are out-of-band, that selecting a model is cheap, and that provider catalogs always fit in a single Discord select menu. None of those assumptions hold for wildcard configs against high-fan-out providers.

This ADR locks in the architecture for a from-the-ground rewrite that treats wildcard configs as the primary use case, not an edge case.

## Decision

Three modules, one new per-plugin contract, thin per-channel render/decode functions. No more layers than needed.

### Module 1: Picker

Stateful per-(channel, accountId, userId, interactionRoot) object. Owns session state, mutation reducer, pagination methods, selection, allowlist. Channels never own state — they consume `picker.snapshot()` and emit mutations via `picker.dispatch(mutation)`.

**Lifecycle:**

```
openPicker(key)  → Picker
picker.dispatch(mutation) → void
picker.snapshot() → PickerState
picker.paginatedProviders({ pageSize, currentPage }) → PaginatedView
picker.paginatedModels({ pageSize, currentPage }) → PaginatedView
```

**Key shape:** `{ channel, accountId, userId, interactionRoot }`. `interactionRoot` is the slash-command invocation that opened the picker. Two simultaneous pickers from the same user in the same channel get distinct sessions.

**State:**

```
{
  catalog:    Map<providerId, ModelDescriptor[]>,  // hydrated by ProviderModels
  selection:  { provider?, model?, runtime? },
  pagination: { providerPage, modelPage },
  allowlist:  Set<modelRef>,
  recents:    string[],
  openedAt:   number,
  lastTouched: number,
}
```

**Mutation reducer:** pure `(state, mutation) → state`. Mutations form a discriminated union:

```
type PickerMutation =
  | { kind: "selectProvider"; provider }
  | { kind: "selectModel"; provider, model }
  | { kind: "selectRuntime"; runtime }
  | { kind: "paginateProvider"; delta: +1 | -1 }
  | { kind: "paginateModel"; delta: +1 | -1 }
  | { kind: "back"; to: "providers" | "models" }
  | { kind: "submit" }
  | { kind: "reset" }
  | { kind: "refreshCatalog"; providerId }
```

**Pagination:** computed methods on the snapshot, not a separate module. Pure: `paginatedProviders` / `paginatedModels` return `{ pageItems, hasNext, hasPrev, totalPages }`. Page-size policy per channel (see Cross-channel contract).

**TTL:** 5 min from `lastTouched`. Any read or write touches. Periodic sweep removes expired pickers.

**Concurrency:** mutations on the same picker serialize via internal queue. Cross-picker mutations are independent.

**Catalog hydration:** when a mutation requires catalog data (e.g. `selectProvider`, `refreshCatalog`, `paginateModel` on a not-yet-loaded provider), the picker calls `ProviderModels.getProviderModels(providerId, opts)` and merges the result into state. The picker is the only caller of `ProviderModels`.

### Module 2: ProviderModels

Per-provider on-demand catalog with stale-while-revalidate. The picker's only collaborator for catalog data.

**Interface:**

```
getProviderModels(providerId, {
  agentId,
  maxStaleness,   // ms; defaults to 5 min
  signal,         // AbortSignal
}) → {
  models:    ModelDescriptor[],
  fetchedAt: number,
  freshness: "fresh" | "stale" | "missing",
}
```

**Semantics:**

- Reads persisted per-agent `models.json` first; returns it `stale` if older than `maxStaleness`, `fresh` if within.
- If `stale` or `missing`, kicks off a single background refresh via the provider plugin's `runOne` hook. Concurrent calls coalesce onto the in-flight promise.
- Refresh writes through to the same `ensureOpenClawModelsJson` write path used by the legacy global flow — single canonical writer.
- Returns the stale/missing result immediately; never blocks on the refresh.
- Auth scope: always agent-scoped via `agentId`. Matches today's per-agent `models.json` behavior.
- In-memory cache lives for the gateway process lifetime; on-disk persistence is the durable source.

**Replaces:** the `providerWildcards.size > 0 → loadCatalog({readOnly: false})` carve-out at `src/agents/model-catalog-browse.ts:20-22`. Obviates manual `openclaw models list --all`.

### Module 3: ModelSwitch

Applies the picker's submit to the agent runtime. Decouples model selection from harness lifecycle.

**Interface:**

```
applySelection({
  sessionKey,
  fromRef,    // ModelRef the session was on
  toRef,      // ModelRef the user picked
  runtime?,   // explicit runtime override
}) → {
  result: "applied" | "queued" | "rejected",
  harnessesAffected: string[],
  message: string,
}
```

**Decision matrix:**

```
fromRef.runtime === toRef.runtime  → no harness change
fromRef.runtime ≠ toRef.runtime    → start toRef.runtime lazily; keep fromRef.runtime warm for revert
```

**Semantics:**

- Persists the override IMMEDIATELY to session config (cheap write).
- Returns synchronously after the override is recorded.
- Harness lifecycle changes are deferred to the next agent turn, not coupled to dispatch.
- No `withTimeout` wrapper needed.
- Same dispatcher is used by `/model <ref>` text commands, so picker UI and text command share one apply path.

Rollback = another `applySelection` to the prior ref.

### Plugin contract: `provider.catalog.runOne`

Not a module — a method added to every bundled provider plugin's existing `catalog` hook. The only collaborator that calls it is `ProviderModels`.

**Contract:**

```
provider.catalog.runOne({
  providerId,
  hint?,
  signal?,
}) → ModelDescriptor[]
```

**Guarantees:**

- Returns within budget (target: p95 ≤ 1 s) under healthy auth + reachable endpoint.
- Does NOT load: auth storage, manifest snapshot, other providers' state, plugin runtime modules for other plugins.
- Throws structured errors with classification: `AuthMissingError`, `AuthInvalidError`, `EndpointUnreachableError`, `ProtocolError`, `TimeoutError`.
- Idempotent.

The existing `provider.catalog.run()` hook stays for global catalog flows (non-picker callers like `loadModelCatalog`).

### Cross-channel render/decode

Each channel implements two pure functions. No channel-side state, no channel "module" abstraction.

```
channel.render(snapshot: PickerState) → ChannelPayload
channel.decode(interaction: ChannelInteraction) → PickerMutation | null
```

Channels covered: Discord, Telegram, Slack, Mattermost. WhatsApp implements only the text-command path through `ModelSwitch` (no first-class slash UI).

**Page-size policy per channel:**

| Channel    | Page size | Reason |
|---         |---        |---     |
| Discord    | 25        | Hard select-menu option limit |
| Telegram   | 8         | Inline-keyboard cell budget after nav buttons |
| Slack      | 100       | Block-kit static_select limit |
| Mattermost | 100       | Same as Slack |

### Component ID encoding

Component custom_id / callback_data encodes ONLY the session reference and action verb. Everything else lives in the picker.

```
mp:<sessionId>:<verb>
```

`<sessionId>` = short opaque token (~10 bytes base64). `<verb>` = enum: `pP` (paginate provider), `pM` (paginate model), `sP` (select provider), `sM` (select model), `sR` (select runtime), `sub`, `back`, `reset`, `rfh` (refresh).

For select menus, the option's `value` carries the index or model ref within the current page. Discord allows up to 100-byte option values; Telegram doesn't have this constraint for inline keyboard rows.

Total encoded ID length: ~15–20 bytes. Fits Discord's 100-byte custom_id limit and Telegram's 64-byte callback_data limit with room to spare.

### Migration plan

Phased per the Linear breakdown:

1. **REN-679** (tracer bullet): minimal `Picker` + `ProviderModels` + `ModelSwitch`; vllm-only routing through them on Discord. Legacy paths untouched for everything else.
2. **REN-680**: `runOne` rolled out to all bundled provider plugins. Discord picker uses `ProviderModels` for all providers.
3. **REN-681**: full `Picker` module — session state, reducer, pagination methods, all mutations. Discord uses `Picker` for the entire picker flow. (Subsumes scope previously in REN-682.)
4. **REN-683**: `ModelSwitch` fully wired with harness lifecycle decoupling.
5. **REN-684**: Telegram, Slack, Mattermost, WhatsApp render/decode functions.
6. **REN-685**: CLI `openclaw models list` consumes `ProviderModels`. `provider/*` literal row dropped.
7. **REN-686**: telemetry spans across modules.
8. **REN-687**: legacy code removed (`loadDiscordModelPickerData`, `buildDiscordModelPickerAllowedModelRefs`, `applyDiscordModelPickerSelection`, the wildcard carve-out in `loadModelCatalogForBrowse`). In-place pmg dist patch reverted.

### What stays

- `loadModelCatalog`: used by thinking-defaults, persistence, startup-log, gateway `models.list` RPC. Stays.
- `ensureOpenClawModelsJson`: now exclusively called via `ProviderModels` for picker writes. Other callers (CLI `models list --all`) unchanged.
- `agents.defaults.models` config schema and wildcard semantics.
- Per-agent `models.json` file format.
- `provider.catalog.run()` hook (global discovery).

### What goes

- `loadModelCatalogForBrowse`'s `providerWildcards.size > 0 → readOnly: false` carve-out.
- `buildModelsProviderData` calls from picker paths in every channel.
- `loadDiscordModelPickerData`, `buildDiscordModelPickerAllowedModelRefs`, `applyDiscordModelPickerSelection`.
- The in-place pmg dist patch at `/usr/lib/node_modules/openclaw/dist/commands-models-CJ3GghDD.js` (reverted in REN-687).
- The CLI's spurious `provider/*` literal row at `src/commands/models/list.configured.ts:75-87`.

## Consequences

### Positive

- Wildcard configs work without "interaction failed" across all channels.
- Per-provider discovery is bounded; picker hot path no longer blocks the event loop.
- Real pagination for providers with hundreds of models.
- Model switches no longer trigger unrelated harness teardown.
- Single canonical writer for `models.json` reduces drift between picker view and persisted state.
- Three modules instead of five — fewer seams, fewer integration test points, fewer interfaces to keep in sync.
- Cross-channel work is two pure functions per channel, not a "channel module" abstraction.

### Negative

- Touches every bundled provider plugin (REN-680) — broad change surface.
- Channel render/decode functions must be migrated in lockstep (REN-684 is wide).
- The in-place pmg dist patch must be reverted in REN-687; until then there's a stop-gap difference between live and source code.

### Risks

- The `runOne` contract assumes every provider's per-provider discovery primitive is fast. Slow ones (e.g. providers that proxy through a slow third-party) need their own bound. Mitigation: `runOne` errors on timeout; `ProviderModels` falls back to stale.
- Session-keyed component IDs assume the session is still resolvable when the user clicks. If the gateway restarts mid-picker, the session is gone. Mitigation: clear "session expired, reopen with `/models`" notice; restart is rare and the prior session was already going to be discarded.
- Slack/Mattermost/Telegram channel SDK quirks may surface during migration. Mitigation: Crabbox live proof per channel before merging REN-684.

## Sign-off

This ADR closes REN-678 once a maintainer has reviewed and approved. Subsequent issues (REN-679 onward) may begin implementation once this ADR is in `Accepted` status.
