import { parseWire, wireNumber, wireObject } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the checkpoints lib so no real git operations run.
vi.mock("../lib/checkpoints.js", () => ({
	archiveCheckpoints: vi.fn(),
	compareCheckpoints: vi.fn(),
	createCheckpoint: vi.fn(),
	getCheckpoint: vi.fn(),
	listCheckpoints: vi.fn(),
	pruneCheckpoints: vi.fn(),
}));

vi.mock("../lib/local-activity.js", () => ({
	readLocalSessions: vi.fn(() => []),
}));

import type { Checkpoint } from "../lib/checkpoints.js";
import {
	archiveCheckpoints,
	compareCheckpoints,
	createCheckpoint,
	getCheckpoint,
	listCheckpoints,
	pruneCheckpoints,
} from "../lib/checkpoints.js";
import { readLocalSessions } from "../lib/local-activity.js";
import {
	checkpointArchiveCommand,
	checkpointCommand,
	checkpointCompareCommand,
	checkpointListCommand,
	checkpointPruneCommand,
	checkpointShowCommand,
} from "./checkpoint.js";

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
	return {
		id: "abc123",
		session_id: "sess-1",
		agent: "agent-x",
		message: "hello world",
		timestamp: "2026-01-01T00:00:00.000Z",
		base_commit: "deadbeefcafebabe",
		trigger: "manual",
		files_changed: [],
		restorable: true,
		...overrides,
	};
}

let logSpy: ReturnType<typeof vi.spyOn>;
let logs: string[];

beforeEach(() => {
	logs = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
		logs.push(String(msg));
	});
	vi.mocked(readLocalSessions).mockReturnValue([]);
});

afterEach(() => {
	logSpy.mockRestore();
	vi.clearAllMocks();
});

function joined(): string {
	return logs.join("\n");
}

describe("createManualCheckpoint (via checkpointCommand) — labels and format", () => {
	it("prints the 'Message' label before the message value", () => {
		vi.mocked(createCheckpoint).mockReturnValue(makeCheckpoint({ message: "my msg" }));
		checkpointCommand("my msg", {});
		expect(joined()).toContain("Message");
		expect(joined()).toContain("my msg");
	});

	it("prints the 'Agent' label before the agent value", () => {
		vi.mocked(createCheckpoint).mockReturnValue(makeCheckpoint({ agent: "special-agent" }));
		checkpointCommand("some message", {});
		expect(joined()).toContain("Agent");
		expect(joined()).toContain("special-agent");
	});

	it("separates the output lines with a newline (not glued together)", () => {
		vi.mocked(createCheckpoint).mockReturnValue(
			makeCheckpoint({ message: "msgline", agent: "agentline" }),
		);
		checkpointCommand("msgline", {});
		const out = joined();
		// If "\n" join were replaced with "", "Message" and "Agent" lines
		// would be concatenated directly without a line break between them.
		expect(out.split("\n").length).toBeGreaterThan(3);
	});

	it("shows Files count 0 when files_changed is empty (ArrayDeclaration kill)", () => {
		vi.mocked(createCheckpoint).mockReturnValue(makeCheckpoint({ files_changed: [] }));
		checkpointCommand("m", {});
		expect(joined()).toContain("Files");
		// The literal [] must produce length 0, not a 1-element mutated array
		expect(joined()).toMatch(/Files[^\n]*?0/);
	});
});

describe("checkpointListCommand — header, table headers, empty-array default, agent/since/limit filters", () => {
	it("prints 'Checkpoints' header", () => {
		vi.mocked(listCheckpoints).mockReturnValue([]);
		checkpointListCommand({});
		expect(joined()).toContain("Checkpoints");
	});

	it("shows the empty-state message for zero checkpoints (ArrayDeclaration [] kill)", () => {
		vi.mocked(listCheckpoints).mockReturnValue([]);
		checkpointListCommand({});
		expect(joined()).toContain("No checkpoints found");
	});

	it("renders full table header row with all column labels when checkpoints exist", () => {
		vi.mocked(listCheckpoints).mockReturnValue([makeCheckpoint()]);
		checkpointListCommand({});
		const out = joined();
		for (const col of ["ID", "Agent", "Trigger", "Files", "Restorable", "When", "Message"]) {
			expect(out).toContain(col);
		}
	});

	it("does NOT filter by agent when opts.agent is undefined", () => {
		vi.mocked(listCheckpoints).mockReturnValue([]);
		checkpointListCommand({});
		expect(listCheckpoints).toHaveBeenCalledWith({});
	});

	it("DOES filter by agent when opts.agent is provided", () => {
		vi.mocked(listCheckpoints).mockReturnValue([]);
		checkpointListCommand({ agent: "bob" });
		expect(listCheckpoints).toHaveBeenCalledWith({ agent: "bob" });
	});

	it("does NOT pass since when opts.since is undefined", () => {
		vi.mocked(listCheckpoints).mockReturnValue([]);
		checkpointListCommand({});
		const call = vi.mocked(listCheckpoints).mock.calls[0]?.[0];
		expect(call).not.toHaveProperty("since");
	});

	it("DOES pass since (a number) when opts.since is provided", () => {
		vi.mocked(listCheckpoints).mockReturnValue([]);
		const before = Date.now();
		checkpointListCommand({ since: "1h" });
		const after = Date.now();
		const call = nonNull(vi.mocked(listCheckpoints).mock.calls[0]?.[0]);
		expect(call).toHaveProperty("since");
		expect(typeof call.since).toBe("number");
		// since = Date.now() - 1h at call time; pin it to that exact formula,
		// bounded by wall-clock samples taken immediately around the call.
		expect(nonNull(call.since)).toBeGreaterThanOrEqual(before - 3600000);
		expect(nonNull(call.since)).toBeLessThanOrEqual(after - 3600000);
	});

	it("does NOT pass limit when opts.limit is undefined", () => {
		vi.mocked(listCheckpoints).mockReturnValue([]);
		checkpointListCommand({});
		const call = vi.mocked(listCheckpoints).mock.calls[0]?.[0];
		expect(call).not.toHaveProperty("limit");
	});

	it("DOES pass limit when opts.limit is provided", () => {
		vi.mocked(listCheckpoints).mockReturnValue([]);
		checkpointListCommand({ limit: "5" });
		const call = nonNull(vi.mocked(listCheckpoints).mock.calls[0]?.[0]);
		expect(call).toEqual({ limit: 5 });
	});

	it("truncates messages longer than 30 chars with ellipsis, keeps short ones intact", () => {
		const longMsg = "a".repeat(35);
		const shortMsg = "short one";
		vi.mocked(listCheckpoints).mockReturnValue([
			makeCheckpoint({ id: "long-cp", message: longMsg }),
			makeCheckpoint({ id: "short-cp", message: shortMsg }),
		]);
		checkpointListCommand({});
		const out = joined();
		expect(out).toContain(`${"a".repeat(30)}...`);
		expect(out).not.toContain(longMsg); // full 35-char string should not appear verbatim
		expect(out).toContain(shortMsg);
		expect(out).not.toContain(`${shortMsg}...`);
	});

	it("message of exactly 30 chars is NOT truncated (boundary: > not >=)", () => {
		const exactMsg = "b".repeat(30);
		vi.mocked(listCheckpoints).mockReturnValue([makeCheckpoint({ message: exactMsg })]);
		checkpointListCommand({});
		const out = joined();
		expect(out).toContain(exactMsg);
		expect(out).not.toContain(`${exactMsg}...`);
	});
});

describe("checkpointShowCommand — field labels", () => {
	it("prints all kv labels: Message, Agent, Trigger, Created, Restorable", () => {
		vi.mocked(getCheckpoint).mockReturnValue(
			makeCheckpoint({
				id: "show-1",
				message: "showmsg",
				agent: "showagent",
				trigger: "manual",
				timestamp: "2026-02-02T00:00:00.000Z",
			}),
		);
		checkpointShowCommand("show-1", {});
		const out = joined();
		for (const label of ["Message", "Agent", "Trigger", "Created", "Restorable"]) {
			expect(out).toContain(label);
		}
		expect(out).toContain("showmsg");
		expect(out).toContain("showagent");
	});

	it("does not list Files changed section when files_changed is empty ([] not seeded)", () => {
		vi.mocked(getCheckpoint).mockReturnValue(makeCheckpoint({ files_changed: [] }));
		checkpointShowCommand("x", {});
		expect(joined()).not.toContain("Files changed");
	});

	it("lists Files changed section when files_changed is non-empty", () => {
		vi.mocked(getCheckpoint).mockReturnValue(
			makeCheckpoint({ files_changed: ["a.ts", "b.ts"] }),
		);
		checkpointShowCommand("x", {});
		expect(joined()).toContain("Files changed");
	});
});

describe("checkpointCompareCommand", () => {
	it("prints diff_summary text when present (truthy branch)", () => {
		vi.mocked(compareCheckpoints).mockReturnValue({
			files_added: [],
			files_modified: [],
			files_deleted: [],
			diff_summary: "SPECIAL_DIFF_MARKER",
		});
		checkpointCompareCommand("a", "b", {});
		expect(joined()).toContain("SPECIAL_DIFF_MARKER");
	});

	it("does not print any diff summary block when diff_summary is empty string", () => {
		vi.mocked(compareCheckpoints).mockReturnValue({
			files_added: [],
			files_modified: [],
			files_deleted: [],
			diff_summary: "",
		});
		checkpointCompareCommand("a", "b", {});
		const out = joined();
		expect(out).not.toContain("undefined");
	});
});

describe("checkpointPruneCommand — removed count and ArrayDeclaration/ObjectLiteral", () => {
	it("reports pruned count text when removed > 0", () => {
		vi.mocked(pruneCheckpoints).mockReturnValue(3);
		checkpointPruneCommand({});
		expect(joined()).toContain("Pruned 3 checkpoint(s)");
	});

	it("reports 'No checkpoints to prune' when removed is 0", () => {
		vi.mocked(pruneCheckpoints).mockReturnValue(0);
		checkpointPruneCommand({});
		expect(joined()).toContain("No checkpoints to prune");
	});

	it("json output carries the real removed value, not an empty object", () => {
		vi.mocked(pruneCheckpoints).mockReturnValue(7);
		checkpointPruneCommand({ json: true });
		const out = joined();
		expect(out).toContain('"removed": 7');
	});
});

describe("checkpointArchiveCommand", () => {
	it("reports archived count when archived > 0", () => {
		vi.mocked(archiveCheckpoints).mockReturnValue({ archived: 2 });
		checkpointArchiveCommand({});
		expect(joined()).toContain("Archived 2 checkpoint(s)");
	});

	it("reports no-checkpoints message when archived is 0", () => {
		vi.mocked(archiveCheckpoints).mockReturnValue({ archived: 0 });
		checkpointArchiveCommand({});
		expect(joined()).toContain("No checkpoints to archive");
	});
});

describe("parseSinceDuration (indirectly via checkpointListCommand -> since option)", () => {
	const REAL_NOW = 1_700_000_000_000;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(REAL_NOW);
		vi.mocked(listCheckpoints).mockReturnValue([]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function sinceArg(input: string): number {
		checkpointListCommand({ since: input });
		const call = parseWire(vi.mocked(listCheckpoints).mock.calls[0]?.[0], wireObject({ "since": wireNumber }), "test JSON value");
		return call.since;
	}

	it("parses a plain 's' duration anchored at the start (^ matters)", () => {
		// "10s" should match ^(\d+)\s*(s|m|h|d)$ fully -> 10 * 1000ms subtracted
		const since = sinceArg("10s");
		expect(since).toBe(REAL_NOW - 10 * 1000);
	});

	it("parses an 'm' duration correctly", () => {
		const since = sinceArg("5m");
		expect(since).toBe(REAL_NOW - 5 * 60000);
	});

	it("parses an 'h' duration correctly", () => {
		const since = sinceArg("2h");
		expect(since).toBe(REAL_NOW - 2 * 3600000);
	});

	it("parses a 'd' duration correctly", () => {
		const since = sinceArg("3d");
		expect(since).toBe(REAL_NOW - 3 * 86400000);
	});

	it("rejects a string with a prefix before the digits (anchored ^ required)", () => {
		// "x10s" should NOT match ^(\d+)\s*(s|m|h|d)$ -> falls back to default 1 day
		const since = sinceArg("x10s");
		expect(since).toBe(REAL_NOW - 86400000);
	});

	it("rejects a string with trailing garbage after the unit (end anchor $ required)", () => {
		// "10sx" should NOT match ...(s|m|h|d)$ -> falls back to default 1 day.
		// If the trailing $ were dropped (kept only leading unit match), this
		// would still match "10s" as a prefix and NOT fall back — so this
		// distinguishes the anchored-end mutant.
		const since = sinceArg("10sx");
		expect(since).toBe(REAL_NOW - 86400000);
	});

	it("accepts whitespace between digit and unit via \\s* (regex must allow \\s*)", () => {
		// "10 s" should MATCH the real regex (\s* allows the space) and NOT
		// fall back to the 1-day default.
		const since = sinceArg("10 s");
		expect(since).toBe(REAL_NOW - 10 * 1000);
	});
});
