// ===========================================
// fail-before-fix — per-test verdicts
// ===========================================
// A test pins a session's change when it passes now and FAILS BY ASSERTION on the pre-session code (SWE-bench's
// FAIL_TO_PASS, per session, with no git history). A crash or a load failure on the pre-session code is
// inconclusive: code that misses a new export proves nothing about behavior (plan 31's setup-failure rule; E66,
// 2026-10-21: partial reverts crashed in 115 of 176 kills). A new test that passes on both sides does not
// reproduce what the session changed. A plain error thrown by the test file itself (a wait-until or "should have
// thrown" helper) is the test's own check and counts like an assertion; its first stack frame decides (E47a-exec,
// 2026-10-22: a `waitFor` helper's Error was discarded as inconclusive although the test caught the fault).

import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "../../lib/json-types.js";

export type TestVerdict = "fails-before-fix" | "passes-before-fix" | "inconclusive" | "not-passing-now";
export interface TestOutcome { status: string; message?: string; thrownInTest?: boolean; }
export interface VitestCase { file: string; name: string; title: string; status: string; message?: string; thrownInTest?: true; }

const CRASH = /^(?:TypeError|ReferenceError|SyntaxError|RangeError)\b|is not a function|Cannot read propert|is not defined|does not provide an export|Cannot find module|is not iterable/;

export function failureKind(message: string): "assertion" | "crash" | "other" {
    if (CRASH.test(message)) return "crash";
    if (message.startsWith("AssertionError")) return "assertion";
    return "other";
}

/** An assertion failed, or a non-crash error was thrown from the test file itself. A crash, and an error thrown
 *  by product or runner code (vitest's own timeout included), are not the test's check. */
export function failedByOwnCheck(outcome: TestOutcome): boolean {
    if (outcome.status !== "failed") return false;
    const kind = failureKind(outcome.message ?? "");
    return kind === "assertion" || (kind === "other" && outcome.thrownInTest === true);
}

export function classifyTest(post: TestOutcome | undefined, pre: TestOutcome | undefined): TestVerdict {
    if (post?.status !== "passed") return "not-passing-now";
    if (pre?.status === "passed") return "passes-before-fix";
    if (pre !== undefined && failedByOwnCheck(pre)) return "fails-before-fix";
    return "inconclusive";
}

const FRAME = /^\s*at (?:[^(]*\()?(.+?):\d+:\d+\)?\s*$/;

/** True when the FIRST stack frame of a failure is the test file (by absolute path, or by its project-relative
 *  path when the runner reports another absolute prefix such as macOS `/private`). The first `at` line decides. */
function thrownIn(message: string, absolute: string, file: string): boolean {
    const line = message.split("\n").find(row => /^\s*at /.test(row));
    const frame = line === undefined ? undefined : FRAME.exec(line)?.[1];
    if (frame === undefined) return false;
    const path = frame.startsWith("file://") ? fileURLToPath(frame) : frame;
    return path === absolute || path.endsWith(`/${file}`);
}

/** A test is new to the session when its own title does not occur in the pre-session bytes of its file. */
export function isNewTest(preSessionFile: string | null, title: string): boolean {
    return preSessionFile === null || !preSessionFile.includes(title);
}

function caseRow(file: string, absolute: string, item: unknown): VitestCase | null {
    if (!isJsonObject(item) || typeof item.fullName !== "string" || typeof item.status !== "string") return null;
    const row: VitestCase = { file, name: item.fullName, title: typeof item.title === "string" ? item.title : item.fullName, status: item.status };
    const first = Array.isArray(item.failureMessages) ? item.failureMessages.find((value): value is string => typeof value === "string") : undefined;
    if (first) row.message = (first.trim().split("\n")[0] ?? "").slice(0, 240);
    if (first && thrownIn(first, absolute, file)) row.thrownInTest = true;
    return row;
}

/** Per-test rows from vitest's JSON reporter; anything that is not that report yields no rows (no evidence). */
export function parseVitestReport(text: string, root: string): VitestCase[] {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return []; }
    if (!isJsonObject(parsed) || !Array.isArray(parsed.testResults)) return [];
    return parsed.testResults.flatMap(result => {
        if (!isJsonObject(result) || typeof result.name !== "string" || !Array.isArray(result.assertionResults)) return [];
        const absolute = isAbsolute(result.name) ? result.name : join(root, result.name), file = relative(root, absolute);
        return result.assertionResults.map(item => caseRow(file, absolute, item)).filter((row): row is VitestCase => row !== null);
    });
}
