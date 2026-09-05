import { defineDataSource, type DataSource } from "./catalog-types.js";

/** Source of truth for logical organization. Discovery includes unregistered files. */
export const DATA_CATALOG: readonly DataSource[] = [
    defineDataSource({ name: "check-executions", category: "quality", description: "All configured quality checks with completion, disabled, skipped, deferred and error states", producer: "harness/quality-checks/tool-check-loop", fields: ["file", "execution.id", "execution.status"] }),
    defineDataSource({ name: "data-maintenance", category: "runtime", description: "Bounded import and lossless retention run receipts", producer: "lib/data/maintenance", fields: ["executed", "indexing.complete", "indexing.inserted"] }),
    defineDataSource({ name: "capture-capabilities", category: "runtime", description: "Provider-visible data capability and coverage declarations", producer: "harness/data-capture-capabilities", fields: ["provider", "session_id", "capabilities"] }),
    defineDataSource({ name: "spec-drift", category: "quality", description: "Repository spec comparisons with scope and observation provenance", producer: "harness/server/spec-ledger-phase", fields: ["kind", "file", "relation", "observation"] }),
    defineDataSource({ name: "activity", category: "agent", description: "Activity, lifecycle, guard verdicts and audit hashes", producer: "harness/server/activity-writer", fields: ["type", "tool", "session", "summary"] }),
    defineDataSource({ name: "collection", category: "agent", description: "Normalized tool and agent events", producer: "lib/collection/writer", schema: "collection.v1", fields: ["kind", "phase", "provider", "provider_tool"] }),
    defineDataSource({ name: "timeline", category: "agent", description: "Transcript messages, exposed summaries, calls, results and usage", producer: "harness/timeline-writer", schema: "timeline.v1", fields: ["category", "session", "tool_name", "text"] }),
    defineDataSource({ name: "recurrences", category: "quality", description: "Observed incidents, misses and historical scan observations", producer: "harness/recurrence", fields: ["kind", "check_id", "file", "scan_id"] }),
    defineDataSource({ name: "recurrence-scans", category: "quality", description: "Identified codebase scan receipts and inventory changes", producer: "harness/recurrence-scanner", fields: ["scan_id", "kind", "file", "check_id"] }),
    defineDataSource({ name: "suggestion-telemetry", category: "quality", description: "Advisory candidates, scores and delivery evidence", producer: "harness/suggestion-scorer", fields: ["finding_id", "check", "score", "shown"] }),
    defineDataSource({ name: "suggestion-outcomes", category: "quality", description: "Subsequent advisory observations", producer: "harness/suggestion-telemetry", fields: ["finding_id", "check", "file", "outcome"] }),
    defineDataSource({ name: "suggestion-summaries", category: "quality", description: "Candidate calibration aggregates", producer: "harness/suggestion-scorer", fields: ["check", "candidates", "shown", "score_sum"] }),
    defineDataSource({ name: "warning-occurrences", category: "quality", description: "Warning first, repeat, change and absence evidence", producer: "harness/warning-evidence", fields: ["warning_id", "kind", "repeat_count", "message"] }),
    defineDataSource({ name: "dedup-shadow", category: "runtime", role: "diagnostic", retention: "diagnostic", description: "Redundant hook deliveries and timing; observation only", producer: "harness/event-dedup", fields: ["key_kind", "key", "delivery_index", "ms_since_first"] }),
    defineDataSource({ name: "reservation-events", category: "coordination", description: "File lease grants, releases and conflicts", producer: "harness/reservations-state-machine", fields: ["action", "file", "agent_name", "conflict_reason"] }),
    defineDataSource({ name: "costs", category: "usage", description: "Per-message token deltas and model attribution", producer: "harness/data-capture-usage", trigger: "new provider usage record", fields: ["session_id", "model", "input_tokens", "output_tokens"] }),
    defineDataSource({ name: "check-results", category: "quality", description: "Per-call findings and execution coverage", producer: "harness/check-results-sink", fields: ["tool", "decision", "ran", "checks.id"] }),
    defineDataSource({ name: "sync-errors", category: "transport", role: "diagnostic", description: "Optional server transport failures", producer: "lib/local-activity-sync", trigger: "failed configured sync attempt", fields: ["stage", "message"] }),
    defineDataSource({ name: "files-touched", category: "agent", description: "Per-file change receipts", producer: "harness/data-capture-native", fields: ["file", "tool", "lines_added", "lines_removed"] }),
    defineDataSource({ name: "tests", category: "quality", description: "Verification command results", producer: "harness/data-capture-native", trigger: "completed verification command", fields: ["kind", "outcome", "command", "duration_ms"] }),
    defineDataSource({ name: "test-events", category: "quality", description: "Opt-in individual test cases and run boundaries", producer: "lib/viz/reporter-vitest", trigger: "test reporter event when configured", fields: ["kind", "file", "name", "status"] }),
    defineDataSource({ name: "daemon-events", category: "runtime", description: "Daemon lifecycle, handovers and resource diagnostics", producer: "harness/daemon-ledger", fields: ["event", "reason", "rss_mb", "outcome"] }),
    defineDataSource({ name: "latency", path: "logs/latency.jsonl", category: "runtime", role: "diagnostic", retention: "diagnostic", description: "Hook/check timing telemetry", producer: "harness/latency-log", fields: ["tool", "hook_event", "total_ms"] }),
    defineDataSource({ name: "stop-digest", category: "quality", description: "Details retained behind bounded Stop presentation", producer: "harness/stop-digest", fields: ["kind", "tag", "check", "text"] }),
    defineDataSource({ name: "obligations", category: "quality", role: "state-ledger", description: "Debt open/discharge transactions; fold before counting open work", producer: "harness/obligation-ledger-io", fields: ["op", "kind", "file", "id"] }),
    defineDataSource({ name: "coverage-obligations", category: "quality", role: "state-ledger", description: "Coverage deferral and discharge transactions", producer: "harness/coverage-obligation-ledger", fields: ["kind", "file", "reason"] }),
    defineDataSource({ name: "mutation-receipts", category: "quality", role: "state-ledger", description: "Overlay-bound mutation evidence", producer: "harness/mutation/manifest", fields: ["generation", "engine", "overlayHash"] }),
    defineDataSource({ name: "mutation-runs", category: "quality", description: "Mutation execution totals and duration", producer: "harness/mutation/run-log", fields: ["file", "mutants", "killed", "survived"] }),
    defineDataSource({ name: "mutation-findings", category: "quality", role: "state-ledger", description: "Durable background mutation delivery receipts", producer: "harness/mutation", fields: ["job_id", "file", "status"] }),
    defineDataSource({ name: "background-tasks", category: "agent", description: "Background shell, subagent and workflow status", producer: "harness/background-task-log", fields: ["id", "type", "status", "description"] }),
    defineDataSource({ name: "gate-reach", category: "quality", description: "Observed gate-stage reachability", producer: "harness/gate-reach-collect", fields: ["session_id", "gates"] }),
    defineDataSource({ name: "verify-runs", category: "quality", description: "Whole-project verification summaries", producer: "commands/verify/verify-summary", fields: ["mode", "files_scanned", "exit_code", "duration_ms"] }),
    defineDataSource({ name: "ephemeral-writes", category: "runtime", description: "Scratch and temporary write evidence", producer: "harness/ephemeral-write-log", fields: ["path", "kind", "bytes", "blocked"] }),
    defineDataSource({ name: "graph-history", category: "quality", description: "Periodic structural counts", producer: "harness/data-capture-graph", fields: ["files", "lines", "import_edges", "resolved_exports"] }),
    defineDataSource({ name: "permission-rule-strips", category: "audit", retention: "preserve", description: "Permission configuration removals", producer: "lib/settings-validator", fields: ["file", "bucket", "rule", "reason"] }),
    defineDataSource({ name: "guard-events", category: "audit", retention: "preserve", description: "Guard enable, disable and clear state changes", producer: "lib/guard-state", fields: ["action", "disabled", "reason", "by"] }),
    defineDataSource({ name: "content-scanner-audit", path: "content-scanner.audit.jsonl", category: "audit", retention: "preserve", description: "Content-scanner configuration changes", producer: "commands/scanner", fields: ["action", "actor", "reason"] }),
    defineDataSource({ name: "metacoder-audit", path: "metacoder.audit.jsonl", category: "audit", retention: "preserve", description: "Historical metacoder configuration changes", producer: "legacy/metacoder", fields: ["action", "actor", "reason"] }),
    defineDataSource({ name: "baseline-folds", category: "audit", retention: "preserve", description: "Baseline tightening/refusal receipts", producer: "harness/baseline-autofold", fields: ["kind", "changed", "refused", "details"] }),
    defineDataSource({ name: "sponsor-beacons", category: "usage", description: "Sponsor impressions", producer: "harness/sponsor", trigger: "eligible sponsor impression", fields: ["kind", "creative", "campaign"] }),
    defineDataSource({ name: "realtime-retry", category: "transport", role: "state-ledger", description: "Pending optional activity transport", producer: "lib/hooks-template", fields: ["type", "tool", "session_id"] }),
    defineDataSource({ name: "error-history", category: "quality", role: "state-ledger", description: "Error context and later resolution evidence", producer: "harness/error-history", fields: ["check_name", "file", "message"] }),
    defineDataSource({ name: "steering-corpus", category: "corpus", role: "corpus", description: "Derived turn corpus with exposed-summary provenance", producer: "scripts/reasoning/build-steering-corpus", fields: ["session", "turn", "teacherModel", "task"] }),
    defineDataSource({ name: "fable-activity", category: "corpus", role: "corpus", description: "Historical model-specific activity corpus", producer: "scripts/reasoning", fields: ["session", "type", "tool"] }),
    defineDataSource({ name: "claude-fable-5-complete", category: "corpus", role: "corpus", description: "Derived model-specific timeline", producer: "scripts/extract-model-timeline", fields: ["session", "category", "model"] }),
    ...["graph-observations", "graph-predictions", "graph-reconciliations"].map((name) => defineDataSource({ name, category: "corpus", role: "corpus", description: "Graph prediction experiment evidence", producer: "harness/graph-prediction-cache", fields: ["case", "file_path", "comparison_status", "decision"] })),
    defineDataSource({ name: "findings", path: "findings/corpus.jsonl", category: "quality", role: "state-ledger", description: "Finding corpus and simplification evidence", producer: "harness/findings", fields: ["id", "status", "file", "message"] }),
    defineDataSource({ name: "finding-reconciliation", path: "findings/reconciliation.jsonl", category: "quality", role: "state-ledger", description: "Finding acknowledgments and touched transitions", producer: "harness/spec/reconciliation", fields: ["id", "state", "reason"] }),
    defineDataSource({ name: "simplification-runs", path: "findings/simplification-runs.jsonl", category: "quality", role: "state-ledger", description: "Explicit simplification run receipts", producer: "lib/simplification", fields: ["run_id", "scope", "status"] }),
    defineDataSource({ name: "manual-marker-snapshots", path: "debt/manual-marker-snapshots.jsonl", category: "quality", role: "state-ledger", description: "Manual debt marker snapshots", producer: "lib/manual-debt-markers", fields: ["file", "kind", "status"] }),
    defineDataSource({ name: "failures", path: "failures/index.jsonl", category: "runtime", role: "diagnostic", description: "Failure artifact index", producer: "harness/failure-record", fields: ["id", "file", "reason"] }),
    defineDataSource({ name: "offline-spool", category: "transport", role: "state-ledger", description: "Pending local guard telemetry", producer: "harness/telemetry-spool", fields: ["type", "decision", "tool"] }),
    defineDataSource({ name: "capture-receipts", category: "runtime", description: "Producer eligibility, successful writes and failures", producer: "lib/data/capture", fields: ["source", "status", "records", "error"] }),
    defineDataSource({ name: "audit-checkpoints", category: "audit", retention: "preserve", description: "Explicit audit recovery boundaries and evidence hashes", producer: "lib/data/audit", fields: ["reason", "source", "offset", "hash"] }),
];

export function dataSourceForPath(path: string): DataSource {
    const normalized = path.replace(/\\/g, "/");
    const plain = normalized.replace(/\.\d+$/, "");
    const segment = /^archive\/(.+)-\d+\.jsonl\.gz$/.exec(plain);
    const logical = segment ? `${segment[1]}.jsonl` : plain;
    const known = DATA_CATALOG.find((source) => source.path === logical);
    if (known) return known;
    return defineDataSource({
        name: normalized, path: normalized, category: "unknown", retention: "preserve",
        description: "Discovered evidence; producer and schema not registered",
        producer: "unknown", fields: ["kind", "type", "category"],
    });
}

export function renderDataCatalogMarkdown(): string {
    const rows = DATA_CATALOG.map((source) =>
        `| \`${source.path}\` | ${source.category} | ${source.role} | ${source.retention} | ${source.producer} | ${source.description} |`);
    return [
        "<!-- Generated from src/lib/data/catalog.ts; do not edit manually. -->",
        "# Local data catalog", "",
        "Unregistered JSONL files are discovered and labeled unknown. Missing files are not created by discovery.",
        "Event time and ingestion time are distinct. Raw evidence and state ledgers remain authoritative.", "",
        "| Path | Category | Role | Retention | Producer | Purpose |",
        "|---|---|---|---|---|---|", ...rows, "",
    ].join("\n");
}
