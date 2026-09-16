import { expect, it } from "vitest";
import { makeEvent } from "../__tests__/fixtures/evaluator.js";
import { makeGuardRules } from "./__tests__/fixtures.js";
import type { WriteContentGuardState } from "./write-content-basic-guards.js";
import { biomeDiffOverlayGuard, tscDiffOverlayGuard } from "./write-content-overlay-guards.js";

function state(extension: string, externalOverlays = false): WriteContentGuardState {
    return { toolName: "Write", filePath: `/repo/example.${extension}`, content: "answer = 42", postEditContent: "answer = 42",
        preEditContent: undefined, event: makeEvent(), rules: makeGuardRules(), session: undefined,
        externalOverlays, warnings: [], escalation: undefined };
}

it.each(["py", "go", "rs", "java", "json", "md"])("does not promise irrelevant JS/TS checks for %s", extension => {
    for (const externalOverlays of [false, true]) {
        const input = state(extension, externalOverlays);
        expect(biomeDiffOverlayGuard(input)).toBeNull();
        expect(tscDiffOverlayGuard(input)).toBeNull();
        expect(input.warnings).toEqual([]);
    }
});

it.each([["ts", 2], ["js", 1], ["mts", 1]] as const)("retains applicable deferrals for %s", (extension, count) => {
    const input = state(extension);
    biomeDiffOverlayGuard(input);
    tscDiffOverlayGuard(input);
    expect(input.warnings).toHaveLength(count);
    expect(input.warnings.every(warning => warning.includes("NOT CHECKED"))).toBe(true);
});
