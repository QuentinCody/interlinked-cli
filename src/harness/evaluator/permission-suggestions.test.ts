import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSession } from "../__tests__/fixtures/evaluator.js";
import { evaluatePermissionPatternDetection } from "./pre-tool-phases.js";
import { extractPermissionPattern } from "./permission-patterns.js";

describe("permission learning is a proposal, never approval", () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), "permission-proposals-")); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it.each([false, true])("preserves settings bytes and absence (existing=%s)", (existing) => {
        const path = join(root, ".claude/settings.json");
        const before = '{ "permissions": { "deny": ["Bash(rm *)"] }, "custom": true }\n';
        if (existing) {
            mkdirSync(join(root, ".claude"));
            writeFileSync(path, before);
        }
        const session = { ...makeSession(), project_root: root };
        const warnings: string[] = [];
        for (let i = 0; i < 6; i++) {
            evaluatePermissionPatternDetection(session, "Bash", { command: "git status --short" }, warnings, root);
        }
        expect(existsSync(path)).toBe(existing);
        if (existing) expect(readFileSync(path, "utf8")).toBe(before);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("Bash(git status *)");
        expect(warnings[0]).toContain("suggestion only");
        expect(warnings[0]).toContain("not proof of approval or execution");
    });

    it.each(["python3 script.py", "node script.js", "bash script.sh", "git status && pwd", "ls; rm x", "cat > file", "FOO=1 ls", "git push", "git -c alias.x=bad x"])("does not propose unqualified command scope: %s", (command) => {
        expect(extractPermissionPattern("Bash", { command })).toBeNull();
        const warnings: string[] = [];
        const session = { ...makeSession(), project_root: root };
        for (let i = 0; i < 4; i++) evaluatePermissionPatternDetection(session, "Bash", { command }, warnings, root);
        expect(warnings).toEqual([]);
        expect(existsSync(join(root, ".claude"))).toBe(false);
    });
});
