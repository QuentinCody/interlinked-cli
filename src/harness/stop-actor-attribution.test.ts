// Tests for subagent file attribution at Stop. Labeled per the Check Evidence
// Contract convention: "positive (must fire)" = a file IS attributed to a
// subagent (and so leaves the main Stop list), "negative (must not fire)" = the
// file stays unattributed and therefore stays in the main list (fail open).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	loadSubagentAttribution,
	parseSubagentFileWrites,
	readFileTail,
	TIMELINE_FILE,
} from "./stop-actor-attribution.js";

/** One timeline.v1 line with the fields the attributor reads. */
function line(over: Record<string, unknown>): string {
	return JSON.stringify({
		schema: "timeline.v1",
		session: "S",
		is_sidechain: true,
		agent_id: "agent1",
		tool_name: "Edit",
		tool_input: { file_path: "src/a.ts" },
		...over,
	});
}

describe("parseSubagentFileWrites — positive (must fire)", () => {
	it("P1: attributes a sidechain Edit to its agent id", () => {
		const out = parseSubagentFileWrites(line({}), "S");
		expect(out.byFile.get("src/a.ts")).toEqual(["agent1"]);
		expect([...out.agents]).toEqual(["agent1"]);
	});

	it("P2: attributes a Write as well as an Edit", () => {
		const out = parseSubagentFileWrites(line({ tool_name: "Write" }), "S");
		expect(out.byFile.has("src/a.ts")).toBe(true);
	});

	it("P3: records two distinct agents that both touched one file", () => {
		const jsonl = [line({}), line({ agent_id: "agent2" })].join("\n");
		expect(parseSubagentFileWrites(jsonl, "S").byFile.get("src/a.ts")).toEqual([
			"agent1",
			"agent2",
		]);
	});

	it("P4: de-duplicates repeated writes by the same agent to the same file", () => {
		const jsonl = [line({}), line({})].join("\n");
		expect(parseSubagentFileWrites(jsonl, "S").byFile.get("src/a.ts")).toEqual(["agent1"]);
	});
});

describe("parseSubagentFileWrites — negative (must not fire)", () => {
	it("N1: ignores a MAIN-actor record (is_sidechain false)", () => {
		const out = parseSubagentFileWrites(line({ is_sidechain: false }), "S");
		expect(out.byFile.size).toBe(0);
	});

	it("N2: ignores a record from a different session", () => {
		const out = parseSubagentFileWrites(line({ session: "OTHER" }), "S");
		expect(out.byFile.size).toBe(0);
	});

	it("N3: ignores a read-only tool call", () => {
		const out = parseSubagentFileWrites(line({ tool_name: "Read" }), "S");
		expect(out.byFile.size).toBe(0);
	});

	it("N4: ignores a sidechain record with no agent_id (unattributable)", () => {
		const out = parseSubagentFileWrites(line({ agent_id: null }), "S");
		expect(out.byFile.size).toBe(0);
	});

	it("N5: skips a malformed line without losing the valid lines around it", () => {
		const jsonl = ["{not json", line({}), "also broken"].join("\n");
		expect(parseSubagentFileWrites(jsonl, "S").byFile.get("src/a.ts")).toEqual(["agent1"]);
	});

	it("N6: ignores a record whose tool_input carries no file_path", () => {
		const out = parseSubagentFileWrites(line({ tool_input: { command: "ls" } }), "S");
		expect(out.byFile.size).toBe(0);
	});
});

describe("loadSubagentAttribution", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "stop-actor-attr-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("P5: reads the timeline tail from disk and attributes the file", () => {
		writeFileSync(join(dir, TIMELINE_FILE), `${line({})}\n`);
		expect(loadSubagentAttribution({ interlinkedDir: dir, sessionId: "S" }).byFile.size).toBe(1);
	});

	it("N7: fails open to an empty attribution when the timeline is absent", () => {
		const out = loadSubagentAttribution({ interlinkedDir: dir, sessionId: "S" });
		expect(out.byFile.size).toBe(0);
		expect(out.agents.size).toBe(0);
	});

	it("N8: fails open when the tail reader throws", () => {
		const out = loadSubagentAttribution({
			interlinkedDir: dir,
			sessionId: "S",
			readTail: () => {
				throw new Error("io");
			},
		});
		expect(out.byFile.size).toBe(0);
	});

	it("N9: drops the first (possibly partial) line of a byte-bounded tail", () => {
		const out = loadSubagentAttribution({
			interlinkedDir: dir,
			sessionId: "S",
			truncatedTail: true,
			readTail: () => `session":"S"}\n${line({})}`,
		});
		expect(out.byFile.get("src/a.ts")).toEqual(["agent1"]);
	});

	it("N10: the real readFileTail returns null when the path is unreadable as a file (a directory, not a file)", () => {
		// `existsSync` is true for a directory, so this reaches the real
		// statSync/openSync/readSync sequence: readSync on a directory fd
		// throws EISDIR (verified on this platform), landing in readFileTail's
		// own catch. Going through `loadSubagentAttribution` here would not
		// discriminate this from its OWN outer try/catch (both fail open to
		// the same empty attribution), so this calls the real reader directly.
		const asDir = join(dir, TIMELINE_FILE);
		mkdirSync(asDir);
		expect(readFileTail(asDir, 1024)).toBeNull();
	});
});
