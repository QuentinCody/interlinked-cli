import { beforeEach, expect, it, vi } from "vitest";
import { recordHookObservations } from "../hook-observations.js";
import { makeEvent } from "../__tests__/fixtures/evaluator.js";
import { makeGuardRules } from "./__tests__/fixtures.js";
import type { WriteContentGuardState } from "./write-content-basic-guards.js";
import { biomeDiffOverlayGuard, tscDiffOverlayGuard } from "./write-content-overlay-guards.js";

vi.mock("../hook-observations.js", () => ({ recordHookObservations: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

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

it.each([["ts", 2], ["js", 1], ["mts", 1]] as const)("records applicable scheduled checks without repeating them to the model for %s", (extension, count) => {
    const input = state(extension);
    biomeDiffOverlayGuard(input);
    tscDiffOverlayGuard(input);
    expect(input.warnings).toEqual([]);
    expect(recordHookObservations).toHaveBeenCalledTimes(count);
});
