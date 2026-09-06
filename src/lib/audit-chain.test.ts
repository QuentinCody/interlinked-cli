import { createHash } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendChainedAuditRecord,
	canonicalJson,
	computeEntryHash,
	GENESIS_HASH,
	getActivityPath,
	iterateFileLines,
	verifyAuditChain,
	verifyAuditChainStreaming,
} from "./audit-chain.js";

type ChainedRecordType = "guard_block" | "guard_warn" | "guard_allow" | "session_end";

function makeEntry(opts: {
	previousHash: string;
	type?: ChainedRecordType;
	ts?: string;
	tool?: string;
	reason?: string;
}): Record<string, unknown> {
	const base: Record<string, unknown> = {
		schema_version: 3,
		ts: opts.ts ?? "2026-05-26T10:00:00.000Z",
		agent: "claude",
		type: opts.type ?? "guard_allow",
		tool: opts.tool ?? "Bash",
		summary: opts.reason ?? "ok",
		previousHash: opts.previousHash,
	};
	base.hash = computeEntryHash(base);
	return base;
}

function makeSessionEndEntry(opts: {
	previousHash: string;
	ts?: string;
	reason?: string;
}): Record<string, unknown> {
	const base: Record<string, unknown> = {
		schema_version: 4,
		ts: opts.ts ?? "2026-05-26T10:30:00.000Z",
		agent: "claude",
		type: "session_end",
		reason: opts.reason ?? "prompt_input_exit",
		previousHash: opts.previousHash,
	};
	base.hash = computeEntryHash(base);
	return base;
}

function writeJsonl(path: string, records: Record<string, unknown>[]): void {
	const dir = join(path, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const text = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
	writeFileSync(path, text);
}

async function writeGzipChunks(
	path: string,
	chunks: Iterable<string> | AsyncIterable<string>,
): Promise<void> {
	await pipeline(Readable.from(chunks), createGzip(), createWriteStream(path));
}

describe("canonicalJson", () => {
	it("sorts top-level keys", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	it("sorts nested-object keys recursively", () => {
		expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
	});

	it("preserves array order", () => {
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
	});

	it("renders null as the literal 'null' (not the object branch)", () => {
		expect(canonicalJson(null)).toBe("null");
	});
});

describe("computeEntryHash", () => {
	it("ignores the hash field when computing", () => {
		const a = { a: 1, b: 2 };
		const b = { ...a, hash: "ffff" };
		expect(computeEntryHash(a)).toBe(computeEntryHash(b));
	});

	it("matches a sha256 of canonical JSON minus the hash field", () => {
		const record = { ts: "2026-05-26", type: "guard_block", previousHash: GENESIS_HASH };
		const expected = createHash("sha256").update(canonicalJson(record)).digest("hex");
		expect(computeEntryHash(record)).toBe(expected);
	});
});

describe("appendChainedAuditRecord", () => {
	let tmp: string;
	let activityPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "audit-chain-append-"));
		activityPath = getActivityPath(tmp);
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function readLastRecord(): Record<string, unknown> {
		const lines = readFileSync(activityPath, "utf8").trim().split("\n");
		return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
	}

	it("chains onto the most recent chained entry already on disk", () => {
		const existing = makeEntry({ previousHash: GENESIS_HASH });
		writeJsonl(activityPath, [existing]);

		appendChainedAuditRecord(
			{ type: "guard_allow", ts: "2026-05-26T10:05:00.000Z", tool: "Bash" },
			tmp,
		);

		const appended = readLastRecord();
		expect(appended.previousHash).toBe(existing.hash as string);
	});

	it("falls back to GENESIS_HASH when the file exists but holds no chainable entry", () => {
		writeJsonl(activityPath, [
			{ ts: "2026-05-26T10:00:00.000Z", type: "prompt_input", summary: "hi" },
		]);

		appendChainedAuditRecord(
			{ type: "guard_allow", ts: "2026-05-26T10:05:00.000Z", tool: "Bash" },
			tmp,
		);

		const appended = readLastRecord();
		expect(appended.previousHash).toBe(GENESIS_HASH);
	});

	it("rejects a record type that does not participate in the hash chain", () => {
		expect(() => appendChainedAuditRecord({ type: "prompt_input" }, tmp)).toThrow(
			"only chained audit record types may use appendChainedAuditRecord",
		);
	});
});

describe("verifyAuditChain", () => {
	let tmp: string;
	let activityPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "audit-chain-"));
		activityPath = join(tmp, ".interlinked", "activity.jsonl");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns valid + zero counts when activity.jsonl is missing", () => {
		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.total_events).toBe(0);
		expect(res.guard_events).toBe(0);
		expect(res.chained_events).toBe(0);
	});

	it("verifies a single entry chained from genesis", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		writeJsonl(activityPath, [e1]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.guard_events).toBe(1);
		expect(res.chained_events).toBe(1);
		expect(res.last_hash).toBe(e1.hash as string);
	});

	it("verifies a 3-entry chain end-to-end", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH, ts: "2026-05-26T10:00:00.000Z" });
		const e2 = makeEntry({
			previousHash: e1.hash as string,
			type: "guard_block",
			ts: "2026-05-26T10:00:01.000Z",
		});
		const e3 = makeEntry({
			previousHash: e2.hash as string,
			type: "guard_warn",
			ts: "2026-05-26T10:00:02.000Z",
		});
		writeJsonl(activityPath, [e1, e2, e3]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.chained_events).toBe(3);
		expect(res.last_hash).toBe(e3.hash as string);
	});

	it("detects a tampered payload field", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const e2 = makeEntry({ previousHash: e1.hash as string, ts: "2026-05-26T10:00:01.000Z" });
		// Tamper: rewrite reason but keep stored hash — verify must recompute and fail.
		const tampered = { ...e2, summary: "altered" };
		writeJsonl(activityPath, [e1, tampered]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_index).toBe(1);
		expect(res.first_bad_reason).toMatch(/hash mismatch/);
	});

	it("detects a broken previousHash link", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		// Wrong previousHash. Recompute hash so the *entry's own* hash matches its
		// claimed payload — verify must still fail because the link is wrong.
		const linkBroken = makeEntry({
			previousHash: "deadbeef".repeat(8),
			ts: "2026-05-26T10:00:01.000Z",
		});
		writeJsonl(activityPath, [e1, linkBroken]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_index).toBe(1);
		expect(res.first_bad_reason).toMatch(/previousHash mismatch/);
	});

	it("counts non-guard records but does not chain them", () => {
		const transcript = {
			ts: "2026-05-26T10:00:00.000Z",
			agent: "claude",
			type: "post_tool_use",
			tool: "Read",
			summary: "transcript line",
		};
		const e1 = makeEntry({ previousHash: GENESIS_HASH, ts: "2026-05-26T10:00:01.000Z" });
		writeJsonl(activityPath, [transcript, e1]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.total_events).toBe(2);
		expect(res.guard_events).toBe(1);
		expect(res.chained_events).toBe(1);
	});

	it("counts hashless legacy guard entries as unchained, not tamper", () => {
		const legacy = {
			ts: "2026-05-26T10:00:00.000Z",
			agent: "claude",
			type: "guard_block",
			tool: "Bash",
			summary: "legacy entry without hash",
		};
		const e1 = makeEntry({ previousHash: GENESIS_HASH, ts: "2026-05-26T10:00:01.000Z" });
		writeJsonl(activityPath, [legacy, e1]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.guard_events).toBe(2);
		expect(res.chained_events).toBe(1);
		expect(res.unchained_guard_events).toBe(1);
	});

	it("chains a session_end record from a guard_allow predecessor", () => {
		const e1 = makeEntry({
			previousHash: GENESIS_HASH,
			type: "guard_allow",
			ts: "2026-05-26T10:00:00.000Z",
		});
		const e2 = makeSessionEndEntry({
			previousHash: e1.hash as string,
			ts: "2026-05-26T10:30:00.000Z",
			reason: "prompt_input_exit",
		});
		writeJsonl(activityPath, [e1, e2]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.guard_events).toBe(2);
		expect(res.chained_events).toBe(2);
		expect(res.last_hash).toBe(e2.hash as string);
	});

	it("detects a session_end record whose reason was rewritten post-hash", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const e2 = makeSessionEndEntry({
			previousHash: e1.hash as string,
			ts: "2026-05-26T10:30:00.000Z",
			reason: "logout",
		});
		// Tamper: rewrite reason after the hash was computed.
		const tampered = { ...e2, reason: "other" };
		writeJsonl(activityPath, [e1, tampered]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_index).toBe(1);
		expect(res.first_bad_reason).toMatch(/hash mismatch/);
	});

	it("fails closed on a malformed JSONL line", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const broken = "{not valid json";
		const e2 = makeEntry({
			previousHash: e1.hash as string,
			ts: "2026-05-26T10:00:01.000Z",
		});
		// Manually compose so we control line order
		const dir = join(tmp, ".interlinked");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(
			activityPath,
			`${JSON.stringify(e1)}\n${broken}\n${JSON.stringify(e2)}\n`,
		);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.chained_events).toBe(1);
		expect(res.first_bad_line_number).toBe(2);
		expect(res.first_bad_reason).toMatch(/invalid audit row.*malformed JSON/);
	});

	it("fails closed on a JSON object whose type field is not a string", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const nonStringType = { ...e1, type: 42 };
		writeJsonl(activityPath, [nonStringType]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.total_events).toBe(1);
		expect(res.guard_events).toBe(0);
		expect(res.first_bad_reason).toMatch(/no valid type/);
	});

	it("N1: fails closed when a physical row is valid JSON but not an audit object", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const e2 = makeEntry({ previousHash: e1.hash as string, ts: "2026-05-26T10:00:01.000Z" });
		const dir = join(tmp, ".interlinked");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(
			activityPath,
			`${JSON.stringify(e1)}\n[1,2,3]\n42\n${JSON.stringify(e2)}\n`,
		);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.total_events).toBe(2);
		expect(res.guard_events).toBe(1);
		expect(res.chained_events).toBe(1);
		expect(res.first_bad_line_number).toBe(2);
		expect(res.first_bad_reason).toMatch(/not a JSON object/);
	});

	it("fails closed on an unterminated malformed tail instead of certifying the prefix", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const dir = join(tmp, ".interlinked");
		mkdirSync(dir, { recursive: true });
		writeFileSync(activityPath, `${JSON.stringify(e1)}\n{"type":"guard_allow"`);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.chained_events).toBe(1);
		expect(res.first_bad_line_number).toBe(2);
		expect(res.first_bad_reason).toMatch(/invalid audit row.*malformed JSON/);
	});

	it("fails the streaming production verifier closed on an unterminated malformed tail", async () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(activityPath, `${JSON.stringify(e1)}\n{"type":"guard_block"`);

		const res = await verifyAuditChainStreaming(tmp);
		expect(res.valid).toBe(false);
		expect(res.chained_events).toBe(1);
		expect(res.first_bad_line_number).toBe(2);
		expect(res.first_bad_reason).toMatch(/invalid audit row.*malformed JSON/);
	});

	it("P1: a record carrying only the fields computeEntryHash expects still chains and hashes byte-identically", () => {
		// Pins that narrowing the parsed JSON via isJsonObject is a pure
		// pass-through: every field on the original record — not just the
		// ones this module happens to read — survives into the hash input.
		const e1: Record<string, unknown> = {
			ts: "2026-05-26T10:00:00.000Z",
			type: "guard_block",
			previousHash: GENESIS_HASH,
			extra_field_untouched_by_any_reader: { nested: [1, 2, 3] },
		};
		e1.hash = computeEntryHash(e1);
		writeJsonl(activityPath, [e1]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.chained_events).toBe(1);
		expect(res.last_hash).toBe(e1.hash);
	});

	it("treats a chained record with a missing previousHash as a mismatch and reports '(missing)'", () => {
		const record = { type: "guard_allow", hash: "a".repeat(64) };
		writeJsonl(activityPath, [record]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toMatch(/previousHash mismatch/);
		expect(res.first_bad_reason).toMatch(/\(missing\)/);
	});

	it("treats a same-length-but-unequal-byte-length previousHash as a mismatch (safeEqualHex catch path)", () => {
		// A 32-codepoint astral-plane string has JS .length === 64 (surrogate
		// pairs) but encodes to 128 UTF-8 bytes — Buffer.from(...).length
		// differs even though the .length guard passed, so
		// node:crypto.timingSafeEqual throws and safeEqualHex's catch
		// returns false rather than propagating.
		const astral64 = "\u{1D7D9}".repeat(32);
		expect(astral64.length).toBe(64);
		const record = { type: "guard_allow", hash: "b".repeat(64), previousHash: astral64 };
		writeJsonl(activityPath, [record]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toMatch(/previousHash mismatch/);
	});

	it("fails closed with a reason when activity.jsonl exists but cannot be read as a file", () => {
		mkdirSync(activityPath, { recursive: true }); // a directory in place of the file
		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toMatch(/^activity\.jsonl unreadable:/);
	});
});

describe("verifyAuditChain — archived segments (readArchivedAuditLines)", () => {
	let tmp: string;
	let dataDir: string;
	let archiveDir: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "audit-chain-archive-"));
		dataDir = join(tmp, ".interlinked");
		archiveDir = join(dataDir, "archive");
		mkdirSync(archiveDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// These two cases previously asserted that an unreadable index reads as NO
	// index — verification then covered only the live log and returned
	// valid:true over whatever the archive held. For a tamper-evidence tool
	// that is the worst possible answer, and it made destroying the index
	// (trivial) strictly more effective than forging segment hashes (hard).
	// The index now fails closed exactly like the segments it indexes; an
	// ABSENT manifest still legitimately means "never compacted".
	it("P: a non-array segments field FAILS verification instead of reading as empty", () => {
		writeFileSync(join(archiveDir, "manifest.json"), JSON.stringify({ segments: "oops" }));

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toContain("archive manifest");
	});

	it("P: a manifest that is not valid JSON FAILS verification, naming the manifest", () => {
		writeFileSync(join(archiveDir, "manifest.json"), "{not valid json");

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toContain("archive manifest");
		// Not misattributed to the live log, which is fine — the operator needs
		// to know to reindex, not to go inspect activity.jsonl.
		expect(res.first_bad_reason).not.toContain("activity.jsonl unreadable");
	});

	it("N: an ABSENT manifest still means 'never compacted', not a failure", () => {
		// No manifest.json written at all.
		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
	});

	it("sorts segments missing 'seq' first (nullish default 0)", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH, ts: "2026-05-26T10:00:00.000Z" });
		const e2 = makeEntry({
			previousHash: e1.hash as string,
			type: "guard_block",
			ts: "2026-05-26T10:00:01.000Z",
		});

		writeFileSync(join(archiveDir, "seg-a.jsonl.gz"), gzipSync(`${JSON.stringify(e1)}\n`));
		writeFileSync(join(archiveDir, "seg-b.jsonl.gz"), gzipSync(`${JSON.stringify(e2)}\n`));

		writeFileSync(
			join(archiveDir, "manifest.json"),
			JSON.stringify({
				segments: [
					// No `seq` — defaults to 0 via `?? 0`, sorts before seq: 1.
					{ file: "seg-a.jsonl.gz" },
					{ file: "seg-b.jsonl.gz", seq: 1 },
				],
			}),
		);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.chained_events).toBe(2);
		expect(res.last_hash).toBe(e2.hash as string);
	});

	// Split out of the case above, where it was asserted as a benign skip. A
	// listed entry with no filename means something was archived and the
	// pointer to it is gone — a hole in the index, which is evidence loss, not
	// a row to step over.
	it("P: a listed segment with no 'file' FAILS verification instead of being skipped", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH, ts: "2026-05-26T10:00:00.000Z" });
		writeFileSync(join(archiveDir, "seg-a.jsonl.gz"), gzipSync(`${JSON.stringify(e1)}\n`));
		writeFileSync(
			join(archiveDir, "manifest.json"),
			JSON.stringify({ segments: [{ file: "seg-a.jsonl.gz", seq: 0 }, { seq: 5 }] }),
		);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toContain("archive manifest");
	});

	it("P2: an unreadable LISTED segment fails verification loudly, naming the segment", () => {
		// A tamper-evidence reader must never skip evidence: a corrupt or
		// missing segment the manifest promises is a verify failure, not noise.
		writeFileSync(join(archiveDir, "seg-corrupt.jsonl.gz"), "not gzip data");
		writeFileSync(
			join(archiveDir, "manifest.json"),
			JSON.stringify({ segments: [{ file: "seg-corrupt.jsonl.gz", seq: 1 }] }),
		);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toContain("seg-corrupt.jsonl.gz");
		expect(res.first_bad_reason).toMatch(/unreadable/);
	});

	it("P3: a manifest-listed segment file that does not exist also fails loudly", () => {
		writeFileSync(
			join(archiveDir, "manifest.json"),
			JSON.stringify({ segments: [{ file: "seg-gone.jsonl.gz", seq: 1 }] }),
		);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toContain("seg-gone.jsonl.gz");
	});

	it("streams a segment larger than the synchronous inflate cap and preserves its chain into the live log", async () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH, ts: "2026-05-26T10:00:00.000Z" });
		const e2 = makeEntry({
			previousHash: String(e1.hash),
			type: "guard_block",
			ts: "2026-05-26T10:00:01.000Z",
		});
		const e3 = makeEntry({
			previousHash: String(e2.hash),
			type: "guard_warn",
			ts: "2026-05-26T10:00:02.000Z",
		});
		const filler = `${JSON.stringify({ type: "post_tool_use", pad: "x".repeat(1024) })}\n`;
		const fillerCount = Math.ceil((17 * 1024 * 1024) / Buffer.byteLength(filler));
		function* largeSegment(): Generator<string> {
			yield `${JSON.stringify(e1)}\n`;
			for (let i = 0; i < fillerCount; i++) yield filler;
			yield `${JSON.stringify(e2)}\n`;
		}

		const segment = join(archiveDir, "large.jsonl.gz");
		await writeGzipChunks(segment, largeSegment());
		writeFileSync(
			join(archiveDir, "manifest.json"),
			JSON.stringify({ segments: [{ file: "large.jsonl.gz", seq: 1 }] }),
		);
		writeJsonl(join(dataDir, "activity.jsonl"), [e3]);

		const legacy = verifyAuditChain(tmp);
		expect(legacy.valid).toBe(false);
		expect(legacy.first_bad_reason).toContain("large.jsonl.gz");

		const streamed = await verifyAuditChainStreaming(tmp);
		expect(streamed.valid).toBe(true);
		expect(streamed.total_events).toBe(fillerCount + 3);
		expect(streamed.chained_events).toBe(3);
		expect(streamed.last_hash).toBe(e3.hash);
	}, 15_000);

	it("fails the synchronous verifier before reading a compressed segment beyond its cap", () => {
		const segment = join(archiveDir, "oversized-compressed.jsonl.gz");
		writeFileSync(segment, "not-a-gzip");
		truncateSync(segment, 17 * 1024 * 1024);
		writeFileSync(
			join(archiveDir, "manifest.json"),
			JSON.stringify({ segments: [{ file: "oversized-compressed.jsonl.gz", seq: 1 }] }),
		);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toContain("compressed segment exceeds");
	});

	it("fails the streaming verifier closed on a corrupt gzip segment", async () => {
		writeFileSync(join(archiveDir, "corrupt-stream.jsonl.gz"), "not gzip data");
		writeFileSync(
			join(archiveDir, "manifest.json"),
			JSON.stringify({ segments: [{ file: "corrupt-stream.jsonl.gz", seq: 1 }] }),
		);

		const res = await verifyAuditChainStreaming(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toContain("corrupt-stream.jsonl.gz");
	});

	it("fails the streaming verifier closed when one decompressed line exceeds the line cap", async () => {
		function* oversizedLine(): Generator<string> {
			for (let i = 0; i < 65; i++) yield "x".repeat(256 * 1024);
			yield "\n";
		}
		await writeGzipChunks(join(archiveDir, "oversized-line.jsonl.gz"), oversizedLine());
		writeFileSync(
			join(archiveDir, "manifest.json"),
			JSON.stringify({ segments: [{ file: "oversized-line.jsonl.gz", seq: 1 }] }),
		);

		const res = await verifyAuditChainStreaming(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toContain("audit line exceeds");
		// 60s, not 15s: this case streams ~16 MB of gzip through the line
		// verifier, and under v8 coverage instrumentation it took 30s on the
		// 2026-09-04 full-suite coverage runs (the ONLY red test in an otherwise
		// green 54k-test run, twice). Plain runs finish in ~2s.
	}, 60_000);
});

describe("iterateFileLines — chunked line streaming", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "audit-chain-lines-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("P4: reassembles a line that spans chunk boundaries (tiny chunkBytes)", () => {
		const path = join(tmp, "log.jsonl");
		const lines = ["short", "a-much-longer-line-that-spans-many-tiny-chunks", "", "tail-no-newline"];
		writeFileSync(path, `${lines.slice(0, 3).join("\n")}\n${lines[3]}`);
		expect([...iterateFileLines(path, 4)]).toEqual(lines);
	});

	it("P5: yields identical lines regardless of chunk size", () => {
		const path = join(tmp, "log.jsonl");
		const content = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(i) }));
		writeFileSync(path, `${content.join("\n")}\n`);
		expect([...iterateFileLines(path, 7)]).toEqual([...iterateFileLines(path, 64 * 1024)]);
	});

	it("fails closed when a newline-free live record exceeds the line cap", () => {
		const path = join(tmp, "oversized-live.jsonl");
		writeFileSync(path, "x");
		truncateSync(path, 17 * 1024 * 1024);
		expect(() => [...iterateFileLines(path)]).toThrow(/audit line exceeds/);
	});
});
