// ===========================================
// Test-quality advice for an edit (Unit E3, plan §12.3)
// ===========================================
// The §12.3 rule table as ADVISORIES attached to the scenario the edited test
// belongs to. Every signal is net-new (multiset diff of trimmed lines, so a
// moved or consolidated assertion is not a finding), deterministic, and
// advice only: the qualification gate never reads these — a required case is
// CASE_NOT_RUN or the boundary evidence is absent, or nothing is proven.

export interface TestQualityFinding { rule: string; /** 1-based line in the edited text, when the signal is an added line. */ line?: number; evidence: string; advice: string; }
export interface EditedText { path: string; before: string | null; after: string; }
interface Rule { rule: string; pattern: RegExp; advice: string; /** With a removed counterpart matching `pattern`, fire only when the added number is larger. */ numeric?: boolean; exempt?: RegExp; }

const MAX_LINES = 3;
const MAX_EVIDENCE = 120;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|e2e|spec|specs)\/|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go|rs)$/;
const ASSERTION = /\bexpect\s*\(|\bassert\b/;
const TEST_BLOCK = /\b(?:test|it)\s*(?:\.\w+)?\s*\(/;
const SPECIFIC_MATCHER = /\.to(?:Be|Equal|StrictEqual|HaveText|HaveLength|Contain|ContainText|MatchObject|HaveBeenCalledWith|HaveValue|HaveURL)\s*\(/;
const TRUTHINESS = /\.toBe(?:Truthy|Falsy|Defined)\s*\(\s*\)/;
const APP_ENDPOINT = /\bpage\.route\s*\(\s*["'`](?!https?:\/\/(?!localhost|127\.0\.0\.1))/;
const ADDED_RULES: Rule[] = [
    { rule: "focus-or-skip", pattern: /\.(?:only|skip|fixme)\s*\(|\b(?:xit|xtest|xdescribe)\s*\(|@pytest\.mark\.skip|#\[ignore\]/, advice: "explain the affected selection; a required variant that is omitted stays unresolved" },
    { rule: "force-option", pattern: /\bforce\s*:\s*true\b/, advice: "force bypasses actionability checks; prefer waiting for the element to be actionable" },
    { rule: "timeout-or-retry", pattern: /\b(?:retries|timeout)\s*[:=]\s*(\d+)|\btest\.setTimeout\s*\(\s*(\d+)/, numeric: true, advice: "a larger budget or passing retries can mask a required failure; the receipt records the first attempt only" },
    { rule: "timing-wait", pattern: /\bwaitForTimeout\s*\(|\bsleep\s*\(|new Promise\s*\(\s*\w+\s*=>\s*setTimeout/, advice: "prefer a bounded condition-based wait (expect(...).toHaveText / waitForResponse) over a fixed delay" },
    { rule: "brittle-locator", pattern: /\b(?:locator|\$\$?|querySelector(?:All)?)\s*\(\s*["'`](?:xpath=|\/\/|[.[]|[^"'`]*\s>\s)/, advice: "prefer a role or test-id locator; a CSS/XPath path alone proves no behavioral defect but breaks on layout changes" },
    { rule: "endpoint-mock", pattern: /\bnock\s*\(|\bsetupServer\s*\(|\b(?:rest|http)\.(?:get|post|put|delete|patch)\s*\(|\bfetchMock\b/, advice: "an intercepted application endpoint replaces the real boundary; the scenario's real components must still be observed through the owned app" },
];

export function isTestFile(path: string): boolean { return TEST_PATH.test(path.replaceAll("\\", "/")); }
function lines(text: string | null): string[] { return text === null ? [] : text.split(/\r?\n/); }
function counts(rows: string[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const row of rows) { const key = row.trim(); if (key) result.set(key, (result.get(key) ?? 0) + 1); }
    return result;
}
/** Lines of `after` (with their 1-based numbers) not present in `before` as a multiset, and removed lines the other way. */
function netNew(before: string | null, after: string): { added: Array<{ line: number; text: string }>; removed: string[] } {
    const seen = counts(lines(before)), afterCounts = counts(lines(after));
    const added: Array<{ line: number; text: string }> = [];
    const budget = new Map(seen);
    for (const [index, raw] of lines(after).entries()) {
        const text = raw.trim();
        if (!text) continue;
        const left = budget.get(text) ?? 0;
        if (left > 0) budget.set(text, left - 1); else added.push({ line: index + 1, text });
    }
    const removed: string[] = [];
    for (const [text, count] of seen) { const surplus = count - (afterCounts.get(text) ?? 0); for (let index = 0; index < surplus; index += 1) removed.push(text); }
    return { added, removed };
}
function count(rows: string[], pattern: RegExp): number { return rows.filter(row => pattern.test(row)).length; }
function evidenceOf(text: string): string { return text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE - 1)}…` : text; }
function numberIn(text: string, pattern: RegExp): number | null {
    const match = pattern.exec(text);
    const value = match?.slice(1).find(group => group !== undefined);
    return value === undefined ? null : Number(value);
}
/** A raised budget fires only when it exceeds every removed counterpart; a lowered or unchanged one is not a signal. */
function numericRaised(rule: Rule, added: string, removed: string[]): boolean {
    const value = numberIn(added, rule.pattern);
    const counterparts = removed.filter(row => rule.pattern.test(row)).map(row => numberIn(row, rule.pattern)).filter((row): row is number => row !== null);
    return value !== null && (!counterparts.length || counterparts.every(row => value > row));
}
function addedLineFindings(added: Array<{ line: number; text: string }>, removed: string[]): TestQualityFinding[] {
    const findings: TestQualityFinding[] = [];
    for (const rule of ADDED_RULES) {
        const hit = added.find(row => rule.pattern.test(row.text) && (!rule.numeric || numericRaised(rule, row.text, removed)));
        if (hit) findings.push({ rule: rule.rule, line: hit.line, evidence: evidenceOf(hit.text), advice: rule.advice });
    }
    return findings;
}
function removalFindings(before: string | null, after: string, added: Array<{ line: number; text: string }>, removed: string[]): TestQualityFinding[] {
    const findings: TestQualityFinding[] = [];
    if (before === null) return findings;
    const lostAssertions = count(lines(before), ASSERTION) - count(lines(after), ASSERTION);
    const lostBlocks = count(lines(before), TEST_BLOCK) - count(lines(after), TEST_BLOCK);
    if (lostAssertions > 0 || lostBlocks > 0) findings.push({ rule: "removed-assertion", evidence: `${Math.max(lostAssertions, 0)} assertion(s), ${Math.max(lostBlocks, 0)} test block(s) removed`, advice: "preserve accepted behavior and required evidence, not the number of assertions; a required case absent from the executed inventory is CASE_NOT_RUN" });
    const weakened = added.find(row => TRUTHINESS.test(row.text));
    if (weakened && removed.some(row => SPECIFIC_MATCHER.test(row))) findings.push({ rule: "truthiness-replacement", line: weakened.line, evidence: evidenceOf(weakened.text), advice: "review the expected versus observed meaning; a truthiness check no longer pins the accepted value" });
    return findings;
}
/** The §12.3 signals introduced by one edit of a test file; empty for a non-test file or an edit that only moved lines. */
export function qualityFindings(edit: EditedText): TestQualityFinding[] {
    if (!isTestFile(edit.path)) return [];
    const { added, removed } = netNew(edit.before, edit.after);
    const findings = removalFindings(edit.before, edit.after, added, removed);
    const [focus, ...rest] = addedLineFindings(added, removed);
    if (focus) findings.splice(1, 0, focus); // keep the table's order: removal, selection, truthiness, then the additive signals
    findings.push(...rest);
    const appMock = added.find(row => APP_ENDPOINT.test(row.text));
    if (appMock && !findings.some(row => row.rule === "endpoint-mock")) findings.push({ rule: "endpoint-mock", line: appMock.line, evidence: evidenceOf(appMock.text), advice: ADDED_RULES.find(row => row.rule === "endpoint-mock")!.advice });
    const newBlocks = added.filter(row => TEST_BLOCK.test(row.text));
    if (newBlocks.length && !added.some(row => ASSERTION.test(row.text))) findings.push({ rule: "no-observable-assertion", line: newBlocks[0]!.line, evidence: evidenceOf(newBlocks[0]!.text), advice: "propose a user-observable outcome; a test with no declared observation qualifies nothing" });
    return findings;
}
/** The before/after texts of an edit tool call; a Write has no before, so only additive signals can fire. */
export function editedTexts(toolName: string, toolInput: Record<string, unknown> | undefined): EditedText[] {
    const path = typeof toolInput?.file_path === "string" ? toolInput.file_path : null;
    if (!path) return [];
    if (toolName === "Write" && typeof toolInput?.content === "string") return [{ path, before: null, after: toolInput.content }];
    if (toolName === "Edit" && typeof toolInput?.old_string === "string" && typeof toolInput.new_string === "string") return [{ path, before: toolInput.old_string, after: toolInput.new_string }];
    if (toolName === "MultiEdit" && Array.isArray(toolInput?.edits)) return toolInput.edits.flatMap(edit => editedTexts("Edit", { file_path: path, ...(typeof edit === "object" && edit ? edit : {}) }));
    return [];
}
/** At most three `[interlinked:e2e-quality]` lines, each naming the scenario(s), the rule, the path:line and the advice. */
export function formatQualityFindings(path: string, findings: TestQualityFinding[], scenarioKeys: readonly string[]): string[] {
    const owner = scenarioKeys.length ? scenarioKeys.join(", ") : "unmapped test file";
    const shown = findings.slice(0, MAX_LINES).map(row => `[interlinked:e2e-quality] ${owner}: ${row.rule} at ${path}${row.line ? `:${row.line}` : ""} — ${row.advice} (advice only; the scenario still clears only through a supervised run)`);
    if (findings.length > MAX_LINES) shown[MAX_LINES - 1] = `${shown[MAX_LINES - 1]} [+${findings.length - MAX_LINES} more signal(s)]`;
    return shown;
}
