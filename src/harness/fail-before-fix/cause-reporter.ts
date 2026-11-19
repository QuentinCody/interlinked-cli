// ===========================================
// fail-before-fix — wrapped-error sidecar (a vitest reporter)
// ===========================================
// vitest's JSON reporter writes each failure as `error.stack || error.message` and drops `error.cause`.
// A property-test runner (fast-check ≥ 4) throws a counterexample report whose `cause` is what the
// predicate threw, so from the JSON report alone an assertion inside a property run and a product
// TypeError inside one are the same bytes ("Error: Property failed after N tests" over fast-check's
// frames; probe 2026-11-05). This reporter is written beside the JSON report, loaded by absolute path
// into the project's own vitest, and records the first error's cause for every failed case;
// `classify.ts` judges that wrapped error as a failure of its own. Zero imports beyond `node:fs`.
// vitest ≥ 3 reports through `onTestCaseResult` / `onTestRunEnd`; the `onFinished(files)` walk is the
// vitest 1–2 route (UNVERIFIED here: only vitest 4 is installed).

import { isJsonObject } from "../../lib/json-types.js";

/** What a failure wrapped as its `cause`: `message` is `<name>: <first line>`, `stack` the cause's own frames. */
export interface WrappedError { message: string; stack: string }
/** `null` = the failure carried no cause; absent = the case is not in the sidecar. Keyed by `causeKey`. */
export type CauseRows = ReadonlyMap<string, WrappedError | null>;

export const CAUSE_SIDECAR = "causes.json";
export const CAUSE_REPORTER = "cause-reporter.mjs";

export const causeKey = (absoluteFile: string, fullName: string): string => `${absoluteFile}\u0000${fullName}`;

/** The reporter module, with the output path baked in. The full name is built exactly as vitest's JSON reporter builds it. */
export function causeReporterSource(outputPath: string): string {
    return [
        'import { writeFileSync } from "node:fs";',
        `const OUT = ${JSON.stringify(outputPath)};`,
        "const firstLine = (value) => String(value ?? \"\").split(\"\\n\")[0];",
        "function wrapped(error) {",
        "  const cause = error && typeof error === \"object\" ? error.cause : undefined;",
        "  if (!cause || typeof cause !== \"object\") return null;",
        "  const stack = typeof cause.stack === \"string\" ? cause.stack : \"\";",
        "  const name = typeof cause.name === \"string\" && cause.name ? cause.name : \"\";",
        "  const message = name ? name + \": \" + firstLine(cause.message) : (firstLine(stack) || firstLine(cause.message));",
        "  return { message, stack };",
        "}",
        "function fullName(task) {",
        "  const names = []; let iter = task.suite;",
        "  while (iter) { names.push(iter.name); iter = iter.suite; }",
        "  names.reverse();",
        "  return task.name ? [...names, task.name].join(\" \") : names.join(\" \");",
        "}",
        "function record(rows, file, task) {",
        "  const errors = task && task.result && Array.isArray(task.result.errors) ? task.result.errors : [];",
        "  if (typeof file !== \"string\" || !file || errors.length === 0) return;",
        "  const name = fullName(task);",
        "  rows.set(file + \"\\u0000\" + name, { file, name, cause: wrapped(errors[0]) });",
        "}",
        "function walk(rows, task, file) {",
        "  if (task.type === \"test\") record(rows, file, task);",
        "  for (const child of task.tasks ?? []) walk(rows, child, file);",
        "}",
        "export default class InterlinkedCauseReporter {",
        "  constructor() { this.rows = new Map(); }",
        "  flush() { try { writeFileSync(OUT, JSON.stringify([...this.rows.values()])); } catch {} }",
        "  onTestCaseResult(testCase) { try { record(this.rows, testCase.module.moduleId, testCase.task); } catch {} }",
        "  onFinished(files) { try { for (const file of files ?? []) walk(this.rows, file, file.filepath); } catch {} this.flush(); }",
        "  onTestRunEnd() { this.flush(); }",
        "}",
        "",
    ].join("\n");
}

/** Rows from the sidecar; anything that is not that file yields no rows. */
export function parseCauseSidecar(text: string): Map<string, WrappedError | null> {
    const out = new Map<string, WrappedError | null>();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return out; }
    if (!Array.isArray(parsed)) return out;
    for (const row of parsed) {
        if (!isJsonObject(row) || typeof row.file !== "string" || typeof row.name !== "string") continue;
        const cause = row.cause;
        if (cause === null) { out.set(causeKey(row.file, row.name), null); continue; }
        if (!isJsonObject(cause) || typeof cause.message !== "string" || typeof cause.stack !== "string") continue;
        out.set(causeKey(row.file, row.name), { message: cause.message, stack: cause.stack });
    }
    return out;
}
