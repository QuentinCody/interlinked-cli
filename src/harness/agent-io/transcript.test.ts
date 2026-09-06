// Behavior companion for transcript.ts — the census-driven ranges the
// mutation-kill file (transcript.mutation-kill-w32.test.ts) does not reach:
// the two file-read catch paths (unreadable transcript), the spawn-tool-use
// fallback path in `spawnToolPrompt` / `firstUserMessage` (a forked agent
// whose transcript opens with the spawning `Agent`/`Task` call instead of a
// user entry), and the genuinely-malformed-JSON catch branches in
// `firstUserMessage` / `lastStructuredReturn` (as opposed to the
// blank-line-skip path the mutation-kill file already covers).
//
// `statSync` is wrapped as a `vi.fn(actual.statSync)` — a mock whose default
// implementation calls straight through to the real function — so a single
// test can override just its own call with `mockImplementationOnce` to force
// a throw. A plain `vi.spyOn(fs, ...)` throws "Module namespace is not
// configurable in ESM" for node:fs (see src/lib/config.mutation-kill.test.ts
// for the same workaround). Every other fs export used by these tests
// (mkdtempSync/writeFileSync/rmSync) is the real implementation, re-exported
// unchanged by the `...actual` spread below.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

import { statSync } from "node:fs";
import {
	firstUserMessage,
	lastStructuredReturn,
	readTranscriptHead,
	readTranscriptTail,
} from "./transcript.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "transcript-behavior-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.mocked(statSync).mockClear();
});

describe("readTranscriptTail — unreadable file", () => {
	// Ranges 41-42: the catch body. existsSync must pass (the file is really
	// there) so the failure has to come from inside the try, proving the
	// null came from the catch and not the early existsSync-false return.
	it("returns null when the file cannot be stat'd after existsSync passes", () => {
		const p = join(dir, "present.jsonl");
		writeFileSync(p, "some transcript content");
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw new Error("EACCES: permission denied");
		});
		expect(readTranscriptTail(p, 100)).toBeNull();
	});
});

describe("readTranscriptHead — unreadable file", () => {
	// Ranges 64-65: same catch shape, mirrored reader.
	it("returns null when the file cannot be stat'd after existsSync passes", () => {
		const p = join(dir, "present.jsonl");
		writeFileSync(p, "some transcript content");
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw new Error("EACCES: permission denied");
		});
		expect(readTranscriptHead(p, 100)).toBeNull();
	});
});

describe("firstUserMessage — spawn-tool fallback (forked agent, no user entry)", () => {
	// Ranges 91-97 + 125 (non-null branch): a forked agent's transcript opens
	// with the spawning `Task` call instead of a `type:"user"` entry, so the
	// spawn tool's own prompt is the only instruction the reader can recover.
	it("returns the spawning Task call's prompt when no user entry exists", () => {
		const spawnLine = JSON.stringify({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", name: "Task", input: { prompt: "go build the widget" } }],
			},
		});
		expect(firstUserMessage(spawnLine)).toBe("go build the widget");
	});

	// Range 100 + 125 (null branch): an assistant entry with content blocks
	// present, none of them a spawn tool_use — the loop runs to completion
	// and both `spawnToolPrompt` and `firstUserMessage` fall through to null.
	it("returns null when no user entry and no spawn tool_use exist", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
		});
		expect(firstUserMessage(line)).toBeNull();
	});

	// Reinforces range 97: a blank/whitespace prompt on the spawn call does
	// not count as a usable instruction, so the fallback stays null.
	it("does not use a spawn tool_use whose prompt is whitespace-only", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Task", input: { prompt: "   " } }] },
		});
		expect(firstUserMessage(line)).toBeNull();
	});
});

describe("firstUserMessage — malformed (non-JSON) line", () => {
	// Range 116: a line that is not blank but fails JSON.parse outright (as
	// opposed to the blank-line skip the mutation-kill file already covers,
	// which never reaches JSON.parse at all).
	it("skips a line that is not valid JSON and keeps scanning", () => {
		const validLine = JSON.stringify({ type: "user", message: { content: "recovered" } });
		const lines = ["{not valid json", validLine].join("\n");
		expect(firstUserMessage(lines)).toBe("recovered");
	});
});

describe("lastStructuredReturn — malformed (non-JSON) line", () => {
	// Range 165: same catch shape, walking backward from the end of the
	// transcript, so the malformed line has to be the LAST one to force the
	// scan to catch-and-continue before it reaches the valid entry.
	it("skips a trailing line that is not valid JSON and keeps scanning backward", () => {
		const validLine = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "StructuredOutput", input: { ok: true } }] },
		});
		const lines = [validLine, "{not valid json"].join("\n");
		expect(lastStructuredReturn(lines)).toEqual({ tool: "StructuredOutput", json: '{"ok":true}' });
	});
});

describe("readTranscriptTail / readTranscriptHead — statSync mock sanity", () => {
	// Guards the mock plumbing itself: with no forced throw, both readers
	// behave exactly as the unmocked implementation would (real regression
	// coverage, not just "the catch didn't fire").
	it("still reads real content through the mocked statSync when it is not made to throw", () => {
		const p = join(dir, "normal.jsonl");
		writeFileSync(p, "AAAA\nBBBB\n");
		expect(readTranscriptTail(p, 1000)).toBe("AAAA\nBBBB\n");
		expect(readTranscriptHead(p, 1000)).toBe("AAAA\nBBBB\n");
	});
});
