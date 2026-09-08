import { describe, expect, it } from "vitest";
import { matchesRule } from "../evaluator/rule-matching.js";
import { PROCESS_RULES_GIT_FS_INLINE } from "./builtin-rules-processes-git-fs-inline.js";

function blocks(command: string): boolean {
    const rule = PROCESS_RULES_GIT_FS_INLINE.find(candidate => candidate.id === "builtin-git-add-interactive");
    if (!rule) throw new Error("Interactive staging rule missing");
    return matchesRule({ command, toolInput: { command }, rule });
}

describe("interactive staging command boundaries", () => {
    it.each(["-i", "-p", "-e", "--interactive", "--patch", "--edit"])("blocks the actual git add option %s", flag => {
        expect(blocks(`git add src/a.ts ${flag}`)).toBe(true);
    });

    it.each(["\n", "\r\n", "; ", " && ", " | "])("does not borrow a later command's flag across %j", separator => {
        expect(blocks(`git add src/a.ts${separator}node -e 'console.log(1)'`)).toBe(false);
    });

    it("retains protection across escaped line continuations", () => {
        expect(blocks("git add \\\n  -p src/a.ts")).toBe(true);
        expect(blocks("git \\\n add src/a.ts -e")).toBe(true);
    });
});
