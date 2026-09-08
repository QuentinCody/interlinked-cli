import { parseWire, wireString } from "../lib/value-validation.js";
// Behavioral coverage for failure-record.ts — the disk substrate for the
// local failure-recovery channel. We mock node:fs (capture the three writes
// without touching disk) and node:crypto's randomFillSync (deterministic
// UUIDv7 randomness) so every assertion is on real, reproducible output.

import { beforeEach, describe, expect, it, vi } from "vitest";

// node:fs — record what the module writes; the real disk is never touched.
vi.mock("node:fs", () => ({
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	appendFileSync: vi.fn(),
}));

// node:crypto — make randomFillSync deterministic. The default fill pattern
// is overridden per-test where the exact bytes matter.
vi.mock("node:crypto", () => ({
	randomFillSync: vi.fn((buf: Uint8Array) => {
		buf.fill(0);
		return buf;
	}),
}));

import { randomFillSync } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { nonNull } from "../lib/non-null.js";
import {
	failureRecordRelPath,
	mintFailureId,
	mintFailureIdFromTimestamp,
	writeFailureRecord,
} from "./failure-record.js";
import type { FailureRecord } from "./types.js";

const mkdirSyncMock = vi.mocked(mkdirSync);
const writeFileSyncMock = vi.mocked(writeFileSync);
const appendFileSyncMock = vi.mocked(appendFileSync);
const randomFillSyncMock = vi.mocked(randomFillSync);

function baseRecord(overrides: Partial<FailureRecord> = {}): FailureRecord {
	return {
		failure_id: "fail_0190a1b2-c3d4-7e5f-8000-000000000000",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Bash",
		timestamp: "2026-05-09T12:00:00.000Z",
		signature: "command-failed",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Restore the default deterministic fill (clearAllMocks wipes the impl).
	randomFillSyncMock.mockImplementation((buf) => {
		new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).fill(0);
		return buf;
	});
});

describe("writeFailureRecord", () => {
	it("creates the failures dir, writes the canonical record, appends the index row", () => {
		const record = baseRecord({
			tool_input: { command: "ls" },
			error_message: "boom",
		});
		writeFailureRecord(record, "/proj");

		// 1. mkdir -p .interlinked/failures under cwd.
		expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
		expect(mkdirSyncMock).toHaveBeenCalledWith("/proj/.interlinked/failures", {
			recursive: true,
		});

		// 2. Canonical record written as pretty JSON to <failure_id>.json.
		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
		const [recordPath, recordBody, recordEnc] = nonNull(writeFileSyncMock.mock.calls[0]);
		expect(recordPath).toBe(`/proj/.interlinked/failures/${record.failure_id}.json`);
		expect(recordEnc).toBe("utf-8");
		// Pretty-printed (2-space indent) and round-trips to the full record.
		expect(recordBody).toBe(JSON.stringify(record, null, 2));
		expect(JSON.parse(parseWire(recordBody, wireString, "test JSON value"))).toEqual(record);

		// 3. Index row appended as one JSONL line with the projected fields.
		expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
		const [indexPath, indexBody, indexEnc] = nonNull(appendFileSyncMock.mock.calls[0]);
		expect(indexPath).toBe("/proj/.interlinked/failures/index.jsonl");
		expect(indexEnc).toBe("utf-8");
		expect(indexBody).toBe(
			`${JSON.stringify({
				failure_id: record.failure_id,
				session_id: record.session_id,
				signature: record.signature,
				tool_name: record.tool_name,
				ts: record.timestamp,
			})}\n`,
		);
		// The index projects only the five summary fields (not the whole record).
		const parsedRow = JSON.parse((parseWire(indexBody, wireString, "test JSON value")).trimEnd());
		expect(parsedRow).toEqual({
			failure_id: record.failure_id,
			session_id: record.session_id,
			signature: record.signature,
			tool_name: record.tool_name,
			ts: record.timestamp,
		});
		expect(parsedRow.error_message).toBeUndefined();
	});

	it("propagates storage errors instead of swallowing them", () => {
		writeFileSyncMock.mockImplementationOnce(() => {
			throw new Error("ENOSPC");
		});
		expect(() => writeFailureRecord(baseRecord(), "/proj")).toThrow("ENOSPC");
		// mkdir ran first; the index append never happened because write threw.
		expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
		expect(appendFileSyncMock).not.toHaveBeenCalled();
	});
});

describe("failureRecordRelPath", () => {
	it("returns the cwd-relative path to the record JSON", () => {
		expect(failureRecordRelPath("fail_abc")).toBe(".interlinked/failures/fail_abc.json");
	});
});

describe("mintFailureId", () => {
	it("encodes the timestamp in the high 48 bits and stamps version/variant", () => {
		// All-random-zero (default mock) isolates the deterministic bits.
		// 0x0102030405 ms -> bytes 0..5 = 01 02 03 04 05 + low byte.
		const id = mintFailureId(0x010203040506);
		expect(id).toBe("fail_01020304-0506-7000-8000-000000000000");
		// Prefix + canonical UUID shape.
		expect(id).toMatch(
			/^fail_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		// randomFillSync was used to seed the 16-byte buffer.
		expect(randomFillSyncMock).toHaveBeenCalledTimes(1);
		expect(nonNull(randomFillSyncMock.mock.calls[0])).toHaveProperty([0,"length"], 16);
	});

	it("preserves the low nibble of byte 6 and low 6 bits of byte 8 from randomness", () => {
		// Fill every byte with 0xff so the masks are observable:
		// byte6 -> (0xff & 0x0f)|0x70 = 0x7f ; byte8 -> (0xff & 0x3f)|0x80 = 0xbf.
		randomFillSyncMock.mockImplementationOnce((buf) => {
			new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).fill(0xff);
			return buf;
		});
		const id = mintFailureId(0);
		// ts=0 -> first 6 bytes zero; byte6 hex "7f"; byte8 hex "bf".
		expect(id).toBe("fail_00000000-0000-7fff-bfff-ffffffffffff");
	});

	it("defaults `now` to Date.now() when omitted", () => {
		const spy = vi.spyOn(Date, "now").mockReturnValue(0x0a0b0c0d0e0f);
		try {
			const id = mintFailureId();
			expect(id).toBe("fail_0a0b0c0d-0e0f-7000-8000-000000000000");
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("zero-pads single-hex-digit bytes", () => {
		// ts whose encoded bytes include values < 0x10 forces padStart("0").
		const id = mintFailureId(0x000102030405);
		expect(id).toBe("fail_00010203-0405-7000-8000-000000000000");
	});
});

describe("mintFailureIdFromTimestamp", () => {
	it("throws when randomBytes is not exactly 10 bytes (too few)", () => {
		expect(() => mintFailureIdFromTimestamp(0, new Uint8Array(9))).toThrow(
			"mintFailureIdFromTimestamp expects 10 random bytes (got 9)",
		);
	});

	it("throws when randomBytes is not exactly 10 bytes (too many)", () => {
		expect(() => mintFailureIdFromTimestamp(0, new Uint8Array(11))).toThrow(
			"mintFailureIdFromTimestamp expects 10 random bytes (got 11)",
		);
	});

	it("lays out the timestamp, copies the 10 random bytes, and stamps version/variant", () => {
		const rand = new Uint8Array([
			0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
		]);
		const id = mintFailureIdFromTimestamp(0x010203040506, rand);
		// ts bytes 01..06; byte6 = (0xa1 & 0x0f)|0x70 = 0x71;
		// byte8 = (0xa3 & 0x3f)|0x80 = 0xa3 already has top bits 10 -> 0xa3.
		// random bytes map to positions 6..15 then masked at 6 and 8.
		expect(id).toBe("fail_01020304-0506-71a2-a3a4-a5a6a7a8a9aa");
		expect(id).toMatch(
			/^fail_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		// Does not touch the real RNG (deterministic seam).
		expect(randomFillSyncMock).not.toHaveBeenCalled();
	});

	it("is deterministic with all-zero random bytes (golden form)", () => {
		const id = mintFailureIdFromTimestamp(0, new Uint8Array(10));
		expect(id).toBe("fail_00000000-0000-7000-8000-000000000000");
	});

	it("masks version/variant nibbles when random bytes are 0xff", () => {
		const id = mintFailureIdFromTimestamp(0, new Uint8Array(10).fill(0xff));
		// byte6 -> 0x7f ; byte8 -> 0xbf ; rest 0xff.
		expect(id).toBe("fail_00000000-0000-7fff-bfff-ffffffffffff");
	});
});
