import { posix } from "node:path";
import { extractWorkflowCommands } from "../harness/ci-command-extractor.js";
import { extractFencedBlocks, fencedLineSet } from "../harness/spec/extract-misc.js";
import { parseJsonc } from "../lib/import-resolution/jsonc.js";
import { isJsonObject } from "../lib/json-types.js";

// Only the launcher's script operand is a root. Paths after it can be data or
// ordinary CLI arguments. Keep unsupported shell syntax out of this evidence.
const SCRIPT_INVOCATION = /^(?:node\s+(?:(?:--expose-gc|--enable-source-maps|--(?:import|loader|require)(?:=|\s+)[\w@./-]+)\s+)*|(?:npx\s+)?tsx\s+)(?:\.\/)?([\w][\w./-]*\.[cm]?[jt]sx?)(?=\s|$)/;
const SHELL_FENCE = /^(?:bash|sh|shell|console)$/i;
const FIXTURE = /(?:^|\/)(?:__fixtures__|fixtures?|tests?|__tests__|node_modules|vendor)(?:\/|$)/;
const DOC = /^(?:readme(?:\.[\w-]+)?\.md|(?:docs|skills)\/.+\.md)$/i;
const PROJECT_DOC = /\/(?:readme|report)(?:\.[\w-]+)?\.md$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const WORKER_CONFIG = /(?:^|\/)wrangler\.jsonc?$/;
const OXLINT_CONFIG = /(?:^|\/)(?:\.oxlintrc|oxlint(?:\.[\w.-]+)?)\.json$/;

/** Local configured entry modules are loaded by their tool even without a JS import. */
function configEntries(file: string, text: string): string[] {
	const config = parseJsonc(text);
	if (!isJsonObject(config)) return [];
	const plugins = Array.isArray(config.jsPlugins) ? config.jsPlugins : [];
	const paths = WORKER_CONFIG.test(file) ? [config.main] : plugins.map(plugin => isJsonObject(plugin) ? plugin.specifier : plugin);
	return paths.flatMap(path => {
		if (typeof path !== "string" || posix.isAbsolute(path)) return [];
		if (OXLINT_CONFIG.test(file) && !/^\.{1,2}\//.test(path)) return [];
		const target = posix.join(posix.dirname(file), path);
		return target.startsWith("../") ? [] : [target];
	});
}

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

function entrySource(file: string) {
	if (FIXTURE.test(file)) return null;
	if (WORKER_CONFIG.test(file) || OXLINT_CONFIG.test(file)) return "config";
	if (DOC.test(file)) return "document";
	if (PROJECT_DOC.test(file)) return "project-document";
	if (WORKFLOW.test(file)) return "workflow";
	return null;
}

function projectDocumentInvocations(file: string, text: string, known: ReadonlySet<string>, found: Set<string>): void {
	const paths = new Set<string>();
	markdownInvocations(text, known, paths);
	const root = file.slice(0, file.indexOf("/") + 1);
	for (const path of paths) {
		if (path.startsWith(root) && !known.has(posix.join(posix.dirname(file), path))) found.add(path);
	}
}

/** Positive, root-relative invocation evidence from repository operating docs
 * and GitHub Actions run steps. Dynamic paths and cwd overrides stay unknown. */
export function scriptCommandEntries(files: readonly string[], read: (path: string) => string | null, known: ReadonlySet<string>): Set<string> {
	const entries = new Set<string>();
	for (const file of files) {
		const source = entrySource(file);
		if (!source) continue;
		const text = read(file);
		if (!text) continue;
		switch (source) {
			case "config":
				for (const target of configEntries(file, text)) if (known.has(target)) entries.add(target);
				break;
			case "document":
				markdownInvocations(text, known, entries);
				break;
			case "project-document":
				projectDocumentInvocations(file, text, known, entries);
				break;
			case "workflow":
				if (/\bworking-directory["']?\s*:/.test(text)) break;
				for (const step of extractWorkflowCommands(text)) addInvocations(step.command, known, entries);
				break;
		}
	}
	return entries;
}
