// B5 file-mediated taint flow between actors: a tainted actor's writes are
// recorded, and another actor reading one of them ratchets. Labeled P/N.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFreshSession } from "../session-state-mutators.js";
import { canonicalTaintPath, taintedFileEntries } from "../taint-file-lineage.js";
import { actorLevel, registerActor } from "../taint-lineage.js";
import { DEFAULT_TAINT_CONFIG, ratchetActorSensitivity } from "../taint-tracker.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import { recordActorWrites, ratchetOnTaintedFileRead } from "./taint-lineage-flow.js";

const CFG = DEFAULT_TAINT_CONFIG;
const SID = "flow-s";
let dir: string;
let session: SessionTrajectory;

function event(over: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: SID,
		agent_source: "claude",
		timestamp: "2026-10-05T00:00:00.000Z",
		cwd: dir,
		...over,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "taint-flow-"));
	session = createFreshSession(event({ hook_event: "SessionStart" }), SID);
	registerActor(session, "child-a");
	registerActor(session, "child-b");
	ratchetActorSensitivity(session, "child-a", { file: "<command-output>", level: "Confidential" }, CFG);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(over: Partial<HarnessEvent>, actor = "child-a"): void {
	recordActorWrites(event({ subagent_id: actor, agent_name: actor, ...over }), CFG, session, actor);
}

function read(input: Record<string, unknown>, toolName: string, actor = "child-b"): string[] {
	return ratchetOnTaintedFileRead({ toolName, toolInput: { cwd: dir, ...input }, taint: CFG, session, actor });
}

describe("B5 flow — positive (must hold)", () => {
	it("P1: a sibling that READS a file the tainted child wrote is ratcheted", () => {
		write({ tool_name: "Write", tool_input: { file_path: join(dir, "notes.txt"), content: "x" } });
		writeFileSync(join(dir, "notes.txt"), "x");
		const warnings = read({ file_path: join(dir, "notes.txt") }, "Read");
		expect(actorLevel(session, "child-b")).toBe("Confidential");
		expect(warnings[0]).toContain("written at Confidential by child-a");
	});

	it("P2: a shell redirect target is recorded and a later rg of it ratchets", () => {
		write({ tool_name: "Bash", tool_input: { command: "echo hi > out.txt" } });
		writeFileSync(join(dir, "out.txt"), "hi\n");
		// Stored canonically: macOS symlinks every temp root, and the read path
		// resolves through realpath, so both sides must agree on one spelling.
		expect(taintedFileEntries(session).map((f) => f.path)).toEqual([
			canonicalTaintPath(join(dir, "out.txt")),
		]);
		read({ command: `rg -n hi ${join(dir, "out.txt")}` }, "Bash");
		expect(actorLevel(session, "child-b")).toBe("Confidential");
	});

	it("P3: an inline interpreter write is recorded through its resolved target", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		write({
			tool_name: "Bash",
			tool_input: { command: `python3 -c "open('${join(dir, "src", "m.ts")}','w').write('x')"` },
		});
		expect(taintedFileEntries(session).map((f) => f.path)).toContain(
			canonicalTaintPath(join(dir, "src", "m.ts")),
		);
	});

	it("P4: the reader's ratchet keeps the root tainted too (ancestor raise)", () => {
		write({ tool_name: "Write", tool_input: { file_path: join(dir, "notes.txt"), content: "x" } });
		writeFileSync(join(dir, "notes.txt"), "x");
		read({ file_path: join(dir, "notes.txt") }, "Read");
		expect(actorLevel(session, SID)).toBe("Confidential");
	});
});

describe("B5 flow — negative (must not hold)", () => {
	it("N1: a sibling reading an UNRELATED file is not ratcheted", () => {
		write({ tool_name: "Write", tool_input: { file_path: join(dir, "notes.txt"), content: "x" } });
		writeFileSync(join(dir, "other.txt"), "y");
		expect(read({ file_path: join(dir, "other.txt") }, "Read")).toEqual([]);
		expect(actorLevel(session, "child-b")).toBe("Public");
	});

	it("N2: a Public actor's write records nothing", () => {
		write({ tool_name: "Write", tool_input: { file_path: join(dir, "clean.txt"), content: "x" } }, "child-b");
		expect(taintedFileEntries(session)).toEqual([]);
	});

	it("N3: a dry run records nothing", () => {
		write({ tool_name: "Write", tool_input: { file_path: join(dir, "notes.txt"), content: "x" }, dry_run: true });
		expect(taintedFileEntries(session)).toEqual([]);
	});

	it("N4: the writer re-reading its own file reports no further escalation", () => {
		write({ tool_name: "Write", tool_input: { file_path: join(dir, "notes.txt"), content: "x" } });
		writeFileSync(join(dir, "notes.txt"), "x");
		expect(read({ file_path: join(dir, "notes.txt") }, "Read", "child-a")).toEqual([]);
	});
});
