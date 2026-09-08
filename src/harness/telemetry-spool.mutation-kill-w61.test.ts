import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wrap the fs functions the module under test relies on so we can both spy
// on calls AND keep real filesystem behavior (all tests use a real tmp dir).
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		readFileSync: vi.fn(actual.readFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
		appendFileSync: vi.fn(actual.appendFileSync),
		mkdirSync: vi.fn(actual.mkdirSync),
		statSync: vi.fn(actual.statSync),
	};
});

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	createTelemetrySpool,
	parseJsonl,
	redactSecretsShallow,
	truncateFilePaths,
	type SpoolEvent,
} from "./telemetry-spool.js";

let dir: string;
let spoolPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "telemetry-spool-w61-"));
	spoolPath = join(dir, "spool.jsonl");
	vi.clearAllMocks();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("trim_threshold — kills cec0b9babaf3eb64 (?? vs &&)", () => {
	// test-contract: public-api — TelemetrySpoolOptions.trim_threshold must be
	// used verbatim (via `??`), not discarded in favor of DEFAULT_TRIM_THRESHOLD.
	it("honors an explicit truthy trim_threshold rather than always using the default", () => {
		const evt: SpoolEvent = { schema: "v1", kind: "hook_decision", ts: "t" };
		const lineBytes = Buffer.byteLength(`${JSON.stringify(evt)}\n`, "utf-8");
		// maxBytes chosen so 3 appended lines land strictly between
		// 0.5*maxBytes (our explicit threshold) and 0.9*maxBytes (the default
		// the buggy `&&` mutant would fall back to).
		const maxBytes = 5 * lineBytes;
		const spool = createTelemetrySpool({ spoolPath, max_bytes: maxBytes, trim_threshold: 0.5 });
		spool.append({ ...evt });
		spool.append({ ...evt });
		spool.append({ ...evt });
		const rawTotal = 3 * lineBytes;
		// Under the real ?? semantics, 3*lineBytes >= 0.5*maxBytes (=2.5*lineBytes)
		// triggers a compaction, shrinking the on-disk size below the raw total.
		// Under the `&&` mutant, threshold becomes 0.9 unconditionally, so
		// 3*lineBytes (< 0.9*maxBytes = 4.5*lineBytes) never triggers a compact
		// and the size stays exactly at rawTotal.
		expect(spool.size().bytes).toBeLessThan(rawTotal);
	});
});

describe("missing-file early returns — kills 92c47a40e6a76c5d, fca79e42bf37e5d9", () => {
	// test-contract: invariant — readAll()/compact() must short-circuit on
	// `!existsSync(spoolPath)` before ever touching readFileSync.
	it("readAll() on a nonexistent spool never calls readFileSync", () => {
		const spool = createTelemetrySpool({ spoolPath });
		vi.clearAllMocks();
		const result = spool.readAll();
		expect(result).toEqual([]);
		expect(readFileSync).not.toHaveBeenCalled();
	});

	// test-contract: invariant — same existsSync short-circuit inside doCompact.
	it("compact() on a nonexistent spool never calls readFileSync", () => {
		const spool = createTelemetrySpool({ spoolPath });
		vi.clearAllMocks();
		const result = spool.compact();
		expect(result).toEqual({ removed: 0, kept: 0 });
		expect(readFileSync).not.toHaveBeenCalled();
	});
});

describe("doCompact leaves unparsable spool content untouched — kills 759c3c0e3b2976ce", () => {
	// test-contract: invariant — `events.length === 0` must early-return before
	// any writeFileSync, so an unparsable-but-existing spool is never rewritten.
	it("does not overwrite the file when no line parses as a valid event", () => {
		const garbage = "not valid json at all\nneither is this\n";
		writeFileSync(spoolPath, garbage);
		const spool = createTelemetrySpool({ spoolPath });
		const result = spool.compact();
		expect(result).toEqual({ removed: 0, kept: 0 });
		// The early `events.length === 0` return must skip the writeFileSync
		// entirely, leaving the garbage content exactly as it was.
		expect(readFileSync(spoolPath, "utf-8")).toBe(garbage);
	});
});

describe("empty kept-list serialization — kills fb767d833cf1c197, 1aac566a58157869, 54ea0352c49354a8", () => {
	// test-contract: invariant — `kept.length > 0 ? "\n" : ""` must produce the
	// exact empty string (not "\n" or a placeholder) when nothing is kept.
	it("writes an exactly-empty file when every event is trimmed away", () => {
		// A tiny budget with only non-preferred events guarantees kept=[].
		const evt: SpoolEvent = { schema: "v1", kind: "hook_decision", ts: "t" };
		writeFileSync(spoolPath, `${JSON.stringify(evt)}\n`);
		const spool = createTelemetrySpool({ spoolPath, max_bytes: 4 }); // target = 2 bytes
		const result = spool.compact();
		expect(result.kept).toBe(0);
		expect(readFileSync(spoolPath, "utf-8")).toBe("");
	});
});

describe("ensureDir skips mkdirSync when the directory already exists — kills a1542aef3b651c87", () => {
	// test-contract: invariant — `!existsSync(dir)` must gate mkdirSync so an
	// existing directory is never redundantly (re-)created.
	it("does not call mkdirSync for an existing directory", () => {
		// `dir` (from mkdtempSync) already exists.
		vi.clearAllMocks();
		createTelemetrySpool({ spoolPath });
		expect(mkdirSync).not.toHaveBeenCalled();
	});

	// test-contract: invariant — companion positive case: a genuinely missing
	// directory must still be created (guards against an over-broad "never call" fix).
	it("does call mkdirSync for a genuinely missing directory", () => {
		const missingDir = join(dir, "nested", "deeper");
		const nestedSpoolPath = join(missingDir, "spool.jsonl");
		vi.clearAllMocks();
		createTelemetrySpool({ spoolPath: nestedSpoolPath });
		expect(mkdirSync).toHaveBeenCalled();
		expect(existsSync(missingDir)).toBe(true);
	});
});

describe("parseJsonl skips blank lines without re-parsing them — kills 72e7f273f0301624", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// test-contract: public-api — `parseJsonl` must never hand an empty line to
	// JSON.parse; the `line.length === 0` continue is the only thing preventing that.
	it("calls JSON.parse only for non-empty lines", () => {
		const parseSpy = vi.spyOn(JSON, "parse");
		const text = "\n\n{\"schema\":\"v1\",\"kind\":\"custom\",\"ts\":\"t\"}\n\n";
		const events = parseJsonl(text);
		expect(events).toHaveLength(1);
		// Only the one non-empty line should ever reach JSON.parse; the
		// mutant that disables the `line.length === 0` skip would call
		// JSON.parse for every blank line too.
		expect(parseSpy).toHaveBeenCalledTimes(1);
	});
});

describe("truncateFilePaths guards non-string file_path — kills 07d1546cff988b42", () => {
	// test-contract: public-api — exported `truncateFilePaths`; the
	// `typeof out.file_path === "string"` check must short-circuit the `&&`
	// before `.length` is read on a non-string (e.g. absent) file_path.
	it("does not throw when file_path is absent", () => {
		const evt: SpoolEvent = { schema: "v1", kind: "custom", ts: "t" };
		expect(() => truncateFilePaths(evt)).not.toThrow();
		expect(truncateFilePaths(evt)).toEqual(evt);
	});
});

describe("PREFERRED_KINDS membership — kills b5242e03f496a6b6, d8f05f11acfc239d, f25b81bee5cdc105", () => {
	// test-contract: public-api — `compact()`/`readAll()` observable output;
	// PREFERRED_KINDS must literally contain "session_lifecycle" and
	// "check_finding" for the doc'd ring-buffer preservation policy to hold.
	it("keeps session_lifecycle and check_finding events even when the byte budget is exhausted", () => {
		const lifecycle: SpoolEvent = { schema: "v1", kind: "session_lifecycle", ts: "t0" };
		const finding: SpoolEvent = { schema: "v1", kind: "check_finding", ts: "t1" };
		const decision: SpoolEvent = { schema: "v1", kind: "hook_decision", ts: "t2" };
		const content = [lifecycle, finding, decision].map((e) => JSON.stringify(e)).join("\n") + "\n";
		writeFileSync(spoolPath, content);
		// max_bytes=10 -> target=5 bytes, far smaller than any single event's
		// JSON encoding, so every event is "over budget" and only the
		// `preferred` override can save session_lifecycle / check_finding.
		const spool = createTelemetrySpool({ spoolPath, max_bytes: 10 });
		spool.compact();
		const kept = spool.readAll();
		const kinds = kept.map((e) => e.kind);
		expect(kinds).toContain("session_lifecycle");
		expect(kinds).toContain("check_finding");
		expect(kinds).not.toContain("hook_decision");
	});
});

describe("redactSecretsShallow removes a present secrets field (baseline sanity)", () => {
	// test-contract: public-api — exported `redactSecretsShallow`; baseline for
	// the "secrets" in out" branch (companion to the still-open c330308f
	// always-true mutant, which is unobservable on the "not present" side).
	it("strips secrets when present", () => {
		// SAFETY: `secrets` is intentionally not part of the base SpoolEvent
		// shape; it is an ad-hoc extra field the redactor is documented to strip.
		const evt: SpoolEvent = { schema: "v1", kind: "custom", ts: "t", secrets: "leak" };
		const out = redactSecretsShallow(evt);
		expect("secrets" in out).toBe(false);
	});
});
