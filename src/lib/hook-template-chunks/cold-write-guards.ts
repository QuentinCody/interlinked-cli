// Single source of truth for the cold-fallback FILE-WRITE gates.
//
// Two consumers, one implementation:
//   1. `src/hook-entry-cold-gates.ts` imports these functions directly and runs
//      them in the cold-fallback path (harness daemon unreachable).
//   2. The generated `.interlinked/hooks/interlinked-activity.mjs` cannot
//      `import` anything — it must run standalone. `guards-inline.ts` embeds
//      `COLD_WRITE_GUARDS_SOURCE` (the joined `Function.toString()` of every
//      function below) verbatim into the .mjs template string, as a run of
//      plain function declarations.
//
// Before this module existed, each gate was written twice — once as TS here-ish
// and once as JS inside the .mjs template string — with hand-kept parity, and
// the two copies had already drifted (different tool-name sets, different block
// text, different path resolution). One shared function makes the two hook
// paths write-gate-identical by construction.
//
// IMPORTANT: every function below MUST stay a free-standing, self-contained
// `function` declaration — no module-scope constants, no imports referenced
// from inside a serialized body. `Function.prototype.toString()` serializes
// only that function's own text. Filesystem access therefore arrives as an
// injected `ColdWriteDeps` argument rather than as a free `existsSync`
// identifier: the .mjs and the tsup bundle name those imports differently, so a
// free reference would be a latent break. The `new Function` round-trip test in
// `__tests__/cold-write-guards.test.ts` pins the invariant.

/** Block verdict shared by both hook paths. `reason` is shown to the agent. */
export interface ColdWriteVerdict {
	decision: "block";
	reason: string;
	rule_id: string;
	severity: string;
	category: string;
}

/** Filesystem/path functions injected by the caller. The .mjs has them from its
 *  own top-level `node:fs` / `node:path` import; this module's TS consumers pass
 *  the real ones. Any member may be null when the host could not supply it — the
 *  guards then degrade to "cannot evaluate", never to a crash. */
export interface ColdWriteDeps {
	existsSync: ((p: string) => boolean) | null;
	statSync: ((p: string) => { mtimeMs: number }) | null;
	join: ((...parts: string[]) => string) | null;
}

/** Tool-input shape the write gates read. Every key is optional — the same
 *  object arrives from four runners with different conventions. */
export interface ColdWriteToolInput {
	file_path?: unknown;
	filePath?: unknown;
	path?: unknown;
	target_file?: unknown;
	content?: unknown;
	new_string?: unknown;
	new_source?: unknown;
	edits?: unknown;
	command?: unknown;
	patch?: unknown;
	_raw_patch?: unknown;
}

/** True for every tool name that writes file content, in both the normalized
 *  snake_case form (`normalizeToolName` in the Claude Code adapter) and the raw
 *  PascalCase form other adapters forward. The list is inline, not a module
 *  constant, because this body is serialized on its own. */
function cwgIsWriteTool(toolName: string): boolean {
	if (!toolName) return false;
	const tools = [
		"write",
		"edit",
		"multi_edit",
		"notebook_edit",
		"write_file",
		"edit_file",
		"file_write",
		"file_edit",
		"create",
		"str_replace",
		"apply_patch",
		"Write",
		"Edit",
		"MultiEdit",
		"NotebookEdit",
		"WriteFile",
		"EditFile",
		"FileWrite",
		"FileEdit",
	];
	return tools.indexOf(toolName) !== -1;
}

/** Read the plain file-path-shaped keys off a tool_input, in a fixed order.
 *  `toolInput` is nullable/undefined-able here because the serialized-JS
 *  runtime path (`guards-inline.ts`'s `inlineGuardCheck`) feeds this from
 *  `JSON.parse`d hook payloads, where `tool_input` is not guaranteed present —
 *  the TS-side callers happen to always coalesce first, but that's a property
 *  of those callers, not of this function's real input. */
function cwgDirectPaths(toolInput: ColdWriteToolInput | null | undefined): string[] {
	const paths: string[] = [];
	if (!toolInput) return paths;
	const keys = ["file_path", "filePath", "path", "target_file"];
	// SAFETY: every key read here is declared optional-unknown on
	// ColdWriteToolInput; the index widening only drops the key-name literal
	// union, and the value is type-narrowed by the typeof check below.
	const bag = toolInput as Record<string, unknown>;
	for (const key of keys) {
		const v = bag[key];
		if (typeof v === "string" && v.trim() !== "") paths.push(v.trim());
	}
	return paths;
}

/** Extract the file paths named in an `apply_patch` body's
 *  `*** Update/Add/Delete File:` and `*** Move to:` headers, deduped against
 *  `existing` and against each other. */
function cwgPatchPaths(toolInput: ColdWriteToolInput | null | undefined, existing: string[]): string[] {
	const body = String(
		toolInput?.command ?? toolInput?.patch ?? toolInput?.content ?? toolInput?._raw_patch ?? "",
	);
	const found: string[] = [];
	const patterns = [
		/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm,
		/^\*\*\* Move to:\s+(.+)$/gm,
	];
	for (const re of patterns) {
		let m = re.exec(body);
		while (m !== null) {
			const p = (m[1] || "").trim();
			if (p && existing.indexOf(p) === -1 && found.indexOf(p) === -1) found.push(p);
			m = re.exec(body);
		}
	}
	return found;
}

/** All target file paths a write tool call names, direct keys first. */
function cwgTargets(toolName: string, toolInput: ColdWriteToolInput | null | undefined): string[] {
	const paths = cwgDirectPaths(toolInput);
	if (toolName === "apply_patch") {
		const extra = cwgPatchPaths(toolInput, paths);
		for (const p of extra) paths.push(p);
	}
	return paths;
}

/** The text a file-write tool call would put on disk, across the Write
 *  (`content`), Edit (`new_string`), NotebookEdit (`new_source`) and MultiEdit
 *  (`edits[].new_string`) shapes. Empty string when there is none. */
function cwgWriteContent(toolInput: ColdWriteToolInput | null | undefined): string {
	if (!toolInput) return "";
	if (typeof toolInput.content === "string") return toolInput.content;
	if (typeof toolInput.new_string === "string") return toolInput.new_string;
	if (typeof toolInput.new_source === "string") return toolInput.new_source;
	if (Array.isArray(toolInput.edits)) return cwgEditsContent(toolInput.edits);
	return "";
}

/** Join the `new_string` of every MultiEdit entry that actually carries one.
 *  Non-object and non-string entries are skipped rather than stringified. */
function cwgEditsContent(edits: unknown[]): string {
	const parts: string[] = [];
	for (const e of edits) {
		if (!e || typeof e !== "object") continue;
		// SAFETY: the entry is a runtime-checked non-null object of unknown
		// shape; the index read is guarded by the typeof check on the value.
		// No backticks in any comment inside a serialized body — the source is
		// spliced into a backtick template literal.
		const ns = (e as Record<string, unknown>).new_string;
		if (typeof ns === "string") parts.push(ns);
	}
	return parts.join("\n");
}

/** Absolute form of `p` against `cwd`. Uses the injected `join` when present and
 *  falls back to plain concatenation so a missing dep degrades rather than
 *  throws. The pre-convergence .mjs reached for node:path through a CommonJS
 *  loader call, which is undefined in an ES module — so every relative path
 *  silently failed open there. */
function cwgAbsolute(p: string, cwd: string, deps: ColdWriteDeps): string {
	if (p.charAt(0) === "/") return p;
	if (deps.join) return deps.join(cwd, p);
	return cwd + "/" + p;
}

/**
 * Cold fail-closed gate: refuse a file write whose content carries
 * merge-conflict markers. A file with `<<<<<<<` / `=======` / `>>>>>>>` is a
 * guaranteed parse error; the daemon blocks it at write-content-guards check
 * A1, so both cold paths must too. Returns a block verdict, or null.
 */
export function checkMergeConflictWrite(
	toolName: string,
	toolInput: ColdWriteToolInput | null | undefined,
): ColdWriteVerdict | null {
	if (!cwgIsWriteTool(toolName)) return null;
	const content = cwgWriteContent(toolInput);
	if (!content) return null;
	if (!/^<{7}\s|^={7}$|^>{7}\s/m.test(content)) return null;
	const paths = cwgTargets(toolName, toolInput);
	const where = paths.length > 0 ? paths[0] : "the target file";
	return {
		decision: "block",
		reason:
			"[interlinked:merge-conflict] BLOCKED: merge-conflict markers " +
			"(<<<<<<<, =======, >>>>>>>) detected in the content being written to " +
			where +
			". A file with conflict markers is a guaranteed parse error — resolve " +
			"the conflict before writing.",
		rule_id: "cold-merge-conflict-markers",
		severity: "high",
		category: "command-shape",
	};
}

/** True when `abs` has a colocated shard that is not stale: the shard's mtime
 *  is within the 60s grace of the source's. Returns false (allow) whenever the
 *  probe cannot be completed — a missing file, an fs error, or a host that
 *  supplied no stat function. */
function cwgHasFreshShard(abs: string, deps: ColdWriteDeps): boolean {
	const existsSyncFn = deps.existsSync;
	const statSyncFn = deps.statSync;
	if (!existsSyncFn || !statSyncFn) return false;
	const stalenessGraceMs = 60000;
	try {
		if (!existsSyncFn(abs)) return false;
		const m = abs.match(/\.[^./]+$/);
		const ext = m ? m[0] : "";
		const shardPath = ext ? abs.slice(0, -ext.length) + ".graph" + ext : abs + ".graph";
		if (!existsSyncFn(shardPath)) return false;
		const sourceMtime = statSyncFn(abs).mtimeMs;
		const shardMtime = statSyncFn(shardPath).mtimeMs;
		return shardMtime >= sourceMtime - stalenessGraceMs;
	} catch {
		return false;
	}
}

/**
 * Cold fail-closed gate for the graph-prediction protocol. Edits to a file with
 * a fresh colocated Supermodel shard MUST go through predict/reveal/reconcile;
 * when the daemon cannot say so, allowing the write silently breaks the
 * protocol's "must" guarantee. Returns a block verdict, or null when the target
 * has no fresh shard / the tool is not a write / the override is set.
 */
export function checkGraphShardWrite(
	toolName: string,
	toolInput: ColdWriteToolInput | null | undefined,
	cwd: string,
	deps: ColdWriteDeps,
): ColdWriteVerdict | null {
	if (!cwgIsWriteTool(toolName)) return null;
	if (process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE === "1") return null;
	const targets = cwgTargets(toolName, toolInput);
	for (const t of targets) {
		const abs = cwgAbsolute(t, cwd, deps);
		if (!cwgHasFreshShard(abs, deps)) continue;
		return {
			decision: "block",
			reason:
				"[interlinked:graph-pred][harness-offline] Cannot evaluate the graph-prediction protocol because the harness daemon is unreachable (or did not respond in time), but " +
				abs +
				" has a fresh Supermodel shard colocated. Edits to E-fresh files MUST go through the predict/reveal/reconcile loop. " +
				// NO "run interlinked harness start" up front. Every blocked caller
				// followed that advice at once on 2026-08-15; the simultaneous
				// starts raced, killed the incumbent, and re-opened the gap for
				// hours. The supervisor brings exactly one daemon back.
				"Retry your edit in a few seconds — the daemon supervisor restarts the harness for you. " +
				"Do NOT start one by hand; concurrent starts race each other. Only if it is still down " +
				"after 30 seconds, run: interlinked harness start. " +
				"Override (advanced, defeats the protocol): set INTERLINKED_DISABLE_GRAPH_SHARD_INLINE=1.",
			rule_id: "graph-prediction-inline-fail-closed",
			severity: "high",
			category: "graph-prediction",
		};
	}
	return null;
}

/**
 * Source text of every function above, joined as a run of plain function
 * declarations, for embedding into the zero-import generated .mjs hook.
 * `guards-inline.ts` splices this in verbatim. Function declarations hoist, so
 * the join order does not matter.
 */
export const COLD_WRITE_GUARDS_SOURCE: string = [
	cwgIsWriteTool,
	cwgDirectPaths,
	cwgPatchPaths,
	cwgTargets,
	cwgWriteContent,
	cwgEditsContent,
	cwgAbsolute,
	cwgHasFreshShard,
	checkMergeConflictWrite,
	checkGraphShardWrite,
]
	.map((fn) => fn.toString())
	.join("\n");
