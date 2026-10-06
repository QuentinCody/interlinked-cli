import { join } from "node:path";
import { readObservationWindow } from "./check-observation-window.js";
import { isJsonObject } from "../lib/json-types.js";
import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNullable, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import { foldObservation, summarizeOutcomes, type CheckObservation, type DetectorExecution, type FindingState } from "./finding-outcomes.js";

const execution = wireObject<DetectorExecution>({
    check: wireString, status: wireLiteral("completed", "unavailable", "suppressed", "removed"),
    findings: wireArray(wireObject({ line: wireNumber, text: wireString,
        emitted: wireAbsentOptional(wireNullable(wireBoolean)), suppressed: wireAbsentOptional(wireString) })), emitted: wireNullable(wireBoolean),
    duration_ms: wireNullable(wireNumber), reason: wireAbsentOptional(wireString),
});
const observationShape = wireObject<CheckObservation>({
    schema: wireLiteral("check-observations.v1"), ts: wireString, session: wireString, call: wireString, file: wireString,
    input: wireNullable(wireString), detector: wireNullable(wireString), configuration: wireNullable(wireString),
    scope: wireLiteral("full", "partial"), executions: wireArray(execution),
});

export function isCheckObservation(value: unknown): value is CheckObservation {
    if (!observationShape(value) || !Number.isFinite(Date.parse(value.ts))) return false;
    if (![value.session, value.call, value.file].every(text => text.length > 0)) return false;
    if (new Set(value.executions.map(row => row.check)).size !== value.executions.length) return false;
    return value.executions.every(row => row.check.length > 0
        && (row.duration_ms === null || Number.isFinite(row.duration_ms) && row.duration_ms >= 0)
        && row.findings.every(hit => Number.isSafeInteger(hit.line) && hit.line >= 1));
}
function isObservationRecord(row: unknown): boolean { return isJsonObject(row) && row.schema === "check-observations.v1"; }
interface ExecutionSummary {
    check: string; completed: number; unavailable: number; suppressed: number; removed: number;
    measured_ms: number; first: string; last: string; detector: string | null;
    configuration: string | null; file: string; scope: CheckObservation["scope"];
}
function foldExecutions(rows: Map<string, ExecutionSummary>, observation: CheckObservation): void {
    for (const execution of observation.executions) {
        const row = rows.get(execution.check) ?? { check: execution.check, completed: 0, unavailable: 0,
            suppressed: 0, removed: 0, measured_ms: 0, first: observation.ts, last: observation.ts,
            detector: observation.detector, configuration: observation.configuration, file: observation.file, scope: observation.scope };
        row[execution.status]++;
        row.measured_ms += execution.duration_ms ?? 0;
        if (observation.ts >= row.last) Object.assign(row, { last: observation.ts, detector: observation.detector,
            configuration: observation.configuration, file: observation.file, scope: observation.scope });
        rows.set(execution.check, row);
    }
}

export async function readFindingOutcomes(cwd: string) {
    const state = new Map<string, FindingState>();
    const executions = new Map<string, ExecutionSummary>();
    let legacyRows = 0;
    let invalidRows = 0;
    let observations = 0;
    let elapsedMs = 0;
    const path = join(cwd, ".interlinked/check-results.jsonl");
    const window = readObservationWindow(path);
        for (const line of window.lines) {
            if (!line.trim()) continue;
            try {
                const row: unknown = JSON.parse(line);
                if (!isCheckObservation(row)) { invalidRows += Number(isObservationRecord(row)); legacyRows += Number(!isObservationRecord(row)); continue; }
                foldObservation(state, row);
                foldExecutions(executions, row);
                observations++;
                elapsedMs += row.executions.reduce((sum, e) => sum + (e.duration_ms ?? 0), 0);
            } catch { invalidRows++; }
        }
    const { lines: _lines, ...readWindow } = window;
    return { schema: "finding-outcomes.v2", read_window: readWindow, checks: summarizeOutcomes(state), state: [...state.values()], executions: [...executions.values()],
        observation_window: { first: [...executions.values()].map(row => row.first).sort()[0] ?? null,
            last: [...executions.values()].map(row => row.last).sort().at(-1) ?? null },
        triage_cost: "unmeasured", severity_basis: "check metadata; individual impact unadjudicated",
        observations, legacy_rows: legacyRows, invalid_rows: invalidRows, measured_execution_ms: elapsedMs,
        coverage: "Bounded tail of the current unrotated log only; omitted history, legacy outcomes and native delivery remain unknown. File/check occurrence slots are conservative, not semantic identity.",
    };
}
