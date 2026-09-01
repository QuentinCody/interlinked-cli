// ===========================================
// Tool-class classifier — assigns a ToolClass to a shell command or tool name
// ===========================================
// Used by runner adapters and the evaluator to decide which checks run and
// which latency budget applies. See docs/design/cli-hook-normalization.md
// §"Tool-class classification".
//
// Classification order for a tool call:
//   1. User override from tool-class-overrides.json `tool_name_classes`.
//   2. Built-in tool-name → ToolClass map.
//   3. For shell/bash tools: first match in `command_substrings` overrides
//      (literal substring match, not regex — eliminates ReDoS surface), then
//      the built-in CLASS_RULES regex set (authored in-source, never user
//      input), then fall through to "modify".
//   4. Unknown tools default to "modify" — the safer default.

import { existsSync, readFileSync } from "node:fs";
import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import type { ToolClass } from "./unified-event.js";

interface ClassRule {
	pattern: RegExp;
	class: ToolClass;
	reason: string;
}

/** User-supplied command matcher. Literal substring (no regex) to avoid any
 *  ReDoS surface from untrusted config. First match wins. */
interface CommandSubstringRule {
	/** The literal substring to search for. */
	match: string;
	class: ToolClass;
	reason?: string;
	/** Default false (case-insensitive). */
	case_sensitive?: boolean;
}

export interface ClassifierOverrides {
	tool_name_classes: Record<string, ToolClass>;
	command_substrings: CommandSubstringRule[];
}

// -----------------------------------------------------------------------------
// Built-in rules (ordered — first match wins). All regexes are authored here,
// never user-supplied — the semgrep ReDoS rule does not apply.
// -----------------------------------------------------------------------------

export const BUILTIN_CLASS_RULES: readonly ClassRule[] = [
	// --- Side-effect: destructive or externally visible ---
	{
		pattern: /\brm\s+(-[rRfF]+|--recursive|--force)\b/,
		class: "side-effect",
		reason: "recursive/force delete",
	},
	{ pattern: /\bgit\s+push\b/, class: "side-effect", reason: "git push" },
	{
		pattern: /\bgit\s+(reset|checkout)\s+(--hard|.*HEAD~)/,
		class: "side-effect",
		reason: "history-rewriting git",
	},
	{
		pattern: /\bgh\s+pr\s+(merge|close|reopen)\b/,
		class: "side-effect",
		reason: "GitHub PR mutation",
	},
	{
		pattern: /\b(wrangler|vercel|fly|railway)\s+(deploy|publish)\b/,
		class: "side-effect",
		reason: "deploy",
	},
	{ pattern: /\bterraform\s+(apply|destroy)\b/, class: "side-effect", reason: "infra mutation" },
	{
		pattern: /\b(aws|gcloud|az)\s+.*\s(delete|destroy|terminate)\b/,
		class: "side-effect",
		reason: "cloud mutation",
	},
	{
		pattern: /\bcurl\s+.*-X\s*(POST|PUT|DELETE|PATCH)\b/,
		class: "side-effect",
		reason: "HTTP mutation",
	},
	{ pattern: /\bnpm\s+publish\b/, class: "side-effect", reason: "package publish" },
	{ pattern: /\bdocker\s+(push|run\s+--rm)\b/, class: "side-effect", reason: "docker mutation" },
	{ pattern: /\bssh\b/, class: "side-effect", reason: "ssh to remote host" },
	{ pattern: /\bscp\b/, class: "side-effect", reason: "scp to remote host" },

	// --- Long-running ---
	{
		pattern: /\bnpm\s+(test|run\s+test|run\s+build|run\s+dev)\b/,
		class: "long-running",
		reason: "npm script",
	},
	{
		pattern: /\b(vitest|jest|mocha|pytest|cargo\s+test|go\s+test)\b/,
		class: "long-running",
		reason: "test runner",
	},
	{
		pattern: /\b(webpack|vite|turbopack|rollup|esbuild)\s+build\b/,
		class: "long-running",
		reason: "bundler",
	},
	{ pattern: /\bcargo\s+(build|check)\b/, class: "long-running", reason: "cargo compile" },
	{ pattern: /\btsc\b(?!\s+--listFiles)/, class: "long-running", reason: "tsc full-project" },
	{ pattern: /\btsgo\b(?!\s+--help)/, class: "long-running", reason: "tsgo full-project" },
	{ pattern: /\bbiome\s+(check|format)\b/, class: "long-running", reason: "biome sweep" },

	// --- Modify ---
	{
		pattern:
			/\b(git\s+(commit|add|stash|rebase|merge|revert)|npm\s+install|pnpm\s+(add|install)|yarn\s+add|cargo\s+add)\b/,
		class: "modify",
		reason: "add/commit/rebase",
	},
	{ pattern: /\b(mv|cp|mkdir|touch|chmod|chown|ln)\b/, class: "modify", reason: "fs modify" },
	{
		pattern: /\brm\b(?!\s+(-[rRfF]+|--recursive|--force))/,
		class: "modify",
		reason: "fs delete",
	},

	// --- Read (fall-through for read-oriented) ---
	{
		pattern:
			/^\s*(ls|cat|pwd|echo|head|tail|wc|find|grep|rg|ag|file|stat|which|type|env|printenv|date|id|whoami|uname|hostname|df|du)\b/,
		class: "read",
		reason: "read-only shell",
	},
	{
		pattern:
			/\bgit\s+(status|log|diff|show|branch|blame|ls-files|rev-parse|remote(?:\s+-v)?|config\s+--get)\b/,
		class: "read",
		reason: "read-only git",
	},
	{
		pattern: /\bgh\s+(pr|issue|run)\s+(view|list|status)\b/,
		class: "read",
		reason: "read-only gh",
	},
	{ pattern: /\b(node|python3?|bun|deno)\s+--version\b/, class: "read", reason: "version probe" },
] as const;

// -----------------------------------------------------------------------------
// Built-in tool-name → class
// -----------------------------------------------------------------------------

/** Claude Code / MCP / generic tool names, normalized lowercase_snake. */
export const BUILTIN_TOOL_NAME_CLASSES: Readonly<Record<string, ToolClass>> = {
	// Claude Code built-ins
	read: "read",
	grep: "read",
	glob: "read",
	ls: "read",
	todowrite: "read",
	exitplanmode: "read",
	edit: "modify",
	write: "modify",
	multiedit: "modify",
	notebookedit: "modify",
	bash: "unknown", // determined from command — "unknown" triggers shell classification
	webfetch: "read",
	websearch: "read",
	task: "unknown",

	// Copilot CLI built-ins
	read_file: "read",
	search: "read",
	list: "read",
	edit_file: "modify",
	write_file: "modify",
	apply_patch: "modify",
	shell: "unknown",
	exec: "unknown",

	// Cursor
	beforeshellexecution: "unknown",
	beforemcptoolexecution: "unknown",
	beforereadfile: "read",
};

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

const MAX_SUBSTRING_CHECKS = 256;

export function classifyCommand(
	command: string,
	substrings: readonly CommandSubstringRule[] = [],
	rules: readonly ClassRule[] = BUILTIN_CLASS_RULES,
): ToolClass {
	if (typeof command !== "string" || command.length === 0) return "unknown";

	// User substring overrides first — literal match, zero regex risk.
	const lowerCommand = command.toLowerCase();
	const cap = Math.min(substrings.length, MAX_SUBSTRING_CHECKS);
	for (let i = 0; i < cap; i++) {
		const rule = substrings[i];
		if (nonNull(rule).case_sensitive) {
			if (command.includes(nonNull(rule).match)) return nonNull(rule).class;
		} else if (lowerCommand.includes(nonNull(rule).match.toLowerCase())) {
			return nonNull(rule).class;
		}
	}

	for (const rule of rules) {
		if (rule.pattern.test(command)) return rule.class;
	}
	// Unknown commands default to "modify" — the safer default per the design doc.
	return "modify";
}

export function classifyFromToolName(
	toolName: string,
	toolInput: unknown,
	opts: { overrides?: ClassifierOverrides } = {},
): ToolClass {
	const overrides = opts.overrides;
	const normalized = toolName.toLowerCase().replace(/[^a-z0-9_]/g, "_");

	// 1. User tool-name overrides
	const override = overrides?.tool_name_classes;
	if (override) {
		if (override[toolName] !== undefined) return override[toolName];
		if (override[normalized] !== undefined) return override[normalized];
	}

	// 2. Built-in tool-name map
	const builtin = BUILTIN_TOOL_NAME_CLASSES[normalized];
	if (builtin && builtin !== "unknown") return builtin;

	// 3. For shell-style tools, classify by command
	if (builtin === "unknown") {
		const command = extractCommandField(toolInput);
		if (command) {
			return classifyCommand(command, overrides?.command_substrings ?? []);
		}
	}

	// 4. Safe default for unknown MCP tools and the like
	return "modify";
}

function extractCommandField(input: unknown): string | null {
	if (input == null || typeof input !== "object") return null;
	const obj = input as JsonObject;
	const cmd = obj.command ?? obj.cmd ?? obj.bash ?? obj.shell ?? obj.script;
	return typeof cmd === "string" ? cmd : null;
}

// -----------------------------------------------------------------------------
// Overrides loader
// -----------------------------------------------------------------------------

const EMPTY_OVERRIDES: ClassifierOverrides = {
	tool_name_classes: {},
	command_substrings: [],
};

/** Maximum length for a user-supplied substring match. */
const MAX_SUBSTRING_LENGTH = 200;

/** Load user-provided tool-class overrides from a JSON file. Missing file is
 *  not an error — returns the empty set. Malformed files log to stderr and
 *  return empty so a broken config never blocks the gate. */
export function loadOverrides(overridesPath: string): ClassifierOverrides {
	if (!existsSync(overridesPath)) return EMPTY_OVERRIDES;
	const text = safeRead(overridesPath);
	if (text === null) return EMPTY_OVERRIDES;
	const raw = safeParse(text, overridesPath);
	if (raw === null) return EMPTY_OVERRIDES;
	return parseOverrides(raw);
}

function safeRead(path: string): string | null {
	const result = { ok: false as boolean, text: "" as string, err: "" as string };
	// Extracted so the try/catch stays in a helper, keeping the happy-path
	// function body flat.
	readAttempt(path, result);
	if (!result.ok) {
		process.stderr.write(`[interlinked] warning: could not read ${path}: ${result.err}\n`);
		return null;
	}
	return result.text;
}

function readAttempt(path: string, out: { ok: boolean; text: string; err: string }): void {
	out.ok = true;
	out.text = "";
	out.err = "";
	let text: string;
	let ok = true;
	let err = "";
	try {
		text = readFileSync(path, "utf-8");
	} catch (e) {
		text = "";
		ok = false;
		err = (e as Error).message;
	}
	out.text = text;
	out.ok = ok;
	out.err = err;
}

function safeParse(text: string, path: string): unknown {
	let parsed: unknown = null;
	let ok = true;
	let err = "";
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		ok = false;
		err = (e as Error).message;
	}
	if (!ok) {
		process.stderr.write(
			`[interlinked] warning: could not parse ${path} (${err}); ignoring overrides\n`,
		);
		return null;
	}
	return parsed;
}

/** Parse a raw JSON value into a validated ClassifierOverrides. Unknown keys
 *  are ignored; invalid entries are dropped with a stderr note. Exported so
 *  test fixtures can share the same parser as the file loader. */
export function parseOverrides(raw: unknown): ClassifierOverrides {
	if (raw == null || typeof raw !== "object") return EMPTY_OVERRIDES;
	const obj = raw as JsonObject;

	const tool_name_classes = parseToolNameClasses(obj.tool_name_classes);
	const command_substrings = parseCommandSubstrings(obj.command_substrings);

	return { tool_name_classes, command_substrings };
}

function parseToolNameClasses(raw: unknown): Record<string, ToolClass> {
	const out: Record<string, ToolClass> = {};
	if (raw == null || typeof raw !== "object") return out;
	for (const [name, cls] of Object.entries(raw as JsonObject)) {
		if (isToolClass(cls)) out[name] = cls;
	}
	return out;
}

function parseCommandSubstrings(raw: unknown): CommandSubstringRule[] {
	const out: CommandSubstringRule[] = [];
	if (!Array.isArray(raw)) return out;
	const entries: readonly unknown[] = raw;
	for (const entry of entries) {
		const rule = parseSubstringEntry(entry);
		if (rule) out.push(rule);
	}
	return out;
}

function parseSubstringEntry(entry: unknown): CommandSubstringRule | null {
	if (entry == null || typeof entry !== "object") return null;
	const e = entry as JsonObject;
	if (typeof e.match !== "string" || e.match.length === 0) return null;
	if (e.match.length > MAX_SUBSTRING_LENGTH) {
		process.stderr.write(
			`[interlinked] warning: command_substrings entry exceeds ${MAX_SUBSTRING_LENGTH} chars; dropping\n`,
		);
		return null;
	}
	if (!isToolClass(e.class)) return null;
	return {
		match: e.match,
		class: e.class,
		reason: typeof e.reason === "string" ? e.reason : "user override",
		case_sensitive: e.case_sensitive === true,
	};
}

function isToolClass(v: unknown): v is ToolClass {
	return (
		v === "read" ||
		v === "modify" ||
		v === "side-effect" ||
		v === "long-running" ||
		v === "unknown"
	);
}
