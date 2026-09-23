# Internal Jev evaluation

Jev is internal research as of 2026-09-22. The public CLI does not register a
`jev` command, and the harness does not call Jev automatically. Old `jev` entries
in guard configuration have no effect. A possible paid semantic-review service
is future work; no customer credential or billing flow is shipped here.

Run from a source checkout with development dependencies installed:

```sh
node --import tsx scripts/internal/jev.mjs test-titles src/example.test.ts
node --import tsx scripts/internal/jev.mjs doc-claims docs/architecture.md --json
node --import tsx scripts/internal/jev.mjs claims final-message.txt transcript.jsonl --json
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
