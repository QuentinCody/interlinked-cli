import { expect, it } from "vitest";
import { createFixture } from "./fixture.js";

it.each([
    { runner: "claude-code", event: "PostToolUse", outputField: "tool_response" },
    { runner: "cursor", event: "postToolUse", outputField: "tool_output" },
] as const)("delivers matching read reminders once per session through the built $runner hook", async ({ runner, event, outputField }) => {
    const message = "Review the fixture notes before making changes.";
    const fixture = await createFixture({ rules: { file_reminders: [
        { id: "notes", glob: "notes/**", operations: ["Read"], message, once_per_session: true },
    ] } });
    try {
        const notes = fixture.file("notes/a.md", "Fixture notes.\n");
        const other = fixture.file("other.md", "Unrelated notes.\n");
        const session = `${fixture.sessionPrefix}-first`;
        for (const [sessionId, file_path, expected] of [
            [session, other, false],
            [session, notes, true],
            [session, notes, false],
            [`${fixture.sessionPrefix}-second`, notes, true],
        ] as const) {
            const result = await fixture.hook({ runner, sessionId, event, tool: "Read",
                input: { file_path }, payload: { [outputField]: "Fixture notes." } });
            fixture.assertServed(result);
            expect(result.code).toBe(0);
            if (expected && runner === "cursor") expect(JSON.parse(result.stdout).additional_context).toContain(message);
            expect((result.stdout + result.stderr).includes(`[interlinked:reminder] ${message}`), JSON.stringify(result)).toBe(expected);
        }
    } finally {
        await fixture.close();
    }
});

it("serves Gemini's native before-tool permission responses through the daemon", async () => {
    const fixture = await createFixture();
    try {
        const call = (command: string) => fixture.hook({
            runner: "gemini-cli", event: "BeforeTool", tool: "run_shell_command", input: { command },
        });
        const allowed = await call("git status --short");
        fixture.assertServed(allowed);
        expect(allowed.code).toBe(0);
        expect(JSON.parse(allowed.stdout).decision).toBeUndefined();
        const blocked = await call("git reset --hard");
        fixture.assertServed(blocked);
        expect(blocked.code).toBe(0);
        expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: "deny", reason: expect.any(String) });
    } finally {
        await fixture.close();
    }
});
