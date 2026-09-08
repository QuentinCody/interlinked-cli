import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireObject, wireOptional, wireString, wireUnknown } from "../lib/value-validation.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicBatchWrite, gateProposedContentInline } from "./multi-edit-apply.js";
import { multiEditCommand, MULTI_EDIT_ERROR_CODES, runMultiEdit } from "./multi-edit.js";

// Mutation-kill suite for src/commands/multi-edit.ts (wave pass1_w49).
// Targets survivors in runMultiEdit (symbol 4ce9da13a3dfa062),
// multiEditCommand (symbol c91d6b1fca0cd332), the stdin utf-8 encoding
// (symbol 53d76be8cdd39bc8), and emit() (symbol e33225c6899b7685).

vi.mock("./multi-edit-apply.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./multi-edit-apply.js")>();
	return {
		...actual,
		gateProposedContentInline: vi.fn(actual.gateProposedContentInline),
		atomicBatchWrite: vi.fn(actual.atomicBatchWrite),
	};
});

const mockGate = vi.mocked(gateProposedContentInline);
const mockWrite = vi.mocked(atomicBatchWrite);

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "multi-edit-w49-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.clearAllMocks();
});

afterAll(() => {
	vi.restoreAllMocks();
});

// ───────────────────────────────────────────────
// runMultiEdit — direct (real fs, real apply/normalize; gate & write kept
// real for these branches since they never reach step 3/4).
// ───────────────────────────────────────────────

describe("runMultiEdit — array literal survivors (file_changes_applied must be [])", () => {
	it("READ_FAILED: file_changes_applied is an empty array, not a placeholder array", () => {
		const missing = join(dir, "does-not-exist.txt");
		const result = runMultiEdit([{ path: missing, edits: [{ old_string: "a", new_string: "b" }] }]);
		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.READ_FAILED);
		expect(result.file_changes_applied).toEqual([]);
		expect(result.file_changes_applied.length).toBe(0);
	});

	it("AMBIGUOUS_OLD_STRING: file_changes_applied is empty and message names the location count", () => {
		const p = join(dir, "ambiguous.txt");
		writeFileSync(p, "foo foo", "utf-8");
		const result = runMultiEdit([{ path: p, edits: [{ old_string: "foo", new_string: "bar" }] }]);
		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.AMBIGUOUS_OLD_STRING);
		expect(result.file_changes_applied).toEqual([]);
		// Kills the ConditionalExpression mutant (applied.code === AMBIGUOUS -> true):
		// the ambiguous-specific wording must be present, not the not-found wording.
		expect(result.error_detail?.message).toContain("matches 2 locations");
		expect(result.error_detail?.message).not.toContain("not found");
	});

	it("OLD_STRING_NOT_FOUND: exact message text and empty file_changes_applied", () => {
		const p = join(dir, "notfound.txt");
		writeFileSync(p, "hello world", "utf-8");
		const result = runMultiEdit([
			{ path: p, edits: [{ old_string: "missing", new_string: "x" }] },
		]);
		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.OLD_STRING_NOT_FOUND);
		expect(result.file_changes_applied).toEqual([]);
		// Kills the StringLiteral mutant (message -> ``): exact text required.
		expect(result.error_detail?.message).toBe(
			"Edit 0: old_string not found in the current buffer.",
		);
	});

	it("no-op composition: ok:true and file_changes_applied is empty (not the fallback array)", () => {
		const p = join(dir, "noop.txt");
		writeFileSync(p, "same", "utf-8");
		// old_string === new_string composes to identical content -> changedOnly.length === 0.
		const result = runMultiEdit([{ path: p, edits: [{ old_string: "same", new_string: "same" }] }]);
		expect(result.ok).toBe(true);
		expect(result.file_changes_applied).toEqual([]);
		expect(result.file_changes_applied.length).toBe(0);
	});

	it("no-op composition across a real change that reverts: still ok:true, no gate call, no write call", () => {
		const p = join(dir, "revert.txt");
		writeFileSync(p, "value", "utf-8");
		const result = runMultiEdit([
			{
				path: p,
				edits: [
					{ old_string: "value", new_string: "other" },
					{ old_string: "other", new_string: "value" },
				],
			},
		]);
		expect(result.ok).toBe(true);
		expect(result.file_changes_applied).toEqual([]);
		// Kills the BlockStatement mutant ({} instead of the real no-op body):
		// gate/write must never be invoked when composition is a true no-op.
		expect(mockGate).not.toHaveBeenCalled();
		expect(mockWrite).not.toHaveBeenCalled();
	});

	it("a genuine content change DOES reach the gate (changedOnly.length === 0 branch is false)", () => {
		const p = join(dir, "changed.txt");
		writeFileSync(p, "value", "utf-8");
		mockGate.mockImplementationOnce(() => []);
		mockWrite.mockImplementationOnce(() => ({ ok: true }));
		const result = runMultiEdit([{ path: p, edits: [{ old_string: "value", new_string: "new" }] }]);
		expect(result.ok).toBe(true);
		expect(mockGate).toHaveBeenCalledTimes(1);
	});
});

describe("runMultiEdit — gate-rejected and write-failed branches", () => {
	it("GATE_REJECTED: file_changes_applied is empty, gate_failures carries through", () => {
		const p = join(dir, "gated.txt");
		writeFileSync(p, "old", "utf-8");
		mockGate.mockImplementationOnce(() => [
			{ path: p, tool: "biome", code: "lint/x", line: 1, message: "bad" },
		]);
		const result = runMultiEdit([{ path: p, edits: [{ old_string: "old", new_string: "new" }] }]);
		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.GATE_REJECTED);
		expect(result.file_changes_applied).toEqual([]);
		expect(result.gate_failures?.length).toBe(1);
	});

	it("gate passing (empty failures) proceeds to write instead of rejecting", () => {
		const p = join(dir, "gated2.txt");
		writeFileSync(p, "old2", "utf-8");
		mockGate.mockImplementationOnce(() => []);
		mockWrite.mockImplementationOnce(() => ({ ok: true }));
		const result = runMultiEdit([{ path: p, edits: [{ old_string: "old2", new_string: "new2" }] }]);
		expect(result.ok).toBe(true);
		expect(mockWrite).toHaveBeenCalledTimes(1);
	});

	it("WRITE_FAILED: file_changes_applied is empty, error_detail carries the failed path/message", () => {
		const p = join(dir, "writefail.txt");
		writeFileSync(p, "before", "utf-8");
		mockGate.mockImplementationOnce(() => []);
		mockWrite.mockImplementationOnce(() => ({
			ok: false,
			failedPath: p,
			message: "disk full",
		}));
		const result = runMultiEdit([{ path: p, edits: [{ old_string: "before", new_string: "after" }] }]);
		expect(result.ok).toBe(false);
		expect(result.error_code).toBe(MULTI_EDIT_ERROR_CODES.WRITE_FAILED);
		expect(result.file_changes_applied).toEqual([]);
		expect(result.error_detail?.path).toBe(p);
		expect(result.error_detail?.message).toBe("disk full");
	});
});

// ───────────────────────────────────────────────
// multiEditCommand — CLI action handler. Uses --json to get a machine
// readable payload via console.log, captured with a spy.
// ───────────────────────────────────────────────

function captureJson(spy: ReturnType<typeof vi.spyOn>): unknown {
	expect(spy).toHaveBeenCalled();
	const raw = parseWire(spy.mock.calls[spy.mock.calls.length - 1]?.[0], wireString, "test JSON value");
	return JSON.parse(raw);
}

describe("multiEditCommand — boolean/array literal survivors (all error branches)", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it("mutually-exclusive --stdin and --manifest: ok:false, empty file_changes_applied", async () => {
		await multiEditCommand(undefined, { stdin: true, manifest: "x.json", json: true });
		const payload = parseWire(captureJson(logSpy), wireObject({ "ok": wireBoolean, "file_changes_applied": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.ok).toBe(false);
		expect(payload.file_changes_applied).toEqual([]);
	});

	it("neither --stdin nor --manifest: ok:false, empty file_changes_applied", async () => {
		await multiEditCommand(undefined, { json: true });
		const payload = parseWire(captureJson(logSpy), wireObject({ "ok": wireBoolean, "file_changes_applied": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.ok).toBe(false);
		expect(payload.file_changes_applied).toEqual([]);
	});

	it("--manifest points at a missing file: ok:false READ_FAILED, empty file_changes_applied", async () => {
		const missing = join(dir, "no-manifest.json");
		await multiEditCommand(undefined, { manifest: missing, json: true });
		const payload = parseWire(captureJson(logSpy), wireObject({ "ok": wireBoolean, "error_code": wireString, "file_changes_applied": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.ok).toBe(false);
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.READ_FAILED);
		expect(payload.file_changes_applied).toEqual([]);
	});

	it("--manifest with invalid JSON: ok:false INVALID_MANIFEST, empty file_changes_applied", async () => {
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{ not valid json", "utf-8");
		await multiEditCommand(undefined, { manifest: bad, json: true });
		const payload = parseWire(captureJson(logSpy), wireObject({ "ok": wireBoolean, "error_code": wireString, "file_changes_applied": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.ok).toBe(false);
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST);
		expect(payload.file_changes_applied).toEqual([]);
	});

	it("--manifest with valid JSON but wrong shape: ok:false INVALID_MANIFEST from normalize, empty file_changes_applied", async () => {
		const bad = join(dir, "wrong-shape.json");
		writeFileSync(bad, JSON.stringify({ version: 1, nothing: true }), "utf-8");
		await multiEditCommand(undefined, { manifest: bad, json: true });
		const payload = parseWire(captureJson(logSpy), wireObject({ "ok": wireBoolean, "error_code": wireString, "file_changes_applied": wireArray(wireUnknown), "error_detail": wireAbsentOptional(wireOptional(wireObject({ "message": wireString }))) }), "test JSON value");
		expect(payload.ok).toBe(false);
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST);
		expect(payload.file_changes_applied).toEqual([]);
		expect(payload.error_detail?.message).toContain("edits");
	});

	it("--manifest read uses utf-8 decoding: a valid single-file manifest is parsed and applied", async () => {
		const target = join(dir, "target.txt");
		writeFileSync(target, "old-value", "utf-8");
		const manifest = join(dir, "manifest.json");
		writeFileSync(
			manifest,
			JSON.stringify({ version: 1, edits: [{ old_string: "old-value", new_string: "new-value" }] }),
			"utf-8",
		);
		mockGate.mockImplementationOnce(() => []);
		mockWrite.mockImplementationOnce(() => ({ ok: true }));
		await multiEditCommand(target, { manifest, json: true });
		const payload = parseWire(captureJson(logSpy), wireObject({ "ok": wireBoolean, "file_changes_applied": wireArray(wireString), "error_code": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
		// If the manifest read used a broken encoding, readFileSync would throw
		// and this would come back as READ_FAILED instead of a clean success —
		// and the JSON.parse of a garbled buffer-as-string would fail too.
		expect(payload.ok).toBe(true);
		expect(payload.error_code).toBeUndefined();
		expect(payload.file_changes_applied).toEqual([target]);
	});

	it("--stdin read failure: ok:false READ_FAILED, empty file_changes_applied", async () => {
		type Handler = (arg?: unknown) => void;
		const handlers: Record<string, Handler[]> = {};
		const fakeStdin = {
			setEncoding: vi.fn(),
			on(event: string, handler: Handler) {
				(handlers[event] ||= []).push(handler);
				return fakeStdin;
			},
		};
		const original = process.stdin;
		Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
		try {
			const promise = multiEditCommand(undefined, { stdin: true, json: true });
			// Fire the error handler asynchronously, like a real stream would.
			for (const h of handlers.error ?? []) h(new Error("stream broke"));
			await promise;
		} finally {
			Object.defineProperty(process, "stdin", { value: original, configurable: true });
		}
		const payload = parseWire(captureJson(logSpy), wireObject({ "ok": wireBoolean, "error_code": wireString, "file_changes_applied": wireArray(wireUnknown) }), "test JSON value");
		expect(payload.ok).toBe(false);
		expect(payload.error_code).toBe(MULTI_EDIT_ERROR_CODES.READ_FAILED);
		expect(payload.file_changes_applied).toEqual([]);
	});

	it("--stdin sets utf-8 encoding on the stream (kills the StringLiteral mutant to '')", async () => {
		type Handler = (arg?: unknown) => void;
		const handlers: Record<string, Handler[]> = {};
		const fakeStdin = {
			setEncoding: vi.fn(),
			on(event: string, handler: Handler) {
				(handlers[event] ||= []).push(handler);
				return fakeStdin;
			},
		};
		const original = process.stdin;
		Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
		try {
			const promise = multiEditCommand(undefined, { stdin: true, json: true });
			for (const h of handlers.data ?? []) h(JSON.stringify({ nothing: true }));
			for (const h of handlers.end ?? []) h();
			await promise;
		} finally {
			Object.defineProperty(process, "stdin", { value: original, configurable: true });
		}
		expect(fakeStdin.setEncoding).toHaveBeenCalledWith("utf-8");
		expect(fakeStdin.setEncoding).not.toHaveBeenCalledWith("");
	});
});

// ───────────────────────────────────────────────
// emit() — exercised only through multiEditCommand's stdout, covering
// gate_failures rendering paths (symbol e33225c6899b7685).
// ───────────────────────────────────────────────

describe("multiEditCommand — emit() gate_failures survivors (non-JSON human output)", () => {
	it("a gate rejection with zero failures still prints the header and 'No files changed.'", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const p = join(dir, "gate-human.txt");
		writeFileSync(p, "before", "utf-8");
		mockGate.mockImplementationOnce(() => []);
		mockWrite.mockImplementationOnce(() => ({
			ok: false,
			failedPath: p,
			message: "boom",
		}));
		const manifest = join(dir, "human-manifest.json");
		writeFileSync(
			manifest,
			JSON.stringify({ version: 1, edits: [{ old_string: "before", new_string: "after" }] }),
			"utf-8",
		);
		await multiEditCommand(p, { manifest, json: false });
		const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("multi-edit failed");
		expect(printed).toContain("No files changed.");
		// gate_failures is empty here (WRITE_FAILED path), so the
		// "N gate failure(s):" line must NOT appear — this kills the
		// `result.gate_failures.length > 0` mutants (true / >= 0), which
		// would wrongly render a gate-failure summary for a write failure.
		expect(printed).not.toContain("gate failure(s)");
		errSpy.mockRestore();
	});

	it("an actual gate rejection DOES print the gate failure summary with count and detail", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const p = join(dir, "gate-human2.txt");
		writeFileSync(p, "before2", "utf-8");
		mockGate.mockImplementationOnce(() => [
			{ path: p, tool: "biome", code: "lint/y", line: 3, message: "nope" },
		]);
		const manifest = join(dir, "human-manifest2.json");
		writeFileSync(
			manifest,
			JSON.stringify({ version: 1, edits: [{ old_string: "before2", new_string: "after2" }] }),
			"utf-8",
		);
		await multiEditCommand(p, { manifest, json: false });
		const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("1 gate failure(s):");
		expect(printed).toContain("lint/y");
		errSpy.mockRestore();
	});
});
