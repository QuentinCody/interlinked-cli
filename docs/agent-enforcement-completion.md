# Completing the agent enforcement workflow

This program finishes the workflow around Interlinked CLI's existing analyzers,
guards, ratchets, mutation runners, obligations, provider adapters, and evidence
stores. Existing lint configuration remains owned by its original analyzer.
The optional Interlinked MCP Server is a separate product and is not required
for local enforcement.

## Completion criteria

A supported operation is evaluated under a known policy; an observed filesystem
change is associated with a bounded verification scope; each required check has
an explicit result; unresolved or stale results remain visible at completion.
An operator can inspect the evidence and its limitations. A clean verdict never
means that an unavailable check returned an empty array.

## Implementation sequence

| Track | Existing foundation | Remaining acceptance criteria |
| --- | --- | --- |
| Consistent action and write enforcement | Provider guards, observed ChangeSets, shared content gate, transaction helper | One transaction implementation across write commands; detect target drift during checking; preserve modes and concurrent edits during rollback; equivalent proposals receive equivalent applicable policy checks |
| Verification evidence and freshness | Typed TypeScript/mutation outcomes, per-request warning spool, local check records | Uniform completed/skipped/unavailable/pending outcomes across analyzers; bind results to source, test, configuration and tool identities; invalidate stale results without discharging debt |
| Durable repair obligations | Coverage, transient-content and mutation ledgers; Stop and commit backstops | Reconcile obligations across daemon restarts and concurrent sessions; discharge only with a fresh result from the owning checker; surface pending background checks when an agent finishes |
| Ratchet and policy integrity | Tightening baselines, lint adoption and configuration digests | Apply equivalent integrity decisions across direct edits and transactional commands; record intentional exceptions; test malformed state, renamed scopes and partial analyzer batches |
| Provider conformance | Capability catalog, installed-hook receipts, supported Claude/Codex adapters | Execute lifecycle fixtures for every claimed control, including missing runtime, denied tools, delayed PostToolUse and interrupted work; keep experimental capabilities explicitly labeled until verified |
| Operator and CI decisions | `doctor`, `verify`, `lint check`, `data health`, searchable local evidence | One inspectable readiness result distinguishing findings, stale evidence, missing capture and unavailable checks; stable machine-readable exit semantics; links to the source evidence and an actionable repair step |
| Effectiveness measurement | Existing regression tests, replay and evidence infrastructure | Compare lint alone, lint with agent hooks, and full enforcement on the same tasks; measure introduced defects, false blocks, verification gaps, repair turns and latency separately; publish measured scope and uncertainty |

## Work started in this change

- Biome overlays now distinguish completed, unconfigured and unavailable runs.
  Transactional consumers reject unavailable runs. Both sides of the lint delta
  use the same analyzer; additional occurrences of an existing rule are counted.
  Diagnostics retain attribution through filesystem path aliases.
- `write` and `multi-edit` use the shared transaction implementation, with target
  snapshots before the gate and a comparison under the project commit lock.
  Unchanged batch members are checked for drift without being rewritten.
- Integration coverage exercises concurrent target changes, duplicate targets,
  symlink escapes, permission preservation, rollback and unavailable verification.
  Staging failures have a regression test for cleaning a partially written temp.

These changes complete the first transaction integration slice. The table above
remains the broader backlog; it is not a statement that every track has shipped.

## Boundaries to preserve

Ordinary edit hooks keep expensive compiler/linter work asynchronous. Transactional
CLI gates explicitly opt into synchronous proposed-content checking. Heuristic
judgments remain advisory; only deterministic policy violations qualify for
pre-execution blocks. A provider event stream is not a syscall audit. The shared
commit lock coordinates cooperating Interlinked commands and does not provide
crash-atomic multi-file writes or exclude ordinary editors.

Every milestone includes regression tests at the owning boundary, generated-doc
updates when registry metadata changes, and updates plus validation for affected
source skills. Installed `.agents/skills/` copies are not edited as source.
