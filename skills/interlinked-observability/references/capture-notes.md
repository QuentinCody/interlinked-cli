# interlinked-observability: capture notes

Reference for [SKILL.md](../SKILL.md). Read it when a capture record or receipt field needs explanation.

For internal claim-verification research, `node --import tsx scripts/internal/jev.mjs claims
<final-message> <transcript> --receipt-shadow <links-file>` adds default-off, log-only
deterministic comparisons to `.interlinked/claim-receipt-shadow.jsonl`. It does not run from
public Stop hooks or change Jev's decision. Links explicitly bind a claim to receipt/source/
selection identities; missing or duplicate links remain not assessable. Only four narrow
receipt predicates are supported; see `docs/internal/jev.md`. A missing Jev score is unmeasured,
including short claims omitted by the legacy splitter. Separate replay statistics from live
usage, and inspect `receiptShadowFailures()` before treating an absent row as no claim.

Ordinary hook delivery omits deep-audit style/design messages after one review
notice, while raw check results remain intact. This applies to synchronous responses
and the late-warning spool; their deduplication state is separate so preparing a
fallback cannot consume the synchronous notice. Repeated guard-scope advice is
deduplicated per session. Compare native delivered feedback separately from raw
finding counts; fewer delivered warnings do not imply fewer findings or clean code.
Interactive ChangeSet batches defer project-wide Gitleaks to explicit verification
or background recovery, with an explicit non-verdict. Confirm actual tool timings
and completion before claiming latency or security-coverage improvements.

For Claude compiler batching, distinguish tool calls, scheduled checks, compiler
executions and delivered diagnostics. `hook-observation.v1` rows record scheduled
TypeScript work; batch results and timing are in `check-results.jsonl`. Pending work
survives in `.interlinked/compiler-batches/`. Coverage observations are retained even
when repeated model warnings are suppressed. Silence does not mean coverage is complete.
Measure a repeated-edit problem by assistant-message/tool-use identity and timestamps:
an edit emitted before an earlier hook's feedback cannot be attributed to that feedback.

`check-executions.jsonl` also carries `hook-observation.v1`: scheduled external overlays,
normal complexity/token measurements, and shadow trajectory observations. These are telemetry,
not check passes or confirmed model delivery. `check-results.jsonl` retains full findings,
including `novelty`, `findingCount` and server-computed `writeAttribution` where available.
Newly observed means report novelty, not proven causation. Repeated advisories may be hidden
from model feedback while remaining in each call's records; hidden findings prevent all-clean.

Own-barrel pre-write analysis can retain advisory `hook-observation.v1` rows with
`measurementState: "unavailable"` and `findingCount: 0`. The zero records no defect
finding from that unavailable evidence; it is not a passing graph verdict. Reasons
include missing or unresolved modules and the runtime traversal budget. These rows
do not create a blocking gate, certify delivery or clear pending check obligations.
Dry-run evaluation does not persist them.

Use `evals/compare-builds.mjs` for paired explicit-build agent pilots. It retains fixtures,
native streams, usage categories, settings, daemon status, final diffs and evaluator-owned
functional checks. Activity warning counts are ledger metrics. Missing native delivery/token
data remains unknown; do not infer billed savings from shorter commands or compressed rows.

`repeated_implementation` check results retain each current AST-matched group with
a `group=<sha256>` detail identity, even when unchanged agent-facing warnings are
suppressed. Compare these identities rather than line numbers across formatting edits.
Post-tool suppression is session-local and resets with the daemon; Stop uses its
existing digest state. NOT CHECKED means missing analysis, not zero clones. Findings
are review candidates, not proven defects or evidence that an extraction helped.


`hook-reentry.jsonl` records Stop/SubagentStop re-entry suppressed before daemon evaluation.
Translation receipts now include advisory context representation as well as denials and
rewrites. Operator-only Stop diagnostics are not model-context delivery. Audit native
completion messages by unique ID; streaming chunks and daemon Stop counts are insufficient
to count continuations.

Shared hook-check receipts may include `scopes` with a batch ID, check name, configuration
hash and captured request-file identities. `kind: request-inputs` is historical execution
evidence, not a complete runtime/dependency closure or reusable cache key. Nonempty
`unavailable` preserves partial evidence and leaves the obligation pending. Keep those states
separate from clean results when comparing recovered check counts or latency.

`source-scan-scope.v1` capture rows record dependency/runtime exclusions from authored-source
quality, with `excluded_not_checked` status. `source-scan-security.v1` retains the separate
security findings and request-input evidence. Neither row authenticates a writer or certifies
runtime-input closure. Repeated unavailable-check messages are deduplicated for delivery by
session, project, configuration and reason; raw check results retain missingness. Counts in
the agent channel therefore differ intentionally from raw deferral counts.

Cowork plugin receipts use a separate metadata-only schema and explicit exports.
Use **interlinked-cowork** and `interlinked cowork report <receipts> --effects <listing>`
for native conformance. An intended hook decision is not execution/prevention proof;
these receipts do not provide complete transcripts or authenticated writer attribution.
