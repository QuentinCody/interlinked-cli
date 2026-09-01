// ===========================================
// Interlinked hook ownership
// ===========================================
// One predicate, used by every install and clean path, that recognizes a
// hook command as Interlinked's — whether it is the legacy generated `.mjs`
// hook (interlinked-activity.mjs) or the adapter hook (`hook-entry.js` /
// `interlinked-hook`, invoked as `node ... --runner ... --event ...`).
//
// The bug it fixes: the legacy cleanup only matched the `interlinked-activity`
// marker and the adapter cleanup only knew its own command shape, so neither
// install system could recognise — or remove — the other's entries.

import { basename } from "node:path";
import type { JsonObject } from "./json-types.js";

// SHELL-POSITION-parsed ownership (review 2026-08-30 final pass: the regex
// version still claimed `echo node /…/hook-entry.js`, `echo ok # node …`,
// and `printf '…' 'node …'` — the marker was found ANYWHERE in the string,
// not in the executable position, and a claimed entry is a REMOVED entry on
// the purge/uninstall paths). The recognizer now tokenizes ONE shell command
// (quotes, escapes, comments-outside-quotes, `;`/`&&`/`||`/`|`/`&`/parens
// separators, leading VAR= assignments, keywords, `exec`) and recognizes
// exactly:
//   - `node <script whose exact basename is hook-entry.js> --runner <known>
//     --event <present>`;
//   - an `interlinked-hook` executable/script with that same adapter argument
//     shape;
//   - `node .interlinked/hooks/interlinked-activity.mjs` (or that exact
//     repo-relative suffix beneath an absolute path);
//   - the exact legacy generated variable-assignment form
//     (`HOOK_SCRIPT_REL=".interlinked/hooks/interlinked-activity.mjs"` in one
//     segment, `HOOK_DIR="$PWD"` in another, and
//     `node "$HOOK_DIR/$HOOK_SCRIPT_REL"` in another).
// Callers hand it COMMAND STRINGS, never serialized JSON — document scanning
// goes through {@link documentContainsInterlinkedHook}.
const LEGACY_MJS_PATH = ".interlinked/hooks/interlinked-activity.mjs";
const LEGACY_ASSIGNMENT = `HOOK_SCRIPT_REL="${LEGACY_MJS_PATH}"`;
const LEGACY_DIR_ASSIGNMENT = 'HOOK_DIR="$PWD"';
const LEGACY_VARIABLE_SCRIPT = "$HOOK_DIR/$HOOK_SCRIPT_REL";
const REGISTERED_RUNNERS = new Set([
	"claude-code",
	"copilot-cli",
	"cursor",
	"gemini-cli",
	"codex",
	"opencode",
	"pi",
]);
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "while", "until", "do", "done", "!", "{", "}"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Cut a `#` comment that sits OUTSIDE quotes; keep everything before it. */
function stripShellComment(segment: string): string {
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote !== null) {
			if (ch === "\\" && quote === '"') i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "\\") i++;
		else if (ch === "#") return segment.slice(0, i);
	}
	return segment;
}

/** One character's contribution during the segment scan. */
function scanChar(
	command: string,
	i: number,
	state: { quote: string | null; current: string; segments: string[] },
): number {
	const ch = command[i] ?? "";
	if (state.quote !== null) {
		state.current += ch;
		if (ch === "\\" && state.quote === '"') {
			state.current += command[i + 1] ?? "";
			return i + 2;
		}
		if (ch === state.quote) state.quote = null;
		return i + 1;
	}
	if (ch === "'" || ch === '"') {
		state.quote = ch;
		state.current += ch;
		return i + 1;
	}
	if (ch === "\\") {
		state.current += ch + (command[i + 1] ?? "");
		return i + 2;
	}
	if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")") {
		state.segments.push(state.current);
		state.current = "";
		return i + 1;
	}
	state.current += ch;
	return i + 1;
}

/** Split on top-level separators (;, &, |, newline, parens) — quote/escape
 *  aware, so a `|` inside quotes never splits. `&&`/`||` fall out of the
 *  single-character split naturally (empty segments are dropped). */
function splitShellSegments(command: string): string[] {
	const state = { quote: null as string | null, current: "", segments: [] as string[] };
	let i = 0;
	while (i < command.length) i = scanChar(command, i, state);
	state.segments.push(state.current);
	return state.segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Quote-aware word split; each word keeps its raw text. */
function shellWords(segment: string): string[] {
	return segment.match(/"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\S+/g) ?? [];
}

function stripQuotes(word: string): string {
	const quoted =
		(word.startsWith("'") && word.endsWith("'") && word.length >= 2) ||
		(word.startsWith('"') && word.endsWith('"') && word.length >= 2);
	return quoted ? word.slice(1, -1) : word;
}

interface ParsedInvocation {
	executable: string;
	script: string | null;
	args: string[];
}

/** The executable word and (for node) its script word of ONE segment, with
 *  keywords, `VAR=` assignments, `exec`, and node CLI options skipped. */
function invocationOf(segment: string): ParsedInvocation | null {
	const words = shellWords(stripShellComment(segment));
	let i = 0;
	while (i < words.length && isSkippableLeadingWord(words[i] ?? "")) i++;
	const executable = words[i];
	if (executable === undefined) return null;
	return parsedInvocation(words, i, stripQuotes(executable));
}

function parsedInvocation(
	words: string[],
	executableIndex: number,
	executable: string,
): ParsedInvocation {
	if (executable === "node") return parsedNodeInvocation(words, executableIndex);
	return {
		executable,
		script: null,
		args: words.slice(executableIndex + 1).map(stripQuotes),
	};
}

function parsedNodeInvocation(words: string[], executableIndex: number): ParsedInvocation {
	const scriptIndex = nodeScriptIndex(words, executableIndex);
	if (scriptIndex === null) return { executable: "node", script: null, args: [] };
	return {
		executable: "node",
		script: stripQuotes(words[scriptIndex] ?? ""),
		args: words.slice(scriptIndex + 1).map(stripQuotes),
	};
}

function isSkippableLeadingWord(word: string): boolean {
	return SHELL_KEYWORDS.has(word) || ASSIGNMENT_RE.test(word) || word === "exec";
}

/** For a `node` invocation, the script word.
 *
 * Interlinked's generated commands put the script immediately after `node`.
 * Treat any Node option as ambiguous instead of guessing whether it consumes
 * the following word: `node --require /tmp/hook-entry.js app.js` executes
 * `app.js`, but a naive "first non-option" scan claims the preload argument as
 * our entry point and lets purge/uninstall delete a user's hook. The standard
 * `--` option terminator is unambiguous and remains supported. */
function nodeScriptIndex(words: string[], executableIndex: number): number | null {
	if (stripQuotes(words[executableIndex] ?? "") !== "node") return null;
	let j = executableIndex + 1;
	const firstArgument = stripQuotes(words[j] ?? "");
	if (firstArgument === "--") j++;
	else if (firstArgument.startsWith("-")) return null;
	return words[j] === undefined ? null : j;
}

/** Read one long option exactly once. Both `--name value` and
 *  `--name=value` are accepted; missing, option-shaped, or duplicate values
 *  are ambiguous and therefore not ownership evidence. */
function optionValue(args: string[], name: string): string | null {
	let found: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const match = optionMatch(args, i, name);
		if (match === null) continue;
		if (match.value === null || found !== null) return null;
		found = match.value;
		i += match.consumedNext ? 1 : 0;
	}
	return found;
}

function optionMatch(
	args: string[],
	index: number,
	name: string,
): { value: string | null; consumedNext: boolean } | null {
	const arg = args[index] ?? "";
	if (arg === name) {
		const next = args[index + 1] ?? "";
		return {
			value: next.length > 0 && !next.startsWith("-") ? next : null,
			consumedNext: true,
		};
	}
	if (!arg.startsWith(`${name}=`)) return null;
	const value = stripQuotes(arg.slice(name.length + 1));
	return {
		value: value.length > 0 && !value.startsWith("-") ? value : null,
		consumedNext: false,
	};
}

function isCanonicalAdapterInvocation(invocation: ParsedInvocation): boolean {
	const runner = optionValue(invocation.args, "--runner");
	const event = optionValue(invocation.args, "--event");
	return runner !== null && REGISTERED_RUNNERS.has(runner) && event !== null;
}

function isRecognizedLegacyScript(script: string, legacyAssigned: boolean): boolean {
	if (script === LEGACY_MJS_PATH || script.endsWith(`/${LEGACY_MJS_PATH}`)) return true;
	return legacyAssigned && script === LEGACY_VARIABLE_SCRIPT;
}

/** One recognized Interlinked invocation, with its identity classified. */
interface HookInvocation {
	executable: string;
	script: string | null;
	kind: "hook-entry" | "legacy-mjs" | "interlinked-hook";
}

/** Classify ONE segment's invocation as Interlinked-owned, or null. Adapter
 *  identity combines an exact basename with canonical runner/event arguments;
 *  legacy identity uses only the reserved project hook path. */
function ownedInvocationOf(segment: string, legacyAssigned: boolean): HookInvocation | null {
	const invocation = invocationOf(segment);
	if (invocation === null) return null;
	const kind = ownedInvocationKind(invocation, legacyAssigned);
	return kind === null
		? null
		: { executable: invocation.executable, script: invocation.script, kind };
}

function ownedInvocationKind(
	invocation: ParsedInvocation,
	legacyAssigned: boolean,
): HookInvocation["kind"] | null {
	const scriptKind = ownedScriptKind(invocation, legacyAssigned);
	if (scriptKind !== null) return scriptKind;
	return isCanonicalAdapterInvocation(invocation) && basename(invocation.executable) === "interlinked-hook"
		? "interlinked-hook"
		: null;
}

function ownedScriptKind(
	invocation: ParsedInvocation,
	legacyAssigned: boolean,
): HookInvocation["kind"] | null {
	const script = invocation.script;
	if (script === null) return null;
	if (isRecognizedLegacyScript(script, legacyAssigned)) return "legacy-mjs";
	if (!isCanonicalAdapterInvocation(invocation)) return null;
	const scriptName = basename(script);
	if (scriptName === "hook-entry.js") return "hook-entry";
	// The bin is also invocable through node (`node '/…/interlinked-hook' …`).
	return scriptName === "interlinked-hook" ? "interlinked-hook" : null;
}

/** True when `command` (ONE shell command string, never a JSON document) is
 *  an Interlinked hook invocation — either entry point. Used by install to
 *  purge prior registrations and by every uninstall / clean path, so the two
 *  install systems can see each other. */
export function isInterlinkedHookCommand(command: string): boolean {
	return ownedInvocations(command).length > 0;
}

/** Every Interlinked-owned invocation in ONE shell command string, in order. */
export function ownedInvocations(command: string): HookInvocation[] {
	const segments = splitShellSegments(command);
	const exactSegments = new Set(segments.map((segment) => stripShellComment(segment).trim()));
	const legacyAssigned =
		exactSegments.has(LEGACY_ASSIGNMENT) && exactSegments.has(LEGACY_DIR_ASSIGNMENT);
	const out: HookInvocation[] = [];
	for (const segment of segments) {
		const invocation = ownedInvocationOf(segment, legacyAssigned);
		if (invocation !== null) out.push(invocation);
	}
	return out;
}

/** True when the entry invokes `binaryPath` with canonical adapter
 *  runner/event arguments. The binary sits in the node script position or is
 *  itself the executable, never merely somewhere in the entry's text. */
export function isHookEntryInvokingBinary(entry: unknown, binaryPath: string): boolean {
	if (binaryPath.length === 0) return false;
	return hookEntryCommands(entry).some((command) =>
		splitShellSegments(command).some((segment) => {
			const invocation = invocationOf(segment);
			if (invocation === null) return false;
			if (!isCanonicalAdapterInvocation(invocation)) return false;
			return invocation.script === binaryPath || invocation.executable === binaryPath;
		}),
	);
}

/** Walk a PARSED settings document's HOOK CONTAINERS for an Interlinked-owned
 *  entry. Every supported runner registers hooks under a `hooks` key (Claude
 *  Code / Gemini / Cursor / Copilot all render `{ hooks: { <Event>: [entry] } }`),
 *  so only that container is scanned — review 2026-08-31: the earlier
 *  unrestricted deep walk also matched a hook-shaped command inside unrelated
 *  metadata (an `unrelated_note` field), which is a mention, not a
 *  registration. */
export function documentContainsInterlinkedHook(parsed: unknown): boolean {
	if (!isRecord(parsed)) return false;
	return hookContainerContainsInterlinkedHook(parsed.hooks);
}

/** The `hooks` container is either an event-name map or an entry array. */
function hookContainerContainsInterlinkedHook(container: unknown): boolean {
	if (Array.isArray(container)) return container.some(isInterlinkedHookEntry);
	if (isRecord(container)) {
		return Object.values(container).some(hookContainerContainsInterlinkedHook);
	}
	return false;
}

function isRecord(value: unknown): value is JsonObject {
	return value instanceof Object && !Array.isArray(value);
}

/**
 * A stable identity for one hook-array entry: canonical JSON with object keys
 * sorted, so two entries differing only in key order compare equal.
 *
 * Exists to answer the one question the ownership predicates below CANNOT: "is
 * this existing entry identical to the one I am about to write?" Ownership asks
 * *whose* hook an entry is; this asks whether it is *the same* hook.
 *
 * Why that distinction is load-bearing (measured 2026-08-08): a user-scope
 * install whose binary lives outside any project — the normal case for a
 * globally installed `interlinked` — produces a hook command containing no
 * project path. {@link isProjectOwnedHookEntry} therefore cannot attribute it,
 * correctly declines to claim it, and the installer spares it as another repo's
 * hook. The append that follows adds an identical copy, and every later install
 * adds one more, unbounded, until the runner refuses to read its own settings
 * file: 8,092 dead entries across 14 events on one machine, all pointing at a
 * single hook binary that never existed on disk.
 *
 * Removing an exact duplicate of what is about to be written is always safe —
 * the append restores it — and keeping one is never correct, since it only
 * makes the runner execute the same hook twice.
 */
/**
 * Public API — `existing` minus every entry identical to one in `incoming`.
 *
 * Runs BEFORE any ownership verdict, because an exact duplicate of what is
 * about to be written raises no ownership question at all. See
 * {@link hookEntryKey} for the unbounded-growth bug this closes.
 */
export function withoutIncomingDuplicates(existing: unknown[], incoming: unknown[]): unknown[] {
	const keys = new Set(incoming.map(hookEntryKey));
	return existing.filter((entry) => !keys.has(hookEntryKey(entry)));
}

function hookEntryKey(entry: unknown): string {
	return JSON.stringify(entry, (_key, value: unknown) => {
		if (!isRecord(value)) return value;
		const sorted: JsonObject = {};
		for (const k of Object.keys(value).sort()) sorted[k] = value[k];
		return sorted;
	});
}

function pushIfString(out: string[], value: unknown): void {
	if (typeof value === "string") out.push(value);
}

/** Pull every shell command string out of a runner hook-array entry.
 *  Handles the shapes across supported runners: Claude Code's nested
 *  `{ hooks: [{ command }] }`, and the flatter `{ command }` / `{ bash }`
 *  forms. Unknown shapes yield an empty list. */
export function hookEntryCommands(entry: unknown): string[] {
	if (!isRecord(entry)) return [];
	const out: string[] = [];
	pushIfString(out, entry.command);
	pushIfString(out, entry.bash);
	if (Array.isArray(entry.hooks)) {
		for (const nested of entry.hooks) {
			if (isRecord(nested)) {
				pushIfString(out, nested.command);
				pushIfString(out, nested.bash);
			}
		}
	}
	return out;
}

/** True when a runner hook-array entry is (or contains) an Interlinked
 *  hook — across the legacy and adapter shapes and all supported runners. */
export function isInterlinkedHookEntry(entry: unknown): boolean {
	return hookEntryCommands(entry).some(isInterlinkedHookCommand);
}

/** True when an Interlinked hook entry was registered by the project rooted
 *  at `projectRoot` — i.e. one of its commands references a path inside that
 *  project. The installer bakes an absolute binary path (`<projectRoot>/…`)
 *  into every adapter hook command, so this distinguishes *this* project's
 *  registration from another repo's inside a shared user-scope settings file:
 *  a user-scope cleanup may purge the former but must leave the latter alone.
 *
 *  The legacy `$PWD`-relative hook command embeds no absolute project path,
 *  so it reads as not-owned here — the safe answer, leaving an ambiguous
 *  entry in place rather than removing another repo's hook. The legacy
 *  installer writes only project-scope files, so a relative command never
 *  lands in a shared user-scope file regardless. */
export function isProjectOwnedHookEntry(entry: unknown, projectRoot: string): boolean {
	if (projectRoot.length === 0) return false;
	// Match `<projectRoot>/` (with the separator) so a sibling repo whose path
	// is a string prefix — e.g. `/repo` vs `/repo-fork` — is not misattributed.
	const needle = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
	// Attribution reads the INVOKED path only (review 2026-08-31: matching the
	// needle anywhere in the command text claimed a FOREIGN repo's hook whose
	// echo argument happened to mention this project's root).
	return hookEntryCommands(entry).some((command) =>
		ownedInvocations(command).some((invocation) =>
			(invocation.script ?? invocation.executable).startsWith(needle),
		),
	);
}
