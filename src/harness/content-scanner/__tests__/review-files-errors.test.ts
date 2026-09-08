// Error-path tests for review-files.ts that the happy-path suite
// (review-files.test.ts, real tmpdir) can't reach: fs failures (disk full,
// corrupt JSON, races on readdir/stat/unlink) and the pruneStale TTL sweep's
// stale/fresh/malformed-entry branches. node:fs is mocked here (module-level
// vi.mock, per the ESM-namespace-not-configurable constraint) so every other
// test file in this package keeps using the real filesystem.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PathLike, Stats } from "node:fs";

const { readdirSyncMock, statSyncMock } = vi.hoisted(() => ({
	readdirSyncMock: vi.fn<(path: PathLike) => string[]>(),
	statSyncMock: vi.fn<(path: PathLike) => Stats>(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readdirSync: readdirSyncMock,
	readFileSync: vi.fn(),
	statSync: statSyncMock,
	unlinkSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

import {
	consumeDecision,
	listPendingReviews,
	readReview,
	writeDecision,
	writeReview,
} from "../review-files.js";

const existsSyncMock = vi.mocked(existsSync);
const mkdirSyncMock = vi.mocked(mkdirSync);
const readFileSyncMock = vi.mocked(readFileSync);
const unlinkSyncMock = vi.mocked(unlinkSync);
const writeFileSyncMock = vi.mocked(writeFileSync);

const { statSync: realStatSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
function statResult(mtimeMs: number): Stats {
	const result = realStatSync(new URL(import.meta.url));
	result.mtimeMs = mtimeMs;
	return result;
}

const CWD = "/repo";
const actor = { user: "u", host: "h", tty: null };
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	stderrSpy.mockRestore();
});

describe("writeReview — fs failure", () => {
	it("returns undefined without writing when the pending dir cannot be created", () => {
		existsSyncMock.mockReturnValue(false); // pending dir must be created
		mkdirSyncMock.mockImplementation(() => {
			throw new Error("mkdir denied");
		});

		const result = writeReview({
			cwd: CWD,
			key: "k1",
			url: "https://example.com",
			prompt: "p",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});

		expect(result).toBeUndefined();
		expect(writeFileSyncMock).not.toHaveBeenCalled();
		const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(written).toContain("mkdir denied");
	});

	it("logs an Error's .message and returns undefined when writeFileSync throws", () => {
		existsSyncMock.mockReturnValue(true); // pending dir already exists
		readdirSyncMock.mockImplementation(() => {
			throw new Error("no dir yet"); // pruneStale: caught, no-op
		});
		writeFileSyncMock.mockImplementation(() => {
			throw new Error("disk full");
		});

		const result = writeReview({
			cwd: CWD,
			key: "k1",
			url: "https://example.com",
			prompt: "p",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});

		expect(result).toBeUndefined();
		const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(written).toContain("disk full");
	});
});

describe("writeDecision — ensureDir and writeFileSync failures", () => {
	it("stringifies a non-Error throw from mkdirSync and returns undefined", () => {
		existsSyncMock.mockReturnValue(false); // pending dir must be created
		mkdirSyncMock.mockImplementation(() => {
			// eslint-disable-next-line no-throw-literal
			throw "boom"; // non-Error thrown value — exercises formatErr's String(e) arm
		});

		const result = writeDecision({ cwd: CWD, key: "k1", decision: "allow", actor });

		expect(result).toBeUndefined();
		const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(written).toContain("boom");
	});

	it("returns undefined and logs when writeFileSync throws after ensureDir succeeds", () => {
		existsSyncMock.mockReturnValue(true); // pending dir already exists
		writeFileSyncMock.mockImplementation(() => {
			throw new Error("permission denied");
		});

		const result = writeDecision({ cwd: CWD, key: "k1", decision: "allow", actor });

		expect(result).toBeUndefined();
		const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(written).toContain("permission denied");
	});
});

describe("readReview — fs failure", () => {
	it("returns undefined and logs when readFileSync throws", () => {
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockImplementation(() => {
			throw new Error("read fail");
		});

		expect(readReview(CWD, "k1")).toBeUndefined();
		const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(written).toContain("read fail");
	});
});

describe("listPendingReviews — readdirSync race", () => {
	it("returns [] when readdirSync throws after existsSync says the dir is there", () => {
		existsSyncMock.mockReturnValue(true);
		readdirSyncMock.mockImplementation(() => {
			throw new Error("dir vanished");
		});

		expect(listPendingReviews(CWD)).toEqual([]);
	});
});

describe("listPendingReviews — corrupt entry and equal-timestamp sort", () => {
	it("skips a review file that fails to parse, and tolerates equal timestamps", () => {
		existsSyncMock.mockImplementation((p) => !String(p).endsWith(".decision.json"));
		readdirSyncMock.mockReturnValue([
			"a.review.json",
			"b.review.json",
			"c.review.json",
		]);
		readFileSyncMock.mockImplementation((p) => {
			const path = String(p);
			if (path.endsWith("a.review.json")) return "not json";
			const key = path.endsWith("b.review.json") ? "b" : "c";
			return JSON.stringify({
				timestamp: "2026-01-01T00:00:00.000Z",
				url: `url-${key}`,
				prompt: "",
				tool_name: "WebFetch",
				body: "b",
				redacted_body: "b",
				findings: [],
				cache_key: key,
			});
		});

		const list = listPendingReviews(CWD);

		expect(list).toHaveLength(2);
		expect(list.map((r) => r.url).sort()).toEqual(["url-b", "url-c"]);
	});

	it("sorts 3 distinct-timestamp entries newest-first (exercises both comparator return arms)", () => {
		existsSyncMock.mockImplementation((p) => !String(p).endsWith(".decision.json"));
		readdirSyncMock.mockReturnValue([
			"x.review.json",
			"y.review.json",
			"z.review.json",
		]);
		const timestamps: Record<string, string> = {
			x: "2026-01-01T00:00:00.000Z",
			y: "2026-06-01T00:00:00.000Z",
			z: "2026-03-01T00:00:00.000Z",
		};
		readFileSyncMock.mockImplementation((p) => {
			const path = String(p);
			const key = path.endsWith("x.review.json") ? "x" : path.endsWith("y.review.json") ? "y" : "z";
			return JSON.stringify({
				timestamp: timestamps[key],
				url: `url-${key}`,
				prompt: "",
				tool_name: "WebFetch",
				body: "b",
				redacted_body: "b",
				findings: [],
				cache_key: key,
			});
		});

		const list = listPendingReviews(CWD);

		expect(list.map((r) => r.url)).toEqual(["url-y", "url-z", "url-x"]);
	});
});

describe("consumeDecision — unlink race", () => {
	it("does not throw when unlinkSync fails for an existing file", () => {
		existsSyncMock.mockReturnValue(true);
		unlinkSyncMock.mockImplementation(() => {
			throw new Error("unlink race");
		});

		expect(() => consumeDecision(CWD, "k1")).not.toThrow();
		expect(unlinkSyncMock.mock.calls).toEqual([
			["/repo/.interlinked/scanner/pending/k1.review.json"],
			["/repo/.interlinked/scanner/pending/k1.decision.json"],
		]);
	});
});

describe("pruneStale (via writeReview) — TTL sweep branches", () => {
	it("deletes only entries past the TTL, skips non-review/decision names, and tolerates a stat race", () => {
		existsSyncMock.mockReturnValue(true); // pending dir already exists
		readdirSyncMock.mockReturnValue([
			"old.review.json",
			"recent.decision.json",
			"ignore.txt",
			"broken.review.json",
		]);
		statSyncMock.mockImplementation((p) => {
			const path = String(p);
			if (path.endsWith("old.review.json")) {
				return statResult(Date.now() - 2 * 60 * 60 * 1000);
			}
			if (path.endsWith("recent.decision.json")) {
				return statResult(Date.now());
			}
			// broken.review.json: simulate a stat race
			throw new Error("stat race");
		});
		writeFileSyncMock.mockImplementation(() => undefined);

		const result = writeReview({
			cwd: CWD,
			key: "k1",
			url: "https://example.com",
			prompt: "p",
			toolName: "WebFetch",
			body: "b",
			redactedBody: "b",
			findings: [],
		});

		expect(result).toBeDefined();
		const unlinkedPaths = unlinkSyncMock.mock.calls.map((c) => String(c[0]));
		expect(unlinkedPaths.some((p) => p.endsWith("old.review.json"))).toBe(true);
		expect(unlinkedPaths.some((p) => p.endsWith("recent.decision.json"))).toBe(false);
		expect(unlinkedPaths.some((p) => p.endsWith("ignore.txt"))).toBe(false);
		expect(unlinkedPaths.some((p) => p.endsWith("broken.review.json"))).toBe(false);
		// statSync must never have been called for the non-matching name.
		const statPaths = statSyncMock.mock.calls.map((c) => String(c[0]));
		expect(statPaths.some((p) => p.endsWith("ignore.txt"))).toBe(false);
	});
});
