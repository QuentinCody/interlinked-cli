// ===========================================
// Manual design-debt markers — comment-lexer line state machine
// ===========================================
// Tracks whether a source line sits inside a block comment / template
// literal / Python triple-quoted string, so the marker scanner can skip
// `interlinked-debt:` lookalikes that only appear inside string bodies.

export type DebtLexicalState = "normal" | "block-comment" | "template" | "triple-single" | "triple-double";

function escapedAt(line: string, index: number): boolean {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) slashes++;
    return slashes % 2 === 1;
}

function unescapedTokenIndex(line: string, token: string, from: number): number {
    let index = line.indexOf(token, from);
    while (index >= 0 && escapedAt(line, index)) index = line.indexOf(token, index + token.length);
    return index;
}

/** One lexer step: the state after the character, the index to resume from, and whether the rest of the line is a comment. */
interface LexStep {
    state: DebtLexicalState;
    index: number;
    stop?: boolean;
}

/** Advances past a single- or double-quoted run starting at `index`; returns `index` unchanged when no quote opens there. */
function skipQuotedRun(line: string, index: number): number {
    const quote = line[index];
    if (quote !== "\"" && quote !== "'") return index;
    const closing = unescapedTokenIndex(line, quote, index + 1);
    return closing < 0 ? line.length : closing;
}

function stepSlashLanguage(line: string, index: number, state: DebtLexicalState): LexStep {
    if (state === "block-comment") {
        if (line.slice(index, index + 2) === "*/") return { state: "normal", index: index + 1 };
        return { state, index };
    }
    if (state === "template") {
        if (line[index] === "`" && !escapedAt(line, index)) return { state: "normal", index };
        return { state, index };
    }
    const pair = line.slice(index, index + 2);
    if (pair === "//") return { state, index, stop: true };
    if (pair === "/*") return { state: "block-comment", index: index + 1 };
    if (line[index] === "`") return { state: "template", index };
    return { state, index: skipQuotedRun(line, index) };
}

export function advanceSlashLanguageState(line: string, initial: DebtLexicalState): DebtLexicalState {
    let state = initial;
    for (let index = 0; index < line.length; index++) {
        const step = stepSlashLanguage(line, index, state);
        state = step.state;
        if (step.stop) break;
        index = step.index;
    }
    return state;
}

function stepPythonInsideTriple(line: string, index: number, state: DebtLexicalState): LexStep {
    const triple = state === "triple-single" ? "'''" : '"""';
    if (line.slice(index, index + 3) === triple && !escapedAt(line, index)) {
        return { state: "normal", index: index + 2 };
    }
    return { state, index };
}

function stepPython(line: string, index: number, state: DebtLexicalState): LexStep {
    if (state === "triple-single" || state === "triple-double") {
        return stepPythonInsideTriple(line, index, state);
    }
    if (line[index] === "#") return { state, index, stop: true };
    const opening = line.slice(index, index + 3);
    if (opening === "'''") return { state: "triple-single", index: index + 2 };
    if (opening === '"""') return { state: "triple-double", index: index + 2 };
    return { state, index: skipQuotedRun(line, index) };
}

export function advancePythonState(line: string, initial: DebtLexicalState): DebtLexicalState {
    let state = initial;
    for (let index = 0; index < line.length; index++) {
        const step = stepPython(line, index, state);
        state = step.state;
        if (step.stop) break;
        index = step.index;
    }
    return state;
}
