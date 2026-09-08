import { parseWire, wireLiteral, wireObject, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked multi-edit — behavioral tests (deterministic, fully mocked)
// ===========================================
//
// This sibling test exercises the surfaces the integration suite in
// `__tests__/multi-edit.test.ts` deliberately leaves to real biome/tsc and
// real disk I/O:
//
//   - `multiEditCommand` — the commander action handler: every input-mode
//     branch (stdin+manifest mutex, neither, stdin read OK/error,
//     --manifest read OK/error, JSON parse OK/error, normalize fail, run
//     success, run failure), both --json and human output, and the
//     `process.exitCode` it sets.
//   - `emit` — every JSON field-omission fork and every human-readable fork
//     (no-op success, n-file success + path loop, failure with/without
//     error_detail edit_index, failure with gate_failures).
//   - `runMultiEdit` GATE_REJECTED + WRITE_FAILED paths, plus the
//     transactional `atomicBatchWrite` rollback matrix — all reached through
//     the public `runMultiEdit` entry (atomicBatchWrite is file-private) by
//     driving a two-file batch whose second write throws.
//   - `gateProposedContentInline` failure-mapping: biome + tsc findings,
//     ruleId present vs absent (`?? "biome"` / `?? "tsc"`), and the
//     projectRoot resolution chain (opts → findProjectRoot → cwd).
//
// Everything is mocked at the module boundary so the suite is sub-second and
// deterministic — no biome, no tsc, no real files.
//
// `node:fs` is mocked (all five fns the command uses). `../harness/
// diff-overlay.js` and `../harness/quality-checks/project-root.js` are mocked
// so the gate is a pure function of test input. `../lib/formatter.js` is
// mocked to identity color helpers so output assertions are color-agnostic.

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── node:fs: replace the five fns multi-edit.ts imports; keep everything
//    else real (path helpers etc. resolve through node:path, not fs). ─────────
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
		renameSync: vi.fn(),
		unlinkSync: vi.fn(),
	};
});

// ── diff-overlay: replace the two evaluators so the gate never spawns a
//    toolchain. `isTscFindingBlocking` stays REAL (multi-edit re-exports it,
//    and runMultiEdit filters tsc findings through it) so the blocking
//    classification is genuine. ────────────────────────────────────────────────
vi.mock("../harness/diff-overlay.js", async () => {
	const actual =
		await vi.importActual<typeof import("../harness/diff-overlay.js")>("../harness/diff-overlay.js");
	return {
		...actual,
		evaluateBiomeDiffOverlay: vi.fn(),
		evaluateTscDiffOverlay: vi.fn(),
	};
});

// ── project-root: deterministic root resolution so the per-file projectRoot
//    branch is exercised without touching the real filesystem layout. ──────────
vi.mock("../harness/quality-checks/project-root.js", () => ({
	findProjectRoot: vi.fn(),
}));

// ── formatter: identity color helpers so `.toContain` assertions match the
//    literal text regardless of the runner's TTY/NO_COLOR state. ───────────────
vi.mock("../lib/formatter.js", () => ({
	c: {
		red: (s: string) => s,
		green: (s: string) => s,
		dim: (s: string) => s,
	},
}));

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { CheckResult } from "../harness/check-engine/types.js";
import type { DiffOverlayResult } from "../harness/diff-overlay.js";
import { evaluateBiomeDiffOverlay, evaluateTscDiffOverlay } from "../harness/diff-overlay.js";
import { findProjectRoot } from "../harness/quality-checks/project-root.js";
import { nonNull } from "../lib/non-null.js";
import {
	countOccurrences,
	type EditBatch,
	gateProposedContentInline,
	MULTI_EDIT_ERROR_CODES,
	type MultiEditOpts,
	multiEditCommand,
	type NormalizeResult,
	normalizeManifest,
	runMultiEdit,
} from "./multi-edit.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockBiome = vi.mocked(evaluateBiomeDiffOverlay);
const mockTsc = vi.mocked(evaluateTscDiffOverlay);
const mockFindProjectRoot = vi.mocked(findProjectRoot);

// ───────────────────────────────────────────────
// Builders + harnesses
// ───────────────────────────────────────────────

/** A DiffOverlayResult carrying the given findings (other fields are inert). */
function overlay(findings: CheckResult[]): DiffOverlayResult {
	return { newFindings: findings, elapsedMs: 1, exceededBudget: false };
}
const emptyOverlay: DiffOverlayResult = overlay([]);

/** Concatenate every console.log call into one newline-joined string. */
function loggedOut(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((call) => call.map(String).join(" "))
		.join("\n");
}

/** Concatenate every console.error call into one newline-joined string. */
function loggedErr(): string {
	return vi
		.mocked(console.error)
		.mock.calls.map((call) => call.map(String).join(" "))
		.join("\n");
}

/** Parse the first console.log line as the --json payload. */
function loggedJson(): Record<string, unknown> {
	const first = vi.mocked(console.log).mock.calls[0]?.[0];
	if (typeof first !== "string") {
		throw new Error(`Expected a JSON string on console.log, got ${typeof first}`);
	}
	return parseWire(JSON.parse(first), wireRecord(wireUnknown), "test JSON value");
}

/** Swap process.stdin for a readable yielding `content` for one call. */
async function withStdin<T>(content: string, fn: () => Promise<T>): Promise<T> {
	const original = process.stdin;
	const fake = Readable.from([Buffer.from(content, "utf-8")]);
	Object.defineProperty(process, "stdin", { value: fake, configurable: true });
	try {
		return await fn();
	} finally {
		Object.defineProperty(process, "stdin", { value: original, configurable: true });
	}
}

/** Swap process.stdin for a readable that emits an `error` event with `payload`. */
async function withStdinError<T>(payload: unknown, fn: () => Promise<T>): Promise<T> {
	const original = process.stdin;
	const fake = new Readable({
		read() {
			// Defer so the command's listeners attach before the error fires.
			process.nextTick(() => this.emit("error", payload));
		},
	});
	Object.defineProperty(process, "stdin", { value: fake, configurable: true });
	try {
		return await fn();
	} finally {
		Object.defineProperty(process, "stdin", { value: original, configurable: true });
	}
}

/** Run multiEditCommand, returning the exitCode it set (reset to 0 first). */
async function runCommand(
	path: string | undefined,
	opts: MultiEditOpts,
): Promise<number | undefined> {
	process.exitCode = 0;
	await multiEditCommand(path, opts);
	const code = process.exitCode;
	process.exitCode = 0; // don't leak a failure code into the worker.
	return code;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});

	// fs defaults: a successful read of a single-site buffer, writes/renames
	// succeed, tmp does not exist. Individual tests override.
	mockReadFileSync.mockReturnValue("const original = 1;\n");
	mockWriteFileSync.mockReturnValue(undefined);
	mockRenameSync.mockReturnValue(undefined);
	mockUnlinkSync.mockReturnValue(undefined);
	mockExistsSync.mockReturnValue(false);

	// Gate passes by default (both overlays clean).
	mockBiome.mockReturnValue(emptyOverlay);
	mockTsc.mockReturnValue(emptyOverlay);
	mockFindProjectRoot.mockReturnValue("/repo");
});

afterEach(() => {
	vi.restoreAllMocks();
});

// A valid one-edit batch matching the default mocked file content.
function simpleBatch(path = "/repo/a.ts"): EditBatch[] {
	return [{ path, edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }] }];
}

// A two-file batch (each with a distinct, single-occurrence edit). Both files
// read back the same default content, which both edits match exactly once.
function twoFileBatch(): EditBatch[] {
	return [
		{ path: "/repo/a.ts", edits: [{ old_string: "const original = 1;", new_string: "const A = 2;" }] },
		{ path: "/repo/b.ts", edits: [{ old_string: "const original = 1;", new_string: "const B = 3;" }] },
	];
}

// ───────────────────────────────────────────────
// countOccurrences — empty-needle guard
// ───────────────────────────────────────────────

describe("countOccurrences", () => {
	it("returns 0 for an empty needle (length === 0 guard)", () => {
		expect(countOccurrences("anything", "")).toBe(0);
	});
	it("counts non-overlapping occurrences", () => {
		expect(countOccurrences("a.a.a", "a")).toBe(3);
		expect(countOccurrences("a.a.a", "z")).toBe(0);
	});
});

// ───────────────────────────────────────────────
// normalizeManifest — every shape-guard + validator branch
// ───────────────────────────────────────────────
// These pure validators are reached only on the manifest's unhappy paths,
// which multiEditCommand short-circuits before the pipeline runs. Driving
// them directly keeps this file self-sufficient for coverage.

function expectFail(raw: unknown, singleFilePath?: string): string {
	const result: NormalizeResult = normalizeManifest(raw, singleFilePath);
	expect(result.ok).toBe(false);
	return (parseWire(result, wireObject({ "ok": wireLiteral(false), "message": wireString }), "test JSON value")).message;
}

function expectOk(raw: unknown, singleFilePath?: string): EditBatch[] {
	const result: NormalizeResult = normalizeManifest(raw, singleFilePath);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.message);
	return result.batches;
}

describe("normalizeManifest root + dispatch", () => {
	it("rejects a non-object root (null / string / number)", () => {
		expect(expectFail(null)).toContain("JSON object");
		expect(expectFail("a string")).toContain("JSON object");
		expect(expectFail(42)).toContain("JSON object");
	});

	it("rejects a wrong manifest version", () => {
		expect(expectFail({ version: 9, edits: [] }, "/x.ts")).toContain("version must be 1");
	});

	it("rejects a manifest with neither edits nor batches", () => {
		expect(expectFail({ version: 1 })).toMatch(/either `edits`.*or `batches`/);
	});

	it("accepts a well-formed single-file manifest with a positional path", () => {
		const batches = expectOk(
			{ version: 1, edits: [{ old_string: "a", new_string: "b" }] },
			"/repo/a.ts",
		);
		expect(batches).toEqual([
			{ path: "/repo/a.ts", edits: [{ old_string: "a", new_string: "b" }] },
		]);
	});

	it("accepts a well-formed multi-file manifest", () => {
		const batches = expectOk({
			version: 1,
			batches: [
				{ path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] },
				{ path: "b.ts", edits: [{ old_string: "p", new_string: "q" }] },
			],
		});
		expect(batches).toHaveLength(2);
		expect(nonNull(batches[1]).path).toBe("b.ts");
	});
});

describe("normalizeManifest single-file path requirement", () => {
	it("rejects a single-file manifest with no positional path", () => {
		expect(expectFail({ version: 1, edits: [{ old_string: "a", new_string: "b" }] })).toContain(
			"requires a path argument",
		);
	});
});

describe("normalizeManifest multi-file shape guards", () => {
	it("rejects a multi-file manifest combined with a positional path", () => {
		expect(
			expectFail(
				{ version: 1, batches: [{ path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] }] },
				"/repo/a.ts",
			),
		).toContain("Cannot pass a positional path");
	});

	it("rejects a batch that is not an object (shapeBatch null/non-object arm)", () => {
		expect(expectFail({ version: 1, batches: [null] })).toContain("Batch 0 must have");
		expect(expectFail({ version: 1, batches: ["not-an-object"] })).toContain("Batch 0 must have");
	});

	it("rejects a batch with a non-string path or non-array edits (shapeBatch field arm)", () => {
		expect(
			expectFail({ version: 1, batches: [{ path: 7, edits: [{ old_string: "a", new_string: "b" }] }] }),
		).toContain("Batch 0 must have");
		expect(expectFail({ version: 1, batches: [{ path: "a.ts", edits: "nope" }] })).toContain(
			"Batch 0 must have",
		);
	});

	it("surfaces the batch index + path when a batch's edits fail validation", () => {
		const msg = expectFail({
			version: 1,
			batches: [{ path: "a.ts", edits: [{ old_string: "", new_string: "b" }] }],
		});
		expect(msg).toContain("Batch 0 (a.ts)");
		expect(msg).toContain("old_string must not be empty");
	});
});

describe("validateEdits (via normalizeManifest)", () => {
	it("rejects an empty edits array", () => {
		expect(expectFail({ version: 1, edits: [] }, "/repo/a.ts")).toContain(
			"At least one edit is required",
		);
	});

	it("rejects an edit missing old_string/new_string (or a null edit)", () => {
		expect(
			expectFail({ version: 1, edits: [{ new_string: "b" }] }, "/repo/a.ts"),
		).toContain("Edit 0 must have");
		expect(expectFail({ version: 1, edits: [null] }, "/repo/a.ts")).toContain("Edit 0 must have");
	});

	it("rejects an edit whose old_string is empty", () => {
		expect(
			expectFail({ version: 1, edits: [{ old_string: "", new_string: "b" }] }, "/repo/a.ts"),
		).toContain("old_string must not be empty");
	});

	it("rejects a no-op edit where old_string === new_string", () => {
		expect(
			expectFail({ version: 1, edits: [{ old_string: "same", new_string: "same" }] }, "/repo/a.ts"),
		).toContain("identical");
	});
});

// ───────────────────────────────────────────────
// gateProposedContentInline — finding mapping + projectRoot chain
// ───────────────────────────────────────────────

describe("gateProposedContentInline (mocked overlays)", () => {
	it("returns empty when both overlays are clean", () => {
		const failures = gateProposedContentInline([{ path: "/repo/a.ts", content: "x" }]);
		expect(failures).toEqual([]);
	});

	it("maps biome findings, preserving ruleId, and tsc blocking findings", () => {
		mockBiome.mockReturnValue(
			overlay([
				{
					tool: "biome",
					severity: "error",
					file: "a.ts",
					line: 12,
					message: "Use === instead of ==.",
					ruleId: "lint/suspicious/noDoubleEquals",
				},
			]),
		);
		mockTsc.mockReturnValue(
			overlay([
				{
					tool: "tsc",
					severity: "error",
					file: "a.ts",
					line: 4,
					message: "Type 'string' is not assignable to type 'number'.",
					ruleId: "TS2322",
				},
			]),
		);

		const failures = gateProposedContentInline([{ path: "/repo/a.ts", content: "x" }]);
		expect(failures).toHaveLength(2);
		const biome = failures.find((f) => f.tool === "biome");
		const tsc = failures.find((f) => f.tool === "tsc");
		expect(biome?.code).toBe("lint/suspicious/noDoubleEquals");
		expect(biome?.line).toBe(12);
		expect(tsc?.code).toBe("TS2322");
		expect(tsc?.message).toContain("not assignable");
	});

	it("falls back to the literal tool name when a biome finding has no ruleId (`?? \"biome\"`)", () => {
		mockBiome.mockReturnValue(
			overlay([{ tool: "biome", severity: "error", file: "a.ts", line: 1, message: "b" }]),
		);
		const failures = gateProposedContentInline([{ path: "/repo/a.ts", content: "x" }]);
		const biome = failures.find((f) => f.tool === "biome");
		expect(biome?.code).toBe("biome");
	});

	it("falls back to the literal tool name when a blocking tsc finding has no ruleId (`?? \"tsc\"`)", () => {
		// `isTscFindingBlocking` is the REAL classifier. A tsc error with NO
		// ruleId is blocking (only the known warn-only codes are exempt), so it
		// survives the filter and exercises the `f.ruleId ?? "tsc"` arm.
		mockTsc.mockReturnValue(
			overlay([{ tool: "tsc", severity: "error", file: "a.ts", line: 2, message: "boom" }]),
		);
		const failures = gateProposedContentInline([{ path: "/repo/a.ts", content: "x" }]);
		expect(failures).toHaveLength(1);
		expect(nonNull(failures[0]).tool).toBe("tsc");
		expect(nonNull(failures[0]).code).toBe("tsc");
	});

	it("drops non-blocking tsc findings (TS6133 unused) via the real classifier", () => {
		mockTsc.mockReturnValue(
			overlay([
				{
					tool: "tsc",
					severity: "error",
					file: "a.ts",
					line: 9,
					message: "'x' is declared but never used.",
					ruleId: "TS6133",
				},
			]),
		);
		const failures = gateProposedContentInline([{ path: "/repo/a.ts", content: "x" }]);
		expect(failures).toEqual([]);
	});

	it("uses opts.projectRoot when provided (findProjectRoot not consulted)", () => {
		gateProposedContentInline([{ path: "/repo/a.ts", content: "x" }], { projectRoot: "/explicit" });
		expect(mockFindProjectRoot).not.toHaveBeenCalled();
		expect(mockBiome).toHaveBeenCalledWith("/repo/a.ts", "x", "/explicit");
	});

	it("falls back to findProjectRoot when no opts.projectRoot", () => {
		mockFindProjectRoot.mockReturnValue("/derived");
		gateProposedContentInline([{ path: "/repo/a.ts", content: "x" }]);
		expect(mockBiome).toHaveBeenCalledWith("/repo/a.ts", "x", "/derived");
	});

	it("falls back to process.cwd() when findProjectRoot returns null", () => {
		mockFindProjectRoot.mockReturnValue(null);
		gateProposedContentInline([{ path: "/repo/a.ts", content: "x" }]);
		expect(mockBiome).toHaveBeenCalledWith("/repo/a.ts", "x", process.cwd());
	});
});

// ───────────────────────────────────────────────
// runMultiEdit — success / GATE_REJECTED / WRITE_FAILED (mocked)
// ───────────────────────────────────────────────

describe("runMultiEdit (mocked gate + fs)", () => {
	it("writes atomically and returns the changed paths on success", () => {
		const result = runMultiEdit(simpleBatch("/repo/a.ts"));
		expect(result.ok).toBe(true);
		expect(result.file_changes_applied).toEqual(["/repo/a.ts"]);
		// temp + rename, no rollback.
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			"/repo/a.ts.interlinked-multi-edit.tmp",
			"const x = 2;\n",
			"utf-8",
		);
		expect(mockRenameSync).toHaveBeenCalledWith(
			"/repo/a.ts.interlinked-multi-edit.tmp",
			"/repo/a.ts",
		);
	});

	it("forwards opts.projectRoot to the gate", () => {
		runMultiEdit(simpleBatch("/repo/a.ts"), { projectRoot: "/forwarded" });
		expect(mockBiome).toHaveBeenCalledWith("/repo/a.ts", "const x = 2;\n", "/forwarded");
	});

	it("returns GATE_REJECTED with the mapped failures when the overlay flags the final content", () => {
		mockBiome.mockReturnValue(
			overlay([
				{
					tool: "biome",
					severity: "error",
					file: "a.ts",
					line: 1,
					message: "bad",
					ruleId: "lint/x",
				},
			]),
		);
		const result = runMultiEdit(simpleBatch("/repo/a.ts"));
		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.GATE_REJECTED);
		expect(result.gate_failures).toHaveLength(1);
		expect(nonNull(result.gate_failures?.[0]).code).toBe("lint/x");
		// Gate rejected before any write.
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it("returns WRITE_FAILED when the single-file atomic write throws (Error message arm)", () => {
		mockRenameSync.mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});
		const result = runMultiEdit(simpleBatch("/repo/a.ts"));
		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.WRITE_FAILED);
		expect(result.error_detail?.path).toBe("/repo/a.ts");
		expect(result.error_detail?.message).toContain("EACCES");
	});

	it("resolves a relative batch path against process.cwd() before reading", () => {
		runMultiEdit([
			{ path: "rel/a.ts", edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }] },
		]);
		const calledWith = mockReadFileSync.mock.calls[0]?.[0];
		expect(String(calledWith).startsWith("/")).toBe(true);
		expect(String(calledWith)).toContain("rel/a.ts");
	});

	it("returns READ_FAILED stringifying a non-Error read rejection (String(err) arm)", () => {
		mockReadFileSync.mockImplementation(() => {
			throw "read failed as a bare string";
		});
		const result = runMultiEdit(simpleBatch("/repo/a.ts"));
		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.READ_FAILED);
		expect(result.error_detail?.message).toBe("read failed as a bare string");
	});

	it("returns AMBIGUOUS_OLD_STRING (with the AFTER-prior-edits wording) when a needle is non-unique", () => {
		mockReadFileSync.mockReturnValue("dup dup\n");
		const result = runMultiEdit([
			{ path: "/repo/a.ts", edits: [{ old_string: "dup", new_string: "x" }] },
		]);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.AMBIGUOUS_OLD_STRING);
		expect(result.error_detail?.match_count).toBe(2);
		expect(result.error_detail?.message).toContain("ambiguity evaluated AFTER prior edits");
	});

	it("skips the gate and the write when every edit composes to a no-op", () => {
		mockReadFileSync.mockReturnValue('const v = "alpha";\n');
		const result = runMultiEdit([
			{
				path: "/repo/a.ts",
				edits: [
					{ old_string: '"alpha"', new_string: '"gamma"' },
					{ old_string: '"gamma"', new_string: '"alpha"' },
				],
			},
		]);
		expect(result.ok).toBe(true);
		expect(result.file_changes_applied).toEqual([]);
		expect(mockBiome).not.toHaveBeenCalled();
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});
});

// ───────────────────────────────────────────────
// atomicBatchWrite rollback — reached through runMultiEdit's two-file path
// ───────────────────────────────────────────────
// atomicBatchWrite is file-private, so the rollback matrix is driven through
// the public runMultiEdit entry: a two-file batch whose SECOND rename throws
// forces the first file to roll back. Each test isolates one catch arm.

describe("atomicBatchWrite rollback (via runMultiEdit two-file batch)", () => {
	it("rolls back the already-written first file and cleans the failed tmp", () => {
		let renameCalls = 0;
		mockRenameSync.mockImplementation(() => {
			renameCalls += 1;
			if (renameCalls === 2) throw new Error("disk full");
		});
		mockExistsSync.mockReturnValue(true); // tmp exists → unlinkSync runs.

		const result = runMultiEdit(twoFileBatch());
		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.WRITE_FAILED);
		expect(result.error_detail?.path).toBe("/repo/b.ts");
		expect(result.error_detail?.message).toContain("disk full");

		// Cleaned the failed file's tmp.
		expect(mockUnlinkSync).toHaveBeenCalledWith("/repo/b.ts.interlinked-multi-edit.tmp");
		// Rolled the first file back to its prior on-disk content.
		expect(mockWriteFileSync).toHaveBeenCalledWith("/repo/a.ts", "const original = 1;\n", "utf-8");
	});

	it("stringifies a non-Error write rejection (String(err) arm)", () => {
		mockRenameSync.mockImplementation(() => {
			throw "plain string failure";
		});
		const result = runMultiEdit(simpleBatch("/repo/a.ts"));
		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.WRITE_FAILED);
		expect(result.error_detail?.message).toBe("plain string failure");
	});

	it("logs a warning when the failed tmp cleanup itself throws (Error arm)", () => {
		mockRenameSync.mockImplementation(() => {
			throw new Error("rename boom");
		});
		mockExistsSync.mockReturnValue(true);
		mockUnlinkSync.mockImplementation(() => {
			throw new Error("unlink boom");
		});
		const result = runMultiEdit(simpleBatch("/repo/a.ts"));
		expect(result.ok).toBe(false);
		expect(loggedErr()).toContain("failed to clean up");
		expect(loggedErr()).toContain("unlink boom");
	});

	it("stringifies a non-Error tmp-cleanup rejection (String(cleanupErr) arm)", () => {
		mockRenameSync.mockImplementation(() => {
			throw new Error("rename boom");
		});
		mockExistsSync.mockReturnValue(true);
		mockUnlinkSync.mockImplementation(() => {
			throw "cleanup-as-string";
		});
		const result = runMultiEdit(simpleBatch("/repo/a.ts"));
		expect(result.ok).toBe(false);
		expect(loggedErr()).toContain("cleanup-as-string");
	});

	it("logs CRITICAL when rolling the first file back also throws (Error arm)", () => {
		let renameCalls = 0;
		mockRenameSync.mockImplementation(() => {
			renameCalls += 1;
			if (renameCalls === 2) throw new Error("second write failed");
		});
		mockWriteFileSync.mockImplementation((p) => {
			// Temp writes (path ends .tmp) succeed; the rollback restore writes
			// the real .ts path directly → throw to hit the CRITICAL arm.
			if (String(p).endsWith(".ts")) throw new Error("rollback failed");
			return undefined;
		});
		const result = runMultiEdit(twoFileBatch());
		expect(result.ok).toBe(false);
		expect(loggedErr()).toContain("CRITICAL");
		expect(loggedErr()).toContain("rollback failed");
	});

	it("stringifies a non-Error rollback rejection (String(rollbackErr) arm)", () => {
		let renameCalls = 0;
		mockRenameSync.mockImplementation(() => {
			renameCalls += 1;
			if (renameCalls === 2) throw new Error("second write failed");
		});
		mockWriteFileSync.mockImplementation((p) => {
			if (String(p).endsWith(".ts")) throw "rollback-as-string";
			return undefined;
		});
		const result = runMultiEdit(twoFileBatch());
		expect(result.ok).toBe(false);
		expect(loggedErr()).toContain("rollback-as-string");
	});

	it("does not clean tmp when it does not exist (existsSync false skips unlink)", () => {
		mockRenameSync.mockImplementation(() => {
			throw new Error("rename failed pre-tmp");
		});
		mockExistsSync.mockReturnValue(false); // tmp absent → unlink skipped.
		const result = runMultiEdit(simpleBatch("/repo/a.ts"));
		expect(result.ok).toBe(false);
		expect(mockUnlinkSync).not.toHaveBeenCalled();
	});
});

// ───────────────────────────────────────────────
// multiEditCommand — input-mode + parse branches
// ───────────────────────────────────────────────

describe("multiEditCommand input modes", () => {
	it("rejects when both --stdin and --manifest are passed (mutex), echoing the path", async () => {
		const code = await runCommand("a.ts", { stdin: true, manifest: "m.json", json: true });
		expect(code).toBe(1);
		const payload = loggedJson();
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST);
		expect((parseWire(payload.error_detail, wireObject({ "message": wireString }), "test JSON value")).message).toContain("mutually exclusive");
		// Truthy `path` arm of `path || ""`.
		expect(payload).toHaveProperty(["error_detail","path"], "a.ts");
	});

	it("mutex error falls back to an empty path string when no positional path (`path || \"\"`)", async () => {
		const code = await runCommand(undefined, { stdin: true, manifest: "m.json", json: true });
		expect(code).toBe(1);
		expect(loggedJson()).toHaveProperty(["error_detail","path"], "");
	});

	it("rejects when neither --stdin nor --manifest is passed", async () => {
		const code = await runCommand(undefined, { json: true });
		expect(code).toBe(1);
		const payload = loggedJson();
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST);
		expect((parseWire(payload.error_detail, wireObject({ "message": wireString }), "test JSON value")).message).toContain("Must supply");
		// path defaults to "" when undefined.
		expect(payload).toHaveProperty(["error_detail","path"], "");
	});

	it("reads a single-file manifest from stdin and applies it (success)", async () => {
		const manifest = JSON.stringify({
			version: 1,
			edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }],
		});
		const code = await withStdin(manifest, () =>
			runCommand("/repo/a.ts", { stdin: true, json: true }),
		);
		expect(code).toBe(0);
		const payload = loggedJson();
		expect(payload.ok).toBe(true);
		expect(payload.file_changes_applied).toEqual(["/repo/a.ts"]);
	});

	it("surfaces READ_FAILED with an Error message when stdin emits an error", async () => {
		const code = await withStdinError(new Error("stdin pipe broke"), () =>
			runCommand("/repo/a.ts", { stdin: true, json: true }),
		);
		expect(code).toBe(1);
		const payload = loggedJson();
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.READ_FAILED);
		expect(payload).toHaveProperty(["error_detail","path"], "<stdin>");
		expect((parseWire(payload.error_detail, wireObject({ "message": wireString }), "test JSON value")).message).toContain("stdin pipe broke");
	});

	it("stringifies a non-Error stdin rejection (String(err) arm)", async () => {
		const code = await withStdinError("stdin failed as a bare string", () =>
			runCommand("/repo/a.ts", { stdin: true, json: true }),
		);
		expect(code).toBe(1);
		const payload = loggedJson();
		expect((parseWire(payload.error_detail, wireObject({ "message": wireString }), "test JSON value")).message).toContain(
			"stdin failed as a bare string",
		);
	});

	it("reads a manifest file with --manifest and applies it (success)", async () => {
		mockReadFileSync.mockImplementation((p) => {
			if (String(p).endsWith("m.json")) {
				return JSON.stringify({
					version: 1,
					batches: [
						{
							path: "/repo/a.ts",
							edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }],
						},
					],
				});
			}
			return "const original = 1;\n";
		});
		const code = await runCommand(undefined, { manifest: "m.json", json: true });
		expect(code).toBe(0);
		expect(loggedJson().ok).toBe(true);
	});

	it("surfaces READ_FAILED when the manifest file cannot be read (Error arm)", async () => {
		mockReadFileSync.mockImplementation((p) => {
			if (String(p).endsWith("missing.json")) throw new Error("ENOENT: no such file");
			return "const original = 1;\n";
		});
		const code = await runCommand(undefined, { manifest: "missing.json", json: true });
		expect(code).toBe(1);
		const payload = loggedJson();
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.READ_FAILED);
		expect(payload).toHaveProperty(["error_detail","path"], "missing.json");
		expect((parseWire(payload.error_detail, wireObject({ "message": wireString }), "test JSON value")).message).toContain("ENOENT");
	});

	it("stringifies a non-Error manifest read rejection (String(err) arm)", async () => {
		mockReadFileSync.mockImplementation((p) => {
			if (String(p).endsWith("weird.json")) throw "manifest read failed as string";
			return "const original = 1;\n";
		});
		const code = await runCommand(undefined, { manifest: "weird.json", json: true });
		expect(code).toBe(1);
		expect((parseWire(loggedJson().error_detail, wireObject({ "message": wireString }), "test JSON value")).message).toContain(
			"manifest read failed as string",
		);
	});

	it("surfaces INVALID_MANIFEST with a JSON parse error (Error arm), path = positional", async () => {
		mockReadFileSync.mockImplementation((p) => {
			if (String(p).endsWith("bad.json")) return "{ not valid json";
			return "const original = 1;\n";
		});
		const code = await runCommand("/repo/a.ts", { manifest: "bad.json", json: true });
		expect(code).toBe(1);
		const payload = loggedJson();
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST);
		expect((parseWire(payload.error_detail, wireObject({ "message": wireString }), "test JSON value")).message).toContain("JSON parse error");
		expect(payload).toHaveProperty(["error_detail","path"], "/repo/a.ts");
	});

	it("falls back to <manifest> in the parse-error path when no positional path", async () => {
		mockReadFileSync.mockImplementation((p) => {
			if (String(p).endsWith("bad.json")) return "}}}";
			return "const original = 1;\n";
		});
		const code = await runCommand(undefined, { manifest: "bad.json", json: true });
		expect(code).toBe(1);
		expect(loggedJson()).toHaveProperty(["error_detail","path"], "<manifest>");
	});

	it("surfaces INVALID_MANIFEST when normalize rejects the parsed manifest (path echoed)", async () => {
		const manifest = JSON.stringify({ version: 2, edits: [] });
		const code = await withStdin(manifest, () =>
			runCommand("/repo/a.ts", { stdin: true, json: true }),
		);
		expect(code).toBe(1);
		const payload = loggedJson();
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST);
		expect((parseWire(payload.error_detail, wireObject({ "message": wireString }), "test JSON value")).message).toMatch(/version/);
		expect(payload).toHaveProperty(["error_detail","path"], "/repo/a.ts");
	});

	it("normalize-reject path falls back to <manifest> when no positional path (`path || \"<manifest>\"`)", async () => {
		// A multi-file manifest read via --manifest with no positional path,
		// but one batch is malformed → normalizeManifest fails and the error
		// path uses the `<manifest>` fallback.
		mockReadFileSync.mockImplementation((p) => {
			if (String(p).endsWith("m.json")) {
				return JSON.stringify({ version: 1, batches: [{ path: 123, edits: [] }] });
			}
			return "const original = 1;\n";
		});
		const code = await runCommand(undefined, { manifest: "m.json", json: true });
		expect(code).toBe(1);
		const payload = loggedJson();
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST);
		expect(payload).toHaveProperty(["error_detail","path"], "<manifest>");
	});

	it("sets exitCode 1 when the pipeline itself fails (OLD_STRING_NOT_FOUND)", async () => {
		const manifest = JSON.stringify({
			version: 1,
			edits: [{ old_string: "ABSENT_STRING", new_string: "x" }],
		});
		const code = await withStdin(manifest, () =>
			runCommand("/repo/a.ts", { stdin: true, json: true }),
		);
		expect(code).toBe(1);
		expect(loggedJson().error_code).toBe(MULTI_EDIT_ERROR_CODES.OLD_STRING_NOT_FOUND);
	});

	it("defaults json to false when opts.json is undefined (human output path)", async () => {
		const manifest = JSON.stringify({
			version: 1,
			edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }],
		});
		const code = await withStdin(manifest, () => runCommand("/repo/a.ts", { stdin: true }));
		expect(code).toBe(0);
		// Human path prints a "file(s) updated" line, not JSON.
		expect(loggedOut()).toContain("file(s) updated");
	});
});

// ───────────────────────────────────────────────
// emit — JSON field omission + human-readable forks
// ───────────────────────────────────────────────
// Driven end-to-end through multiEditCommand so emit's branches are exercised
// against real results rather than a hand-built object.

describe("emit output forks", () => {
	it("JSON success omits error_code/error_detail/gate_failures", async () => {
		const manifest = JSON.stringify({
			version: 1,
			edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }],
		});
		await withStdin(manifest, () => runCommand("/repo/a.ts", { stdin: true, json: true }));
		const payload = loggedJson();
		expect(payload).toHaveProperty("ok", true);
		expect(payload).toHaveProperty("file_changes_applied");
		expect(payload).not.toHaveProperty("error_code");
		expect(payload).not.toHaveProperty("error_detail");
		expect(payload).not.toHaveProperty("gate_failures");
	});

	it("JSON failure includes error_code + error_detail", async () => {
		mockReadFileSync.mockImplementation((p) => {
			if (String(p).endsWith("a.ts")) throw new Error("ENOENT");
			return JSON.stringify({
				version: 1,
				batches: [
					{
						path: "/repo/a.ts",
						edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }],
					},
				],
			});
		});
		await runCommand(undefined, { manifest: "m.json", json: true });
		const payload = loggedJson();
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.READ_FAILED);
		expect(payload).toHaveProperty("error_detail");
	});

	it("JSON failure includes gate_failures when the gate rejects", async () => {
		mockTsc.mockReturnValue(
			overlay([
				{
					tool: "tsc",
					severity: "error",
					file: "a.ts",
					line: 1,
					message: "type error",
					ruleId: "TS2322",
				},
			]),
		);
		const manifest = JSON.stringify({
			version: 1,
			edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }],
		});
		await withStdin(manifest, () => runCommand("/repo/a.ts", { stdin: true, json: true }));
		const payload = loggedJson();
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.GATE_REJECTED);
		expect(Array.isArray(payload.gate_failures)).toBe(true);
		expect(payload).toHaveProperty(["gate_failures","length"], 1);
	});

	it("human success with zero changes prints the no-op line", async () => {
		// alpha → gamma → alpha composes to a no-op: no files written, n === 0.
		mockReadFileSync.mockReturnValue('const v = "alpha";\n');
		const manifest = JSON.stringify({
			version: 1,
			edits: [
				{ old_string: '"alpha"', new_string: '"gamma"' },
				{ old_string: '"gamma"', new_string: '"alpha"' },
			],
		});
		const code = await withStdin(manifest, () => runCommand("/repo/a.ts", { stdin: true }));
		expect(code).toBe(0);
		expect(loggedOut()).toContain("no-op");
	});

	it("human success with N changes prints the count and each path", async () => {
		const manifest = JSON.stringify({
			version: 1,
			edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }],
		});
		await withStdin(manifest, () => runCommand("/repo/a.ts", { stdin: true }));
		const out = loggedOut();
		expect(out).toContain("1 file(s) updated");
		expect(out).toContain("/repo/a.ts");
	});

	it("human failure prints error_code, path with edit index, and message", async () => {
		// OLD_STRING_NOT_FOUND carries edit_index → the `(edit N)` suffix path.
		const manifest = JSON.stringify({
			version: 1,
			edits: [{ old_string: "ABSENT", new_string: "x" }],
		});
		await withStdin(manifest, () => runCommand("/repo/a.ts", { stdin: true }));
		const err = loggedErr();
		expect(err).toContain("multi-edit failed: OLD_STRING_NOT_FOUND");
		expect(err).toContain("(edit 0)");
		expect(err).toContain("No files changed.");
	});

	it("human failure prints the gate-failures block when present", async () => {
		mockTsc.mockReturnValue(
			overlay([
				{
					tool: "tsc",
					severity: "error",
					file: "a.ts",
					line: 7,
					message: "type error here",
					ruleId: "TS2322",
				},
			]),
		);
		const manifest = JSON.stringify({
			version: 1,
			edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }],
		});
		await withStdin(manifest, () => runCommand("/repo/a.ts", { stdin: true }));
		const err = loggedErr();
		expect(err).toContain("multi-edit failed: GATE_REJECTED");
		expect(err).toContain("gate failure(s)");
		expect(err).toContain("TS2322");
		expect(err).toContain("type error here");
	});

	it("human failure without edit_index omits the `(edit N)` suffix", async () => {
		// A READ_FAILED error_detail has no edit_index → suffix is empty.
		mockReadFileSync.mockImplementation((p) => {
			if (String(p).endsWith("a.ts")) throw new Error("ENOENT: gone");
			return JSON.stringify({
				version: 1,
				batches: [
					{
						path: "/repo/a.ts",
						edits: [{ old_string: "const original = 1;", new_string: "const x = 2;" }],
					},
				],
			});
		});
		await runCommand(undefined, { manifest: "m.json" });
		const err = loggedErr();
		expect(err).toContain("multi-edit failed: READ_FAILED");
		expect(err).not.toContain("(edit");
		expect(err).toContain("ENOENT: gone");
	});
});
