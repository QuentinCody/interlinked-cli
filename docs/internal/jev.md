# Internal Jev evaluation

Jev is internal research as of 2026-09-22. The public CLI does not register a
`jev` command or invoke the legacy Jev reviewer at Stop. Default-off, log-only
hook experiments can call Jev through the edit shadow (`jev.enabled` and
`jev.shadow_edits`) or decision shadows (`decision_shadow.enabled`, backend
`jev`, and `jev.enabled`). See `docs/harness.md`, "Edit shadow" and "Decision
shadows", for their distinct configuration and evidence limits. They do not change
guard decisions. The experimental `metrics decisions` pipeline is a separate
explicitly configured inference surface. A possible paid semantic-review service
is future work; no customer credential or billing flow is shipped here.

Run from a source checkout with development dependencies installed:

```sh
node --import tsx scripts/internal/jev.mjs test-titles src/example.test.ts
node --import tsx scripts/internal/jev.mjs doc-claims docs/architecture.md --json
node --import tsx scripts/internal/jev.mjs claims final-message.txt transcript.jsonl --json
node --import tsx scripts/internal/jev.mjs claims final-message.txt transcript.jsonl --receipt-shadow links.json --json
```

Explicit invocation enables the internal client. Supply `TYPESAFE_API_KEY` in the
environment or the checkout's gitignored `.interlinked/config.local.json`.
Selected test bodies and document paragraphs are sent to TypeSafe. No API call
is made by requesting runner help. Scripts and source are excluded from the npm
package's file allowlist; the runner is not a public package entry point.

The reusable client and all three review algorithms remain under
`src/harness/jev/`, including claim-versus-transcript evaluation. Historical
datasets and calibration results remain under `scratch/2026-09-16-jev-*` and in
`docs/external-pulse/typesafe-jev.md`.

Findings remain advisory. The existing test-title/document actions can report
zero findings when individual API calls fail; do not treat that as a completed
clean review. The client ledger records failures, and improving evaluation
coverage reporting remains separate work.

## Deterministic receipt observation

`claims --receipt-shadow <links-file>` enables an internal, log-only comparison, off by default.
It appends `.interlinked/claim-receipt-shadow.jsonl`; it never changes Jev's findings,
warnings, exit decision or public Stop behavior. The shadow scores the first 12 receipt-grammar
claims in at most one additional Jev call on its own client and ledger; every later grammar claim
still gets its row, with a null Jev comparison. It makes no call when the message
has no grammar claim or the turn has no evidence. Its failures and spend never reach
the findings, warnings or exit decision (they appear only as "shadow spend" in the summary). Row-capture failures
are counted by `receiptShadowFailures()`, and observer-level failures by `claimShadowFailures()`;
neither can fail the judgment path.

The links file is an array of `{ claim, family, scope, receipt }`. `claim` must match the
source claim exactly. `scope` supplies `receiptId`, `cwd`, `sourceIdentity` and `selection`.
Use `family: "tests"` for a structured test-runner receipt; the other three families use
operational receipts. Schemas and predicates are in `src/harness/jev/receipt-verifiers.ts`.
Only the explicit forms `All N executed tests passed.`, `Command completed.`,
`Typecheck completed cleanly.` and `File \`PATH\` was written.` are interpreted.
A grammar claim is a sentence that matches one form exactly, after the line loses its list or
blockquote marker and any emphasis that wraps the whole line; a sentence ends at `.`, `!` or `?`
followed by whitespace and an uppercase letter, outside backtick code. Fenced code blocks never
yield grammar claims (the judgment path's legacy splitter strips only triple-backtick fences).
Each grammar claim gives exactly one row, keyed on that sentence with its backticks. In the
written log, a row whose claim no link names carries a sha256 digest instead of the claim text;
a linked claim is written scrubbed and length-capped.

Links and capture provenance must already be established; this observer does not infer
which execution a vague completion claim means, authenticate a supplied receipt, or
treat an existing file as an observed write. Missing, malformed or duplicate links stay
not assessable. Short exact claims omitted by the legacy splitter are scored by the shadow's
own call; a row's comparison is null when that call fails or no shadow client is supplied. A nonzero command exit can establish completion without
establishing success. Keep replay/fixture statistics separate from live observations.
