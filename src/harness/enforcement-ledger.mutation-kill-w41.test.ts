import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial node:fs mock: every wrapped function still calls through to the real
// implementation (so behavior against the real mkdtemp'd fixtures is
// unchanged) — only the CALL COUNT is observed. This is how several mutants
// below are distinguished even though their final return value happens to
// converge with the pristine value through a different code path.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		closeSync: vi.fn(actual.closeSync),
		existsSync: vi.fn(actual.existsSync),
		openSync: vi.fn(actual.openSync),
		readFileSync: vi.fn(actual.readFileSync),
		readSync: vi.fn(actual.readSync),
		statSync: vi.fn(actual.statSync),
	};
});

import {
	appendFileSync,
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyRow,
	enforcementLedgerPath,
	loadEnforcementLedger,
	updateEnforcementLedger,
} from "./enforcement-ledger.js";

const AT = "2026-08-22T00:00:00.000Z";
const AT2 = "2026-08-23T00:00:00.000Z";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "enf-ledger-w41-"));
	vi.clearAllMocks();
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeActivity(rows: unknown[]): void {
	writeFileSync(join(dir, "activity.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

describe("updateEnforcementLedger — fd lifecycle", () => {
	// test-contract: invariant — a successful read must close what it opened.
	it("P1: closes the opened descriptor via closeSync after a successful read", () => {
		writeActivity([{ type: "guard_block" }]);
		const result = updateEnforcementLedger(dir, AT);
		expect(result.blocked).toBe(1);
		expect(openSync).toHaveBeenCalledTimes(1);
		expect(closeSync).toHaveBeenCalledTimes(1);
	});

	// test-contract: boundary — nothing to close when open itself fails first.
	it("P2: does not attempt to close when openSync throws before a descriptor exists", () => {
		writeActivity([{ type: "guard_block" }]);
		vi.mocked(openSync).mockImplementationOnce(() => {
			throw new Error("boom");
		});
		const result = updateEnforcementLedger(dir, AT);
		expect(closeSync).not.toHaveBeenCalled();
		expect(result.blocked).toBe(0);
	});
});

describe("loadEnforcementLedger — short-circuit on missing file", () => {
	// test-contract: invariant — a missing ledger returns without attempting a read.
	it("P1: does not call readFileSync when the ledger file does not exist", () => {
		const result = loadEnforcementLedger(dir);
		expect(readFileSync).not.toHaveBeenCalled();
		expect(result).toEqual({ version: 1, since: "", cursor: 0, blocked: 0, caught: 0, evaluated: 0 });
	});
});

describe("updateEnforcementLedger — short-circuit on missing activity log", () => {
	// test-contract: invariant — a missing activity log returns without stat'ing it.
	it("P1: does not call statSync when activity.jsonl does not exist", () => {
		const result = updateEnforcementLedger(dir, AT);
		expect(statSync).not.toHaveBeenCalled();
		expect(result).toMatchObject({ blocked: 0, cursor: 0 });
	});
});

describe("updateEnforcementLedger — no-op pass skips the read path", () => {
	// test-contract: invariant — a second pass with no new bytes never reopens the file.
	it("P1: does not reopen the file when nothing new was appended", () => {
		writeActivity([{ type: "guard_block" }]);
		updateEnforcementLedger(dir, AT);
		vi.clearAllMocks();
		const second = updateEnforcementLedger(dir, AT);
		expect(openSync).not.toHaveBeenCalled();
		expect(second.blocked).toBe(1);
	});
});

describe("classifyRow — non-object guard", () => {
	// test-contract: boundary — the typeof guard must reject `undefined` before any property read.
	it("P1: undefined input contributes nothing and does not throw", () => {
		expect(classifyRow(undefined)).toEqual({ blocked: 0, caught: 0, evaluated: 0 });
	});
});

describe("updateEnforcementLedger — cold-start truncation", () => {
	// test-contract: invariant — an oversized first-ever read truncates to the
	// cold-start window; a row that predates the window is not counted.
	it("P1: a file larger than the cold-start window skips rows before the window", () => {
		const COLD_START_MAX_BYTES = 4 * 1024 * 1024;
		const early = `${JSON.stringify({ type: "guard_block" })}\n`;
		const padding = `${"x".repeat(COLD_START_MAX_BYTES + 200_000)}\n`;
		const late = `${JSON.stringify({ type: "guard_block" })}\n`;
		writeFileSync(join(dir, "activity.jsonl"), early + padding + late);
		const result = updateEnforcementLedger(dir, AT);
		expect(result.blocked).toBe(1);
	});
});

describe("updateEnforcementLedger — rotation rescans from the start", () => {
	// test-contract: invariant — a shrunk (rotated) log is rescanned from byte 0
	// and its rows are added on top of the previously accumulated totals.
	it("P1: rescans from the start after the log rotates smaller, adding to prior totals", () => {
		writeActivity([{ type: "guard_block" }, { type: "guard_block" }]);
		const first = updateEnforcementLedger(dir, AT);
		expect(first.blocked).toBe(2);

		writeActivity([{ type: "guard_block" }]);
		const after = updateEnforcementLedger(dir, AT);
		expect(after.blocked).toBe(3);
	});
});

describe("updateEnforcementLedger — no complete line yet", () => {
	// test-contract: boundary — with zero complete lines, nothing is counted or
	// persisted; the partial content is left whole for the next pass.
	it("P1: a file with no newline at all is left untouched (no `since` stamped)", () => {
		writeFileSync(join(dir, "activity.jsonl"), '{"unfinished');
		const result = updateEnforcementLedger(dir, AT);
		expect(result.since).toBe("");
		expect(result.blocked).toBe(0);
		expect(loadEnforcementLedger(dir).since).toBe("");
	});
});

describe("updateEnforcementLedger — trailing line without a newline", () => {
	// test-contract: boundary — content after the last newline is never counted
	// this pass, even if it happens to look like complete valid JSON.
	it("P1: a complete-looking row after the last newline is deferred, not counted", () => {
		writeFileSync(
			join(dir, "activity.jsonl"),
			`${JSON.stringify({ type: "guard_block" })}\n${JSON.stringify({ type: "guard_block" })}`,
		);
		expect(updateEnforcementLedger(dir, AT).blocked).toBe(1);
	});
});

describe("updateEnforcementLedger — cursor bookkeeping", () => {
	// test-contract: invariant — cursor lands exactly one byte past the last
	// counted newline, never re-reading or skipping bytes on the next pass.
	it("P1: cursor lands exactly at end-of-file when the log ends on a newline", () => {
		const line = `${JSON.stringify({ type: "guard_block" })}\n`;
		writeFileSync(join(dir, "activity.jsonl"), line);
		const result = updateEnforcementLedger(dir, AT);
		expect(result.cursor).toBe(line.length);
	});
});

describe("updateEnforcementLedger — since is stamped only once", () => {
	// test-contract: invariant — `since` records the FIRST fold's timestamp and
	// is never overwritten by a later call, even when new rows are appended.
	it("P1: since stays pinned to the first call's timestamp across a second call", () => {
		writeActivity([{ type: "guard_block" }]);
		const first = updateEnforcementLedger(dir, AT);
		expect(first.since).toBe(AT);

		appendFileSync(join(dir, "activity.jsonl"), `${JSON.stringify({ type: "guard_block" })}\n`);
		const second = updateEnforcementLedger(dir, AT2);
		expect(second.since).toBe(AT);
	});
});

describe("updateEnforcementLedger — persisted file formatting", () => {
	// test-contract: public-api — the persisted ledger is tab-indented so it is
	// readable/diffable on disk.
	it("P1: the persisted ledger.json is tab-indented", () => {
		writeActivity([{ type: "guard_block" }]);
		updateEnforcementLedger(dir, AT);
		// SAFETY: readFileSync is called with an explicit "utf8" encoding above,
		// so its return type is a string, not a Buffer.
		const raw = readFileSync(enforcementLedgerPath(dir), "utf8");
		expect(raw.includes("\t")).toBe(true);
	});
});
