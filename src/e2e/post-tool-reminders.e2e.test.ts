import { expect, it } from "vitest";
import { createFixture } from "./fixture.js";

it("delivers matching read reminders once per session through the built hook", async () => {
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
            const result = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Read",
                input: { file_path }, payload: { tool_response: "Fixture notes." } });
            fixture.assertServed(result);
            expect(result.code).toBe(0);
            expect((result.stdout + result.stderr).includes(`[interlinked:reminder] ${message}`), JSON.stringify(result)).toBe(expected);
        }
    } finally {
        await fixture.close();
    }
});
