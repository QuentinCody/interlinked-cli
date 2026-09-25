// ===========================================
// Playwright JSON reporter → structured cases (Unit E2, plan §10.2)
// ===========================================
// Playwright's `--reporter=json` writes { config, suites: [{ title, file,
// specs: [{ title, tests: [{ projectName, status, annotations, results:
// [{ status, retry, startTime, duration, error }] }] }], suites: [...] }] }.
// The normalizer keeps exact identities (file › title path [project]), lets
// the FIRST attempt decide (PE-27: a retry that passes never hides the first
// failure), never passes a skipped or expected-failure case, and refuses
// anything it cannot read exactly.

import { ReportInvalid, type StructuredCase, type StructuredReport } from "./structured-report.js";

const MAX_CASES = 50_000;
const MAX_MESSAGE_CHARS = 1024;
const RESULT_STATUSES = new Set(["passed", "failed", "timedOut", "skipped", "interrupted"]);
const EXPECTED_FAILURE_ANNOTATIONS = new Set(["fail", "fixme"]);
interface PlaywrightResult { status: string; retry: number; startTime?: string; duration?: number; error?: { message?: string }; }
interface Walk { titles: string[]; out: StructuredCase[]; where: string; }

function fail(message: string): never { throw new ReportInvalid(message); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function parseResult(value: unknown, where: string): PlaywrightResult {
    if (!isRecord(value) || typeof value.status !== "string" || !RESULT_STATUSES.has(value.status)) fail(`${where}: result status ${JSON.stringify(isRecord(value) ? value.status : value)} is not a Playwright result status`);
    const row: PlaywrightResult = { status: value.status, retry: typeof value.retry === "number" ? value.retry : 0 };
    if (typeof value.startTime === "string") row.startTime = value.startTime;
    if (typeof value.duration === "number") row.duration = value.duration;
    if (isRecord(value.error) && typeof value.error.message === "string") row.error = { message: value.error.message };
    return row;
}
function expectedFailure(test: Record<string, unknown>): boolean {
    return list(test.annotations).some(item => isRecord(item) && typeof item.type === "string" && EXPECTED_FAILURE_ANNOTATIONS.has(item.type));
}
function statusOf(test: Record<string, unknown>, first: PlaywrightResult | undefined): StructuredCase["status"] {
    if (expectedFailure(test)) return "todo";
    if (!first || first.status === "skipped") return "skipped";
    return first.status === "passed" ? "passed" : "failed";
}
function messageOf(results: PlaywrightResult[]): string | undefined {
    const laterPass = results.find(item => item.retry > 0 && item.status === "passed");
    const notes = [results[0]?.error?.message ?? "", laterPass ? `passed on retry ${laterPass.retry}; the first attempt counts` : ""].filter(Boolean);
    return notes.length ? notes.join(" — ").slice(0, MAX_MESSAGE_CHARS) : undefined;
}
/** The first attempt decides; a later passing retry is recorded in the message, never as the status (PE-27). */
function normalizeTest(test: Record<string, unknown>, id: string, where: string): StructuredCase {
    const results = list(test.results).map((item, index) => parseResult(item, `${where}.results[${index}]`)).sort((a, b) => a.retry - b.retry);
    const first = results[0];
    const row: StructuredCase = { id, status: statusOf(test, first), attempts: results.length };
    if (first?.duration !== undefined) row.durationMs = first.duration;
    if (first?.startTime !== undefined) row.startedAt = first.startTime;
    const message = messageOf(results);
    if (message !== undefined) row.message = message;
    return row;
}
function walkSpec(spec: unknown, file: string, walk: Walk): void {
    if (!isRecord(spec) || typeof spec.title !== "string") fail(`${walk.where} must have a title`);
    const path = [file || (typeof spec.file === "string" ? spec.file : ""), ...walk.titles, spec.title].filter(Boolean).join(" › ");
    for (const [index, test] of list(spec.tests).entries()) {
        if (!isRecord(test)) fail(`${walk.where}.tests[${index}] must be an object`);
        const variant = typeof test.projectName === "string" && test.projectName ? ` [${test.projectName}]` : "";
        walk.out.push(normalizeTest(test, `${path}${variant}`, `${walk.where}.tests[${index}]`));
        if (walk.out.length > MAX_CASES) fail(`report exceeds ${MAX_CASES} cases`);
    }
}
function walkSuite(suite: unknown, walk: Walk): void {
    if (!isRecord(suite)) fail(`${walk.where} must be an object`);
    const file = typeof suite.file === "string" ? suite.file : "";
    const titles = typeof suite.title === "string" && suite.title !== file ? [...walk.titles, suite.title] : walk.titles;
    for (const [index, spec] of list(suite.specs).entries()) walkSpec(spec, file, { titles, out: walk.out, where: `${walk.where}.specs[${index}]` });
    for (const [index, child] of list(suite.suites).entries()) walkSuite(child, { titles, out: walk.out, where: `${walk.where}.suites[${index}]` });
}
export function parsePlaywrightJson(text: string): StructuredReport {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (error) { fail(`report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    if (!isRecord(parsed)) fail("report must be a JSON object");
    if (!Array.isArray(parsed.suites)) fail("report.suites must be a list (Playwright's JSON reporter output)");
    const cases: StructuredCase[] = [];
    for (const [index, suite] of parsed.suites.entries()) walkSuite(suite, { titles: [], out: cases, where: `suites[${index}]` });
    const seen = new Set<string>();
    for (const row of cases) { if (seen.has(row.id)) fail(`duplicate case id ${row.id}`); seen.add(row.id); }
    return { format: "playwright", cases };
}
