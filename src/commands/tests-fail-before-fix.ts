import { realpathSync } from "node:fs";
import { failBeforeFix, type FailBeforeFixReport, type TestReport } from "../harness/fail-before-fix/index.js";
import { latestEditSession } from "../harness/fail-before-fix/edit-log.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

function counts(rows: readonly TestReport[]): { fail: number; pass: number; inconclusive: number } {
    return {
        fail: rows.filter(row => row.verdict === "fails-before-fix").length,
        pass: rows.filter(row => row.verdict === "passes-before-fix").length,
        inconclusive: rows.filter(row => row.verdict === "inconclusive").length,
    };
}

export function renderFailBeforeFix(report: FailBeforeFixReport): string {
    const lines = [`fail-before-fix: ${report.status} — session ${report.session}${report.base ? `, replayed from HEAD ${report.base.slice(0, 12)}` : ""}`];
    const replayed = report.files.filter(row => row.state === "reverted");
    lines.push(`  files: ${replayed.length} replayed (${replayed.filter(row => row.role === "product").length} product, ${replayed.filter(row => row.role === "test").length} test), ${report.files.length - replayed.length} unavailable`);
    if (report.recovered) lines.push(`  ${report.recovered} replayed edit(s) came from the transcript timeline: the harness log has no row for them`);
    lines.push(...report.reasons.map(reason => `  ${reason}`));
    if (report.status !== "ok") return lines.join("\n");
    const fresh = report.tests.filter(row => row.isNew), old = report.tests.filter(row => !row.isNew);
    const n = counts(fresh), o = counts(old);
    const strengthening = fresh.filter(row => row.verdict === "passes-before-fix" && !row.subjectChanged).length;
    lines.push(`  new tests: ${n.fail} fail on the pre-session code (they pin the change), ${n.pass} pass there, ${n.inconclusive} inconclusive`);
    lines.push(...fresh.filter(concern).map(row => `    passes before the change although the session changed its subject: ${row.file} › ${row.name}`));
    if (strengthening) lines.push(`    ${strengthening} new test(s) whose subject did not change pass there too (they strengthen existing behavior)`);
    lines.push(`  existing tests: ${o.pass} pass on the pre-session code, ${o.fail} fail there, ${o.inconclusive} inconclusive`);
    return lines.join("\n");
}

/** A new test, written beside code the session changed, that passes on the code from before the change. */
function concern(row: TestReport): boolean { return row.isNew && row.subjectChanged && row.verdict === "passes-before-fix"; }

/** 0 = evidence reported; 1 = --strict and a concern exists; 2 = no evidence (unavailable, unknown session). */
export function failBeforeFixExitCode(report: FailBeforeFixReport, strict: boolean): number {
    if (report.status === "unavailable" || report.status === "no-session") return 2;
    return strict && report.tests.some(concern) ? 1 : 0;
}

export async function testsFailBeforeFixCommand(options: { cwd?: string; session?: string; timeout?: string; strict?: boolean; json?: boolean }): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const root = realpathSync(options.cwd ?? process.cwd());
        const session = options.session ?? await latestEditSession(root);
        if (!session) { outputError(mode, "no applied edit in the live harness log; pass --session <id>"); process.exitCode = 2; return; }
        const budgetMs = Number(options.timeout ?? "300000");
        if (!Number.isFinite(budgetMs) || budgetMs <= 0) { outputError(mode, "--timeout must be a positive number of milliseconds"); process.exitCode = 2; return; }
        const report = await failBeforeFix({ root, session, budgetMs });
        output(mode, report, { normal: () => renderFailBeforeFix(report) });
        process.exitCode = failBeforeFixExitCode(report, options.strict === true);
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "fail-before-fix unavailable"); process.exitCode = 2; }
}
