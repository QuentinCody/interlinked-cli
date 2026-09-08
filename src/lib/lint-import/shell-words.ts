interface ShellWords { words: string[]; word: string; started: boolean; commands: string[][] }

function flushWord(state: ShellWords): void {
    if (state.started) state.words.push(state.word);
    state.word = "";
    state.started = false;
}

function finishCommand(state: ShellWords): void {
    flushWord(state);
    if (state.words.length > 0) state.commands.push(state.words);
    state.words = [];
}

function appendToken(state: ShellWords, token: string): void {
    if (token === "&&" || token === ";" || token === "\n") { finishCommand(state); return; }
    if (/^\s+$/.test(token)) { flushWord(state); return; }
    state.started = true;
    if (token.startsWith("'")) { state.word += token.slice(1, -1); return; }
    if (token.startsWith('"')) {
        const value = token.slice(1, -1);
        if (/(?<!\\)[$`]/.test(value)) throw new Error("Dynamic shell expansion needs review");
        state.word += value.replace(/\\(["\\$`])/g, "$1");
        return;
    }
    state.word += token.startsWith("\\") ? token.slice(1) : token;
}

/** Parse a literal command list. Pipelines, substitutions and control flow are never evaluated. */
export function lintShellCommands(command: string): string[][] {
    if (command.length > 64_000) throw new Error("Lint command exceeds the inspection budget");
    const input = command.replace(/\\\r?\n/g, " ");
    const token = /"(?:\\.|[^"\\])*"|'[^']*'|\\[^\n]|&&|;|\n|[^\S\n]+|[^\s"'\\;&|<>`$()]+/y;
    const state: ShellWords = { words: [], word: "", started: false, commands: [] };
    let index = 0;
    while (index < input.length) {
        token.lastIndex = index;
        const match = token.exec(input);
        if (!match) throw new Error("Non-literal shell syntax needs review");
        appendToken(state, match[0]);
        index = token.lastIndex;
    }
    finishCommand(state);
    return state.commands;
}
