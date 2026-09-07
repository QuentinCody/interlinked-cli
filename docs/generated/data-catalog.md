<!-- Generated from src/lib/data/catalog.ts; do not edit manually. -->
# Local data catalog

Unregistered JSONL files are discovered and labeled unknown. Missing files are not created by discovery.
Event time and ingestion time are distinct. Raw evidence and state ledgers remain authoritative.

| Path | Category | Role | Retention | Producer | Purpose |
|---|---|---|---|---|---|
| `native-claude.jsonl` | agent | events | preserve | lib/data-search/snapshot | Explicit local snapshots of original Claude transcripts; not an automatic native-history backup |
| `check-executions.jsonl` | quality | events | archive | harness/quality-checks/tool-check-loop | All configured quality checks with completion, disabled, skipped, deferred and error states |
| `data-maintenance.jsonl` | runtime | events | archive | lib/data/maintenance | Bounded import and lossless retention run receipts |
| `capture-capabilities.jsonl` | runtime | events | archive | harness/data-capture-capabilities | Provider-visible data capability and coverage declarations |
| `spec-drift.jsonl` | quality | events | archive | harness/server/spec-ledger-phase | Repository spec comparisons with scope and observation provenance |
| `activity.jsonl` | agent | events | archive | harness/server/activity-writer | Activity, lifecycle, guard verdicts and audit hashes |
| `collection.jsonl` | agent | events | archive | lib/collection/writer | Normalized tool and agent events |
| `timeline.jsonl` | agent | events | archive | harness/timeline-writer | Transcript messages, exposed summaries, calls, results and usage |
| `recurrences.jsonl` | quality | events | archive | harness/recurrence | Observed incidents, misses and historical scan observations |
| `recurrence-scans.jsonl` | quality | events | archive | harness/recurrence-scanner | Identified codebase scan receipts and inventory changes |
| `suggestion-telemetry.jsonl` | quality | events | archive | harness/suggestion-scorer | Advisory candidates, scores and delivery evidence |
| `suggestion-outcomes.jsonl` | quality | events | archive | harness/suggestion-telemetry | Subsequent advisory observations |
| `suggestion-summaries.jsonl` | quality | events | archive | harness/suggestion-scorer | Candidate calibration aggregates |
| `warning-occurrences.jsonl` | quality | events | archive | harness/warning-evidence | Warning first, repeat, change and absence evidence |
| `dedup-shadow.jsonl` | runtime | diagnostic | diagnostic | harness/event-dedup | Redundant hook deliveries and timing; observation only |
| `reservation-events.jsonl` | coordination | events | archive | harness/reservations-state-machine | File lease grants, releases and conflicts |
| `costs.jsonl` | usage | events | archive | harness/data-capture-usage | Per-message token deltas and model attribution |
| `check-results.jsonl` | quality | events | archive | harness/check-results-sink | Per-call findings and execution coverage |
| `sync-errors.jsonl` | transport | diagnostic | archive | lib/local-activity-sync | Optional server transport failures |
| `files-touched.jsonl` | agent | events | archive | harness/data-capture-native | Per-file change receipts |
| `tests.jsonl` | quality | events | archive | harness/data-capture-native | Verification command results |
| `test-events.jsonl` | quality | events | archive | lib/viz/reporter-vitest | Opt-in individual test cases and run boundaries |
| `daemon-events.jsonl` | runtime | events | archive | harness/daemon-ledger | Daemon lifecycle, handovers and resource diagnostics |
| `logs/latency.jsonl` | runtime | diagnostic | diagnostic | harness/latency-log | Hook/check timing telemetry |
| `stop-digest.jsonl` | quality | events | archive | harness/stop-digest | Details retained behind bounded Stop presentation |
| `obligations.jsonl` | quality | state-ledger | preserve | harness/obligation-ledger-io | Debt open/discharge transactions; fold before counting open work |
| `coverage-obligations.jsonl` | quality | state-ledger | preserve | harness/coverage-obligation-ledger | Coverage deferral and discharge transactions |
| `mutation-receipts.jsonl` | quality | state-ledger | preserve | harness/mutation/manifest | Overlay-bound mutation evidence |
| `mutation-runs.jsonl` | quality | events | archive | harness/mutation/run-log | Mutation execution totals and duration |
| `mutation-findings.jsonl` | quality | state-ledger | preserve | harness/mutation | Durable background mutation delivery receipts |
| `background-tasks.jsonl` | agent | events | archive | harness/background-task-log | Background shell, subagent and workflow status |
| `gate-reach.jsonl` | quality | events | archive | harness/gate-reach-collect | Observed gate-stage reachability |
| `verify-runs.jsonl` | quality | events | archive | commands/verify/verify-summary | Whole-project verification summaries |
| `ephemeral-writes.jsonl` | runtime | events | archive | harness/ephemeral-write-log | Scratch and temporary write evidence |
| `graph-history.jsonl` | quality | events | archive | harness/data-capture-graph | Periodic structural counts |
| `permission-rule-strips.jsonl` | audit | events | preserve | lib/settings-validator | Permission configuration removals |
| `guard-events.jsonl` | audit | events | preserve | lib/guard-state | Guard enable, disable and clear state changes |
| `content-scanner.audit.jsonl` | audit | events | preserve | commands/scanner | Content-scanner configuration changes |
| `metacoder.audit.jsonl` | audit | events | preserve | legacy/metacoder | Historical metacoder configuration changes |
| `baseline-folds.jsonl` | audit | events | preserve | harness/baseline-autofold | Baseline tightening/refusal receipts |
| `sponsor-beacons.jsonl` | usage | events | archive | harness/sponsor | Sponsor impressions |
| `realtime-retry.jsonl` | transport | state-ledger | preserve | lib/hooks-template | Pending optional activity transport |
| `error-history.jsonl` | quality | state-ledger | preserve | harness/error-history | Error context and later resolution evidence |
| `steering-corpus.jsonl` | corpus | corpus | preserve | scripts/reasoning/build-steering-corpus | Derived turn corpus with exposed-summary provenance |
| `fable-activity.jsonl` | corpus | corpus | preserve | scripts/reasoning | Historical model-specific activity corpus |
| `claude-fable-5-complete.jsonl` | corpus | corpus | preserve | scripts/extract-model-timeline | Derived model-specific timeline |
| `graph-observations.jsonl` | corpus | corpus | preserve | harness/graph-prediction-cache | Graph prediction experiment evidence |
| `graph-predictions.jsonl` | corpus | corpus | preserve | harness/graph-prediction-cache | Graph prediction experiment evidence |
| `graph-reconciliations.jsonl` | corpus | corpus | preserve | harness/graph-prediction-cache | Graph prediction experiment evidence |
| `findings/corpus.jsonl` | quality | state-ledger | preserve | harness/findings | Finding corpus and simplification evidence |
| `findings/reconciliation.jsonl` | quality | state-ledger | preserve | harness/spec/reconciliation | Finding acknowledgments and touched transitions |
| `findings/simplification-runs.jsonl` | quality | state-ledger | preserve | lib/simplification | Explicit simplification run receipts |
| `debt/manual-marker-snapshots.jsonl` | quality | state-ledger | preserve | lib/manual-debt-markers | Manual debt marker snapshots |
| `failures/index.jsonl` | runtime | diagnostic | archive | harness/failure-record | Failure artifact index |
| `offline-spool.jsonl` | transport | state-ledger | preserve | harness/telemetry-spool | Pending local guard telemetry |
| `capture-receipts.jsonl` | runtime | events | archive | lib/data/capture | Producer eligibility, successful writes and failures |
| `audit-checkpoints.jsonl` | audit | events | preserve | lib/data/audit | Explicit audit recovery boundaries and evidence hashes |
