// ===========================================
// Structured test reports — JSON protocol v1 and a JUnit XML subset
// ===========================================
// Plan 31 §10.1 / Unit C. A report NORMALIZES execution evidence: which
// native case ids ran and how each ended. It never establishes a boundary and
// never counts a skipped/todo case as a pass (§11). Both parsers are bounded,
// constructing and ambiguity-refusing: an unknown status, a duplicate id, a
// layout that could hide a case, or any XML entity/DOCTYPE machinery makes
// the whole report unreadable — unverified, never guessed at.

export const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_CASES = 50_000;
const MAX_ID_BYTES = 512;
const MAX_MESSAGE_CHARS = 1024;
export type StructuredStatus = "passed" | "failed" | "skipped" | "todo" | "error";
export type ReportFormat = "json" | "junit" | "playwright";
export interface StructuredCase {
    id: string; status: StructuredStatus; durationMs?: number; message?: string;
    /** Playwright (E2): the first attempt's start instant and the number of attempts observed — the window a boundary observation is correlated to. */ startedAt?: string; attempts?: number;
}
export interface StructuredReport { format: ReportFormat; cases: StructuredCase[]; }
const STATUSES: readonly StructuredStatus[] = ["passed", "failed", "skipped", "todo", "error"];

export class ReportInvalid extends Error {}
function fail(message: string): never { throw new ReportInvalid(message); }
function boundedText(text: string): void {
    if (Buffer.byteLength(text) > MAX_REPORT_BYTES) fail(`report exceeds ${MAX_REPORT_BYTES} bytes`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function onlyKeys(row: Record<string, unknown>, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(row)) if (!allowed.includes(key)) fail(`${where}: unknown key "${key}"`);
}
function caseId(value: unknown, where: string): string {
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > MAX_ID_BYTES || value.includes("\0")) fail(`${where} must be a non-empty id of at most ${MAX_ID_BYTES} bytes`);
    return value;
}
function refuseDuplicates(cases: readonly StructuredCase[]): void {
    const seen = new Set<string>();
    for (const row of cases) { if (seen.has(row.id)) fail(`duplicate case id ${row.id}`); seen.add(row.id); }
}
function jsonCase(value: unknown, where: string): StructuredCase {
    if (!isRecord(value)) fail(`${where} must be an object`);
    onlyKeys(value, ["id", "status", "durationMs", "message"], where);
    // SAFETY: widening the literal tuple to string[] for the membership test that itself narrows `status` below.
    if (typeof value.status !== "string" || !(STATUSES as readonly string[]).includes(value.status)) fail(`${where}.status must be one of ${STATUSES.join(", ")}`);
    // SAFETY: membership checked above.
    const row: StructuredCase = { id: caseId(value.id, `${where}.id`), status: value.status as StructuredStatus };
    if (value.durationMs !== undefined) { if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) fail(`${where}.durationMs must be a non-negative number`); row.durationMs = value.durationMs; }
    if (value.message !== undefined) { if (typeof value.message !== "string") fail(`${where}.message must be a string`); row.message = value.message.slice(0, MAX_MESSAGE_CHARS); }
    return row;
}
/** Protocol v1: `{ "version": 1, "cases": [{ "id", "status", "durationMs"?, "message"? }] }`. Any runner can emit it; no plugin needed. */
export function parseStructuredJson(text: string): StructuredReport {
    boundedText(text);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (error) { fail(`report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    if (!isRecord(parsed)) fail("report must be a JSON object");
    onlyKeys(parsed, ["version", "cases"], "report");
    if (parsed.version !== 1) fail(`report.version must be 1; got ${JSON.stringify(parsed.version)}`);
    if (!Array.isArray(parsed.cases)) fail("report.cases must be a list");
    if (parsed.cases.length > MAX_CASES) fail(`report.cases exceeds ${MAX_CASES} entries`);
    const cases = parsed.cases.map((item, index) => jsonCase(item, `cases[${index}]`));
    refuseDuplicates(cases);
    return { format: "json", cases };
}

// ---- JUnit XML subset ------------------------------------------------------
// Grammar accepted: an optional <?xml?> prolog and comments; one root that is
// <testsuites> (containing <testsuite>s) or a single <testsuite>; each
// <testcase name [classname] [time]> holds at most ONE of <failure>, <error>,
// <skipped>; <system-out>/<system-err>/<properties> are ignored. Nothing else.
interface Tag { name: string; attributes: Record<string, string>; closing: boolean; selfClosing: boolean; index: number; }
interface Suite { name: string; declaredTests: number | null; seen: number; }
interface OpenCase { id: string; outcome: StructuredStatus | null; message?: string; durationMs?: number; }
interface Walk { stack: string[]; suite: Suite | null; current: OpenCase | null; cases: StructuredCase[]; suites: number; }
const STANDARD_ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/;
const OUTCOME_OF: Record<string, StructuredStatus> = { failure: "failed", error: "error", skipped: "skipped" };
const MS_PER_SECOND = 1000;
const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function unescape(text: string): string {
    return text.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (_match, name: string) => {
        if (name === "amp") return "&"; if (name === "lt") return "<"; if (name === "gt") return ">"; if (name === "quot") return "\""; if (name === "apos") return "'";
        return String.fromCodePoint(name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10));
    });
}
/** No DOCTYPE, no ENTITY declarations, no entity references beyond the five standard ones and numeric ones: nothing is ever resolved. */
function refuseEntityMachinery(xml: string): void {
    if (/<!DOCTYPE/i.test(xml)) fail("DOCTYPE declarations are not accepted (no external or internal entity resolution)");
    if (/<!ENTITY/i.test(xml)) fail("ENTITY declarations are not accepted");
    for (const match of xml.matchAll(/&[^\s<]*;?/g)) if (!STANDARD_ENTITY.test(match[0])) fail(`entity reference ${match[0].slice(0, 32)} is not accepted; only the five standard and numeric entities are read`);
}
function stripMarkup(xml: string): string {
    return xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
}
function attributesOf(text: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    for (const match of text.matchAll(ATTRIBUTE)) attributes[match[1]!] = unescape(match[2] ?? match[3] ?? "");
    return attributes;
}
function tokenize(xml: string): Tag[] {
    const tags: Tag[] = [];
    for (const match of xml.matchAll(TAG)) tags.push({ closing: match[1] === "/", name: match[2]!, attributes: attributesOf(match[3] ?? ""), selfClosing: match[4] === "/", index: match.index });
    const stray = xml.replace(TAG, "").match(/<[^>]*$|<[^>]*>/);
    if (stray) fail(`malformed markup near ${JSON.stringify(stray[0].slice(0, 32))}`);
    return tags;
}
function openSuite(walk: Walk, tag: Tag): void {
    if (walk.suite) fail("nested testsuite elements are an ambiguous layout; flatten the report or split it per suite");
    if (walk.stack.some(name => name !== "testsuites")) fail("testsuite must be a root element or a child of testsuites");
    const declared = tag.attributes.tests;
    walk.suite = { name: tag.attributes.name ?? "", declaredTests: declared === undefined ? null : Number.parseInt(declared, 10), seen: 0 };
    walk.suites += 1;
}
function closeSuite(walk: Walk): void {
    const suite = walk.suite;
    if (suite && suite.declaredTests !== null && suite.declaredTests !== suite.seen) fail(`testsuite ${JSON.stringify(suite.name)} declares tests="${suite.declaredTests}" but holds ${suite.seen} testcase element(s)`);
    walk.suite = null;
}
function openCase(walk: Walk, tag: Tag): void {
    if (!walk.suite) fail("testcase outside a testsuite element");
    if (walk.current) fail("testcase nested inside testcase");
    const name = tag.attributes.name;
    if (name === undefined || !name.trim()) fail("testcase without a name attribute");
    const prefix = tag.attributes.classname?.trim() || walk.suite.name.trim();
    if (!prefix) fail(`testcase ${JSON.stringify(name)} has no classname and its suite has no name; the id would be ambiguous`);
    const row: OpenCase = { id: `${prefix}::${name}`, outcome: null };
    const seconds = tag.attributes.time === undefined ? Number.NaN : Number.parseFloat(tag.attributes.time);
    if (Number.isFinite(seconds) && seconds >= 0) row.durationMs = Math.round(seconds * MS_PER_SECOND);
    walk.current = row;
    walk.suite.seen += 1;
}
function closeCase(walk: Walk): void {
    const row = walk.current!;
    const result: StructuredCase = { id: caseId(row.id, "testcase id"), status: row.outcome ?? "passed" };
    if (row.durationMs !== undefined) result.durationMs = row.durationMs;
    if (row.message !== undefined) result.message = row.message;
    walk.cases.push(result);
    walk.current = null;
}
function markOutcome(walk: Walk, tag: Tag): void {
    if (!walk.current) fail(`${tag.name} outside a testcase`);
    if (walk.current.outcome !== null) fail(`testcase ${walk.current.id} carries both ${walk.current.outcome} and ${tag.name}; the outcome is ambiguous`);
    walk.current.outcome = OUTCOME_OF[tag.name] ?? "skipped";
    if (tag.attributes.message !== undefined) walk.current.message = tag.attributes.message.slice(0, MAX_MESSAGE_CHARS);
}
function enter(walk: Walk, tag: Tag): void {
    if (tag.name === "testsuite") openSuite(walk, tag);
    else if (tag.name === "testcase") openCase(walk, tag);
    else if (tag.name === "failure" || tag.name === "error" || tag.name === "skipped") markOutcome(walk, tag);
    else if (tag.name !== "testsuites" && tag.name !== "system-out" && tag.name !== "system-err" && tag.name !== "properties" && tag.name !== "property") fail(`unsupported element <${tag.name}>; the JUnit subset reads testsuites, testsuite, testcase, failure, error, skipped`);
    if (!tag.selfClosing) walk.stack.push(tag.name);
    else leave(walk, tag.name);
}
function leave(walk: Walk, name: string): void {
    if (name === "testsuite") closeSuite(walk);
    else if (name === "testcase") closeCase(walk);
}
function closeTag(walk: Walk, tag: Tag): void {
    const open = walk.stack.pop();
    if (open !== tag.name) fail(`mismatched closing tag </${tag.name}>${open ? ` (open: <${open}>)` : ""}`);
    leave(walk, tag.name);
}
/** Documented JUnit subset importer. Ambiguity (a count that disagrees, nesting, two outcomes) is refused, never guessed. */
export function parseJUnitXml(xml: string): StructuredReport {
    boundedText(xml);
    refuseEntityMachinery(xml);
    const walk: Walk = { stack: [], suite: null, current: null, cases: [], suites: 0 };
    for (const tag of tokenize(stripMarkup(xml))) {
        if (tag.closing) closeTag(walk, tag); else enter(walk, tag);
        if (walk.cases.length > MAX_CASES) fail(`report exceeds ${MAX_CASES} testcases`);
    }
    if (walk.stack.length) fail(`unclosed element <${walk.stack[walk.stack.length - 1]}>`);
    if (!walk.suites) fail("no testsuite element found");
    refuseDuplicates(walk.cases);
    return { format: "junit", cases: walk.cases };
}
export async function parseStructuredReport(text: string, format: ReportFormat): Promise<StructuredReport> {
    if (format === "playwright") { const { parsePlaywrightJson } = await import("./playwright-report.js"); return parsePlaywrightJson(text); }
    return format === "json" ? parseStructuredJson(text) : parseJUnitXml(text);
}
