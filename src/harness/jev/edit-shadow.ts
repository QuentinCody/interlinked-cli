// Jev edit shadow — experiment E7 (scratch/CAMPAIGN-decisions-orthogonal.md).
//
// One fixed Noul question per PostToolUse Write/Edit/MultiEdit/apply_patch on an
// in-scope code file (`jev.shadow_scope`: `cappable` default, or `code`, which
// includes scratch/): "does this edit warrant verification before the next
// edit?". An apply_patch is asked about its FIRST in-scope file only. The
// answer is LOGGED, never shown: this module returns nothing to the hook
// response, cannot block, and cannot change a decision. Its only output is one
// row per call in `.interlinked/decision-shadow.jsonl`, joined offline against
// what the agent actually did next (tool_use_id / seq / session_id). The ledger
// is shared with decision-shadow.ts, so rows carry `surface: "edit"` and the
// same `session_id` key as the `guard_block` / `secret_hit` rows.
//
// Gates, in order: `event.dry_run` (no network, no row), `jev.enabled &&
// jev.shadow_edits` (both default OFF), a successful PostToolUse of a write
// tool, an in-scope file (default `isCappableFile`: no tests / generated / scratch), a
// resolvable TYPESAFE_API_KEY, one call per tool_use_id (hook deliveries can
// repeat). The per-daemon spend cap stops calls and writes ONE `spend_cap` row.
// Every failure is a row with `p: null` and an error class; nothing throws.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { extractApplyPatchRaw, parseApplyPatchSections } from "../apply-patch-content.js";
import { isCappableFile } from "../large-file-policy.js";
import { resolveApiKey } from "../policy-classifier.js";
import { readToolString } from "../evaluator/tool-input-values.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { JEV_API_KEY_ENV, JEV_USD_PER_INPUT_TOKEN, JevClient, type JevFetch } from "./client.js";
import type { JevConfig, JevNoulQuestion } from "./types.js";

export const EDIT_SHADOW_QUESTION_ID = "edit_needs_verification_v1";
export const EDIT_SHADOW_LEDGER = "decision-shadow.jsonl";
export const EDIT_SHADOW_DEFAULT_MAX_SPEND_USD = 0.5;
export const EDIT_SHADOW_DEFAULT_TIMEOUT_MS = 1_500;
/** Characters of the edit text (new_string / content) sent as state. */
export const EDIT_SHADOW_SUMMARY_CHARS = 4_000;
/** Characters of the replaced text (Edit old_string) sent as `before_excerpt`. */
export const EDIT_SHADOW_BEFORE_CHARS = 2_000;
/** Bound on the remembered tool_use_ids used for once-per-call de-duplication. */
const SEEN_IDS_CAP = 4_096;

/** The fixed question. Cited verbatim by the experiment; change the id if the text changes. */
export const EDIT_SHADOW_QUESTION: JevNoulQuestion = {
	type: "noul",
	instructions:
		"An AI coding agent just made this edit to a TypeScript source file in a repository with a test suite. Before the agent makes its NEXT edit, does this edit warrant running the project's tests or type-checker first (as opposed to safely continuing to edit)?",
	criteria: {
		true: "The edit changes behavior, types, or control flow in a way that could break existing tests or compilation, so verification should run before further edits.",
		false: "The edit is cosmetic, comment/doc-only, a rename with no semantic effect, or otherwise safe to continue without verification.",
	},
};

const SHADOW_TOOLS = new Set(["Write", "Edit", "MultiEdit", "apply_patch"]);

/** Discriminator shared with the decision-shadow rows in the same ledger. */
export const EDIT_SHADOW_SURFACE = "edit";

export interface EditShadowRow {
	ts: string;
	session_id: string;
	surface: typeof EDIT_SHADOW_SURFACE;
	agent: string | null;
	subagent_id: string | null;
	tool_use_id: string | null;
	seq: number | null;
	tool: string;
	file: string;
	p: number | null;
	latency_ms: number | null;
	input_tokens: number | null;
	usd: number | null;
	model: string | null;
	error: string | null;
	question_id: typeof EDIT_SHADOW_QUESTION_ID;
}

export interface EditShadowDeps {
	/** Injected in tests; global fetch otherwise. */
	fetchImpl?: JevFetch;
	/** Injected in tests; `resolveApiKey(TYPESAFE_API_KEY)` otherwise. */
	resolveKey?: () => string | undefined;
}

interface ShadowState {
	usd: number;
	capRowWritten: boolean;
	seen: Set<string>;
	ledgerErrors: number;
	lastLedgerError: string | null;
}

let state: ShadowState = freshState();

function freshState(): ShadowState {
	return { usd: 0, capRowWritten: false, seen: new Set(), ledgerErrors: 0, lastLedgerError: null };
}

/** Test seam: the spend ledger and de-dup set are per daemon process. */
export function resetEditShadowState(): void {
	state = freshState();
}

/** Spend so far in this process (USD). */
export function editShadowSpendUsd(): number {
	return state.usd;
}

interface ShadowTarget {
	cwd: string;
	file: string;
	tool: string;
	summary: string;
	before: string | null;
}

function shadowConfig(rules: GuardRulesConfig): JevConfig | null {
	const jev = rules.jev;
	return jev?.enabled === true && jev.shadow_edits === true ? jev : null;
}

function editText(tool: string, input: Record<string, unknown>): { summary: string; before: string | null } {
	if (tool === "Write") return { summary: readToolString(input.content), before: null };
	if (tool === "Edit") {
		const old = readToolString(input.old_string);
		return { summary: readToolString(input.new_string), before: old === "" ? null : old.slice(0, EDIT_SHADOW_BEFORE_CHARS) };
	}
	const edits = Array.isArray(input.edits) ? input.edits : [];
	const parts = edits.map((e: unknown) => (typeof e === "object" && e !== null && "new_string" in e ? readToolString(e.new_string) : ""));
	return { summary: parts.join("\n…\n"), before: null };
}

const CODE_SCOPE_EXT_RE = /\.(?:ts|mts|tsx|js|mjs|py)$/;
const CODE_SCOPE_EXCLUDED_RE = /(?:^|\/)(?:node_modules|dist|generated)\/|\.(?:test|spec)\.|(?:^|\/)__tests__\/|\.d\.ts$/;

/** `code` scope: a source extension under the repo root, not a test, declaration
 *  or generated/dist/node_modules path. Path-only; the file need not be read. */
export function isCodeScopeFile(abs: string, cwd: string): boolean {
	const rel = relative(cwd, abs).replace(/\\/g, "/");
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
	return CODE_SCOPE_EXT_RE.test(rel) && !CODE_SCOPE_EXCLUDED_RE.test(rel);
}

function inScope(abs: string, cwd: string, scope: JevConfig["shadow_scope"]): boolean {
	if (scope === "code") return isCodeScopeFile(abs, cwd);
	try {
		return isCappableFile({ filePath: abs, content: readFileSync(abs, "utf-8"), root: cwd });
	} catch {
		return false; // unreadable after the edit: out of scope
	}
}

/** Candidate (path, summary, before) triples for one tool call, in source order. */
function editCandidates(tool: string, input: Record<string, unknown>): { path: string; summary: string; before: string | null }[] {
	if (tool === "apply_patch") {
		const raw = extractApplyPatchRaw(input);
		return parseApplyPatchSections(raw)
			.filter((s) => s.op !== "delete")
			.map((s) => ({ path: s.path, summary: s.body.join("\n"), before: null }));
	}
	const path = readToolString(input.file_path);
	return path ? [{ path, ...editText(tool, input) }] : [];
}

/** Selection: the FIRST in-scope file of the tool call, or null when none is in scope. */
export function selectShadowTarget(event: HarnessEvent, scope: JevConfig["shadow_scope"] = "cappable"): ShadowTarget | null {
	const tool = event.tool_name ?? "";
	if (event.hook_event !== "PostToolUse" || !SHADOW_TOOLS.has(tool)) return null;
	if (event.tool_outcome === "error" || event.tool_outcome === "interrupted") return null;
	const cwd = event.cwd || process.cwd();
	for (const c of editCandidates(tool, event.tool_input ?? {})) {
		const abs = isAbsolute(c.path) ? c.path : resolve(cwd, c.path);
		if (!inScope(abs, cwd, scope)) continue;
		return { cwd, file: relative(cwd, abs), tool, summary: c.summary.slice(0, EDIT_SHADOW_SUMMARY_CHARS), before: c.before };
	}
	return null;
}

function baseRow(event: HarnessEvent, target: ShadowTarget): EditShadowRow {
	return {
		ts: new Date().toISOString(),
		session_id: event.session_id,
		surface: EDIT_SHADOW_SURFACE,
		agent: event.agent_name ?? null,
		subagent_id: event.subagent_id ?? null,
		tool_use_id: event.tool_use_id ?? null,
		seq: event.seq ?? null,
		tool: target.tool,
		file: target.file,
		p: null,
		latency_ms: null,
		input_tokens: null,
		usd: null,
		model: null,
		error: null,
		question_id: EDIT_SHADOW_QUESTION_ID,
	};
}

/** Append one row under `<cwd>/.interlinked/`. No-op when that directory is
 *  absent (not a managed project); filesystem errors are swallowed. */
function appendRow(cwd: string, row: EditShadowRow): void {
	const dir = join(cwd, ".interlinked");
	try {
		if (!existsSync(dir)) return;
		appendFileSync(join(dir, EDIT_SHADOW_LEDGER), `${JSON.stringify(row)}\n`);
	} catch (err) {
		// A ledger gap beats a daemon crash; count it so the gap is not silent.
		state.ledgerErrors++;
		state.lastLedgerError = err instanceof Error ? err.message : String(err);
	}
}

/** Claim this tool call; false when it was already shadowed (repeat delivery). */
function claimToolCall(event: HarnessEvent): boolean {
	const id = event.tool_use_id;
	if (!id) return true;
	if (state.seen.has(id)) return false;
	if (state.seen.size >= SEEN_IDS_CAP) state.seen.clear();
	state.seen.add(id);
	return true;
}

/**
 * Run the shadow for one PostToolUse event. Resolves to the row written, or
 * null when nothing was in scope. Never rejects. The hook path calls this
 * without awaiting; tests await it.
 */
export async function runEditShadow(event: HarnessEvent, rules: GuardRulesConfig, deps: EditShadowDeps = {}): Promise<EditShadowRow | null> {
	try {
		if (event.dry_run === true) return null;
		const config = shadowConfig(rules);
		if (!config) return null;
		const target = selectShadowTarget(event, config.shadow_scope);
		if (!target) return null;
		const apiKey = (deps.resolveKey ?? (() => resolveApiKey(JEV_API_KEY_ENV)))();
		if (!apiKey) return null;
		if (!claimToolCall(event)) return null;
		return await askAndRecord(event, target, config, apiKey, deps);
	} catch {
		return null;
	}
}

async function askAndRecord(event: HarnessEvent, target: ShadowTarget, config: JevConfig, apiKey: string, deps: EditShadowDeps): Promise<EditShadowRow | null> {
	const row = baseRow(event, target);
	if (state.usd >= (config.shadow_max_spend_usd ?? EDIT_SHADOW_DEFAULT_MAX_SPEND_USD)) {
		if (state.capRowWritten) return null;
		state.capRowWritten = true;
		row.error = "spend_cap";
		appendRow(target.cwd, row);
		return row;
	}
	const client = new JevClient({
		apiKey,
		config: { ...config, timeout_ms: config.shadow_timeout_ms ?? EDIT_SHADOW_DEFAULT_TIMEOUT_MS },
		...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
	});
	const stateEntry = { file: target.file, tool: target.tool, edit_summary: target.summary, ...(target.before !== null ? { before_excerpt: target.before } : {}) };
	const started = performance.now();
	const result = await client.askDetailed(stateEntry, { [EDIT_SHADOW_QUESTION_ID]: EDIT_SHADOW_QUESTION });
	row.latency_ms = Math.round(performance.now() - started);
	if (!result.ok) {
		row.error = result.error;
	} else {
		const answer = result.response.answers[EDIT_SHADOW_QUESTION_ID];
		const usd = result.response.usage.input_tokens * JEV_USD_PER_INPUT_TOKEN;
		state.usd += usd;
		row.model = result.response.model;
		row.input_tokens = result.response.usage.input_tokens;
		row.usd = usd;
		if (answer?.type === "noul") row.p = answer.noul;
		else row.error = "missing_answer";
	}
	appendRow(target.cwd, row);
	return row;
}

/** Hook-path entry: return immediately; the file read and the request run on a
 *  later tick so the hook response never waits on them. Nothing awaits it. */
export function scheduleEditShadow(event: HarnessEvent, rules: GuardRulesConfig): void {
	if (event.dry_run === true || !shadowConfig(rules)) return;
	setImmediate(() => {
		void runEditShadow(event, rules);
	});
}
