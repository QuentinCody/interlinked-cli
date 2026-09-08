import { parseWire, wireArray, wireRecord, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked write — behavioral tests
// ===========================================
//
// These tests exercise `writeCommand` directly (no subprocess) by mocking the
// module boundaries it touches:
//   - `node:fs`              — existsSync / readFileSync / writeFileSync /
//                              renameSync / unlinkSync / statSync / chmodSync
//                              (no real disk I/O)
//   - `../harness/content-gate.js` — `gateProposedContent` returns a
//                              deterministic GateResult so the test never spawns
//                              real biome/tsc. The genuine `formatGateResult`,
//                              `GATE_SEVERITY_ERROR`, and types are preserved via
//                              `importOriginal`, so human-readable output is the
//                              real renderer.
//   - `process.stdin`        — swapped for a `Readable.from(...)` during the
//                              --stdin branch only.
//   - `process.exit`         — stubbed to throw a tagged sentinel so the
//                              function halts exactly where the real binary
//                              would exit; the test catches it and asserts on
//                              the recorded exit code.
//
// Every branch of `writeCommand` (and its file-private helpers, reached through
// the public entry) is covered: single-file (stdin / --from-file / neither),
// batch-manifest validation (every guard), path validation (inside / outside /
// system-prefix / --unsafe-outside-repo), gate-pass vs gate-block, the
// shared-transaction success and failure propagation, and
// every JSON-vs-human output fork including non-blocking gate warnings.
//
// The `detectBashCodeFileWrite` allowlist regressions at the bottom are
// genuine (they pin the PreToolUse rule that lets `interlinked write` through),
// so they are kept.

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock node:fs. All seven fns the command uses are vi.fn(); defaults set in
//    beforeEach. `Readable`/path stay real. ──────────────────────────────────
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
		renameSync: vi.fn(),
		unlinkSync: vi.fn(),
		statSync: vi.fn(),
		chmodSync: vi.fn(),
	};
});

// ── Mock the content gate: only `gateProposedContent` is replaced. The real
//    formatter + severity constant + types come through unchanged so output
//    assertions exercise the genuine renderer. ─────────────────────────────────
vi.mock("../harness/content-gate.js", async () => {
	const actual =
		await vi.importActual<typeof import("../harness/content-gate.js")>("../harness/content-gate.js");
	return {
		...actual,
		gateProposedContent: vi.fn(),
	};
});

// Transaction mechanics have real-filesystem coverage in gated-write-transaction.test.ts.
vi.mock("../lib/gated-file-transaction.js", () => ({
	captureGatedWriteBaseline: vi.fn(() => ({ id: "test-transaction", repoRoot: "/repo", writes: [] })),
	commitGatedWrites: vi.fn(),
}));

import {
	chmodSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	type GateFailure,
	type GateResult,
	gateProposedContent,
} from "../harness/content-gate.js";
import { nonNull } from "../lib/non-null.js";
import { captureGatedWriteBaseline, commitGatedWrites } from "../lib/gated-file-transaction.js";
import { type WriteCommandOptions, writeCommand } from "./write.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockStatSync = vi.mocked(statSync);
const mockChmodSync = vi.mocked(chmodSync);
const mockGate = vi.mocked(gateProposedContent);
const mockCommit = vi.mocked(commitGatedWrites);
const mockCapture = vi.mocked(captureGatedWriteBaseline);

// ── process.exit sentinel. The real handler is `never`-returning; we mimic
//    that by throwing so control flow stops at the call site, then surface the
//    captured code to the test. ────────────────────────────────────────────────
class ExitSignal extends Error {
	constructor(public code: number) {
		super(`process.exit(${code})`);
		this.name = "ExitSignal";
	}
}

/** Run `writeCommand`, capturing a thrown ExitSignal as `{ exitCode }`. */
async function run(
	target: string | undefined,
	opts: WriteCommandOptions,
): Promise<{ exitCode: number | undefined }> {
	try {
		await writeCommand(target, opts);
		return { exitCode: undefined };
	} catch (err) {
		if (err instanceof ExitSignal) return { exitCode: err.code };
		throw err;
	}
}

/** Concatenate every argument of every console.log call into one string. */
function loggedOut(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((c) => c.map(String).join(" "))
		.join("\n");
}

/** Concatenate every argument of every console.error call into one string. */
function loggedErr(): string {
	return vi
		.mocked(console.error)
		.mock.calls.map((c) => c.map(String).join(" "))
		.join("\n");
}

/** Parse the first console.log line as JSON (the JSON-mode payload). */
function loggedJson(): Record<string, unknown> {
	const first = vi.mocked(console.log).mock.calls[0]?.[0];
	if (typeof first !== "string") {
		throw new Error(`Expected console.log to receive a JSON string, got ${typeof first}`);
	}
	return parseWire(JSON.parse(first), wireRecord(wireUnknown), "test JSON value");
}

/** Build a passing GateResult (no failures). */
function gateOk(elapsedMs = 5): GateResult {
	return { ok: true, failures: [], elapsedMs };
}

/** Build a GateResult carrying the given failures. `ok` derives from severity. */
function gateWith(failures: GateFailure[], elapsedMs = 5): GateResult {
	return { ok: !failures.some((f) => f.severity === "error"), failures, elapsedMs };
}

const errFailure: GateFailure = {
	path: "foo.ts",
	tool: "biome",
	code: "noDoubleEquals",
	line: 3,
	message: "Use === instead of ==.",
	severity: "error",
};
const warnFailure: GateFailure = {
	path: "foo.ts",
	tool: "tsc",
	code: "TS6133",
	line: 7,
	message: "'x' is declared but never used.",
	severity: "warning",
};

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ExitSignal(Number(code ?? 0));
	});

	// fs defaults: nothing exists (so new-file writes & path checks are simple),
	// writes/renames succeed.
	mockExistsSync.mockReturnValue(false);
	mockReadFileSync.mockReturnValue("");
	mockWriteFileSync.mockReturnValue(undefined);
	mockRenameSync.mockReturnValue(undefined);
	mockUnlinkSync.mockReturnValue(undefined);
	mockStatSync.mockImplementation(() => Object.assign(new Stats(), { mode: 0o644 }));
	mockChmodSync.mockReturnValue(undefined);

	// Gate passes unless a test overrides.
	mockGate.mockReturnValue(gateOk());
	mockCommit.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A path under cwd so validateTargetPath accepts it. */
function inRepo(name: string): string {
	return `${process.cwd()}/${name}`;
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
			// Defer so the command's listeners are attached before the error.
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

// ════════════════════════════════════════════════════════════════════════════
// Module shape
// ════════════════════════════════════════════════════════════════════════════
describe("write command module", () => {
	it("exports writeCommand as a function", () => {
		expect(typeof writeCommand).toBe("function");
		expect(writeCommand.name).toBe("writeCommand");
		expect(writeCommand.length).toBe(2);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Single-file mode — entry resolution
// ════════════════════════════════════════════════════════════════════════════
describe("interlinked write — single-file mode", () => {
	it("writes content from stdin atomically when the gate passes", async () => {
		const target = inRepo("new_ok.ts");
		const content = "export const x: number = 1;\n";
		const r = await withStdin(content, () => run(target, { stdin: true }));

		expect(r.exitCode).toBeUndefined();
		expect(mockGate).toHaveBeenCalledWith(
			[{ path: target, content }],
			// Transactional path: unavailable tsc checker aborts (review pass 18).
			{ tscUnavailableSeverity: "error" },
		);
		expect(mockCapture).toHaveBeenCalledWith(process.cwd(), [{ path: target, content }], { allowOutsideRepo: false });
		expect(mockCommit).toHaveBeenCalledWith(mockCapture.mock.results[0]?.value);
		expect(mockCapture.mock.invocationCallOrder[0]).toBeLessThan(nonNull(mockGate.mock.invocationCallOrder[0]));
		expect(mockGate.mock.invocationCallOrder[0]).toBeLessThan(nonNull(mockCommit.mock.invocationCallOrder[0]));
		// Human output names the count and the path.
		expect(loggedOut()).toContain("1 file written");
		expect(loggedOut()).toContain(target);
	});

	it("reads content from --from-file when the source exists", async () => {
		const target = inRepo("from_src.ts");
		const src = inRepo("source.ts");
		const content = "export const y = 2;\n";
		mockExistsSync.mockImplementation((p) => String(p) === src);
		mockReadFileSync.mockReturnValue(content);

		const r = await run(target, { fromFile: src });

		expect(r.exitCode).toBeUndefined();
		expect(mockReadFileSync).toHaveBeenCalledWith(src, "utf-8");
		expect(mockGate).toHaveBeenCalledWith(
			[{ path: target, content }],
			// Transactional path: unavailable tsc checker aborts (review pass 18).
			{ tscUnavailableSeverity: "error" },
		);
	});

	it("errors (exit 2) when --from-file source does not exist", async () => {
		const target = inRepo("t.ts");
		const src = inRepo("missing.ts");
		mockExistsSync.mockReturnValue(false);

		const r = await run(target, { fromFile: src });

		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain(`Source file not found: ${src}`);
		expect(mockGate).not.toHaveBeenCalled();
	});

	it("errors (exit 2) when neither --stdin nor --from-file is given", async () => {
		const r = await run(inRepo("t.ts"), {});
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("Provide --stdin or --from-file");
	});

	it("errors (exit 2) when no path and no --batch are given", async () => {
		const r = await run(undefined, {});
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("Provide a <path> argument");
	});

	it("stringifies a non-Error rejected by stdin (String(err) arm of the entry-resolution catch)", async () => {
		// readStdin rejects with whatever the stream emits on `error`. A bare
		// string (not an Error) exercises the `: String(err)` arm of the
		// entry-resolution catch in writeCommand.
		const r = await withStdinError("stdin blew up as a string", () =>
			run(inRepo("foo.ts"), { stdin: true }),
		);
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("stdin blew up as a string");
		expect(mockGate).not.toHaveBeenCalled();
	});

	it("renders the usage error as JSON when --json is set", async () => {
		const r = await run(undefined, { json: true });
		expect(r.exitCode).toBe(2);
		const payload = loggedJson();
		expect(payload.ok).toBe(false);
		expect(String(payload.error)).toContain("Provide a <path> argument");
		// JSON mode must NOT also write to stderr.
		expect(loggedErr()).toBe("");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Batch mode — manifest loading & validation (every guard in loadBatchManifest)
// ════════════════════════════════════════════════════════════════════════════
describe("interlinked write — batch manifest validation", () => {
	const manifestPath = "/tmp/manifest.json";

	/** Make existsSync true for the manifest, readFileSync return `raw`. */
	function manifestRaw(raw: string): void {
		mockExistsSync.mockImplementation((p) => String(p) === manifestPath);
		mockReadFileSync.mockImplementation((p) => {
			if (String(p) === manifestPath) return raw;
			throw new Error("ENOENT");
		});
	}

	it("errors when the manifest file is missing", async () => {
		mockExistsSync.mockReturnValue(false);
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain(`Batch manifest not found: ${manifestPath}`);
	});

	it("errors when a positional path is combined with --batch", async () => {
		manifestRaw(JSON.stringify({ version: 1, writes: [{ path: inRepo("a.ts"), content: "x" }] }));
		const r = await run(inRepo("a.ts"), { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("Do not pass a path positional argument");
	});

	it("errors when readFileSync throws (unreadable manifest)", async () => {
		mockExistsSync.mockImplementation((p) => String(p) === manifestPath);
		mockReadFileSync.mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("Could not read batch manifest");
		expect(loggedErr()).toContain("EACCES");
	});

	it("errors on invalid JSON", async () => {
		manifestRaw("{ not json");
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("not valid JSON");
	});

	it("errors when the manifest is a JSON non-object (array)", async () => {
		manifestRaw("[]");
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		// Arrays are objects in JS, so they pass the typeof gate and fail the
		// version check instead — version is undefined.
		expect(loggedErr()).toContain("version must be 1");
	});

	it("errors when the manifest parses to JSON null", async () => {
		manifestRaw("null");
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("must be a JSON object");
	});

	it("errors when the manifest parses to a JSON primitive", async () => {
		manifestRaw("42");
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("must be a JSON object");
	});

	it("errors when version != 1", async () => {
		manifestRaw(JSON.stringify({ version: 2, writes: [] }));
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("version must be 1");
	});

	it("errors when writes is missing / not an array", async () => {
		manifestRaw(JSON.stringify({ version: 1, writes: "nope" }));
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("non-empty 'writes' array");
	});

	it("errors when writes is an empty array", async () => {
		manifestRaw(JSON.stringify({ version: 1, writes: [] }));
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("non-empty 'writes' array");
	});

	it("errors when a write entry is not an object", async () => {
		manifestRaw(JSON.stringify({ version: 1, writes: ["nope"] }));
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("writes[0] must be an object");
	});

	it("errors when a write entry has a non-string / empty path", async () => {
		manifestRaw(JSON.stringify({ version: 1, writes: [{ path: "", content: "x" }] }));
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("writes[0].path must be a non-empty string");
	});

	it("errors when a write entry has a non-string content", async () => {
		manifestRaw(JSON.stringify({ version: 1, writes: [{ path: inRepo("a.ts"), content: 5 }] }));
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("writes[0].content must be a string");
	});

	it("stringifies a non-Error thrown while reading the manifest (String(err) arm)", async () => {
		// readFileSync throwing a bare string (not an Error) exercises the
		// `err instanceof Error ? … : String(err)` false-arm in loadBatchManifest.
		mockExistsSync.mockImplementation((p) => String(p) === manifestPath);
		mockReadFileSync.mockImplementation(() => {
			throw "raw string failure"; // intentional non-Error throw
		});
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("Could not read batch manifest");
		expect(loggedErr()).toContain("raw string failure");
	});

	it("loads a valid multi-file manifest and writes every entry atomically", async () => {
		const a = inRepo("a.ts");
		const b = inRepo("b.ts");
		manifestRaw(
			JSON.stringify({
				version: 1,
				writes: [
					{ path: a, content: "export const a = 1;\n" },
					{ path: b, content: "export const b = 2;\n" },
				],
			}),
		);
		const r = await run(undefined, { batch: manifestPath });
		expect(r.exitCode).toBeUndefined();
		expect(mockGate).toHaveBeenCalledWith(
			[
				{ path: a, content: "export const a = 1;\n" },
				{ path: b, content: "export const b = 2;\n" },
			],
			{ tscUnavailableSeverity: "error" },
		);
		expect(mockCapture.mock.calls[0]?.[1]).toHaveLength(2);
		expect(mockCommit).toHaveBeenCalledWith(mockCapture.mock.results[0]?.value);
		expect(loggedOut()).toContain("2 files written");
	});

	// test-contract: boundary — relative and absolute aliases of one target are rejected before gate evaluation or any filesystem write
	it("rejects duplicate batch targets when relative and absolute aliases resolve to the same path", async () => {
		const manifest = manifestPath;
		const relative = "duplicate-target.ts";
		const absolute = inRepo(relative);
		manifestRaw(
			JSON.stringify({
				version: 1,
				writes: [
					{ path: relative, content: "first\n" },
					{ path: absolute, content: "second\n" },
				],
			}),
		);

		const result = await run(undefined, { batch: manifest });

		expect(result.exitCode).toBe(2);
		expect(loggedErr()).toContain(`Batch contains the same target more than once: ${absolute}`);
		expect(mockGate).not.toHaveBeenCalled();
		expect(mockWriteFileSync).not.toHaveBeenCalled();
		expect(mockRenameSync).not.toHaveBeenCalled();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Path validation (validateTargetPath, reached via the entry)
// ════════════════════════════════════════════════════════════════════════════
describe("interlinked write — path validation", () => {
	it("rejects a path outside the project root", async () => {
		const outside = "/var/tmp/escape.ts";
		const r = await withStdin("x\n", () => run(outside, { stdin: true }));
		expect(r.exitCode).toBe(2);
		expect(loggedErr()).toContain("Refusing to write outside project root");
		expect(mockGate).not.toHaveBeenCalled();
	});

	it("allows a path outside the root with --unsafe-outside-repo", async () => {
		const outside = "/var/tmp/escape.ts";
		const r = await withStdin("x\n", () =>
			run(outside, { stdin: true, unsafeOutsideRepo: true }),
		);
		expect(r.exitCode).toBeUndefined();
		expect(mockGate).toHaveBeenCalledWith(
			[{ path: outside, content: "x\n" }],
			{ tscUnavailableSeverity: "error" },
		);
	});

	it.each([
		{ root: "/etc", sysPath: "/etc/passwd" },
		{ root: "/usr", sysPath: "/usr/lib/x" },
		{ root: "/bin", sysPath: "/bin/sh" },
		{ root: "/sbin", sysPath: "/sbin/init" },
	])(
		"hard-blocks system path $sysPath even when it lies inside the project root",
		async ({ root, sysPath }) => {
			// The system-prefix guard only runs AFTER the outside-root check
			// passes and `unsafeOutsideRepo` is false (source comment: "unlikely,
			// but e.g. cwd=/ would allow them otherwise"). Reach it by setting
			// cwd to the system dir itself so `sysPath` is genuinely inside the
			// root — the boundary check passes, then the hard system-prefix
			// block fires.
			vi.spyOn(process, "cwd").mockReturnValue(root);
			const r = await withStdin("x\n", () => run(sysPath, { stdin: true }));
			expect(r.exitCode).toBe(2);
			expect(loggedErr()).toContain("Refusing to write to system path");
		},
	);

	it("renders a path-validation error as JSON when --json is set", async () => {
		const r = await withStdin("x\n", () =>
			run("/var/tmp/escape.ts", { stdin: true, json: true }),
		);
		expect(r.exitCode).toBe(2);
		const payload = loggedJson();
		expect(payload.ok).toBe(false);
		expect(String(payload.error)).toContain("Refusing to write outside project root");
		expect(loggedErr()).toBe("");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Gate outcomes — block, warn-but-pass, JSON shapes
// ════════════════════════════════════════════════════════════════════════════
describe("interlinked write — gate outcomes", () => {
	it("blocks (exit 1) and leaves files untouched when the gate has a blocking failure", async () => {
		mockGate.mockReturnValue(gateWith([errFailure]));
		const r = await withStdin("x\n", () => run(inRepo("foo.ts"), { stdin: true }));
		expect(r.exitCode).toBe(1);
		// Human output uses the real formatGateResult + the trailing nudge.
		expect(loggedErr()).toContain("blocking failure");
		expect(loggedErr()).toContain("noDoubleEquals");
		expect(loggedErr()).toContain("No files changed");
		// Nothing was written.
		expect(mockWriteFileSync).not.toHaveBeenCalled();
		expect(mockRenameSync).not.toHaveBeenCalled();
	});

	it("emits the gate failure as the JSON payload when --json is set", async () => {
		mockGate.mockReturnValue(gateWith([errFailure]));
		const r = await withStdin("x\n", () =>
			run(inRepo("foo.ts"), { stdin: true, json: true }),
		);
		expect(r.exitCode).toBe(1);
		const payload = loggedJson();
		expect(payload.ok).toBe(false);
		const failures = parseWire(payload.failures, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({
			path: "foo.ts",
			tool: "biome",
			code: "noDoubleEquals",
			line: 3,
			severity: "error",
		});
		// "wrote" must be absent on a blocked batch.
		expect(payload.wrote).toBeUndefined();
	});

	it("writes through a warning-only gate and surfaces non-blocking warnings (human)", async () => {
		mockGate.mockReturnValue(gateWith([warnFailure]));
		const r = await withStdin("x\n", () => run(inRepo("foo.ts"), { stdin: true }));
		expect(r.exitCode).toBeUndefined();
		expect(mockCommit).toHaveBeenCalledWith(mockCapture.mock.results[0]?.value);
		const out = loggedOut();
		expect(out).toContain("1 file written");
		expect(out).toContain("Gate warnings (non-blocking)");
		expect(out).toContain("TS6133");
	});

	it("includes failures AND wrote in the JSON payload on a warning-only pass", async () => {
		mockGate.mockReturnValue(gateWith([warnFailure]));
		const target = inRepo("foo.ts");
		const r = await withStdin("x\n", () => run(target, { stdin: true, json: true }));
		expect(r.exitCode).toBeUndefined();
		const payload = loggedJson();
		expect(payload.ok).toBe(true);
		expect(payload.wrote).toEqual([target]);
		expect(payload).toHaveProperty(["failures","length"], 1);
	});

	it("passes a column through into the JSON failure payload when present", async () => {
		const withCol: GateFailure = { ...errFailure, column: 12 };
		mockGate.mockReturnValue(gateWith([withCol]));
		const r = await withStdin("x\n", () =>
			run(inRepo("foo.ts"), { stdin: true, json: true }),
		);
		expect(r.exitCode).toBe(1);
		const failures = parseWire(loggedJson().failures, wireArray(wireRecord(wireUnknown)), "test JSON value");
		expect(nonNull(failures[0]).column).toBe(12);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Atomic write failure — rename throws → temp cleanup, exit 1
// ════════════════════════════════════════════════════════════════════════════
describe("interlinked write — transaction failures", () => {
    it.each([new Error("transaction lock busy"), "write failed", new Error("guarded rollback incomplete: a.ts")])("surfaces transaction failure with exit 1: %s", async (error) => {
        mockCommit.mockImplementationOnce(() => { throw error; });
        const result = await withStdin("new", () => run(inRepo("a.ts"), { stdin: true, json: true }));
        expect(result.exitCode).toBe(1);
        expect(loggedJson()).toEqual({ ok: false, error: error instanceof Error ? error.message : error });
    });
    it.each([new Error("transaction lock busy"), "write failed", new Error("guarded rollback incomplete: a.ts")])("reports transaction failure to stderr in human output: %s", async (error) => {
        mockCommit.mockImplementationOnce(() => { throw error; });
        const result = await withStdin("new", () => run(inRepo("a.ts"), { stdin: true }));
        expect(result.exitCode).toBe(1);
        expect(loggedErr()).toContain(`interlinked write: atomic write failed — ${error instanceof Error ? error.message : error}`);
    });
    it("reports a snapshot failure before executing any checker", async () => {
        mockCapture.mockImplementationOnce(() => { throw new Error("target is a symlink"); });
        const result = await withStdin("new", () => run(inRepo("a.ts"), { stdin: true }));
        expect(result.exitCode).toBe(2);
        expect(loggedErr()).toContain("target is a symlink");
        expect(mockGate).not.toHaveBeenCalled();
        expect(mockCommit).not.toHaveBeenCalled();
    });
});

describe("interlinked write — exit codes", () => {
	it("uses exit code 2 for usage errors", async () => {
		await run(undefined, {});
		expect(exitSpy).toHaveBeenCalledWith(2);
	});
	it("uses exit code 1 for gate blocks", async () => {
		mockGate.mockReturnValue(gateWith([errFailure]));
		await withStdin("x\n", () => run(inRepo("foo.ts"), { stdin: true }));
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Regression: the Bash pre_block rule ALLOWS `interlinked write` and still
// blocks naive `node -e fs.writeFileSync(...)` / heredocs. (Genuine — kept.)
// ════════════════════════════════════════════════════════════════════════════
describe("detectBashCodeFileWrite allowlist for interlinked write", async () => {
	const { detectBashCodeFileWrite } = await import("../harness/pre-checks.js");

	it("allows `interlinked write` through unconditionally", () => {
		expect(
			detectBashCodeFileWrite("interlinked write src/foo.ts --from-file /tmp/newcontent.ts"),
		).toBeNull();
		expect(
			detectBashCodeFileWrite("cat newcontent.ts | interlinked write src/foo.ts --stdin"),
		).toBeNull();
		expect(detectBashCodeFileWrite("interlinked write --batch /tmp/manifest.json")).toBeNull();
	});

	it("still blocks naive `node -e fs.writeFileSync(...)` to code paths", () => {
		const hit = detectBashCodeFileWrite(
			`node -e "require('fs').writeFileSync('src/app.ts', 'const x = 1;')"`,
		);
		expect(hit).not.toBeNull();
		expect(hit?.target).toBe("src/app.ts");
	});

	it("still blocks `cat > file.ts` heredocs", () => {
		const hit = detectBashCodeFileWrite("cat > src/foo.ts << 'EOF'\nconst x = 1;\nEOF");
		expect(hit).not.toBeNull();
		expect(hit?.target).toBe("src/foo.ts");
	});
});
