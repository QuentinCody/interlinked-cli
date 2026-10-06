import { describe, expect, it } from "vitest";
import { extractPermissionPattern } from "../permission-patterns.js";

// Contract: plan A replaces automatic broad grants with conservative proposals.
describe("qualified permission proposals", () => {
    it.each([["ls -la", "Bash(ls *)"], ["git   status --short", "Bash(git status *)"], ["git diff file.ts", "Bash(git diff *)"]])("retains qualified scope for %s", (command, expected) => {
        expect(extractPermissionPattern("Bash", { command })).toBe(expected);
    });
    it.each(["", "   ", "rm file", "git checkout main", "npm install", "npx package", "ls && pwd", "ls\npwd", "ls $(pwd)", "cat 'a;b'", "node -e code", "git -C /tmp status", "find . -exec bash x"])("does not generalize %s", (command) => {
        expect(extractPermissionPattern("Bash", { command })).toBeNull();
    });
    it("limits web proposals to valid HTTP hosts", () => {
        expect(extractPermissionPattern("WebFetch", { url: "https://example.com/a" })).toBe("WebFetch(domain:example.com)");
        expect(extractPermissionPattern("web_fetch", { url: "http://example.com" })).toBe("WebFetch(domain:example.com)");
        expect(extractPermissionPattern("WebFetch", { url: "file:///etc/passwd" })).toBeNull();
        expect(extractPermissionPattern("WebFetch", { url: "bad" })).toBeNull();
        expect(extractPermissionPattern("Read", { file_path: "a" })).toBeNull();
    });
});
