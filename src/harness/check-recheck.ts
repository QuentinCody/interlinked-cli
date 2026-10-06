import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { CHECK_REGISTRY } from "./check-registry/index.js";
import { isInsideRoot } from "./large-file-policy.js";
import { appendCheckObservation, FILE_EVIDENCE_COHORT, makeCheckObservation, RAW_FILE_CHECK_CONFIGURATION } from "./check-observation-store.js";
import type { DetectorExecution } from "./finding-outcomes.js";

const MAX_RECHECK_FILES = 20;

function runFileDetectors(content: string, file: string): DetectorExecution[] {
    return CHECK_REGISTRY.filter((check) => FILE_EVIDENCE_COHORT.has(check.id)).map((check) => {
        const started = performance.now();
        try {
            return { check: check.id, status: "completed", findings: check.fn(content, file),
                emitted: false, duration_ms: performance.now() - started };
        } catch (error) {
            return { check: check.id, status: "unavailable", findings: [], emitted: null,
                duration_ms: performance.now() - started, reason: String(error) };
        }
    });
}

/** Bounded explicit follow-up independent of which files an agent chooses to edit. */
export function recheckFindingFiles(cwd: string, files: readonly string[]): { checked: number; unavailable: string[]; deferred: string[] } {
    let checked = 0;
    const unavailable: string[] = [];
    const unique = [...new Set(files)];
    for (const file of unique.slice(0, MAX_RECHECK_FILES)) {
        const absolute = resolve(cwd, file);
        if (!isInsideRoot(cwd, absolute)) { unavailable.push(file); continue; }
        const event = { hook_event: "Verify", session_id: "harness-health", agent_source: "cli",
            timestamp: new Date().toISOString(), tool_use_id: randomUUID() };
        try {
            if (statSync(absolute).size > 2_000_000) throw new Error("file exceeds 2 MB recheck budget");
            const content = readFileSync(absolute, "utf8");
            const row = makeCheckObservation({ event, file: relative(cwd, absolute), content,
                executions: runFileDetectors(content, absolute), scope: "full", configuration: RAW_FILE_CHECK_CONFIGURATION });
            // A raced input remains historical evidence and cannot qualify a current follow-up.
            if (readFileSync(absolute, "utf8") !== content) row.input = null;
            appendCheckObservation(cwd, event, row);
            checked++;
        } catch (error) {
            unavailable.push(file);
            const row = makeCheckObservation({ event, file: relative(cwd, absolute), content: "",
                scope: "partial", configuration: RAW_FILE_CHECK_CONFIGURATION,
                executions: [...FILE_EVIDENCE_COHORT].map(check => ({ check, status: "unavailable",
                    findings: [], emitted: null, duration_ms: null, reason: String(error) })) });
            row.input = null;
            appendCheckObservation(cwd, event, row);
        }
    }
    return { checked, unavailable, deferred: unique.slice(MAX_RECHECK_FILES) };
}
