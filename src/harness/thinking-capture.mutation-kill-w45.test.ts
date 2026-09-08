import { nonNull } from "../lib/non-null.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractNewThinking, latestTranscriptModel, resolveTranscriptPath } from "./thinking-capture.js";

const dirs: string[] = [];

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "thinking-capture-w45-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0, dirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("extractNewThinking — cursor persistence and JSON-line parsing", () => {
	// test-contract: public-api — extractNewThinking's doc comment promises "only
	// thinking appended since the previous one"; this pins that cursor contract.
	it("persists the read offset across calls so a second call returns only the newly appended thinking", () => {
		const dir = makeDir();
		const transcriptPath = join(dir, "t.jsonl");
		const cursorPath = join(dir, "cursor.json");

		const line1 = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "thinking", thinking: "first-thought" }] },
		});
		writeFileSync(transcriptPath, `${line1}\n`);

		const r1 = extractNewThinking(transcriptPath, cursorPath);
		expect(r1).toContain("first-thought");

		const line2 = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "thinking", thinking: "second-thought" }] },
		});
		appendFileSync(transcriptPath, `${line2}\n`);

		const r2 = extractNewThinking(transcriptPath, cursorPath);
		expect(r2).toContain("second-thought");
		expect(r2).not.toContain("first-thought");
	});

	// test-contract: invariant — only assistant `{type:"assistant", message}` lines
	// (parseAssistantMessage's own gate) may contribute captured thinking text.
	it("does not extract thinking blocks from non-assistant records", () => {
		const dir = makeDir();
		const transcriptPath = join(dir, "t.jsonl");
		const cursorPath = join(dir, "cursor.json");

		const userLine = JSON.stringify({
			type: "user",
			message: { content: [{ type: "thinking", thinking: "leaked-user-thought" }] },
		});
		writeFileSync(transcriptPath, `${userLine}\n`);

		const result = extractNewThinking(transcriptPath, cursorPath);
		expect(result).toBeNull();
	});

	// test-contract: bug — a stray non-object content entry (e.g. null) must be
	// skipped, not abort extraction of the valid entries around it in the record.
	it("skips non-object content entries without discarding earlier valid thinking in the same record", () => {
		const dir = makeDir();
		const transcriptPath = join(dir, "t.jsonl");
		const cursorPath = join(dir, "cursor.json");

		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "thinking", thinking: "real-thought" }, null] },
		});
		writeFileSync(transcriptPath, `${line}\n`);

		const result = extractNewThinking(transcriptPath, cursorPath);
		expect(result).not.toBeNull();
		expect(result).toContain("real-thought");
	});

	// test-contract: invariant — the function's own doc comment restricts capture
	// to `entry.type === "thinking"` blocks; a `.thinking` field elsewhere must not leak.
	it('only captures content entries whose type is exactly "thinking"', () => {
		const dir = makeDir();
		const transcriptPath = join(dir, "t.jsonl");
		const cursorPath = join(dir, "cursor.json");

		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "other", thinking: "should-not-leak" }] },
		});
		writeFileSync(transcriptPath, `${line}\n`);

		const result = extractNewThinking(transcriptPath, cursorPath);
		expect(result).toBeNull();
	});

	// test-contract: invariant — extracted thinking blocks are joined with a
	// "\n---\n" separator, so two distinct blocks stay textually distinguishable.
	it("joins multiple thinking blocks with a separator, not a bare concatenation", () => {
		const dir = makeDir();
		const transcriptPath = join(dir, "t.jsonl");
		const cursorPath = join(dir, "cursor.json");

		const line1 = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "thinking", thinking: "alpha" }] },
		});
		const line2 = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "thinking", thinking: "beta" }] },
		});
		writeFileSync(transcriptPath, `${line1}\n${line2}\n`);

		const result = extractNewThinking(transcriptPath, cursorPath);
		expect(result).not.toBeNull();
		// SAFETY: guarded by the not-null assertion above — result is a string here.
		expect(nonNull(result)).toContain("---");
	});

	// test-contract: boundary — `cursor.offset >= size` must return null BEFORE
	// the cursor-write side effect; an empty transcript sits exactly on that boundary.
	it("does not create a cursor file when the transcript is empty (offset already at size)", () => {
		const dir = makeDir();
		const transcriptPath = join(dir, "t.jsonl");
		const cursorPath = join(dir, "cursor.json");
		writeFileSync(transcriptPath, "");

		const result = extractNewThinking(transcriptPath, cursorPath);
		expect(result).toBeNull();
		expect(existsSync(cursorPath)).toBe(false);
	});

	// test-contract: invariant — the read buffer is sized `size - cursor.offset`;
	// a larger allocation would read past EOF and corrupt the trailing JSON line.
	it("reads exactly the newly appended bytes on a second call (buffer sized as size-offset)", () => {
		const dir = makeDir();
		const transcriptPath = join(dir, "t.jsonl");
		const cursorPath = join(dir, "cursor.json");

		// Large first chunk so the persisted cursor offset is comfortably > 0.
		const filler = "x".repeat(2000);
		const line1 = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "thinking", thinking: `first-${filler}` }] },
		});
		writeFileSync(transcriptPath, `${line1}\n`);
		const r1 = extractNewThinking(transcriptPath, cursorPath);
		expect(r1).toContain("first-");

		// Append a second entry with NO trailing newline: if the read buffer is
		// over-allocated past the real remaining bytes, the padding lands right
		// after this line with nothing to separate it, corrupting the JSON.
		const line2 = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "thinking", thinking: "second-thought-no-nl" }] },
		});
		appendFileSync(transcriptPath, line2);

		const r2 = extractNewThinking(transcriptPath, cursorPath);
		expect(r2).not.toBeNull();
		expect(r2).toContain("second-thought-no-nl");
	});
});

describe("resolveTranscriptPath — session id required", () => {
	// test-contract: public-api — resolveTranscriptPath's doc comment says it
	// returns null when it "can't resolve to an existing file"; sessionId is required first.
	it("returns null when no session id is given, even if a same-named derived path incidentally exists", () => {
		const dir = makeDir();
		const cwd = "/some/project";
		const slug = cwd.replace(/\//g, "-");
		const projDir = join(dir, ".claude", "projects", slug);
		mkdirSync(projDir, { recursive: true });
		// If the `!sessionId` guard were bypassed, `${sessionId}` would stringify
		// to "undefined" and this file would be found.
		writeFileSync(join(projDir, "undefined.jsonl"), "{}");

		const result = resolveTranscriptPath(undefined, undefined, cwd, dir);
		expect(result).toBeNull();
	});
});

describe("latestTranscriptModel — tail-window read and perf filter", () => {
	// test-contract: invariant — the line-level `'"model"'` substring gate must
	// still visit the one line that contains it, so the real model gets found.
	it('finds the model on a line containing the "model" key', () => {
		const dir = makeDir();
		const transcriptPath = join(dir, "t.jsonl");

		const junk1 = "not json at all, no key mention here";
		const junk2 = "another irrelevant line without the keyword";
		const realLine = JSON.stringify({ type: "assistant", message: { model: "test-model-marker" } });
		writeFileSync(transcriptPath, [junk1, junk2, realLine].join("\n") + "\n");

		const model = latestTranscriptModel(transcriptPath);
		expect(model).toBe("test-model-marker");
	});

	// test-contract: invariant — the `'"model"'` substring gate is a perf
	// shortcut: a line lacking it must never reach JSON.parse.
	it('does not attempt JSON.parse on a line lacking the "model" key', () => {
		const dir = makeDir();
		const transcriptPath = join(dir, "t.jsonl");

		const junk = "not json at all, no key mention here";
		writeFileSync(transcriptPath, `${junk}\n`);

		const parseSpy = vi.spyOn(JSON, "parse");
		const model = latestTranscriptModel(transcriptPath);
		expect(model).toBeNull();
		expect(parseSpy).not.toHaveBeenCalled();
		parseSpy.mockRestore();
	});

	// test-contract: invariant — the tail-read buffer is sized `size - start`;
	// a larger allocation would read past EOF and corrupt the trailing JSON line.
	it("reads exactly the trailing window on large transcripts (buffer sized as size-start)", () => {
		const dir = makeDir();
		const transcriptPath = join(dir, "t.jsonl");

		// Pad well past the 256KB tail-read window so `start` is meaningfully > 0.
		const filler = "x".repeat(300000);
		const finalLine = JSON.stringify({ type: "assistant", message: { model: "claude-tail-model" } });
		// No trailing newline: an over-allocated read buffer would pad this line
		// with garbage bytes and break its JSON.
		writeFileSync(transcriptPath, `${filler}\n${finalLine}`);

		const model = latestTranscriptModel(transcriptPath);
		expect(model).toBe("claude-tail-model");
	});
});
