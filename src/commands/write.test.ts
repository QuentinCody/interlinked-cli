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
// atomic-write success and failure (rename throw → temp cleanup) paths, and
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
import { type WriteCommandOptions, writeCommand } from "./write.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockStatSync = vi.mocked(statSync);
const mockChmodSync = vi.mocked(chmodSync);
const mockGate = vi.mocked(gateProposedContent);

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
		// Atomic write: a temp file written, then renamed into place.
		expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
		const [tmpPath, writtenContent] = nonNull(mockWriteFileSync.mock.calls[0]);
		expect(String(tmpPath)).toContain(`${target}.interlinked-write-`);
		expect(writtenContent).toBe(content);
		expect(mockRenameSync).toHaveBeenCalledWith(tmpPath, target);
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
		// Two temps written, two renames.
		expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
		expect(mockRenameSync).toHaveBeenCalledTimes(2);
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
		expect(mockGate).toHaveBeenCalled();
	});

	it("accepts the project root itself (absolute === root branch)", async () => {
		const r = await withStdin("x\n", () => run(process.cwd(), { stdin: true }));
		// cwd === root passes the boundary check; gate runs and write proceeds.
		expect(r.exitCode).toBeUndefined();
		expect(mockGate).toHaveBeenCalled();
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
		expect(mockRenameSync).toHaveBeenCalledTimes(1);
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
describe("interlinked write — atomic write failure", () => {
	it("cleans up temp files and exits 1 (human) when rename fails", async () => {
		// Temp write succeeds; rename throws. Cleanup unlinks the temp (we make
		// existsSync(temp) true so the unlink branch executes).
		mockRenameSync.mockImplementation(() => {
			throw new Error("EXDEV: cross-device link not permitted");
		});
		mockExistsSync.mockReturnValue(true); // temp "exists" → unlink runs

		const r = await withStdin("x\n", () => run(inRepo("foo.ts"), { stdin: true }));

		expect(r.exitCode).toBe(1);
		expect(loggedErr()).toContain("atomic write failed");
		expect(loggedErr()).toContain("EXDEV");
		// The temp written in phase 1 is cleaned up in the catch.
		expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
		const tmpWritten = String(nonNull(mockWriteFileSync.mock.calls[0])[0]);
		expect(mockUnlinkSync).toHaveBeenCalledWith(tmpWritten);
	});

	it("restores an existing target when a later batch rename fails", async () => {
		const manifest = inRepo("batch.json");
		const a = inRepo("a.ts");
		const b = inRepo("b.ts");
		const raw = JSON.stringify({
			version: 1,
			writes: [
				{ path: a, content: "new a\n" },
				{ path: b, content: "new b\n" },
			],
		});
		mockExistsSync.mockImplementation((path) => [manifest, a, b].includes(String(path)));
		mockReadFileSync.mockImplementation((path) => {
			if (String(path) === manifest) return raw;
			if (String(path) === a) return "old a\n";
			if (String(path) === b) return "old b\n";
			return "";
		});
		let renames = 0;
		mockRenameSync.mockImplementation(() => {
			renames++;
			if (renames === 2) throw new Error("second rename failed");
		});

		const result = await run(undefined, { batch: manifest });

		expect(result.exitCode).toBe(1);
		expect(mockWriteFileSync).toHaveBeenCalledWith(
			expect.stringContaining("a.ts.interlinked-rollback-"),
			"old a\n",
		);
		expect(mockRenameSync).toHaveBeenLastCalledWith(
			expect.stringContaining("a.ts.interlinked-rollback-"),
			a,
		);
	});

	// test-contract: invariant — an existing target's mode is applied to both its staged replacement and its rollback restoration temp
	it("preserves an existing target mode on staged and rollback temps", async () => {
		const manifest = inRepo("mode-batch.json");
		const a = inRepo("mode-a.ts");
		const b = inRepo("mode-b.ts");
		const raw = JSON.stringify({
			version: 1,
			writes: [
				{ path: a, content: "new a\n" },
				{ path: b, content: "new b\n" },
			],
		});
		mockExistsSync.mockImplementation((path) => [manifest, a, b].includes(String(path)));
		mockReadFileSync.mockImplementation((path) => {
			if (String(path) === manifest) return raw;
			if (String(path) === a) return "old a\n";
			if (String(path) === b) return "old b\n";
			return "";
		});
		mockStatSync.mockImplementation((path) => ({
			// stat.mode includes regular-file type bits; chmod receives only
			// permission/special bits from the public write behavior.
			mode: String(path) === a ? 0o100640 : 0o100600,
		}) as ReturnType<typeof statSync>);
		let renames = 0;
		mockRenameSync.mockImplementation(() => {
			renames++;
			if (renames === 2) throw new Error("second rename failed");
		});

		const result = await run(undefined, { batch: manifest });

		expect(result.exitCode).toBe(1);
		expect(mockChmodSync).toHaveBeenCalledWith(
			expect.stringContaining("mode-a.ts.interlinked-write-"),
			0o640,
		);
		expect(mockChmodSync).toHaveBeenCalledWith(
			expect.stringContaining("mode-a.ts.interlinked-rollback-"),
			0o640,
		);
	});

	// test-contract: invariant — a temp path is cleaned up even when writing its contents throws
	it("cleans up a temp path registered before a partial write failure", async () => {
		const target = inRepo("partial-write.ts");
		mockExistsSync.mockImplementation((path) => String(path).includes(".interlinked-write-"));
		mockWriteFileSync.mockImplementation(() => {
			throw new Error("disk full after partial write");
		});

		const result = await withStdin("x\n", () => run(target, { stdin: true }));

		expect(result.exitCode).toBe(1);
		expect(loggedErr()).toContain("disk full after partial write");
		const tmpWritten = String(nonNull(mockWriteFileSync.mock.calls[0])[0]);
		expect(mockUnlinkSync).toHaveBeenCalledWith(tmpWritten);
	});

	// test-contract: invariant — a failed later commit removes an earlier target that did not exist in the captured pre-write state
	it("removes a newly-created earlier target when a later batch rename fails", async () => {
		const manifest = inRepo("new-target-batch.json");
		const a = inRepo("new-a.ts");
		const b = inRepo("new-b.ts");
		const raw = JSON.stringify({
			version: 1,
			writes: [
				{ path: a, content: "new a\n" },
				{ path: b, content: "new b\n" },
			],
		});
		const renamedTemps = new Set<string>();
		let aCommitted = false;
		mockExistsSync.mockImplementation((path) => {
			const value = String(path);
			if (value === manifest) return true;
			if (value === a) return aCommitted;
			return value.includes(".interlinked-write-") && !renamedTemps.has(value);
		});
		mockReadFileSync.mockImplementation((path) => {
			if (String(path) === manifest) return raw;
			throw new Error("unexpected target read");
		});
		let renames = 0;
		mockRenameSync.mockImplementation((from, to) => {
			renames++;
			if (renames === 1) {
				renamedTemps.add(String(from));
				aCommitted = true;
				return;
			}
			throw new Error(`rename ${String(to)} failed`);
		});

		const result = await run(undefined, { batch: manifest });

		expect(result.exitCode).toBe(1);
		expect(mockUnlinkSync).toHaveBeenCalledWith(a);
		expect(mockWriteFileSync).not.toHaveBeenCalledWith(
			expect.stringContaining(".interlinked-rollback-"),
			expect.anything(),
		);
	});

	it("stringifies a non-Error thrown by rename (String(err) arm of the atomic-write catch)", async () => {
		mockRenameSync.mockImplementation(() => {
			throw "rename failed as a string"; // intentional non-Error throw
		});
		mockExistsSync.mockReturnValue(false);
		const r = await withStdin("x\n", () => run(inRepo("foo.ts"), { stdin: true }));
		expect(r.exitCode).toBe(1);
		expect(loggedErr()).toContain("atomic write failed");
		expect(loggedErr()).toContain("rename failed as a string");
	});

	it("renders the atomic-write failure as JSON when --json is set", async () => {
		mockRenameSync.mockImplementation(() => {
			throw new Error("EXDEV");
		});
		mockExistsSync.mockReturnValue(false); // temp not found → unlink skipped
		const r = await withStdin("x\n", () =>
			run(inRepo("foo.ts"), { stdin: true, json: true }),
		);
		expect(r.exitCode).toBe(1);
		const payload = loggedJson();
		expect(payload.ok).toBe(false);
		expect(String(payload.error)).toContain("EXDEV");
		// existsSync false → no unlink attempt.
		expect(mockUnlinkSync).not.toHaveBeenCalled();
	});

	it("swallows a unlink error during cleanup (best-effort) and still exits 1", async () => {
		mockRenameSync.mockImplementation(() => {
			throw new Error("rename boom");
		});
		mockExistsSync.mockReturnValue(true);
		mockUnlinkSync.mockImplementation(() => {
			throw new Error("unlink boom"); // must be swallowed, not rethrown
		});
		const r = await withStdin("x\n", () => run(inRepo("foo.ts"), { stdin: true }));
		expect(r.exitCode).toBe(1);
		expect(loggedErr()).toContain("atomic write failed");
		expect(loggedErr()).toContain("rename boom");
	});

	/**
	 * Arrange a two-file batch where the SECOND commit rename fails and the
	 * rollback rename that would restore the first (already-committed) target
	 * fails too — the only state that reaches `rollbackCommitted`'s catch.
	 * Returns the two target paths so each test can assert on them.
	 */
	function arrangeFailedRollback(): { a: string; b: string } {
		const manifest = inRepo("rollback-fail-batch.json");
		const a = inRepo("rollback-fail-a.ts");
		const b = inRepo("rollback-fail-b.ts");
		const raw = JSON.stringify({
			version: 1,
			writes: [
				{ path: a, content: "new a\n" },
				{ path: b, content: "new b\n" },
			],
		});
		mockExistsSync.mockImplementation((path) => {
			const value = String(path);
			return [manifest, a, b].includes(value) || value.includes(".interlinked-rollback-");
		});
		mockReadFileSync.mockImplementation((path) => {
			if (String(path) === manifest) return raw;
			if (String(path) === a) return "old a\n";
			if (String(path) === b) return "old b\n";
			return "";
		});
		let renames = 0;
		mockRenameSync.mockImplementation(() => {
			renames++;
			if (renames === 1) return; // a committed
			if (renames === 2) throw new Error("second rename failed");
			throw new Error("restore rename failed"); // the rollback rename
		});
		return { a, b };
	}

	// test-contract: invariant — a rollback that cannot be completed is reported alongside the originating failure, never swallowed
	it("appends the unrestored target to the error when its rollback rename fails", async () => {
		const { a } = arrangeFailedRollback();

		const result = await run(undefined, { batch: inRepo("rollback-fail-batch.json") });

		expect(result.exitCode).toBe(1);
		expect(loggedErr()).toContain(
			`second rename failed; rollback incomplete (${a}: restore rename failed)`,
		);
	});

	it("removes the rollback temp it staged for a target it could not restore", async () => {
		const { a } = arrangeFailedRollback();

		await run(undefined, { batch: inRepo("rollback-fail-batch.json") });

		const rollbackFilter = (path: string): boolean => path.includes(".interlinked-rollback-");
		const staged = mockWriteFileSync.mock.calls.map((call) => String(call[0])).filter(rollbackFilter);
		const removed = mockUnlinkSync.mock.calls.map((call) => String(call[0])).filter(rollbackFilter);
		// Exactly one rollback temp is staged (for `a`), and the failing restore
		// leaves none of it behind.
		expect(staged).toHaveLength(1);
		expect(nonNull(staged[0]).startsWith(`${a}.interlinked-rollback-`)).toBe(true);
		expect(removed).toEqual(staged);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// process.exit was actually invoked with the sentinel codes
// ════════════════════════════════════════════════════════════════════════════
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
