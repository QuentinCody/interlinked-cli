import { expect, it } from "vitest";
import { CHECK_REGISTRY } from "../check-registry/index.js";
import { CORPUS_CONTROLS, NAN_COERCION_CALIBRATION, qualifyCorpusControls } from "./corpus-controls.js";
for (const id of Object.keys(CORPUS_CONTROLS)) {
    it(id + " distinguishes a required defect from its repair and rejects a disabled detector", () => {
        const check = CHECK_REGISTRY.find(check => check.id === id);
        if (!check) throw new Error("missing check " + id);
        const result = qualifyCorpusControls(check);
        if (id === "unawaited_async_assertion") {
            // Qualification must stay withheld while the single-line positive is missed.
            expect(result).toMatchObject({ qualified: false, positive: 1, negative: 2 });
            expect(result.failures).toContain("An asynchronous assertion must finish before its test finishes. MUST-FIRE did not fire");
        } else expect(result).toMatchObject({ qualified: true, positive: 1, negative: 1 });
        expect(qualifyCorpusControls({ ...check, fn: () => [] })).toMatchObject({ qualified: false, positive: 0 });
        expect(qualifyCorpusControls({ ...check, fn: () => [{ line: 1, text: "always" }] }).qualified).toBe(false);
    });
}
// Retained as a failing control until 2026-11-06, when nan_coercion_guard learned that Number.isInteger /
// Number.isSafeInteger are NaN guards: the broken counterparts still fire, the guarded ones no longer do.
it("qualifies the integer-guard controls: each broken counterpart fires, each guarded one is silent", () => {
    const check = CHECK_REGISTRY.find(row => row.id === "nan_coercion_guard");
    if (!check) throw new Error("missing calibration detector");
    const result = qualifyCorpusControls(check, NAN_COERCION_CALIBRATION);
    expect(result).toMatchObject({ qualified: true, positive: 2, negative: 2 });
    expect(result.failures).toEqual([]);
});
