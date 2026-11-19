import { extractWorkflowCommands } from "../harness/ci-command-extractor.js";
import { extractFencedBlocks, fencedLineSet } from "../harness/spec/extract-misc.js";

// Only the launcher's script operand is a root. Paths after it can be data or
// ordinary CLI arguments. Keep unsupported shell syntax out of this evidence.
const SCRIPT_INVOCATION = /^(?:node\s+(?:(?:--expose-gc|--enable-source-maps|--(?:import|loader|require)(?:=|\s+)[\w@./-]+)\s+)*|(?:npx\s+)?tsx\s+)(?:\.\/)?([\w][\w./-]*\.[cm]?[jt]sx?)(?=\s|$)/;
const SHELL_FENCE = /^(?:bash|sh|shell|console)$/i;
const FIXTURE = /(?:^|\/)(?:__fixtures__|fixtures?|tests?|__tests__|node_modules|vendor)(?:\/|$)/;
const DOC = /^(?:readme(?:\.[\w-]+)?\.md|(?:docs|skills)\/.+\.md)$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

function addInvocations(block: string, known: ReadonlySet<string>, found: Set<string>): void {
	const lines = block.split(/\r?\n/).map(line => line.trim().replace(/^\$\s+/, "")).filter(line => line && !line.startsWith("#"));
	const invocations = lines.map(line => SCRIPT_INVOCATION.exec(line)?.[1]);
	// Another command in a shell block can change the cwd or open a heredoc.
	if (invocations.some(path => path === undefined) || /[;&|<>`]|\$\(|\\\s*$/m.test(lines.join("\n"))) return;
	for (const path of invocations) if (path && known.has(path)) found.add(path);
}

/** Shell-labelled fences and explicit inline command examples carry invocation
 * evidence. Source-language examples and bare prose can name arbitrary paths. */
function markdownInvocations(text: string, known: ReadonlySet<string>, found: Set<string>): void {
	const lines = text.split(/\r?\n/);
	const blocks = extractFencedBlocks(lines);
	for (const block of blocks) {
		if (SHELL_FENCE.test(block.lang)) addInvocations(lines.slice(block.startLine, block.endLine - 1).join("\n"), known, found);
	}
	const fenced = fencedLineSet(blocks);
	for (const [index, line] of lines.entries()) {
		if (fenced.has(index + 1)) continue;
		for (const code of line.matchAll(/`([^`\n]+)`/g)) addInvocations(code[1] ?? "", known, found);
	}
}

/** Positive, root-relative invocation evidence from repository operating docs
 * and GitHub Actions run steps. Dynamic paths and cwd overrides stay unknown. */
export function scriptCommandEntries(files: readonly string[], read: (path: string) => string | null, known: ReadonlySet<string>): Set<string> {
	const entries = new Set<string>();
	for (const file of files) {
		if (FIXTURE.test(file) || !(DOC.test(file) || WORKFLOW.test(file))) continue;
		const text = read(file);
		if (!text) continue;
		if (DOC.test(file)) markdownInvocations(text, known, entries);
		else if (!/\bworking-directory["']?\s*:/.test(text)) {
			for (const step of extractWorkflowCommands(text)) addInvocations(step.command, known, entries);
		}
	}
	return entries;
}
