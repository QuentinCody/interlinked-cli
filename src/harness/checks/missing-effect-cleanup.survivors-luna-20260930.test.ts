import { describe, expect, it } from "vitest";
import { effectCleanupCases } from "./__fixtures__/effect-cleanup-cases.js";
import { checkMissingEffectCleanup } from "./missing-effect-cleanup.js";

describe("effect cleanup in complete components", () => {
    // test-contract: bug — rendering JSX does not dispose a recurring timer; returning its teardown from the effect does.
    it.each(effectCleanupCases)("$name", ({ content, path, lines }) => {
        const findings = checkMissingEffectCleanup(content, path);
        expect(findings.map((finding) => finding.line)).toEqual(lines);
        expect(findings.map((finding) => finding.text)).toEqual(lines.map(() =>
            "[useEffect with subscription but no cleanup — potential memory leak] useEffect(() => {"));
    });
});
