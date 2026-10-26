import { afterEach, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

let fixture: E2eFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

function deferred(file: string, sessionId: string, timestamp: string) {
    return { kind: "coverage", file, session_id: sessionId, timestamp,
        reason: "budget_exceeded", estimated_suite_ms: 8000, budget_ms: 2000 };
}

function discharged(file: string, sessionId: string, timestamp: string) {
    return { kind: "coverage_discharge", file, session_id: sessionId, timestamp };
}

async function deferredStopWarnings(owned: E2eFixture, sessionId: string): Promise<string[]> {
    const offset = owned.ledger("stop-digest.jsonl").length;
    const result = await owned.hook({ sessionId, event: "Stop" });
    owned.assertServed(result);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('"decision":"block"');
    return owned.ledger("stop-digest.jsonl").slice(offset).flatMap(row =>
        typeof row === "object" && row !== null && "session" in row && row.session === sessionId
        && "text" in row && typeof row.text === "string" && row.text.includes("deferred coverage check(s)")
            ? [row.text] : []);
}

it("reports deferred coverage by session while honoring cross-session discharges and later edits", async () => {
    fixture = await createFixture({ rules: { per_edit_coverage: { enabled: true } } });
    const editor = `${fixture.sessionPrefix}-editor`, other = `${fixture.sessionPrefix}-other`, cleared = `${fixture.sessionPrefix}-cleared`;
    const openedAt = "2026-10-01T10:00:00Z", measuredAt = "2026-10-01T10:01:00Z", editedAgainAt = "2026-10-01T10:02:00Z";
    const pending = "src/pending.ts", covered = "src/covered.ts", reopened = "src/reopened.ts", foreign = "src/foreign.ts";
    for (const path of [pending, covered, reopened, foreign]) fixture.file(path, "export const value = 1;\n");
    // Persisted input history, not a claimed test run: the built Stop consumer must
    // reconcile it in chronological order before presenting its coverage reminder.
    const history = [
        deferred(pending, editor, openedAt), deferred(pending, editor, editedAgainAt),
        deferred(covered, editor, openedAt), deferred(covered, cleared, openedAt),
        discharged(covered, other, measuredAt),
        deferred(reopened, editor, openedAt), discharged(reopened, other, measuredAt),
        deferred(reopened, editor, editedAgainAt), deferred(foreign, other, openedAt),
    ];
    fixture.file(".interlinked/coverage-obligations.jsonl", history.map(row => JSON.stringify(row)).join("\n") + "\n");

    const editorWarnings = await deferredStopWarnings(fixture, editor);
    expect(editorWarnings).toHaveLength(1);
    expect(editorWarnings[0]).toContain("Stopping with 2 deferred coverage check(s)");
    expect(editorWarnings[0]?.match(/  - [^\n]+/g)).toEqual(["  - pending.ts", "  - reopened.ts"]);
    expect(editorWarnings[0]).toContain("Run the full suite with coverage");
    expect(editorWarnings[0]).toContain("reminder, not a block");

    const otherWarnings = await deferredStopWarnings(fixture, other);
    expect(otherWarnings).toHaveLength(1);
    expect(otherWarnings[0]).toContain("Stopping with 1 deferred coverage check(s)");
    expect(otherWarnings[0]?.match(/  - [^\n]+/g)).toEqual(["  - foreign.ts"]);
    // This is cleared's first Stop, so a missing warning cannot be repeat suppression.
    expect(await deferredStopWarnings(fixture, cleared)).toEqual([]);
});
