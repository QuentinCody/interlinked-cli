# File size and guard-change prediction

Decision, 2026-09-25: per-file physical size is an advisory decomposition signal.
It must not refuse a source edit, a cold-fallback edit, verification, or a commit
solely because a file exceeds or grows beyond its recorded line threshold.
Keep existing measurements, thresholds and historical baselines; do not replace
the line gate with a statement-count gate. Other resource limits and per-function
metrics have separate contracts. No LLM context-size claim is made by line counts
or by the existing syntax-token counter.

Formatting, comments, optional braces and line wrapping must not be presented as
decomposition. Future blocking size proposals require transformation-invariance
tests and a stated purpose. Export/import structure and behavioral coverage can
inform review, but no scalar proves a module has one responsibility.

Brace policy follows the target repository's explicit linter configuration. The
generic readability fallback allows single-line guards and only advises about
multiline unbraced bodies. It does not rewrite source. Existing expression size,
callback count/depth and control-depth preferences remain advisory.

Guard changes extend predict–reveal–reconcile with a local before/after AST oracle.
An existing return/throw losing or changing its enclosing condition is a change
to predict before a proposed edit lands. Prediction mismatch is a protocol finding,
not a proof of a bug; a matching prediction declares the change, not its correctness.
Other checks and behavioral tests still apply.

The guard oracle runs on raw proposed content before formatting or brace fixes.
Predictions bind the session, canonical file identity, source hash and proposal
hash. A stale prediction, blanket acknowledgment or a prediction for a different
proposal cannot authorize a changed proposal. Revealed surprises remain recorded
as surprises even when a subsequent explicit reconciliation permits a retry.
Neither graph-shard availability nor graph-prediction opt-in governs this local
oracle. Its protocol modes and receipts must be explicit.

Initial syntax scope is JS/TS with exact parsing. Matching must be conservative:
unambiguous statement identity and function ownership are required. Formatting,
comments and optional braces do not change guard identity. Duplicate statements,
ambiguous moves, changed statement text, missing before-state and unsupported
syntax must never become a claimed clean guard-preservation result. Initial
lexical `if` ownership does not establish complete control-flow dominance,
exception reachability, or semantic equivalence of predicates.

Validation covers guard-preserving formatting, insertion/replacement/move loss,
changed predicates and branch polarity, nested functions, duplicate statements,
stale/session-mismatched predictions, multi-file proposals, missing parsers, and
independence from formatters and the remote graph oracle. Source/write hook
integration, native cold fallback, reference documentation and operational skills
must agree before handoff.

## Operational contract

Shared configuration accepts `harness.guard_prediction.mode`: `enforced`
(default), `shadow` (record and reveal without refusing), or `off`. The local
oracle runs in the prediction phase before write-content checks. Supermodel's
existing graph opt-in is unchanged. Supported but unmeasurable edits receive
NOT CHECKED; unsupported languages remain outside this first oracle.

Receipts live at `.interlinked/predictions/guards/<sha256(session)>/<id>.json`.
The ID is SHA-256 of `JSON.stringify([1, file, beforeSha256, afterSha256])`; `file`
is canonical and repository-relative, and hashes use exact UTF-8 source content.
Receipt fields are `version: 1`, `session`, these four proposal fields, a nonempty
declaration `nonce`, and expected `changes`. Each change records `owner`, `statement`,
`before` and `after`; guard stacks contain `{condition, branch}` from outer to inner,
with branch `then` or `else`. Statement/condition strings use parser-resolved token
spellings joined by spaces. Declare expected changes from the source before editing.

After a reveal, the receipt must also include `reconcile: id` and a nonempty
`rationale`, or the proposal must be corrected. Identical retries retain their
declaration, including retries after unrelated gates refuse an edit. Different
bytes, files or sessions cannot reuse it. `guard-events.jsonl` retains the original
surprise alongside later reconciliation. These records express agent intent, not
independent proof of correctness or an adversarial security boundary. Behavioral
tests still matter.

Complete unchanged function bodies do not generate fresh ambiguity warnings;
changed ambiguous bodies stay partial. Combined before/after source over 2 MB is
NOT CHECKED. Multi-file proposals are checked together; declarations are accepted
only after every file passes this oracle. Dry runs do not write events. A shared
cross-process ledger lock prevents concurrent admissions from losing a reveal.

Native cold fallback runs the same oracle. Self-contained generated hooks cannot
load an AST parser without the daemon and report NOT CHECKED. Arbitrary shell
mutation, cross-file moves, deleted/changed statements, loops, switches and exception
dominance remain outside this oracle. See the canonical
[harness skill](../skills/interlinked-harness/SKILL.md) for receipt recovery guidance.
