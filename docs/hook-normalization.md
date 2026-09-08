# Hook normalization: implementation and operation

Updated 2026-09-08. The [ecosystem survey](design/harness-hook-support-survey.md)
and [source catalog](../src/harness/adapters/hook-support-catalog.json) describe
45 inspected runtime profiles. These include coding clients, hosted variants,
SDK callbacks and protocols; they are not 45 installed integrations. The catalog
contains 556 named entries, including grouped callbacks and discovery records.

## Architecture and evidence

Native input enters a provider adapter, becomes a `UnifiedHookEvent`, and reaches
the existing Interlinked CLI evaluator. A provider encoder translates the decision
back into the native response. The envelope preserves the original payload and
keeps lifecycle, tool batch, model, configuration and filesystem boundaries distinct.
The daemon independently observes protected files and reservations for all clients.

| Evidence | Meaning | Does not establish |
|---|---|---|
| Catalog declaration | A cited source describes an event/control | Emission by an installed version |
| Selected event | Adapter intends to subscribe | Installation or provider trust |
| Installer manifest | Interlinked wrote a configuration entry | A running client loaded it |
| Runtime receipt | Hook entry point received an invocation | Native enforcement of its response |
| Translation receipt | Response encoded the requested control, degraded it, or could not express it | Side effects were prevented |
| Coverage check receipt | Enumerated checks completed for a captured file and policy identity | Unrun checks, baseline approval or writer attribution |

`interlinked harness capabilities --json` joins these records with the catalog.
Controls are independent: deny, approval, input rewriting, result replacement,
context, continuation, cancellation, wake and operation substitution. Missing
control evidence stays unmeasured; an explicit empty control list is observational.
Unknown versions are never certified merely by matching an event name. The compiled
entry point writes metadata-only translation rows to `.interlinked/hook-translations.jsonl`.
These diagnostic rows do not store tool payloads and currently require operator-managed
retention. Cold fallback paths retain their existing degradation diagnostics.

## Installed adapters

The existing `enable --clients` integrations remain Claude Code, Codex, Copilot CLI,
Gemini CLI, Cursor, OpenCode and Pi. Four additional adapters are explicit experimental
`install-hooks --runner` integrations:

| Runner | Project settings | Implemented boundary |
|---|---|---|
| `factory-droid` | `.factory/hooks.json` | Tool, prompt, session and stop hooks; native permission and input rewriting |
| `windsurf` | `.windsurf/hooks.json` | Command/read/write/MCP pre-gates; after-event observation |
| `antigravity` | `.agents/hooks.json` | Native pre-tool denial/forced approval, model context and stop continuation |
| `crush` | `crush.json` | Native pre-tool denial, context and input rewriting |

These adapters preserve provider identity through the legacy daemon bridge. Installation
and uninstall preserve user entries and respect each provider's container layout.
Their shell wrappers target POSIX; Windows and native headless behavior remain unmeasured.
Antigravity positional/multi-chunk edits and multi-root project selection are not yet
certified as exact content overlays. A declared pre-tool gate is not a claim that every
tool's proposed post-image is measured. Missing native call IDs remain missing.

The adapter installer requires a compiled runtime. It refuses the generated `.mjs`
compatibility script instead of installing expanded subscriptions that script cannot
serve. Existing legacy installs remain compatibility paths. Build an unbuilt checkout,
then refresh hooks with `interlinked install-hooks --refresh --preserve-mode`.

Claude FileChanged has no static matcher; dynamic `watchPaths` are returned at
SessionStart, CwdChanged and FileChanged. PostToolUseFailure remains parse-only to
preserve the existing duplicate-hook-output policy. PostToolBatch cancels the loop
before another model request; it does not undo any tool. FileChanged and PostCompact
are observational. Copilot responses are phase-specific, and Gemini receives its
own JSON contract, including a valid empty response. Unsupported approval requests
conservatively deny. Required input rewrites unsupported by Windsurf or Antigravity
also deny. Codex retains its own semantics and feature flag; Claude-shaped payloads
do not give it Claude's watcher, batch or idle-wake events.

## External writes and verification

The daemon observes package manifests, lockfiles, root tsconfigs, protected
`.interlinked` policy/baseline files, `.claude/settings.json` and current literal
reservation paths. Directory notifications are reconciled against content hashes at
startup, delivery boundaries and periodically. Kernel delivery is not assumed lossless.
Globs, paths outside the workspace, symbolic links and unreadable/oversized files
are explicitly unmeasured. Transient writes that disappear between observations can
be missed. No filesystem event identifies the writer.

New identities become persistent pending obligations in `.interlinked/hook-coverage.json`.
Session exit and event delivery do not acknowledge them. Atomic replacement preserves
the previous ledger on write failure; this is local recovery state, not tamper-proof
storage or an fsync-based power-loss guarantee.

```sh
interlinked harness coverage status --json
interlinked harness coverage verify --json
interlinked harness coverage verify --no-wait --json
```

Verification runs configured PostToolUse checks in bounded batches. It records only
completed checks, retains findings, and rejects stale file/policy evidence. A job may
finish with pending or unmeasured versions. Manual `acknowledge` requires the current
observation ID, generation, content identity and review evidence; it records manual
review, never an automated pass. `accept-policy <digest>` separately accepts an
explicitly reviewed current policy identity. Inspect status before retrying any mutation
whose response was lost; mutation requests are not automatically replayed on another transport.

An accepted policy digest can make Claude ConfigChange refuse runtime application of
differing protected state. It does not retain an immutable copy of active configuration,
prevent the disk write, cover every runtime reload, or approve new baseline values.
Existing pre-tool baseline protections and commit gates remain necessary. Watching
the water-lines alone does not close every baseline-rewrite path.

## Cloudflare Think bridge

`interlinked-cli/hook-bridge` exports `createThinkHookBridge`,
`createDurableHookJournal` and their TypeScript contracts. It has no implicit Node,
network or storage dependency. The application supplies session/turn identity,
runtime version, policy/profile digests, policy evaluation, durable storage and an
idempotent receipt receiver. The journal adapter uses Durable Object storage transactions.

Create one bridge for a turn and call its `beforeToolCall(ctx)` and
`afterToolCall(ctx)` methods from the corresponding Think hooks. Return the bridge's
before decision to Think. Admission is persisted before it returns. Policy failure,
cancellation and deadline expiry refuse execution. A duplicate call identity refuses
admission; an ambiguous completion never earns execution evidence. Preserve the same
application IDs when reconstructing a bridge for delivery recovery.

Think can report success after blocking or substituting a tool. The bridge records
policy separately from execution, and retains rewritten effective input because the
after-hook input can be the original input. `flush(toolCallId)` retries an undelivered
receipt without re-executing the tool. The application must retain the call IDs and
schedule recovery; this package does not create an alarm or workflow. Delivery is
at least once, so receivers must deduplicate the stable receipt ID. See the
[Think lifecycle contract](https://developers.cloudflare.com/agents/harnesses/think/lifecycle-hooks/).

Client-executed tools and nested tool bodies outside Think's server-tool boundary
are unmeasured. The remaining Think lifecycle callbacks and other SDK/protocol
profiles are cataloged integration seams, not installed wrappers. This package does
not deploy the Interlinked MCP Server or implement the remote shadow execution broker.
Remote admission still needs finalized bundle/environment identity and stale-result checks.

## Conformance and remaining work

Unit and process fixtures exercise translation, installation/uninstall, missing runtime,
rewrites, watcher notifications/reconciliation, stale acknowledgments, policy deadlines,
duplicate admission and delivery recovery. They are not native-provider certificates.
Local version probes found Claude 2.1.263, Codex 0.153.4, Gemini 0.51.0, Copilot 1.0.77,
Cursor 2026.08.11-e8db854 and OpenCode 1.18.25. These version strings do not upgrade
the catalog's `runtime_verified: false` records.

Before claiming production parity for a provider/version/mode, capture native success,
denial, timeout, cancellation and rewrite cases; verify the executed sentinel, approval
surface, transcript and subsequent model input. Add concrete wrappers for remaining
catalog profiles as their runtime contracts are validated. Hosted variants, sync SDK
callbacks and protocol notifications require their own integrations. See the
[implementation ledger](design/harness-hook-normalization-implementation.md).
