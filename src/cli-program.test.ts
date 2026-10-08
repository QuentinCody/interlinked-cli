// Printed-command parity (antithesis intake backlog #10): every `interlinked …`
// command that product code prints inside a string must exist in the real
// commander tree. An agent follows a printed recovery step literally; a step
// that names a missing command fails at the worst moment (three such strings
// shipped before this pin: `interlinked register`, `interlinked baseline
// restore`, `interlinked review`).
//
// Only string literals and template text are read (TypeScript AST), never
// comments. The words after `interlinked` are walked through the tree: a word
// that is not a subcommand of a group that takes no arguments is a dead step.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Command } from "commander";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildProgram } from "./cli-program.js";

interface PrintedCommand {
	words: string[];
	line: number;
}

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const COMMAND_RE = /(?<![\w./-])interlinked((?: [a-z][a-z0-9-]*){1,3})/g;
// Prose and labels also say "interlinked <word>" ("interlinked only stops it", "# interlinked bash completion",
// "interlinked gate: clean"), so a match is a command only when the text marks it as one: a quote, backtick,
// `$ ` or color code directly before it (`${CYAN}`, `\x1b[36m`), a run verb before it, or a string that holds
// the command and nothing else.
const COMMAND_SIGNAL_BEFORE = /(?:[`'"]|\$ |\}|\x1b\[[\d;]*m|(?:^|\s)(?:[Rr]un|[Rr]erun|[Tt]ry|[Uu]se|via|with|then|Fix:|fix:|→)\s+)$/;
const LINE_BASE = 1;
// Server-sent-event hello labels of the viz feeds (`src/lib/viz/feeds.ts`): whole-string labels, not commands.
const LABEL_STRINGS = new Set([
	"interlinked agent presence",
	"interlinked baseline stream",
	"interlinked checks stream",
	"interlinked test stream",
	"interlinked mutant stream",
	"interlinked mutation run stream",
]);

function isStringText(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode {
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
}

// zsh `_describe -t commands '<label>'`: the quoted text is a completion-group title, not a command.
const ZSH_DESCRIBE_LABEL = /_describe(?: -t \S+)? '$/;

function isCommandShaped(text: string, match: RegExpMatchArray): boolean {
	const start = match.index ?? 0;
	if (ZSH_DESCRIBE_LABEL.test(text.slice(0, start))) return false;
	const wholeString = text.trim() === match[0] && !LABEL_STRINGS.has(match[0]);
	return wholeString || COMMAND_SIGNAL_BEFORE.test(text.slice(0, start));
}

function commandsInText(text: string, line: number): PrintedCommand[] {
	return [...text.matchAll(COMMAND_RE)]
		.filter((m) => isCommandShaped(text, m))
		.map((m) => ({ words: (m[1] ?? "").trim().split(" "), line }));
}

function printedCommandsIn(source: string): PrintedCommand[] {
	const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
	const out: PrintedCommand[] = [];
	const visit = (node: ts.Node): void => {
		if (isStringText(node)) {
			const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + LINE_BASE;
			out.push(...commandsInText(node.text, line));
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return out;
}

/** Null when the words resolve; otherwise why the printed step is dead. */
function deadCommandSteps(program: Command, words: string[]): string | null {
	let node = program;
	for (const word of words) {
		const next = node.commands.find((c) => c.name() === word || c.aliases().includes(word));
		if (next) {
			node = next;
			continue;
		}
		if (node.commands.length === 0 || node.registeredArguments.length > 0) return null;
		return node === program ? `unknown command \`${word}\`` : `\`${node.name()}\` has no subcommand \`${word}\``;
	}
	return null;
}

function productSources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		const skippedDir = entry.name === "__tests__" || entry.name === "__fixtures__";
		if (entry.isDirectory()) return skippedDir ? [] : productSources(path);
		const isTest = /\.(test|spec)\.ts$/.test(entry.name) || entry.name.endsWith(".d.ts");
		return entry.name.endsWith(".ts") && !isTest ? [path] : [];
	});
}

describe("printedCommandsIn — positive (must fire)", () => {
	it("P1: reads command words from string literals and template text", () => {
		const source = 'const a = "run `interlinked harness restart` now";\nconst b = `then interlinked caps status --json ${x}`;';
		expect(printedCommandsIn(source).map((c) => c.words)).toEqual([["harness", "restart"], ["caps", "status"]]);
	});

	it("P2: reports the 1-based line of each printed command", () => {
		expect(printedCommandsIn('\n\nconst a = "interlinked doctor";')).toEqual([{ words: ["doctor"], line: 3 }]);
	});

	it("P3: the three dead steps that shipped (verbatim from 31b5259f) are all read as commands", () => {
		const source = [
			"const a = \"config.local.json not found -- run 'interlinked login' or 'interlinked register'\";",
			"const b = `interlinked baseline restore ${toolUseId}\\n`;",
			'const c = `LINE2="\\${YELLOW}⚠ \\${REVIEW_COUNT} file(s) awaiting review\\${RESET}\\${SEP}\\${CYAN}interlinked review\\${RESET}"`;',
		].join("\n");
		expect(printedCommandsIn(source).map((c) => c.words)).toEqual([["login"], ["register"], ["baseline", "restore"], ["review"]]);
	});
});

describe("printedCommandsIn — negative (must not fire)", () => {
	it("N1: comments are not printed text", () => {
		expect(printedCommandsIn("// run interlinked register\n/* interlinked review */")).toEqual([]);
	});

	it("N2: the package name, paths and capitalized prose are not commands", () => {
		const source = 'const a = "interlinked-cli"; const b = ".interlinked/x"; const c = "Interlinked harness";';
		expect(printedCommandsIn(source)).toEqual([]);
	});

	it("N3: prose, labels and file headers that say `interlinked <word>` are not commands", () => {
		const source = [
			'const a = "the interlinked harness should be guarding this project";',
			'const b = "interlinked gate: clean (3ms)";',
			'const c = "# interlinked bash completion";',
			'const d = "interlinked agent presence";',
			"const e = \"_describe -t commands 'interlinked commands' commands\";",
		].join("\n");
		expect(printedCommandsIn(source)).toEqual([]);
	});
});

describe("deadCommandSteps — positive (must fire)", () => {
	it("P1: an unknown top-level command is dead", () => {
		expect(deadCommandSteps(buildProgram("0.0.0"), ["register"])).toBe("unknown command `register`");
	});

	it("P2: an unknown subcommand under a group that takes no arguments is dead", () => {
		expect(deadCommandSteps(buildProgram("0.0.0"), ["harness", "bogus"])).toBe("`harness` has no subcommand `bogus`");
	});
});

describe("deadCommandSteps — negative (must not fire)", () => {
	it("N1: real command paths resolve", () => {
		const program = buildProgram("0.0.0");
		expect(deadCommandSteps(program, ["harness", "restart"])).toBeNull();
		expect(deadCommandSteps(program, ["caps", "status"])).toBeNull();
	});

	it("N2: a word after a leaf command is an argument, not a step", () => {
		const program = buildProgram("0.0.0");
		expect(deadCommandSteps(program, ["doctor", "anything"])).toBeNull();
	});
});

describe("printed-command parity over product source", () => {
	it("every printed `interlinked …` command exists in the commander tree", () => {
		const program = buildProgram("0.0.0");
		const printed = productSources(SRC).flatMap((file) =>
			printedCommandsIn(readFileSync(file, "utf8")).map((command) => ({ file: relative(ROOT, file), ...command })),
		);
		const dead = printed.flatMap(({ file, words, line }) => {
			const reason = deadCommandSteps(program, words);
			return reason === null ? [] : [`${file}:${line} interlinked ${words.join(" ")} — ${reason}`];
		});
		expect(printed.length).toBeGreaterThan(100);
		expect(dead).toEqual([]);
	}, 60_000);
});
