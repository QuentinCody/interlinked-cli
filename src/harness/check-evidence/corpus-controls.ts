import type { CheckRegistration } from "../check-registry/types.js";

export interface CorpusControl { file: string; broken: string; fixed: string; requirement: string }
/** Retained corpus false positives; this detector is a calibration case, not a qualified cohort member. */
export const NAN_COERCION_CALIBRATION: readonly CorpusControl[] = ["isInteger", "isSafeInteger"].map(guard => ({
    file: "integer-validation.ts", broken: "const n = Number(raw);\nif (n < 1) throw new Error('invalid');",
    fixed: `const n = Number(raw);\nif (!Number.${guard}(n) || n < 1) throw new Error('invalid');`,
    requirement: `Number.${guard}(NaN) is false; the left short-circuit condition rejects invalid input before the comparison.`,
}));
export const CORPUS_CONTROLS: Readonly<Record<string, readonly CorpusControl[]>> = {
    async_promise_executor: [{ file: "control.ts",
        broken: "const p = new Promise(async (resolve) => { resolve(await work()); });",
        fixed: "const p = work().then(value => value);",
        requirement: "Promise constructors do not observe rejection of an async executor." }],
    nan_comparison: [{ file: "control.ts",
        broken: "const bad = value === NaN;", fixed: "const good = Number.isNaN(value);",
        requirement: "Equality against NaN never recognizes NaN." }],
    unawaited_async_assertion: [{ file: "control.test.ts",
        broken: 'it("rejects", async () => {\n  expect(work()).rejects.toThrow("bad");\n});',
        fixed: 'it("rejects", async () => {\n  await expect(work()).rejects.toThrow("bad");\n});',
        requirement: "An asynchronous assertion must finish before its test finishes." }, { file: "control.test.ts",
        broken: 'it("rejects", async () => { expect(work()).rejects.toThrow("bad"); });',
        fixed: 'it("rejects", async () => { await expect(work()).rejects.toThrow("bad"); });',
        requirement: "An asynchronous assertion must finish before its test finishes." }],
};
export interface ControlResult { qualified: boolean; positive: number; negative: number; sensitivity: boolean; failures: string[] }
export function qualifyCorpusControls(check: CheckRegistration, cases = CORPUS_CONTROLS[check.id] ?? []): ControlResult {
    const failures: string[] = [];
    let positive = 0;
    let negative = 0;
    for (const example of cases) {
        try {
            if (check.fn(example.broken, example.file).length > 0) positive++;
            else failures.push(example.requirement + " MUST-FIRE did not fire");
            if (check.fn(example.fixed, example.file).length === 0) negative++;
            else failures.push(example.requirement + " MUST-NOT-FIRE fired");
        } catch (error) { failures.push(String(error)); }
    }
    // A disabled detector cannot satisfy any of these required positive witnesses.
    const sensitivity = cases.length > 0 && positive === cases.length;
    return { qualified: sensitivity && negative === cases.length && failures.length === 0,
        positive, negative, sensitivity, failures };
}
