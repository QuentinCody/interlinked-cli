// ===========================================
// Per-function cyclomatic complexity (Python) via radon
// ===========================================
// The Python counterpart to `cyclomatic-ast.ts`. The TS path parses with the
// `typescript` compiler API; there is no equivalent in-process Python parser in
// a Node harness, so we shell to `radon cc --json -s` — radon is the canonical,
// well-tested Python cyclomatic tool (its decision set matches the canonical
// definition: if/elif/for/while/except/with/assert/and/or/comprehension-ifs/
// ternary). One entry is emitted per function, method, and nested closure;
// the per-class aggregate block radon also reports is deliberately dropped (its
// `complexity` is the sum of its methods and would double-count).
//
// Availability mirrors `astComplexityAvailable()`: when `radon` is not on PATH
// (spawn ENOENT) or exits nonzero, `computeCyclomaticPython` returns `null` —
// the SAME loud "unavailable, do not treat as simple" signal `computeCyclomaticAst`
// uses when `typescript` is absent. Callers MUST surface that (a degrade warning)
// rather than read `null` as "no functions / file is simple". We never silently
// return `[]` for an unanalyzable file.
//
// radon needs a real `.py` file to parse (it opens paths, not stdin for cc), so
// the proposed content is written to a uniquely-named temp file, analyzed, then
// removed. The spawn function is INJECTABLE so the test suite exercises every
// path (clean parse / parse-error / ENOENT / nonzero) without radon installed.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import type { FunctionComplexityEntry } from "./cyclomatic.js";

/** The slice of a spawn result this module reads. The real `spawnSync` return
 *  is structurally assignable to it. */
export type PythonSpawnResult = Pick<
	SpawnSyncReturns<string>,
	"status" | "stdout" | "stderr" | "error"
>;

/**
 * The narrowed `spawnSync` contract this module relies on, so a test can supply
 * a fake without constructing a full `SpawnSyncReturns`. The real `spawnSync` is
 * structurally assignable to this.
 */
export type PythonSpawnFn = (
	command: string,
	args: readonly string[],
	options: { encoding: "utf-8"; timeout: number },
) => PythonSpawnResult;

const RADON_TIMEOUT_MS = 5000;

/** The real spawn, adapting `spawnSync`'s overloaded signature to `PythonSpawnFn`. */
const defaultSpawn: PythonSpawnFn = (command, args, options) =>
	spawnSync(command, [...args], options);

/**
 * Probe whether `radon` is invokable. Mirrors `astComplexityAvailable()` for the
 * TS path so a daemon/status surface can report the Python cyclomatic gate as
 * degraded the same way. ENOENT (not installed) or a nonzero `--version` → false.
 */
export function radonAvailable(spawn: PythonSpawnFn = defaultSpawn): boolean {
	try {
		const r = spawn("radon", ["--version"], { encoding: "utf-8", timeout: RADON_TIMEOUT_MS });
		return r.error === undefined && (r.status === 0 || r.status === null);
	} catch {
		return false;
	}
}

/** A single radon CC block. `methods`/`closures` nest function-like blocks. */
interface RadonBlock {
	type: "function" | "method" | "class";
	name: string;
	complexity: number;
	lineno: number;
	endline: number;
	methods?: RadonBlock[];
	closures?: RadonBlock[];
}

function asFiniteNumber(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isBlock(b: RadonBlock | null): b is RadonBlock {
	return b !== null;
}

/** Narrow one untrusted JSON node into a RadonBlock, or null if malformed. */
function toRadonBlock(raw: unknown): RadonBlock | null {
	if (!isJsonObject(raw)) return null;
	const o = raw;
	const type = o.type;
	if (type !== "function" && type !== "method" && type !== "class") return null;
	const name = typeof o.name === "string" ? o.name : null;
	const complexity = asFiniteNumber(o.complexity);
	const lineno = asFiniteNumber(o.lineno);
	const endline = asFiniteNumber(o.endline);
	if (name === null || complexity === null || lineno === null || endline === null) return null;
	const block: RadonBlock = { type, name, complexity, lineno, endline };
	if (Array.isArray(o.methods)) block.methods = o.methods.map(toRadonBlock).filter(isBlock);
	if (Array.isArray(o.closures)) block.closures = o.closures.map(toRadonBlock).filter(isBlock);
	return block;
}

/**
 * Flatten radon's nested blocks into one `FunctionComplexityEntry` per
 * function/method/closure. The `class` block itself is skipped — its complexity
 * is the aggregate of its methods (which we emit individually), so emitting it
 * too would double-count. We still descend into a class's `methods`.
 */
function flattenBlocks(blocks: RadonBlock[], out: FunctionComplexityEntry[]): void {
	for (const b of blocks) {
		if (b.type === "function" || b.type === "method") {
			out.push({
				name: b.name,
				line: b.lineno,
				endLine: b.endline,
				cyclomatic: b.complexity,
				language: "python",
			});
		}
		if (b.methods) flattenBlocks(b.methods, out);
		if (b.closures) flattenBlocks(b.closures, out);
	}
}

/**
 * Parse radon's `cc --json` stdout into entries. radon keys the result by file
 * path; a file that failed to parse maps to `{ "error": "..." }` instead of an
 * array. Returns `null` when the payload is unusable (not JSON, or the only file
 * entry is a parse error) so the caller fails open rather than treating a
 * syntactically-broken file as "no functions". An empty-but-valid result (a file
 * with zero functions) returns `[]`.
 */
export function parseRadonJson(stdout: string): FunctionComplexityEntry[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!isJsonObject(parsed)) return null;
	const fileEntries = Object.values(parsed);
	if (fileEntries.length === 0) return [];

	const out: FunctionComplexityEntry[] = [];
	let sawArray = false;
	for (const fileResult of fileEntries) {
		if (Array.isArray(fileResult)) {
			sawArray = true;
			flattenBlocks(fileResult.map(toRadonBlock).filter(isBlock), out);
		}
		// A `{ error: ... }` map (parse failure) contributes nothing; if it's the
		// ONLY entry, sawArray stays false and we treat the run as a failure below.
	}
	if (!sawArray) return null; // every file errored → fail open, do not say "simple"
	out.sort((a, b) => a.line - b.line);
	return out;
}

/**
 * Per-function cyclomatic complexity for a `.py` file, computed by `radon`.
 *
 * Return contract MATCHES `computeCyclomaticAst`:
 *   - `FunctionComplexityEntry[]` on success (possibly empty for a function-free
 *     file),
 *   - `null` when the analyzer is UNAVAILABLE or FAILS (radon not on PATH /
 *     spawn error / nonzero exit / unparseable output / file failed to parse).
 *     `null` is the loud "do not treat as simple" degrade signal — callers must
 *     surface it, never coerce it to `[]`.
 *
 * `filePath` is used only to give the temp file a recognizable basename; the
 * content is what radon analyzes. `spawn` is injectable for tests.
 */
export function computeCyclomaticPython(
	content: string,
	filePath: string,
	spawn: PythonSpawnFn = defaultSpawn,
): FunctionComplexityEntry[] | null {
	let dir: string | null = null;
	try {
		dir = mkdtempSync(join(tmpdir(), "interlinked-radon-"));
		const sanitized = basename(filePath).replace(/[^\w.-]/g, "_");
		const safeBase = sanitized.length > 0 ? sanitized : "edit.py";
		const tmpFile = join(dir, safeBase.endsWith(".py") ? safeBase : `${safeBase}.py`);
		writeFileSync(tmpFile, content, "utf-8");

		let result: PythonSpawnResult;
		try {
			result = spawn("radon", ["cc", "--json", "-s", tmpFile], {
				encoding: "utf-8",
				timeout: RADON_TIMEOUT_MS,
			});
		} catch {
			return null; // spawn threw (e.g. ENOENT surfaced as throw) → unavailable
		}
		// ENOENT / spawn failure surfaces as `error`; a radon crash as nonzero status.
		if (result.error !== undefined) return null;
		if (result.status !== 0 && result.status !== null) return null;
		if (typeof result.stdout !== "string" || result.stdout.trim() === "") return null;
		return parseRadonJson(result.stdout);
	} catch {
		// mkdtemp/writeFile failure (e.g. no temp dir) → fail open, surface degrade.
		return null;
	} finally {
		if (dir !== null) rmSync(dir, { recursive: true, force: true });
	}
}
