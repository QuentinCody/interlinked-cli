// Instruction packets — the trajectory WINDOW digest (design §7, R6).
//
// A window is an ORDERED list of calls, each with its class, outcome and
// verifier scope, plus the turn's prompts, the final message and the packets
// that fired. Counts are derived from the list, never stored instead of it:
// "tests passed before the edit" and "tests passed after the edit" are
// different digests. A call whose outcome the log did not capture is
// `unknown`, never `pass`. Rendering is bounded: the OLDEST calls fold into an
// ordered class/outcome summary; a recent call is never dropped. Pure.

import { createHash } from "node:crypto";
import { maskCredentialAssignments, redactE20 } from "../jev/decision-shadow-redact.js";
import type { JevEntry } from "../jev/types.js";

export type CallClass = "test" | "typecheck" | "build" | "lint" | "git" | "edit" | "read" | "search" | "shell" | "other";
export type CallOutcome = "pass" | "fail" | "interrupted" | "unknown";
export type VerifierScope = "file" | "dir" | "suite" | "n/a";

export interface WindowCall {
	seq: number;
	ts: string;
	tool: string;
	class: CallClass;
	files: string[];
	command: string | null;
	outcome: CallOutcome;
	scope: VerifierScope;
}

export interface WindowDigest {
	kind: "turn" | "session";
	session_id: string;
	from_seq: number;
	to_seq: number;
	calls: WindowCall[];
	prompts: string[];
	final_message: string | null;
	fired_packets: string[];
	/** True when calls older than the cap were dropped from `calls`. */
	truncated: boolean;
}

export const DEFAULT_MAX_CALLS = 200;
export const DEFAULT_RENDER_CHARS = 4_096;
const COMMAND_CHARS = 120;
const PROMPT_CHARS = 600;
/** Aggregate budget for prompt text; the NEWEST prompts are kept. */
const PROMPTS_TOTAL_CHARS = 1_200;
const FINAL_CHARS = 800;

/** Every string that leaves the machine passes the same redaction as per-call evidence (R3). */
function clean(text: string): string {
	return maskCredentialAssignments(redactE20(text));
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "str_replace", "create", "WriteFile", "EditFile", "write_file", "edit_file"]);
const READ_TOOLS = new Set(["Read", "ReadFile", "read_file", "NotebookRead"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "grep", "glob", "WebSearch"]);
const RUNNER = /(^|[\s;&|(])(npx\s+)?(vitest|jest|mocha|pytest|cargo\s+test|go\s+test|npm\s+(run\s+)?test)\b/;
const TYPECHECK = /(^|[\s;&|(])(npm\s+run\s+typecheck|npx\s+)?(tsc|tsgo)\b|\bnpm\s+run\s+typecheck\b|\bmypy\b|\bcargo\s+check\b/;
const BUILD = /\bnpm\s+run\s+build\b|\btsup\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\b/;
const LINT = /\b(biome|eslint|oxlint|ruff|clippy)\b/;
const GIT = /(^|[\s;&|(])git\s+\w+/;
const QUOTED = /"[^"]*"|'[^']*'/g;

/** The class of one call, from the tool name first and the command text (outside quotes) second. */
export function classifyCall(tool: string, command: string | null, files: readonly string[]): CallClass {
	if (EDIT_TOOLS.has(tool)) return "edit";
	if (READ_TOOLS.has(tool)) return "read";
	if (SEARCH_TOOLS.has(tool)) return "search";
	if (tool !== "Bash" || command === null) return files.length > 0 ? "edit" : "other";
	const bare = command.replace(QUOTED, '""');
	if (RUNNER.test(bare)) return "test";
	if (TYPECHECK.test(bare)) return "typecheck";
	if (BUILD.test(bare)) return "build";
	if (LINT.test(bare)) return "lint";
	if (GIT.test(bare)) return "git";
	return "shell";
}

/** What a verifier command covered: a file, a directory, the whole suite, or nothing (not a verifier). */
export function verifierScope(command: string | null): VerifierScope {
	if (command === null) return "n/a";
	const bare = command.replace(QUOTED, '""');
	if (!RUNNER.test(bare) && !TYPECHECK.test(bare)) return "n/a";
	const args = bare.split(/\s+/).filter((a) => a.length > 0 && !a.startsWith("-"));
	const paths = args.filter((a) => /[/.]/.test(a) && !/^(npx|npm|node|vitest|jest|pytest|tsc|tsgo|run|test|typecheck)$/.test(a) && !a.startsWith("npm") && !a.endsWith(".mjs"));
	if (paths.some((p) => /\.[a-z]+$/i.test(p))) return "file";
	if (paths.length > 0) return "dir";
	return "suite";
}

export interface DigestInput {
	kind: "turn" | "session";
	session_id: string;
	calls: readonly WindowCall[];
	prompts: readonly string[];
	final_message: string | null;
	fired_packets: readonly string[];
}

/** Order by seq; keep the NEWEST `maxCalls`; record truncation. */
export function buildDigest(input: DigestInput, limits: { maxCalls?: number } = {}): WindowDigest {
	const max = limits.maxCalls ?? DEFAULT_MAX_CALLS;
	const ordered = [...input.calls].sort((a, b) => a.seq - b.seq);
	const kept = ordered.length > max ? ordered.slice(ordered.length - max) : ordered;
	return {
		kind: input.kind,
		session_id: input.session_id,
		from_seq: kept[0]?.seq ?? 0,
		to_seq: kept[kept.length - 1]?.seq ?? 0,
		calls: kept,
		prompts: [...input.prompts],
		final_message: input.final_message,
		fired_packets: [...input.fired_packets],
		truncated: ordered.length > max,
	};
}

function cut(text: string, n: number): string {
	return text.length > n ? `${text.slice(0, n)}…` : text;
}

/** Consecutive equal class/outcome pairs as one run (`test/fail×3`): order and outcomes survive, bytes do not grow with the count. */
function foldRuns(calls: readonly WindowCall[]): string {
	const runs: string[] = [];
	let current: { key: string; n: number } | null = null;
	for (const c of calls) {
		const key = `${c.class}/${c.outcome}`;
		if (current && current.key === key) current.n++;
		else {
			if (current) runs.push(current.n > 1 ? `${current.key}×${current.n}` : current.key);
			current = { key, n: 1 };
		}
	}
	if (current) runs.push(current.n > 1 ? `${current.key}×${current.n}` : current.key);
	return runs.join(" ");
}

export interface RenderedDigest {
	entry: JevEntry;
	/** The calls rendered individually (the newest), in order; older ones are folded. */
	kept: WindowCall[];
}

function callLineClean(c: WindowCall, commandChars: number): string {
	const scope = c.scope === "n/a" ? "" : ` ${c.scope}`;
	const what = c.command !== null ? cut(clean(c.command.replace(/\s+/g, " ")), commandChars) : clean(c.files.join(", "));
	return `${c.seq} ${c.class} ${c.tool} ${c.outcome}${scope}: ${what}`;
}

function promptsWithinBudget(prompts: readonly string[]): string[] {
	const out: string[] = [];
	let used = 0;
	for (const p of [...prompts].reverse()) {
		const text = cut(clean(p), PROMPT_CHARS);
		if (used + text.length > PROMPTS_TOTAL_CHARS && out.length > 0) break;
		out.unshift(used + text.length > PROMPTS_TOTAL_CHARS ? cut(text, PROMPTS_TOTAL_CHARS) : text);
		used += text.length;
	}
	return out;
}

/** Ordered, bounded, SANITIZED rendering for a Jev state. The budget binds the whole serialized state:
 *  prompts are capped in aggregate (newest kept), then the oldest calls fold into class/outcome runs,
 *  then command excerpts shrink, then the fold itself is cut. A recent call is never dropped. */
export function renderDigestDetailed(d: WindowDigest, maxChars = DEFAULT_RENDER_CHARS): RenderedDigest {
	const base = {
		window: d.kind,
		from_seq: d.from_seq,
		to_seq: d.to_seq,
		truncated: d.truncated,
		prompts: promptsWithinBudget(d.prompts),
		final_message: d.final_message === null ? null : cut(clean(d.final_message), FINAL_CHARS),
		fired_packets: [...d.fired_packets],
	};
	let keep = d.calls.length;
	let commandChars = COMMAND_CHARS;
	let folded: string | null = null;
	const render = () => ({ ...base, folded, calls: d.calls.slice(d.calls.length - keep).map((c) => callLineClean(c, commandChars)) });
	const size = () => JSON.stringify(render()).length;
	const foldFor = (kept: number): string | null => {
		const older = d.calls.slice(0, d.calls.length - kept);
		return older.length === 0 ? null : `${older.length} earlier calls in order: ${foldRuns(older)}`;
	};
	while (keep > 1 && size() > maxChars) {
		keep = Math.max(1, Math.floor(keep * 0.75));
		folded = foldFor(keep);
	}
	while (commandChars > 24 && size() > maxChars) commandChars = Math.floor(commandChars / 2);
	const current: string | null = folded;
	if (current !== null && size() > maxChars) folded = cut(current, Math.max(40, current.length - (size() - maxChars) - 1));
	return { entry: render(), kept: d.calls.slice(d.calls.length - keep) };
}

export function renderDigest(d: WindowDigest, maxChars = DEFAULT_RENDER_CHARS): JevEntry {
	return renderDigestDetailed(d, maxChars).entry;
}

/** The text the deciders and triggers read: every command and file, in order. */
export function digestSubject(d: WindowDigest): string {
	return d.calls.map((c) => c.command ?? c.files.join("\n")).join("\n");
}

export function digestHash(d: WindowDigest): string {
	return createHash("sha256").update(JSON.stringify(renderDigest(d, Number.MAX_SAFE_INTEGER))).digest("hex");
}
