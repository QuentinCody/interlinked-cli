// B5 file propagation store: files written by an actor above Public carry the
// writer's level. Labeled P (must hold) / N (must not).

import { describe, expect, it } from "vitest";
import { createFreshSession } from "./session-state-mutators.js";
import {
	clearTaintedFiles,
	MAX_TAINTED_FILES,
	recordTaintedFile,
	restoreTaintedFiles,
	serializeTaintedFiles,
	taintedFileCount,
	taintedFilesMatching,
} from "./taint-file-lineage.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

function session(): SessionTrajectory {
	const event: HarnessEvent = {
		hook_event: "SessionStart",
		session_id: "files-s",
		agent_source: "claude",
		timestamp: "2026-10-05T00:00:00.000Z",
		cwd: "/nonexistent-root",
	};
	return createFreshSession(event, "files-s");
}

const rec = (path: string, level: "Public" | "Internal" | "Confidential" = "Confidential", writer = "child-a") => ({
	path,
	level,
	writer,
	at_step: 7,
});

describe("tainted-file store — positive (must hold)", () => {
	it("P1: a write above Public is recorded and matched by exact path", () => {
		const s = session();
		expect(recordTaintedFile(s, rec("/w/out.txt"))).toBe(true);
		expect(taintedFilesMatching(s, "/w/out.txt")).toEqual([rec("/w/out.txt")]);
	});

	it("P2: a directory read matches the files under it, and a file under a recorded directory matches it", () => {
		const s = session();
		recordTaintedFile(s, rec("/w/dir/a.txt"));
		recordTaintedFile(s, rec("/w/copy-dir"));
		expect(taintedFilesMatching(s, "/w/dir").map((r) => r.path)).toEqual(["/w/dir/a.txt"]);
		expect(taintedFilesMatching(s, "/w/copy-dir/a.txt").map((r) => r.path)).toEqual(["/w/copy-dir"]);
	});

	it("P3: a later write keeps the HIGHER level (never downgraded by a cleaner writer)", () => {
		const s = session();
		recordTaintedFile(s, rec("/w/out.txt", "Confidential"));
		recordTaintedFile(s, rec("/w/out.txt", "Internal", "child-b"));
		expect(taintedFilesMatching(s, "/w/out.txt")[0]).toMatchObject({ level: "Confidential", writer: "child-a" });
	});

	it("P4: the table round-trips through the snapshot form", () => {
		const s = session();
		recordTaintedFile(s, rec("/w/out.txt"));
		const t = session();
		expect(restoreTaintedFiles(t, serializeTaintedFiles(s))).toBe(1);
		expect(taintedFilesMatching(t, "/w/out.txt")).toEqual([rec("/w/out.txt")]);
	});

	it("P5: clear by writer drops only that writer's files; clear-all drops every file", () => {
		const s = session();
		recordTaintedFile(s, rec("/w/a.txt", "Confidential", "child-a"));
		recordTaintedFile(s, rec("/w/b.txt", "Confidential", "child-b"));
		expect(clearTaintedFiles(s, "child-a")).toBe(1);
		expect(taintedFileCount(s)).toBe(1);
		expect(clearTaintedFiles(s)).toBe(1);
		expect(taintedFileCount(s)).toBe(0);
	});
});

describe("tainted-file store — negative (must not hold)", () => {
	it("N1: a Public write is not recorded", () => {
		const s = session();
		expect(recordTaintedFile(s, rec("/w/out.txt", "Public"))).toBe(false);
		expect(taintedFileCount(s)).toBe(0);
	});

	it("N2: a sibling path with a shared prefix does not match", () => {
		const s = session();
		recordTaintedFile(s, rec("/w/out.txt"));
		expect(taintedFilesMatching(s, "/w/out.txt.bak")).toEqual([]);
		expect(taintedFilesMatching(s, "/w/ou")).toEqual([]);
	});

	it("N3: the table is bounded; the oldest entry is evicted first", () => {
		const s = session();
		for (let i = 0; i <= MAX_TAINTED_FILES; i++) recordTaintedFile(s, rec(`/w/f${i}`));
		expect(taintedFileCount(s)).toBe(MAX_TAINTED_FILES);
		expect(taintedFilesMatching(s, "/w/f0")).toEqual([]);
	});

	it("N4: malformed snapshot rows (relative path, unknown level) are dropped", () => {
		const s = session();
		expect(restoreTaintedFiles(s, [{ path: "rel.txt", level: "Confidential", writer: "a", at_step: 1 }, { path: "/x", level: "Secret", writer: "a", at_step: 1 }, 3])).toBe(0);
		expect(restoreTaintedFiles(s, undefined)).toBe(0);
	});
});
