import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { makeGuardRules } from "./__tests__/fixtures.js";
import { evaluateMutationDirectedProfile } from "./mutation-directed-guard.js";
import type { HarnessEvent } from "../types.js";

it("ignores malformed siblings while recognizing an assertion moved to a valid sibling", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutation-siblings-"));
    try {
        const primary = join(dir, "widget.mutation-kill.test.ts");
        const sibling = join(dir, "moved.mutation-kill.test.ts");
        writeFileSync(primary, 'it("x", () => {\n    expect(value()).toBe(1);\n});\n');
        const content = 'it("x", () => {\n});\n';
        const event: HarnessEvent = { hook_event: "PreToolUse", session_id: "move", agent_source: "codex", timestamp: "t", cwd: dir };
        const warnings: string[] = [];
        const malformed = [null, false, 42, "sibling", [], {}, { file_path: primary, content }];
        expect(evaluateMutationDirectedProfile(event, makeGuardRules(), "Write", {
            path: primary, content, edits: [...malformed, { file_path: sibling, content: 'it("moved", () => {\n    expect(value()).toBe(1);\n});\n' }],
        }, warnings)).toBeNull();
        expect(warnings).toEqual([]);
        const removalWarnings: string[] = [];
        expect(evaluateMutationDirectedProfile(event, makeGuardRules(), "Write", { path: primary, content, edits: malformed }, removalWarnings)).toBeNull();
        expect(removalWarnings).toHaveLength(1);
        expect(removalWarnings[0]).toContain("removes 1 test-case/assertion line(s)");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
