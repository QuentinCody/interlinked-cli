import { createHash } from "node:crypto";

export interface DetectorExecution {
    check: string;
    status: "completed" | "unavailable" | "suppressed" | "removed";
    findings: Array<{ line: number; text: string; emitted?: boolean | null; suppressed?: string }>;
    /** Intended emission only; null means delivery information is unavailable. */
    emitted: boolean | null;
    duration_ms: number | null;
    reason?: string;
}
export interface CheckObservation {
    schema: "check-observations.v1";
    ts: string;
    session: string;
    call: string;
    file: string;
    input: string | null;
    detector: string | null;
    configuration: string | null;
    scope: "full" | "partial";
    executions: DetectorExecution[];
}
type Latest = "present" | "rechecked-clean" | "not-rechecked" | "unavailable" | "suppressed" | "removed";
export interface FindingState {
    id: string;
    anchor: string;
    text_fingerprint: string;
    matching_ambiguous: boolean;
    check: string;
    file: string;
    detector: string | null;
    configuration: string | null;
    first_seen: string;
    last_seen: string;
    last_call: string;
    latest: Latest;
    emissions: number;
    delivery_unknown: number;
    recurrences: number;
    followed_up: boolean;
    /** An inline acknowledgement is not a clean detector result. */
    disposition?: { state: "suppressed"; reason: string; at: string; session: string };
}
export function evidenceDigest(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}
function occurrenceIds(row: CheckObservation, execution: DetectorExecution): string[] {
    // Conservative file/check slots. Changed text is ambiguous, never an inferred
    // repair; implementation version belongs to observations, not finding identity.
    return execution.findings.map((_finding, slot) => evidenceDigest(JSON.stringify(["file-check-slot:v2", row.file, execution.check, slot])));
}
function isBound(row: CheckObservation): boolean {
    return row.input !== null && row.detector !== null && row.configuration !== null;
}
function occurrenceAnchor(row: CheckObservation, check: string): string {
    return evidenceDigest(JSON.stringify([row.file, check]));
}
function ambiguousMatch(state: Map<string, FindingState>, execution: DetectorExecution, anchor: string): boolean {
    const prior = [...state.values()].filter(finding => finding.anchor === anchor && finding.latest !== "rechecked-clean");
    return prior.length > 0 && execution.findings.length > 0 && prior.length !== execution.findings.length;
}
function updatePrior(state: Map<string, FindingState>, row: CheckObservation, seen: Set<string>): void {
    const executions = new Map(row.executions.map((execution) => [execution.check, execution]));
    for (const finding of state.values()) {
        if (finding.file !== row.file || seen.has(finding.id)) continue;
        const execution = executions.get(finding.check);
        const compatible = finding.detector !== null && finding.configuration !== null
            && finding.detector === row.detector && finding.configuration === row.configuration;
        finding.followed_up = false;
        finding.latest = "not-rechecked";
        if (!execution || !compatible) continue;
        if (execution.status !== "completed") {
            finding.latest = execution.status;
        } else if (row.scope === "full" && isBound(row)) {
            if (execution.findings.length > 0) {
                finding.matching_ambiguous = true;
                continue;
            }
            finding.latest = "rechecked-clean";
            finding.followed_up = true;
            finding.matching_ambiguous = false;
        }
    }
}
function observeOccurrence(args: { state: Map<string, FindingState>; previous: Map<string, FindingState>; row: CheckObservation; execution: DetectorExecution; id: string; index: number }): void {
    const { state, previous, row, execution, id, index } = args;
    const prior = previous.get(id);
    const hit = execution.findings[index]!;
    const anchor = occurrenceAnchor(row, execution.check);
    const textFingerprint = evidenceDigest(hit.text.trim().replace(/\s+/g, " "));
    const ambiguous = prior !== undefined && (prior.text_fingerprint !== textFingerprint || ambiguousMatch(previous, execution, anchor));
    const compatible = prior?.detector === row.detector && prior?.configuration === row.configuration;
    const emitted = hit.emitted === undefined ? execution.emitted : hit.emitted;
    const call = row.session + ":" + row.call;
    if (prior?.last_call === call) return;
    state.set(id, {
        id, anchor, text_fingerprint: textFingerprint, matching_ambiguous: ambiguous, check: execution.check, file: row.file, detector: row.detector, configuration: row.configuration,
        first_seen: prior?.first_seen ?? row.ts, last_seen: row.ts, last_call: call, latest: "present",
        emissions: (prior?.emissions ?? 0) + Number(emitted === true),
        delivery_unknown: (prior?.delivery_unknown ?? 0) + Number(emitted === null),
        recurrences: (prior?.recurrences ?? 0) + Number(compatible && prior?.latest === "rechecked-clean"),
        followed_up: compatible && !ambiguous && row.scope === "full" && isBound(row),
        ...(hit.suppressed === undefined ? {} : { disposition: { state: "suppressed", reason: hit.suppressed, at: row.ts, session: row.session } }),
    });
}
/** Absence requires an explicit full compatible execution before clearance. */
export function foldObservation(state: Map<string, FindingState>, row: CheckObservation): void {
    const seen = new Set<string>();
    const previous = new Map(state);
    for (const execution of row.executions) {
        if (execution.status !== "completed") continue;
        for (const [index, id] of occurrenceIds(row, execution).entries()) {
            seen.add(id);
            observeOccurrence({ state, previous, row, execution, id, index });
        }
    }
    updatePrior(state, row, seen);
}
export function summarizeOutcomes(state: ReadonlyMap<string, FindingState>) {
    const checks = new Map<string, FindingState[]>();
    for (const finding of state.values()) {
        const bucket = checks.get(finding.check) ?? [];
        bucket.push(finding);
        checks.set(finding.check, bucket);
    }
    return [...checks].sort(([a], [b]) => a.localeCompare(b)).map(([check, findings]) => {
        const count = (latest: Latest) => findings.filter((finding) => finding.latest === latest).length;
        const followups = findings.filter((finding) => finding.followed_up).length;
        return { check, unique_findings: findings.length, present: count("present"), rechecked_clean: count("rechecked-clean"),
            not_rechecked: count("not-rechecked"), unavailable: count("unavailable"), suppressed: count("suppressed"), removed: count("removed"),
            emissions: findings.reduce((n, f) => n + f.emissions, 0), delivery_unknown: findings.reduce((n, f) => n + f.delivery_unknown, 0),
            findings_ever_emitted: findings.filter(f => f.emissions > 0).length,
            repeat_emissions: findings.reduce((n, f) => n + Math.max(0, f.emissions - 1), 0),
            acknowledged: findings.filter(f => f.disposition?.state === "suppressed").length,
            ambiguous_occurrences: findings.filter(f => f.matching_ambiguous).length,
            recurrences: findings.reduce((n, f) => n + f.recurrences, 0), followup_coverage: followups / findings.length,
            observed_clearance: followups > 0 ? count("rechecked-clean") / followups : null,
        };
    });
}
