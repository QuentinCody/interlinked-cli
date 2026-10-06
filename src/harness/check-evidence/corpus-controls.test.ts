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
it("retains integer-guard false positives as failed qualification controls, with valid and broken counterparts", () => {
    const check = CHECK_REGISTRY.find(row => row.id === "nan_coercion_guard");
    if (!check) throw new Error("missing calibration detector");
    const result = qualifyCorpusControls(check, NAN_COERCION_CALIBRATION);
    expect(result).toMatchObject({ qualified: false, positive: 2, negative: 0 });
    expect(result.failures).toHaveLength(2);
});
