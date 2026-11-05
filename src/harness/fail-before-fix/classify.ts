// ===========================================
// fail-before-fix — per-test verdicts and THE own-check rule
// ===========================================
// A test pins a session's change when it passes now and FAILS BY ITS OWN CHECK on the pre-session code (SWE-bench's
// FAIL_TO_PASS, per session, with no git history). A crash or a load failure on the pre-session code is
// inconclusive: code that misses a new export proves nothing about behavior (plan 31's setup-failure rule; E66,
// 2026-10-21: partial reverts crashed in 115 of 176 kills). A new test that passes on both sides does not
// reproduce what the session changed.
//
// `failedByOwnCheck` is the ONE place that decides "the test's own check fired"; `tests prove-kill` and `tests faults
// run` judge through it too (prove-kill adds a snapshot-mismatch clause and a product `node:assert` exclusion on top).
// A failure is the test's own check when:
//   (a) it is an assertion (`AssertionError…`);
//   (b) a non-crash error's FIRST stack frame is the test file — a wait-until or "should have thrown" helper (E47a-exec,
//       2026-10-22: a `waitFor` helper's Error was discarded as inconclusive although the test caught the fault);
//   (c) a non-crash error left one of vitest's own helpers (`vi.waitUntil`, under node_modules/vitest) with the test
//       file within its first 5 frames — the runner's own timeout (`@vitest/runner`) is excluded;
//   (d) a property-test counterexample report (fast-check: `Property failed after N tests` / `Counterexample:`) wraps
//       an error that passes (a)–(b) itself: the report's `cause` (fast-check ≥ 4, captured by `cause-reporter.ts`) or
//       its `Got …` section (fast-check 3), with "first frame" read past the runner's own frames; or wraps nothing
//       because the predicate RETURNED FALSE and the report's stack reaches the test file (a synchronous `fc.assert`).
// A crash (inside a property run too: the wrapped TypeError is product code's), a plain error whose first frame is
// product code, the runner's timeout, and a property report whose wrapped error was not captured are NOT the test's
// check (2026-11-05, census #37: a fast-check detection in `ltl/rules.test.ts` P5 could not earn a kill).

import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "../../lib/json-types.js";
import { causeKey, type CauseRows, type WrappedError } from "./cause-reporter.js";

export type TestVerdict = "fails-before-fix" | "passes-before-fix" | "inconclusive" | "not-passing-now";

/** A property-test (fast-check) counterexample report, judged by what it wraps. */
export interface PropertyFailure {
    /** The report's own stack reaches the test file once the property runner's frames are skipped (a synchronous `fc.assert`). */
    reportedInTest: boolean;
    /** What the predicate threw, as a failure of its own; `thrownInTest` = its first frame past the runner's is the test file. */
    wrapped?: { message: string; thrownInTest: boolean };
    /** The predicate returned false — the runner's verdict on the test's own predicate, nothing thrown. */
    returnedFalse?: true;
}
export interface TestOutcome {
    status: string;
    message?: string;
    /** The FIRST stack frame is the test file. */
    thrownInTest?: boolean;
    /** The first frame is one of vitest's own helpers and the test file is within the first 5 frames. */
    throughVitestHelper?: boolean;
    property?: PropertyFailure;
}
export interface VitestCase { file: string; name: string; title: string; status: string; message?: string; thrownInTest?: true; throughVitestHelper?: true; property?: PropertyFailure; }

const CRASH = /^(?:TypeError|ReferenceError|SyntaxError|RangeError)\b|is not a function|Cannot read propert|is not defined|does not provide an export|Cannot find module|is not iterable/;

export function failureKind(message: string): "assertion" | "crash" | "other" {
    if (CRASH.test(message)) return "crash";
    if (message.startsWith("AssertionError")) return "assertion";
    return "other";
}

/** The own-check rule (clauses (a)–(d) in the header). Anything else — a crash, product code's error, the runner's — is not. */
export function failedByOwnCheck(outcome: TestOutcome): boolean {
    if (outcome.status !== "failed") return false;
    const kind = failureKind(outcome.message ?? "");
    if (kind === "assertion") return true;
    if (kind === "crash") return false;
    if (outcome.thrownInTest === true || outcome.throughVitestHelper === true) return true;
    return outcome.property !== undefined && propertyOwnCheck(outcome.property);
}

function propertyOwnCheck(property: PropertyFailure): boolean {
    if (property.wrapped !== undefined) return failedByOwnCheck({ status: "failed", ...property.wrapped });
    return property.returnedFalse === true && property.reportedInTest;
}

/** The failure the rule judged: a property report's wrapped error, else the outcome itself (prove-kill's `node:assert` exclusion reads this). */
export function judgedFailure(outcome: TestOutcome): { message: string; thrownInTest: boolean } {
    const wrapped = outcome.property?.wrapped;
    return wrapped ?? { message: outcome.message ?? "", thrownInTest: outcome.thrownInTest === true };
}

/** The first failure line, with what a property report wrapped (or did not) spelled out. */
export function describeFailure(outcome: TestOutcome): string {
    const message = outcome.message ?? "";
    const property = outcome.property;
    if (property === undefined) return message;
    if (property.wrapped !== undefined) return `${message} (wrapping ${property.wrapped.message})`;
    if (property.returnedFalse === true) return `${message} (the predicate returned false)`;
    return `${message} (the error the property wrapped was not captured)`;
}

export function classifyTest(post: TestOutcome | undefined, pre: TestOutcome | undefined): TestVerdict {
    if (post?.status !== "passed") return "not-passing-now";
    if (pre?.status === "passed") return "passes-before-fix";
    if (pre !== undefined && failedByOwnCheck(pre)) return "fails-before-fix";
    return "inconclusive";
}

const FRAME = /^\s*at (?:[^(]*\()?(.+?):\d+:\d+\)?\s*$/;
const PROPERTY_REPORT = /^(?:Error: )?Property failed after \d+ tests?\b/;
const RETURNED_FALSE = /^(?:Error: )?Property failed by returning false/;
const PROPERTY_RUNNER = /\/node_modules\/fast-check\//;
/** vitest's own helpers (`vi.waitUntil` lives in vitest/dist); `@vitest/runner` is the runner itself (its timeout), never a helper. */
const VITEST_HELPER = /\/node_modules\/(?:vitest|@vitest\/expect)\//;
const HELPER_WINDOW = 5;

/** The path of every `at` line, in order; `null` for a frame with no `file:line:col` (`at async Promise.all (index 0)`). */
function framePaths(text: string): (string | null)[] {
    return text.split("\n").filter(row => /^\s*at /.test(row)).map(row => {
        const frame = FRAME.exec(row)?.[1];
        if (frame === undefined) return null;
        try { return frame.startsWith("file://") ? fileURLToPath(frame) : frame; } catch { return null; }
    });
}

/** By absolute path, or by project-relative path when the runner reports another absolute prefix (macOS `/private`). */
const isTestFile = (path: string | null, absolute: string, file: string): boolean => path !== null && (path === absolute || path.endsWith(`/${file}`));

/** The first `at` line decides. */
const thrownIn = (paths: readonly (string | null)[], absolute: string, file: string): boolean => paths.length > 0 && isTestFile(paths[0] ?? null, absolute, file);

function throughHelper(paths: readonly (string | null)[], absolute: string, file: string): boolean {
    const first = paths[0];
    return typeof first === "string" && VITEST_HELPER.test(first) && paths.slice(0, HELPER_WINDOW).some(path => isTestFile(path, absolute, file));
}

/** The first frame that is neither the property runner's nor Node's own. */
function pastRunner(paths: readonly (string | null)[]): string | null {
    return paths.find(path => path === null || !(PROPERTY_RUNNER.test(path) || path.startsWith("node:"))) ?? null;
}

/** fast-check 3 put the wrapped error in the message: `Got error: …` / `Got AssertionError: …` followed by its stack. */
function wrappedFromMessage(message: string): WrappedError | null {
    const lines = message.split("\n");
    const at = lines.findIndex(row => /^Got \S/.test(row));
    if (at === -1) return null;
    const head = (lines[at] ?? "").slice("Got ".length).replace(/^error: /, "Error: ");
    return { message: head, stack: lines.slice(at).join("\n") };
}

function propertyFailure(message: string, paths: readonly (string | null)[], absolute: string, file: string, cause: WrappedError | null | undefined): PropertyFailure | undefined {
    if (!PROPERTY_REPORT.test(message.trim()) && !message.includes("\nCounterexample:")) return undefined;
    const reportedInTest = isTestFile(pastRunner(paths), absolute, file);
    const wrapped = cause ?? wrappedFromMessage(message);
    if (wrapped === null) return { reportedInTest };
    if (RETURNED_FALSE.test(wrapped.message)) return { reportedInTest, returnedFalse: true };
    return { reportedInTest, wrapped: { message: wrapped.message.slice(0, 240), thrownInTest: isTestFile(pastRunner(framePaths(wrapped.stack)), absolute, file) } };
}

/** A test is new to the session when its own title does not occur in the pre-session bytes of its file. */
export function isNewTest(preSessionFile: string | null, title: string): boolean {
    return preSessionFile === null || !preSessionFile.includes(title);
}

/** vitest 3/4 report a test or hook timeout as the stack placeholder it created when the test was scheduled
 *  (`new Error("STACK_TRACE_ERROR")` in @vitest/runner); vitest 2 said `Error: Test timed out in 100ms.`. The
 *  placeholder names nothing, so the row says what happened (kill-proof review round 4, M9). */
const STACK_TRACE_PLACEHOLDER = "Error: STACK_TRACE_ERROR";
export const TIMEOUT_REASON = "test timed out (vitest testTimeout or hookTimeout; reported as Error: STACK_TRACE_ERROR)";

function firstLine(message: string): string {
    const line = (message.trim().split("\n")[0] ?? "").slice(0, 240);
    return line === STACK_TRACE_PLACEHOLDER ? TIMEOUT_REASON : line;
}

function caseRow(file: string, absolute: string, item: unknown, causes: CauseRows | undefined): VitestCase | null {
    if (!isJsonObject(item) || typeof item.fullName !== "string" || typeof item.status !== "string") return null;
    const row: VitestCase = { file, name: item.fullName, title: typeof item.title === "string" ? item.title : item.fullName, status: item.status };
    const first = Array.isArray(item.failureMessages) ? item.failureMessages.find((value): value is string => typeof value === "string") : undefined;
    if (first === undefined) return row;
    row.message = firstLine(first);
    const paths = framePaths(first);
    if (thrownIn(paths, absolute, file)) row.thrownInTest = true;
    else if (throughHelper(paths, absolute, file)) row.throughVitestHelper = true;
    const property = propertyFailure(first, paths, absolute, file, causes?.get(causeKey(absolute, item.fullName)));
    if (property !== undefined) row.property = property;
    return row;
}

/** Per-test rows from vitest's JSON reporter; anything that is not that report yields no rows (no evidence).
 *  `causes` (the sidecar `cause-reporter.ts` wrote, keyed by the report's absolute file name) supplies what each failure wrapped. */
export function parseVitestReport(text: string, root: string, causes?: CauseRows): VitestCase[] {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return []; }
    if (!isJsonObject(parsed) || !Array.isArray(parsed.testResults)) return [];
    return parsed.testResults.flatMap(result => {
        if (!isJsonObject(result) || typeof result.name !== "string" || !Array.isArray(result.assertionResults)) return [];
        const absolute = isAbsolute(result.name) ? result.name : join(root, result.name), file = relative(root, absolute);
        return result.assertionResults.map(item => caseRow(file, absolute, item, causes)).filter((row): row is VitestCase => row !== null);
    });
}
