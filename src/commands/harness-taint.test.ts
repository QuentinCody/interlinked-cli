import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "../harness/rules-loader.js";
import { readTaintClearAudit } from "../harness/taint-clear-log.js";
import type { TaintControlReport } from "../harness/taint-control.js";
import {
	confirmationToken,
	harnessTaintClearCommand,
	harnessTaintStatusCommand,
	NON_INTERACTIVE_REFUSAL,
	type TaintCommandDeps,
} from "./harness-taint.js";

const LEGACY_ID = "c698b9a9-d8f0-449f-a527-d7c3efd48402";
const TOKEN = "c698b9a9";

let cwd: string;
let out: string[];
let notices: string[];
let answers: string[];

function writeLegacySnapshot(id: string): void {
	const dir = join(cwd, ".interlinked", "sessions");
	mkdirSync(dir, { recursive: true });
	const snapshot = {
		session_id: id,
		agent_name: "lead",
		tool_call_count: 769,
		sensitivity_level: "Confidential",
		step_limit: 10_000,
		taint_sources: [
			{ file: "<command-output>", level: "Confidential", at_step: 769, provenance: "local_read" },
		],
	};
	writeFileSync(join(dir, `${id}.live.json`), `${JSON.stringify(snapshot)}\n`);
}

/** A daemon status report carrying the per-actor lineage (B3): a tainted root
 *  and a clean concurrent sibling. */
function actorReport(): TaintControlReport {
	return {
		ok: true,
		session: {
			session_id: LEGACY_ID,
			agent_name: "lead",
			sensitivity_level: "Confidential",
			step_limit: 10_000,
			network_block_at: "Confidential",
			network_blocked: true,
			set_by: null,
			source_count: 1,
			recent_sources: [],
			origin: "daemon-memory",
			actors: [
				{ actor: LEGACY_ID, parent: null, level: "Confidential", spawned_at: null },
				{ actor: "child-b", parent: LEGACY_ID, level: "Public", spawned_at: 3 },
			],
			tainted_files: 1,
		},
	};
}

function storedLevel(id: string): unknown {
	const raw = readFileSync(join(cwd, ".interlinked", "sessions", `${id}.live.json`), "utf-8");
	// SAFETY: this fixture and writeLiveSnapshot both serialize a JSON object.
	return (JSON.parse(raw) as { sensitivity_level?: unknown }).sensitivity_level;
}

function deps(over: Partial<TaintCommandDeps> = {}): TaintCommandDeps {
	return {
		cwd,
		query: () => Promise.resolve(null),
		config: () => getDefaultConfig().taint_tracking,
		isInteractive: () => true,
		promptLine: () => Promise.resolve(answers.shift() ?? ""),
		operatorUser: () => "qcody",
		pid: () => 4242,
		now: () => "2026-10-05T12:00:00.000Z",
		write: (line) => notices.push(line),
		...over,
	};
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "taint-cmd-"));
	out = [];
	notices = [];
	answers = [];
	process.exitCode = 0;
	vi.spyOn(console, "log").mockImplementation((line: unknown) => {
		out.push(String(line));
	});
	vi.spyOn(console, "error").mockImplementation((line: unknown) => {
		out.push(String(line));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("harness taint status — positive (must fire)", () => {
	it("P1: names the old-format setter of the legacy snapshot", async () => {
		writeLegacySnapshot(LEGACY_ID);
		await harnessTaintStatusCommand({ session: LEGACY_ID }, deps());
		const text = out.join("\n");
		expect(text).toContain("Confidential");
		expect(text).toContain("<command-output>");
		expect(text).toContain("inferred");
		expect(text).toContain("network: BLOCKED");
		expect(process.exitCode).toBe(0);
	});

	it("P2: --json carries the structured report and its source", async () => {
		writeLegacySnapshot(LEGACY_ID);
		await harnessTaintStatusCommand({ session: LEGACY_ID, json: true }, deps());
		// SAFETY: the renderer serializes the report envelope this test asserts on.
		const parsed = JSON.parse(out.join("\n")) as {
			via?: string;
			session?: { sensitivity_level?: string; set_by?: { inferred?: boolean } };
		};
		expect(parsed.via).toBe("snapshot");
		expect(parsed.session?.sensitivity_level).toBe("Confidential");
		expect(parsed.session?.set_by?.inferred).toBe(true);
	});

	it("P3: with no --session it lists the tainted sessions", async () => {
		writeLegacySnapshot(LEGACY_ID);
		await harnessTaintStatusCommand({}, deps());
		expect(out.join("\n")).toContain(LEGACY_ID);
	});

	it("P4: a daemon report with per-actor rows renders one line per actor (B3)", async () => {
		await harnessTaintStatusCommand(
			{ session: LEGACY_ID },
			deps({ query: () => Promise.resolve(actorReport()) }),
		);
		const text = out.join("\n");
		expect(text).toContain("actors: 2; 1 file(s) written while tainted");
		expect(text).toContain(`- ${LEGACY_ID} (root): Confidential, network BLOCKED`);
		expect(text).toContain(`- child-b (child of ${LEGACY_ID}): Public, network allowed`);
	});

	it("P5: a pre-lineage snapshot says the per-actor data is absent, not empty", async () => {
		writeLegacySnapshot(LEGACY_ID);
		await harnessTaintStatusCommand({ session: LEGACY_ID }, deps());
		expect(out.join("\n")).toContain("actors: not recorded");
	});
});

describe("harness taint status — negative (must not fire)", () => {
	it("N1: an unknown session is an error, not an invented level", async () => {
		await harnessTaintStatusCommand({ session: "nope" }, deps());
		expect(out.join("\n")).toContain("Unknown session nope");
		expect(process.exitCode).toBe(1);
	});
});

describe("harness taint clear — positive (must fire)", () => {
	it("P1: a TTY plus the right confirmation lowers the level and writes the audit row", async () => {
		writeLegacySnapshot(LEGACY_ID);
		answers = [TOKEN];
		await harnessTaintClearCommand(
			{ session: LEGACY_ID, reason: "youtube public key false positive" },
			deps(),
		);

		expect(process.exitCode).toBe(0);
		expect(storedLevel(LEGACY_ID)).toBe("Public");
		expect(readTaintClearAudit(cwd)).toEqual([
			{
				ts: "2026-10-05T12:00:00.000Z",
				session: LEGACY_ID,
				previous_level: "Confidential",
				set_by: "<command-output>",
				reason: "youtube public key false positive",
				operator_user: "qcody",
				pid: 4242,
			},
		]);
		expect(notices.join("\n")).toContain(TOKEN);
	});

	it("P2: the confirmation token is the first eight characters of the session id", () => {
		expect(confirmationToken(LEGACY_ID)).toBe(TOKEN);
		expect(confirmationToken("short")).toBe("short");
	});
});

describe("harness taint clear — negative (must not fire)", () => {
	it("N1: no TTY refuses and changes nothing", async () => {
		writeLegacySnapshot(LEGACY_ID);
		const prompt = vi.fn(() => Promise.resolve(TOKEN));
		await harnessTaintClearCommand(
			{ session: LEGACY_ID, reason: "r" },
			deps({ isInteractive: () => false, promptLine: prompt }),
		);
		expect(out.join("\n")).toContain(NON_INTERACTIVE_REFUSAL);
		expect(prompt).not.toHaveBeenCalled();
		expect(storedLevel(LEGACY_ID)).toBe("Confidential");
		expect(readTaintClearAudit(cwd)).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("N2: a wrong confirmation refuses and changes nothing", async () => {
		writeLegacySnapshot(LEGACY_ID);
		answers = ["yes"];
		await harnessTaintClearCommand({ session: LEGACY_ID, reason: "r" }, deps());
		expect(out.join("\n")).toContain("confirmation did not match");
		expect(storedLevel(LEGACY_ID)).toBe("Confidential");
		expect(readTaintClearAudit(cwd)).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("N3: an unknown session refuses before any prompt", async () => {
		const prompt = vi.fn(() => Promise.resolve(TOKEN));
		await harnessTaintClearCommand(
			{ session: "nope", reason: "r" },
			deps({ promptLine: prompt }),
		);
		expect(out.join("\n")).toContain("Unknown session nope");
		expect(prompt).not.toHaveBeenCalled();
		expect(readTaintClearAudit(cwd)).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("N4: a missing --reason refuses before any prompt", async () => {
		writeLegacySnapshot(LEGACY_ID);
		const prompt = vi.fn(() => Promise.resolve(TOKEN));
		await harnessTaintClearCommand({ session: LEGACY_ID }, deps({ promptLine: prompt }));
		expect(out.join("\n")).toContain("--reason");
		expect(prompt).not.toHaveBeenCalled();
		expect(storedLevel(LEGACY_ID)).toBe("Confidential");
		expect(process.exitCode).toBe(1);
	});

	it("N6: --actor without a daemon is refused — per-actor levels live in daemon memory", async () => {
		writeLegacySnapshot(LEGACY_ID);
		answers = [TOKEN];
		await harnessTaintClearCommand(
			{ session: LEGACY_ID, reason: "r", actor: "child-a" },
			deps(),
		);
		expect(out.join("\n")).toContain("--actor needs a running daemon");
		expect(storedLevel(LEGACY_ID)).toBe("Confidential");
		expect(notices.join("\n")).toContain("ONLY actor child-a");
		expect(process.exitCode).toBe(1);
	});

	it("N5: an already-Public session is refused", async () => {
		answers = [TOKEN];
		const dir = join(cwd, ".interlinked", "sessions");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${LEGACY_ID}.live.json`),
			`${JSON.stringify({ session_id: LEGACY_ID, sensitivity_level: "Public", taint_sources: [] })}\n`,
		);
		await harnessTaintClearCommand({ session: LEGACY_ID, reason: "r" }, deps());
		expect(out.join("\n")).toContain("already Public");
		expect(readTaintClearAudit(cwd)).toEqual([]);
		expect(process.exitCode).toBe(1);
	});
});
