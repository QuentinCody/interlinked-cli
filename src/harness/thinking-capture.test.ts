import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	extractNewThinking,
	latestTranscriptModel,
	MAX_THINKING_TRANSCRIPT_BYTES,
	resolveTranscriptPath,
} from "./thinking-capture.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "think-cap-"));
	dirs.push(d);
	return d;
}

/** One assistant record with the given thinking text (Claude transcript shape). */
function asstThinking(text: string): string {
	return JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: text }] } });
}
function asstToolUse(): string {
	return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } });
}

describe("extractNewThinking", () => {
	it("extracts thinking blocks from new assistant records", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp, `${asstThinking("first reasoning")}\n${asstToolUse()}\n${asstThinking("second reasoning")}\n`);
		const out = extractNewThinking(tp, cp);
		expect(out).toContain("first reasoning");
		expect(out).toContain("second reasoning");
	});

	it("scrubs secrets and PII in the captured thinking", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp, `${asstThinking("token sk-abcdefghijklmnopqrstuvwx and email a@b.com")}\n`);
		const out = extractNewThinking(tp, cp) ?? "";
		expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwx");
		expect(out).not.toContain("a@b.com");
		expect(out).toContain("[REDACTED");
	});

	it("advances the cursor so a second call with no new content returns null", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp, `${asstThinking("once")}\n`);
		expect(extractNewThinking(tp, cp)).toContain("once");
		expect(extractNewThinking(tp, cp)).toBeNull(); // cursor at EOF, nothing new
	});

	it("captures only NEW thinking appended after the cursor", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp, `${asstThinking("old")}\n`);
		extractNewThinking(tp, cp);
		writeFileSync(tp, `${asstThinking("old")}\n${asstThinking("brand new")}\n`);
		const out = extractNewThinking(tp, cp) ?? "";
		expect(out).toContain("brand new");
		expect(out).not.toContain("old");
	});

	it("captures a newly seen transcript when the session path changes", () => {
		const d = tmp();
		const tp1 = join(d, "s1.jsonl");
		const tp2 = join(d, "s2.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp1, `${asstThinking("session one")}\n`);
		extractNewThinking(tp1, cp);
		writeFileSync(tp2, `${asstThinking("session two")}\n`);
		expect(extractNewThinking(tp2, cp)).toContain("session two");
		expect(JSON.parse(readFileSync(cp, "utf-8")).path).toBe(tp2);
	});

	it("keeps independent offsets when parallel sessions alternate A to B to A", () => {
		const d = tmp();
		const tp1 = join(d, "s1.jsonl");
		const tp2 = join(d, "s2.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp1, `${asstThinking("session one old")}\n`);
		writeFileSync(tp2, `${asstThinking("session two")}\n`);

		expect(extractNewThinking(tp1, cp)).toContain("session one old");
		expect(extractNewThinking(tp2, cp)).toContain("session two");
		appendFileSync(tp1, `${asstThinking("session one new")}\n`);
		const resumed = extractNewThinking(tp1, cp) ?? "";

		expect(resumed).toContain("session one new");
		expect(resumed).not.toContain("session one old");
		const cursor: { offsets?: Record<string, number> } = JSON.parse(readFileSync(cp, "utf-8"));
		expect(cursor.offsets).toMatchObject({
			[tp1]: readFileSync(tp1).byteLength,
			[tp2]: readFileSync(tp2).byteLength,
		});
	});

	it("bounds the persisted transcript offsets with least-recently-used eviction", () => {
		const d = tmp();
		const cp = join(d, "cursor.json");
		const transcriptPaths: string[] = [];
		for (let i = 0; i < 33; i++) {
			const transcriptPath = join(d, `s${i}.jsonl`);
			transcriptPaths.push(transcriptPath);
			writeFileSync(transcriptPath, `${asstThinking(`session ${i}`)}\n`);
			extractNewThinking(transcriptPath, cp);
		}

		const cursor: { offsets?: Record<string, number> } = JSON.parse(readFileSync(cp, "utf-8"));
		expect(Object.keys(cursor.offsets ?? {})).toHaveLength(32);
		expect(cursor.offsets).not.toHaveProperty(transcriptPaths[0] ?? "");
		expect(cursor.offsets).toHaveProperty(transcriptPaths[32] ?? "");
	});

	it("reads only a bounded tail from a sparse 1 GiB transcript", () => {
		const d = tmp();
		const tp = join(d, "large.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp, "");
		truncateSync(tp, 1024 * 1024 * 1024);
		appendFileSync(tp, `\n${asstThinking("bounded tail")}\n`);

		expect(extractNewThinking(tp, cp)).toContain("bounded tail");
		expect(MAX_THINKING_TRANSCRIPT_BYTES).toBe(8 * 1024 * 1024);
	});

	it("returns null for a missing transcript or a transcript with no thinking", () => {
		const d = tmp();
		const cp = join(d, "cursor.json");
		expect(extractNewThinking(join(d, "nope.jsonl"), cp)).toBeNull();
		const tp = join(d, "notools.jsonl");
		writeFileSync(tp, `${asstToolUse()}\n`);
		expect(extractNewThinking(tp, cp)).toBeNull();
	});

	it("skips malformed transcript lines and still captures valid thinking", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp, `{not valid json\n${asstThinking("valid one")}\n`);
		expect(extractNewThinking(tp, cp)).toContain("valid one");
	});

	it("fails open (returns null) when the transcript is unreadable", () => {
		const d = tmp(); // a directory path → readSync throws EISDIR → outer catch
		expect(extractNewThinking(d, join(d, "cursor.json"))).toBeNull();
	});
});

describe("extractNewThinking — parseThinkingCursor boundary parser", () => {
	it("P1: resumes from and migrates a legacy path/offset cursor", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		const firstLine = `${asstThinking("skip me")}\n`;
		writeFileSync(tp, `${firstLine}${asstThinking("read me")}\n`);
		writeFileSync(cp, JSON.stringify({ path: tp, offset: firstLine.length }));
		const out = extractNewThinking(tp, cp) ?? "";
		expect(out).toContain("read me");
		expect(out).not.toContain("skip me");
		const migrated: { path?: string; offset?: number; offsets?: Record<string, number> } = JSON.parse(
			readFileSync(cp, "utf-8"),
		);
		expect(migrated.path).toBe(tp);
		expect(migrated.offsets?.[tp]).toBe(readFileSync(tp).byteLength);
	});

	it("N1: a cursor file that is a bare JSON array is ignored, re-reading from the start", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp, `${asstThinking("recovered")}\n`);
		writeFileSync(cp, JSON.stringify([1, 2, 3]));
		expect(extractNewThinking(tp, cp)).toContain("recovered");
	});

	it("N2: a cursor with offset stored as a numeric string is ignored, re-reading from the start", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp, `${asstThinking("also recovered")}\n`);
		writeFileSync(cp, JSON.stringify({ path: tp, offset: "0" }));
		expect(extractNewThinking(tp, cp)).toContain("also recovered");
	});

	it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
		"N3: rejects a non-safe legacy offset (%s) and re-reads from the start",
		(offset) => {
			const d = tmp();
			const tp = join(d, "s.jsonl");
			const cp = join(d, "cursor.json");
			writeFileSync(tp, `${asstThinking("strict offset recovery")}\n`);
			writeFileSync(cp, JSON.stringify({ path: tp, offset }));
			expect(extractNewThinking(tp, cp)).toContain("strict offset recovery");
		},
	);

	it("N4: ignores an invalid per-transcript offset instead of seeking from it", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		writeFileSync(tp, `${asstThinking("map offset recovery")}\n`);
		writeFileSync(cp, JSON.stringify({ path: "other", offset: 0, offsets: { [tp]: -1 } }));
		expect(extractNewThinking(tp, cp)).toContain("map offset recovery");
	});
});

describe("extractNewThinking — parseAssistantThinkingBlocks boundary parser", () => {
	it("P1: ignores non-object entries within an otherwise valid content array", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		const line = JSON.stringify({
			type: "assistant",
			message: { content: ["not-a-block", 42, { type: "thinking", thinking: "kept" }] },
		});
		writeFileSync(tp, `${line}\n`);
		expect(extractNewThinking(tp, cp)).toBe("kept");
	});

	it("N1: a content field that is not an array contributes no thinking (no throw)", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		const line = JSON.stringify({ type: "assistant", message: { content: "not-an-array" } });
		writeFileSync(tp, `${line}\n${asstThinking("still found")}\n`);
		expect(extractNewThinking(tp, cp)).toBe("still found");
	});

	it("N2: a non-string thinking field is excluded even though the block type matches (old code coerced it in)", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		const cp = join(d, "cursor.json");
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "thinking", thinking: 12345 }] },
		});
		writeFileSync(tp, `${line}\n`);
		expect(extractNewThinking(tp, cp)).toBeNull();
	});
});

describe("resolveTranscriptPath", () => {
	it("prefers an explicit path that exists", () => {
		const d = tmp();
		const tp = join(d, "explicit.jsonl");
		writeFileSync(tp, "{}\n");
		expect(resolveTranscriptPath(tp, "sess", "/repo", d)).toBe(tp);
	});

	it("derives ~/.claude/projects/<slug>/<session>.jsonl when no explicit path", () => {
		const home = tmp();
		const cwd = "/Users/me/proj";
		const slug = cwd.replace(/\//g, "-");
		mkdirSync(join(home, ".claude", "projects", slug), { recursive: true });
		const tp = join(home, ".claude", "projects", slug, "abc.jsonl");
		writeFileSync(tp, "{}\n");
		expect(resolveTranscriptPath(undefined, "abc", cwd, home)).toBe(tp);
	});

	it("returns null when nothing resolves", () => {
		const d = tmp();
		expect(resolveTranscriptPath(undefined, undefined, "/repo", d)).toBeNull();
		expect(resolveTranscriptPath(join(d, "missing.jsonl"), "sess", "/repo", d)).toBeNull();
	});
});

describe("latestTranscriptModel", () => {
	it("returns the most recent assistant message.model", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		writeFileSync(
			tp,
			`${JSON.stringify({ type: "assistant", message: { model: "model-earlier", content: [] } })}\n${JSON.stringify({ type: "assistant", message: { model: "model-latest", content: [] } })}\n`,
		);
		expect(latestTranscriptModel(tp)).toBe("model-latest");
	});

	it("returns null for a missing transcript or one with no assistant model", () => {
		const d = tmp();
		expect(latestTranscriptModel(join(d, "no.jsonl"))).toBeNull();
		const tp = join(d, "x.jsonl");
		writeFileSync(tp, `${JSON.stringify({ type: "user" })}\n`);
		expect(latestTranscriptModel(tp)).toBeNull();
	});

	it("skips a torn line that mentions a model and keeps the last valid one", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		// The truncated line passes the `"model"` substring prefilter, so only the
		// per-line parse guard keeps it from sinking the whole tail read.
		writeFileSync(
			tp,
			`${JSON.stringify({ type: "assistant", message: { model: "kept-model", content: [] } })}\n{"type":"assistant","message":{"model":"tor\n`,
		);
		expect(latestTranscriptModel(tp)).toBe("kept-model");
	});

	it("fails open (returns null) when the transcript path exists but cannot be read", () => {
		const d = tmp(); // a directory path → readSync throws EISDIR → outer catch
		expect(existsSync(d)).toBe(true); // past the missing-transcript guard
		expect(latestTranscriptModel(d)).toBeNull();
	});

	// parseAssistantModel boundary parser (internal).
	it("P1: ignores a non-assistant record's model-shaped field", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		writeFileSync(
			tp,
			`${JSON.stringify({ type: "user", message: { model: "should-be-ignored" } })}\n${JSON.stringify({ type: "assistant", message: { model: "real-model", content: [] } })}\n`,
		);
		expect(latestTranscriptModel(tp)).toBe("real-model");
	});

	it("N1: a non-string model field on an assistant record is ignored, keeping the prior valid model (old code coerced the number in)", () => {
		const d = tmp();
		const tp = join(d, "s.jsonl");
		writeFileSync(
			tp,
			`${JSON.stringify({ type: "assistant", message: { model: "first-model", content: [] } })}\n${JSON.stringify({ type: "assistant", message: { model: 42, content: [] } })}\n`,
		);
		expect(latestTranscriptModel(tp)).toBe("first-model");
	});
});
