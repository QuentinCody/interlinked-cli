// ===========================================
// `interlinked verify` — project e2e section (Unit F6, plan §12)
// ===========================================
// The same evaluation `tests e2e check` runs (working tree, no reconcile,
// nothing executed), rendered as one verify section with the same reason
// codes. Absent policy ⇒ no section; open required obligation, invalid policy
// or an unavailable evaluation ⇒ the section fails under verify's exit
// convention. It never runs a suite.

import { evaluateE2e, formatEvaluation, type E2eEvaluation } from "../../harness/project-e2e/evaluate.js";
import { hasProjectE2ePolicy } from "../../harness/project-e2e/hooks.js";
import { runStructureVerify } from "./structure.js";

type StructureOpts = Parameters<typeof runStructureVerify>[1];

export interface ProjectE2eSection {
    status: E2eEvaluation["status"];
    failed: boolean;
    lines: string[];
    json: { status: E2eEvaluation["status"]; exit_code: 0 | 1 | 2; open_required: number; reason?: string; scenarios: Array<{ key: string; status: string; required: boolean; codes: string[] }> };
}
const UNCONFIGURED: ProjectE2eSection = { status: "unconfigured", failed: false, lines: [], json: { status: "unconfigured", exit_code: 2, open_required: 0, scenarios: [] } };
export function projectE2eSection(cwd: string): ProjectE2eSection {
    if (!hasProjectE2ePolicy(cwd)) {
        return UNCONFIGURED; // zero cost (and no clock read) in a repository without a policy
    }
    const evaluation = evaluateE2e({ root: cwd, atMs: Date.now() });
    const openRequired = evaluation.verdicts.filter(row => row.required && !row.satisfied).length;
    const scenarios = evaluation.verdicts.map(row => ({ key: row.key, status: row.status, required: row.required, codes: row.reasons.map(reason => reason.code) }));
    const json: ProjectE2eSection["json"] = { status: evaluation.status, exit_code: evaluation.exitCode, open_required: openRequired, scenarios };
    if (evaluation.reason !== undefined) {
        json.reason = evaluation.reason;
    }
    if (evaluation.status === "unconfigured") {
        return { status: evaluation.status, failed: false, lines: [], json };
    }
    const lines = formatEvaluation(evaluation);
    if (evaluation.exitCode === 1) {
        lines.push("next: interlinked tests e2e run (supervised execution; verify never runs a suite)");
    }
    return { status: evaluation.status, failed: evaluation.exitCode !== 0, lines, json };
}
/** verify's tail: the opt-in structure section (when requested), then the e2e section under verify's exit convention. */
export async function streamTailSections(cwd: string, opts: StructureOpts): Promise<void> {
    if (opts.structure) {
        await runStructureVerify(cwd, opts);
    }
    if (streamProjectE2eSection(cwd)) {
        process.exitCode = 1;
    }
}
/** Streams the section to stderr (verify's streaming mode); returns whether it failed so the caller applies verify's exit convention. */
export function streamProjectE2eSection(cwd: string): boolean {
    const section = projectE2eSection(cwd);
    if (section.status === "unconfigured") {
        return false;
    }
    const label = section.failed ? "\x1b[31me2e\x1b[0m" : "\x1b[32me2e\x1b[0m";
    process.stderr.write(`\n  ${label} (project e2e policy; same verdict as interlinked tests e2e check)\n`);
    for (const line of section.lines) {
        process.stderr.write(`    ${line}\n`);
    }
    return section.failed;
}
