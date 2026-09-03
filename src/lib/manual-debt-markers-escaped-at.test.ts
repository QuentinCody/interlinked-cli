import { describe, expect, it } from "vitest";
import {
    advancePythonState,
    advanceSlashLanguageState,
    type DebtLexicalState,
} from "./manual-debt-markers-escaped-at.js";

describe("advanceSlashLanguageState", () => {
    it("carries a block comment open across lines", () => {
        const afterOpen = advanceSlashLanguageState("/* start of comment", "normal");
        expect(afterOpen).toBe("block-comment");
        const afterClose = advanceSlashLanguageState("rest of comment */ code", afterOpen);
        expect(afterClose).toBe("normal");
    });

    it("ignores // markers inside a string literal, then stops at a real line comment", () => {
        const state = advanceSlashLanguageState('const s = "// not a comment"; // real', "normal");
        expect(state).toBe("normal");
    });

    it("treats an escaped backtick inside a template literal as staying open", () => {
        const opened = advanceSlashLanguageState("const t = `line one \\`", "normal");
        expect(opened).toBe("template");
    });
});

describe("advancePythonState", () => {
    it("carries a triple-double-quoted string open across lines", () => {
        const opened = advancePythonState('doc = """first line', "normal");
        expect(opened).toBe("triple-double");
        const closed = advancePythonState('second line"""', opened);
        expect(closed).toBe("normal");
    });

    it("treats a # after a closed string as a real comment start", () => {
        const state = advancePythonState('x = "a#b" # trailing comment', "normal");
        expect(state).toBe("normal");
    });

    it("supports the triple-single-quote variant independently", () => {
        const opened = advancePythonState("doc = '''first", "normal");
        expect(opened).toBe("triple-single");
    });
});

it("type DebtLexicalState admits every documented state", () => {
    const states: DebtLexicalState[] = [
        "normal",
        "block-comment",
        "template",
        "triple-single",
        "triple-double",
    ];
    expect(states).toHaveLength(5);
});
