import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// unlinkSync is wrapped so the consumeDecision(existsSync-guard) test can
// observe whether it was actually invoked, without changing behavior for
// every other test (the wrapper still forwards to the real implementation).
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		unlinkSync: vi.fn(actual.unlinkSync),
	};
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	consumeDecision,
	countPendingReviews,
	listPendingReviews,
	parseDecisionPayload,
	parseReviewPayload,
	readDecision,
	readReview,
	writeReview,
} from "./review-files.js";

let cwd: string;
let dir: string;

// Fixed system clock: writeReview() timestamps its payload with
// `new Date().toISOString()` and pruneStale() computes its cutoff from
// `Date.now()`. Pinning the clock keeps every TTL assertion below
// deterministic (see interlinked:test_nondeterminism).
const FIXED_NOW = new Date("2024-06-01T00:00:00.000Z");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(FIXED_NOW);
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-files-w47-"));
	dir = path.join(cwd, ".interlinked", "scanner", "pending");
	vi.mocked(fs.unlinkSync).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(cwd, { recursive: true, force: true });
});

function baseReviewArgs(key: string) {
	return {
		cwd,
		key,
		url: "https://example.com",
		prompt: "p",
		toolName: "WebFetch",
		body: "body",
		redactedBody: "redacted",
		findings: [],
	};
}

function writeRawReview(key: string, obj: unknown) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${key}.review.json`), JSON.stringify(obj));
}

function writeRawDecision(key: string, obj: unknown) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${key}.decision.json`), JSON.stringify(obj));
}

function genuineReview(key: string) {
	return {
		timestamp: "2024-01-01T00:00:00.000Z",
		url: "u",
		prompt: "p",
		tool_name: "tn",
		body: "b",
		redacted_body: "rb",
		findings: [],
		cache_key: key,
	};
}

// ===========================================
// ensureDir (existsSync(dir) mutant 76ed2d26)
// ===========================================

describe("ensureDir via writeReview", () => {
	// test-contract: public-api — writeReview() must skip mkdir (and go
	// straight to the write attempt) once the pending dir already exists;
	// distinguishes ensureDir's existsSync(dir) check from an unconditional
	// mkdirSync call.
	it("skips mkdir and attempts the write when the pending dir already exists (even as a non-dir)", () => {
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		// Make the "pending" path itself a plain file, so existsSync(dir) is
		// true — ensureDir must short-circuit without calling mkdirSync.
		fs.writeFileSync(dir, "not a directory");
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = writeReview(baseReviewArgs("k"));
		expect(result).toBeUndefined();
		const messages = errSpy.mock.calls.map((c) => String(c[0]));
		expect(messages.some((m) => m.includes("cannot write"))).toBe(true);
		expect(messages.some((m) => m.includes("cannot create"))).toBe(false);
		errSpy.mockRestore();
	});
});

// ===========================================
// formatErr (BlockStatement mutant 6f4d2d2c) + readReview
// ===========================================

describe("readReview", () => {
	// test-contract: public-api — readReview()'s catch path must surface the
	// real Error#message via formatErr, not swallow it (formatErr's body
	// emptied would print "undefined").
	it("reports the real parse-error text, not undefined, for malformed JSON", () => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "badjson.review.json"), "{not valid json");
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = readReview(cwd, "badjson");
		expect(result).toBeUndefined();
		const msg = String(errSpy.mock.calls.at(-1)?.[0] ?? "");
		expect(msg).toContain("cannot read review");
		expect(msg).not.toMatch(/: undefined\n$/);
		errSpy.mockRestore();
	});

	// test-contract: public-api — a missing review file is the steady state
	// (not an error): readReview() must return undefined without writing to
	// stderr, distinguishing the existsSync(abs) guard from an unconditional
	// readFileSync attempt.
	it("returns undefined with no stderr write when the file does not exist", () => {
		fs.mkdirSync(dir, { recursive: true });
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = readReview(cwd, "missing-key");
		expect(result).toBeUndefined();
		expect(errSpy).not.toHaveBeenCalled();
		errSpy.mockRestore();
	});

	// test-contract: public-api — a well-formed review file must round-trip
	// through readReview(); pins the "utf-8" encoding argument to
	// readFileSync (an invalid encoding throws before JSON.parse runs).
	it("reads a valid payload back correctly (encoding must be utf-8)", () => {
		writeRawReview("goodpayload", genuineReview("goodpayload"));
		const result = readReview(cwd, "goodpayload");
		expect(result).toBeDefined();
		expect(result?.cache_key).toBe("goodpayload");
	});

	// test-contract: public-api — a schema-invalid (but syntactically valid)
	// review file must yield undefined, strictly (parseReviewPayload returns
	// null, and readReview's `!payload` guard converts that to undefined).
	it("returns undefined (strictly, not null) for a schema-invalid but valid-JSON review file", () => {
		writeRawReview("malformed", { foo: "bar" });
		const result = readReview(cwd, "malformed");
		expect(result).toBeUndefined();
	});
});

// ===========================================
// parseScanFinding / parseScanFindings / parseReviewPayload
// ===========================================

describe("parseReviewPayload", () => {
	const good = genuineReview("k");

	// test-contract: public-api — parseReviewPayload() rejects a non-object
	// top-level value (the isJsonObject guard).
	it("rejects a non-object top-level value", () => {
		expect(parseReviewPayload("nope")).toBeNull();
		expect(parseReviewPayload(null)).toBeNull();
	});

	// test-contract: public-api — parseReviewPayload() rejects a non-string
	// timestamp field.
	it("rejects a non-string timestamp", () => {
		expect(parseReviewPayload({ ...good, timestamp: 123 })).toBeNull();
	});

	// test-contract: public-api — parseReviewPayload() rejects a non-string
	// cache_key field.
	it("rejects a non-string cache_key", () => {
		expect(parseReviewPayload({ ...good, cache_key: 999 })).toBeNull();
	});

	// test-contract: public-api — parseReviewPayload() rejects findings that
	// are not an array (parseScanFindings' Array.isArray guard).
	it("rejects non-array findings", () => {
		expect(parseReviewPayload({ ...good, findings: {} })).toBeNull();
	});

	// test-contract: public-api — parseReviewPayload() rejects a findings
	// array whose entries are not objects (parseScanFinding's isJsonObject
	// guard, run per-entry).
	it("rejects a findings array whose entries are not objects", () => {
		expect(parseReviewPayload({ ...good, findings: ["not-an-object"] })).toBeNull();
	});

	// test-contract: public-api — a fully valid payload must parse.
	it("accepts a fully valid payload", () => {
		expect(parseReviewPayload(good)).not.toBeNull();
	});
});

// ===========================================
// listPendingReviews
// ===========================================

describe("listPendingReviews", () => {
	// test-contract: public-api — a review file readReview() can't parse
	// must be skipped, never thrown on (the `!review` continue guard).
	it("returns [] and never throws for a schema-invalid review file (!review guard)", () => {
		writeRawReview("bad", { foo: "bar" });
		expect(listPendingReviews(cwd)).toEqual([]);
	});

	// test-contract: public-api — a filename that does not end with
	// ".review.json" must never be processed as a review entry, even when
	// its stripped form would coincidentally collide with a real key.
	it("does not process a filename that does not end with .review.json", () => {
		// Genuine review file for key "k" plus a decoy whose slice(0,-13)
		// also lands on key "k" — only the genuine .review.json entry may
		// be counted.
		writeRawReview("k", genuineReview("k"));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "k1234567890123"), "");
		const result = listPendingReviews(cwd);
		expect(result).toHaveLength(1);
		expect(result[0]?.key).toBe("k");
	});

	// test-contract: public-api — the returned summary's `path` must come
	// from the ".review.json"-stripped key, not the raw directory entry
	// name (pins the exact suffix-slice, not just the endsWith guard).
	it("resolves the summary path from the stripped review key, not the raw filename", () => {
		writeRawReview("k", genuineReview("k"));
		// A second entry named exactly "k" (no suffix) that must be skipped.
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "k"), "");
		const result = listPendingReviews(cwd);
		expect(result).toHaveLength(1);
		const [summary] = result;
		expect(summary).toBeDefined();
		expect(summary?.path.endsWith(".review.json")).toBe(true);
	});

	// test-contract: public-api — listPendingReviews() sorts strictly
	// newest-first by payload timestamp, independent of on-disk filename
	// order (pins the sort comparator's direction).
	it("sorts strictly newest-first regardless of filename order", () => {
		writeRawReview("aaa", { ...genuineReview("aaa"), timestamp: "2025-01-01T00:00:00.000Z" });
		writeRawReview("bbb", { ...genuineReview("bbb"), timestamp: "2023-01-01T00:00:00.000Z" });
		writeRawReview("ccc", { ...genuineReview("ccc"), timestamp: "2024-01-01T00:00:00.000Z" });
		const result = listPendingReviews(cwd);
		expect(result.map((r) => r.key)).toEqual(["aaa", "ccc", "bbb"]);
	});
});

describe("countPendingReviews", () => {
	// test-contract: public-api — countPendingReviews() must equal
	// listPendingReviews().length for the same directory state.
	it("mirrors listPendingReviews length", () => {
		writeRawReview("only", genuineReview("only"));
		expect(countPendingReviews(cwd)).toBe(1);
	});
});

// ===========================================
// parseDecisionPayload / parseDecisionActor
// ===========================================

describe("parseDecisionPayload", () => {
	const good = {
		decision: "allow" as const,
		timestamp: "2024-01-01T00:00:00.000Z",
		cache_key: "k",
		// SAFETY: `tty` is deliberately typed as the union the parser accepts
		// (string | null) so the two negative cases below can widen it to an
		// invalid type via a spread override.
		actor: { user: "u", host: "h", tty: null },
	};

	// test-contract: public-api — parseDecisionPayload() rejects a
	// non-string `actor.user` field.
	it("rejects a non-string user", () => {
		expect(parseDecisionPayload({ ...good, actor: { ...good.actor, user: 123 } })).toBeNull();
	});

	// test-contract: public-api — parseDecisionPayload() rejects an
	// `actor.tty` that is neither null nor a string.
	it("rejects a tty that is neither null nor a string", () => {
		expect(parseDecisionPayload({ ...good, actor: { ...good.actor, tty: 42 } })).toBeNull();
	});

	// test-contract: public-api — a fully valid decision payload must parse.
	it("accepts a fully valid payload", () => {
		expect(parseDecisionPayload(good)).not.toBeNull();
	});
});

// ===========================================
// readDecision
// ===========================================

describe("readDecision", () => {
	// test-contract: public-api — a missing decision file is the steady
	// state: readDecision() must return undefined without writing to
	// stderr (the existsSync(abs) guard).
	it("returns undefined with no stderr write when the file does not exist", () => {
		fs.mkdirSync(dir, { recursive: true });
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = readDecision(cwd, "missing");
		expect(result).toBeUndefined();
		expect(errSpy).not.toHaveBeenCalled();
		errSpy.mockRestore();
	});

	// test-contract: public-api — a well-formed decision file must
	// round-trip through readDecision() (pins the "utf-8" encoding
	// argument to readFileSync).
	it("reads a valid decision payload back correctly (encoding must be utf-8)", () => {
		writeRawDecision("k5", {
			decision: "allow",
			timestamp: "2024-01-01T00:00:00.000Z",
			cache_key: "k5",
			actor: { user: "u", host: "h", tty: null },
		});
		const result = readDecision(cwd, "k5");
		expect(result).toBeDefined();
		expect(result?.decision).toBe("allow");
	});

	// test-contract: public-api — a schema-invalid (but syntactically valid)
	// decision file must yield undefined, strictly (the `!payload` guard).
	it("returns undefined (strictly, not null) for a schema-invalid decision file", () => {
		writeRawDecision("bad", { foo: "bar" });
		const result = readDecision(cwd, "bad");
		expect(result).toBeUndefined();
	});

	// test-contract: public-api — readDecision()'s catch path must surface
	// the real parse-error text via formatErr, using the documented
	// "cannot read decision" prefix.
	it("reports the real parse-error text on malformed JSON", () => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "badjson.decision.json"), "{not valid");
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const result = readDecision(cwd, "badjson");
		expect(result).toBeUndefined();
		const msg = String(errSpy.mock.calls.at(-1)?.[0] ?? "");
		expect(msg).toContain("cannot read decision");
		errSpy.mockRestore();
	});
});

// ===========================================
// consumeDecision
// ===========================================

describe("consumeDecision", () => {
	// test-contract: public-api — consumeDecision() must consult
	// existsSync(abs) before calling unlinkSync, so it is a true no-op
	// (no filesystem write attempted) when neither file is present.
	it("does not call unlinkSync when neither file exists", () => {
		consumeDecision(cwd, "totally-absent-key");
		expect(fs.unlinkSync).not.toHaveBeenCalled();
	});

	// test-contract: public-api — consumeDecision() removes both the review
	// and decision files for a key when they do exist.
	it("removes both files when they exist", () => {
		writeRawReview("k6", genuineReview("k6"));
		writeRawDecision("k6", {
			decision: "allow",
			timestamp: "2024-01-01T00:00:00.000Z",
			cache_key: "k6",
			actor: { user: "u", host: "h", tty: null },
		});
		consumeDecision(cwd, "k6");
		expect(fs.existsSync(path.join(dir, "k6.review.json"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "k6.decision.json"))).toBe(false);
	});
});

// ===========================================
// pruneStale (via writeReview, which calls it internally) + REVIEW_TTL_MS
// ===========================================

describe("pruneStale (exercised through writeReview)", () => {
	function setMtime(p: string, msAgo: number) {
		const t = new Date(FIXED_NOW.getTime() - msAgo);
		fs.utimesSync(p, t, t);
	}

	// test-contract: invariant — pruneStale() (run as part of every
	// writeReview call) deletes review/decision files older than
	// REVIEW_TTL_MS, leaves unrelated extensions and fresh files alone.
	// Distinguishes the real GC pass from a no-op body, a skip-all
	// condition, a process-all condition, and the endsWith/startsWith swap.
	it("deletes stale review/decision files, spares unrelated and fresh ones", () => {
		fs.mkdirSync(dir, { recursive: true });
		const staleReview = path.join(dir, "stale.review.json");
		const staleDecision = path.join(dir, "stale.decision.json");
		const staleOther = path.join(dir, "stale.txt");
		const freshReview = path.join(dir, "fresh.review.json");

		fs.writeFileSync(staleReview, "{}");
		fs.writeFileSync(staleDecision, "{}");
		fs.writeFileSync(staleOther, "unrelated");
		fs.writeFileSync(freshReview, "{}");

		const oneHourMs = 60 * 60 * 1000;
		setMtime(staleReview, oneHourMs + 60_000);
		setMtime(staleDecision, oneHourMs + 60_000);
		setMtime(staleOther, oneHourMs + 60_000);
		// freshReview keeps the fixed "current" mtime.

		// Trigger pruneStale as a side effect of writing a new review.
		writeReview(baseReviewArgs("newkey"));

		expect(fs.existsSync(staleReview)).toBe(false);
		expect(fs.existsSync(staleDecision)).toBe(false);
		expect(fs.existsSync(staleOther)).toBe(true);
		expect(fs.existsSync(freshReview)).toBe(true);
	});

	// test-contract: invariant — REVIEW_TTL_MS is one hour (60*60*1000ms),
	// not one second (60/60*1000ms); a file 5s old must survive a prune pass.
	it("uses a one-hour TTL, not a one-second one", () => {
		fs.mkdirSync(dir, { recursive: true });
		const nearlyStale = path.join(dir, "nearly.review.json");
		fs.writeFileSync(nearlyStale, "{}");
		setMtime(nearlyStale, 5_000); // 5s old: well under 1hr, well over 1s.

		writeReview(baseReviewArgs("newkey2"));

		expect(fs.existsSync(nearlyStale)).toBe(true);
	});
});
