import { expect, it } from "vitest";
import { coworkHookSettings } from "./capabilities.js";

function hooks(probe = false) {
    // SAFETY: this is the generated hook-settings contract, whose contents are asserted below.
    return coworkHookSettings(undefined, probe).hooks as Record<string, { matcher: string }[]>;
}

it("subscribes normal post-tool hooks to explicit mutating tools only", () => {
    const settings = hooks(), matcher = settings.PostToolUse?.[0]?.matcher;
    expect(matcher).toBeTruthy();
    const matches = new RegExp(matcher ?? "");
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "mcp__remote-devices__device_bash"]) expect(matches.test(tool), tool).toBe(true);
    for (const tool of ["Read", "Grep", "Glob", "WebFetch", "mcp__files__Read", "mcp__docs__ReadNotebookEditHistory"]) expect(matches.test(tool), tool).toBe(false);
    expect(settings.PreToolUse?.[0]?.matcher).toBe("");
    expect(settings.PostToolUseFailure).toBeUndefined();
});

it("retains broad subscriptions in the diagnostic probe", () => {
    const settings = hooks(true);
    expect(settings.PostToolUse?.[0]?.matcher).toBe("");
    expect(settings.PostToolUseFailure?.[0]?.matcher).toBe("");
});
