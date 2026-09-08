import { parseWire, wireString } from "../../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs before importing
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
		mkdirSync: vi.fn(),
	};
});

// Mock config
vi.mock("../../lib/config.js", () => ({
	readLocalConfig: vi.fn(() => ({ agent_name: "test-agent" })),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readLocalConfig } from "../../lib/config.js";
import { nonNull } from "../../lib/non-null.js";
import { reminderAddCommand, reminderListCommand, reminderRemoveCommand } from "../reminder.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReadLocalConfig = vi.mocked(readLocalConfig);

// console.log captures the rendered output for one command; grab it as a string.
function lastLog(): string {
	const calls = (vi.mocked(console.log)).mock.calls;
	return String(calls[calls.length - 1]?.[0] ?? "");
}

function mockGuardRulesFile(local: boolean, content: Record<string, unknown> | null) {
	mockExistsSync.mockImplementation((p) => {
		const path = String(p);
		if (local && path.includes("guard-rules.local.json")) return content !== null;
		if (!local && path.includes("guard-rules.json") && !path.includes("local"))
			return content !== null;
		// .interlinked dir exists
		if (path.endsWith(".interlinked")) return true;
		return false;
	});
	mockReadFileSync.mockImplementation((p) => {
		const path = String(p);
		if (content && local && path.includes("guard-rules.local.json"))
			return JSON.stringify(content);
		if (content && !local && path.includes("guard-rules.json") && !path.includes("local"))
			return JSON.stringify(content);
		throw new Error("ENOENT");
	});
}

// Mock BOTH team and local guard-rules files at once (for list, which reads both).
function mockBothReminderFiles(
	team: Record<string, unknown> | null,
	local: Record<string, unknown> | null,
) {
	mockExistsSync.mockImplementation((p) => {
		const path = String(p);
		if (path.includes("guard-rules.local.json")) return local !== null;
		if (path.includes("guard-rules.json") && !path.includes("local")) return team !== null;
		if (path.endsWith(".interlinked")) return true;
		return false;
	});
	mockReadFileSync.mockImplementation((p) => {
		const path = String(p);
		if (local && path.includes("guard-rules.local.json")) return JSON.stringify(local);
		if (team && path.includes("guard-rules.json") && !path.includes("local"))
			return JSON.stringify(team);
		throw new Error("ENOENT");
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockReadLocalConfig.mockReturnValue({ agent_name: "test-agent" });
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("reminder add", () => {
	it("writes reminder to local guard rules", () => {
		mockGuardRulesFile(true, null);
		reminderAddCommand({ glob: "src/auth/**", message: "Run auth tests" });

		expect(mockWriteFileSync).toHaveBeenCalledOnce();
		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders).toHaveLength(1);
		expect(written.file_reminders[0].glob).toBe("src/auth/**");
		expect(written.file_reminders[0].message).toBe("Run auth tests");
		expect(written.file_reminders[0].id).toMatch(/^reminder-/);
		expect(written.file_reminders[0].created_at).toBeTruthy();
		expect(written.file_reminders[0].created_by).toBe("test-agent");
	});

	it("appends to existing reminders", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "old/**", message: "old", id: "old-id" }],
		});
		reminderAddCommand({ glob: "new/**", message: "new" });

		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders).toHaveLength(2);
		expect(written.file_reminders[1].glob).toBe("new/**");
	});

	it("rejects duplicate id", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "src/auth/**", message: "exists", id: "reminder-309fbaef" }],
		});
		reminderAddCommand({ glob: "src/auth/**", message: "duplicate" });

		expect(mockWriteFileSync).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			'Error: Reminder with id "reminder-309fbaef" already exists for glob "src/auth/**"',
		);
	});

	it("parses --ops into operations array", () => {
		mockGuardRulesFile(true, null);
		reminderAddCommand({ glob: "*.ts", message: "test", ops: "Edit,Write" });

		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders[0].operations).toEqual(["Edit", "Write"]);
	});

	it("writes to team file with --team", () => {
		mockGuardRulesFile(false, null);
		reminderAddCommand({ glob: "*.ts", message: "team reminder", team: true });

		expect(mockWriteFileSync).toHaveBeenCalledOnce();
		const path = parseWire(nonNull(mockWriteFileSync.mock.calls[0])[0], wireString, "test JSON value");
		expect(path).toContain("guard-rules.json");
		expect(path).not.toContain("local");
	});

	it("errors when --glob or --message missing", () => {
		reminderAddCommand({ glob: "*.ts" });
		expect(console.error).toHaveBeenCalledWith("Error: --glob and --message are required");
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it("errors when --message present but --glob missing", () => {
		reminderAddCommand({ message: "no glob" });
		expect(console.error).toHaveBeenCalledWith("Error: --glob and --message are required");
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it("emits JSON envelope with --json (added + file)", () => {
		mockGuardRulesFile(true, null);
		reminderAddCommand({ glob: "src/x/**", message: "json add", json: true });

		const payload = JSON.parse(lastLog());
		expect(payload.file).toBe("guard-rules.local.json");
		expect(payload.added.glob).toBe("src/x/**");
		expect(payload.added.message).toBe("json add");
		expect(payload.added.created_by).toBe("test-agent");
	});

	it("reports the team file name in --json envelope with --team", () => {
		mockGuardRulesFile(false, null);
		reminderAddCommand({ glob: "src/y/**", message: "team json", team: true, json: true });

		const payload = JSON.parse(lastLog());
		expect(payload.file).toBe("guard-rules.json");
	});

	it("normal-mode output names the local target file and glob", () => {
		mockGuardRulesFile(true, null);
		reminderAddCommand({ glob: "src/normal/**", message: "normal add" });

		const out = lastLog();
		expect(out).toContain("guard-rules.local.json");
		expect(out).toContain("src/normal/**");
		expect(out).toContain("normal add");
	});

	it("uses an explicit --id verbatim instead of the derived hash", () => {
		mockGuardRulesFile(true, null);
		reminderAddCommand({ glob: "src/z/**", message: "custom id", id: "my-custom-id" });

		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders[0].id).toBe("my-custom-id");
	});

	it("falls back to created_by 'cli' when no agent_name is configured", () => {
		mockReadLocalConfig.mockReturnValueOnce(null);
		mockGuardRulesFile(true, null);
		reminderAddCommand({ glob: "src/nocfg/**", message: "no agent" });

		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders[0].created_by).toBe("cli");
	});

	it("sets once_per_session false when --once is explicitly false", () => {
		mockGuardRulesFile(true, null);
		reminderAddCommand({ glob: "src/every/**", message: "every time", once: false });

		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders[0].once_per_session).toBe(false);
	});
});

describe("reminder list", () => {
	it("shows empty state", () => {
		mockGuardRulesFile(true, null);
		mockGuardRulesFile(false, null);
		reminderListCommand({});
		expect(lastLog()).toContain("No active file reminders");
	});

	it("annotates team and local sources in JSON", () => {
		// Mock both files existing
		mockExistsSync.mockImplementation((p) => {
			const path = String(p);
			if (path.includes("guard-rules.local.json")) return true;
			if (path.includes("guard-rules.json") && !path.includes("local")) return true;
			if (path.endsWith(".interlinked")) return true;
			return false;
		});
		mockReadFileSync.mockImplementation((p) => {
			const path = String(p);
			if (path.includes("guard-rules.local.json"))
				return JSON.stringify({
					file_reminders: [{ glob: "local/**", message: "local one" }],
				});
			if (path.includes("guard-rules.json") && !path.includes("local"))
				return JSON.stringify({
					file_reminders: [{ glob: "team/**", message: "team one" }],
				});
			throw new Error("ENOENT");
		});

		reminderListCommand({ json: true });
		const output = JSON.parse(nonNull((vi.mocked(console.log)).mock.calls[0])[0]);
		expect(output).toHaveLength(2);
		expect(output[0].source).toBe("team");
		expect(output[1].source).toBe("local");
	});

	it("normal mode renders both team and local rows with all formatting branches", () => {
		// team reminder: has operations, once_per_session=false, created_by set
		// local reminder: no operations, once_per_session omitted (=> "once"), no created_by
		mockBothReminderFiles(
			{
				file_reminders: [
					{
						glob: "team/scoped/**",
						message: "team msg",
						id: "rem-team",
						operations: ["Edit", "Write"],
						once_per_session: false,
						created_by: "alice",
					},
				],
			},
			{
				file_reminders: [{ glob: "local/scoped/**", message: "local msg", id: "rem-local" }],
			},
		);

		reminderListCommand({});
		const out = lastLog();
		// header + both rows
		expect(out).toContain("File Reminders (2 active)");
		// team row: source label, operations list, "every time", created_by
		expect(out).toContain("team/scoped/**");
		expect(out).toContain("team msg");
		expect(out).toContain("[team]");
		expect(out).toContain("Edit,Write");
		expect(out).toContain("every time");
		expect(out).toContain("by alice");
		// local row: source label, "any op", "once"
		expect(out).toContain("local/scoped/**");
		expect(out).toContain("[local]");
		expect(out).toContain("any op");
		expect(out).toContain("once");
	});

	it("normal mode shows the empty placeholder when no reminders exist", () => {
		mockBothReminderFiles(null, null);
		reminderListCommand({});
		expect(lastLog()).toContain("No active file reminders");
	});

	it("short mode reports a count when reminders exist", () => {
		mockBothReminderFiles(
			{ file_reminders: [{ glob: "a/**", message: "a", id: "ra" }] },
			{ file_reminders: [{ glob: "b/**", message: "b", id: "rb" }] },
		);
		reminderListCommand({ short: true });
		expect(lastLog()).toBe("2 active reminder(s)");
	});

	it("short mode reports the empty state", () => {
		mockBothReminderFiles(null, null);
		reminderListCommand({ short: true });
		expect(lastLog()).toBe("No active reminders");
	});
});

describe("reminder remove", () => {
	it("removes by id", () => {
		mockGuardRulesFile(true, {
			file_reminders: [
				{ glob: "a/**", message: "a", id: "rem-a" },
				{ glob: "b/**", message: "b", id: "rem-b" },
			],
		});
		reminderRemoveCommand("rem-a", {});

		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders).toHaveLength(1);
		expect(written.file_reminders[0].id).toBe("rem-b");
	});

	it("removes by glob", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "src/auth/**", message: "auth", id: "rem-auth" }],
		});
		reminderRemoveCommand("src/auth/**", {});

		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders).toHaveLength(0);
	});

	it("removes all with --all", () => {
		mockGuardRulesFile(true, {
			file_reminders: [
				{ glob: "a/**", message: "a", id: "rem-a" },
				{ glob: "b/**", message: "b", id: "rem-b" },
			],
		});
		reminderRemoveCommand(undefined, { all: true });

		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders).toHaveLength(0);
	});

	it("errors when no match found", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "a/**", message: "a", id: "rem-a" }],
		});
		reminderRemoveCommand("nonexistent", {});

		expect(console.error).toHaveBeenCalledWith('Error: No reminder found matching "nonexistent"');
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it("errors when no arg and no --all", () => {
		reminderRemoveCommand(undefined, {});
		expect(console.error).toHaveBeenCalledWith(
			"Error: Provide a reminder id or glob to remove, or use --all",
		);
	});

	it("removes from the team file with --team", () => {
		mockGuardRulesFile(false, {
			file_reminders: [{ glob: "team/**", message: "team", id: "rem-team" }],
		});
		reminderRemoveCommand("rem-team", { team: true });

		expect(mockWriteFileSync).toHaveBeenCalledOnce();
		const path = parseWire(nonNull(mockWriteFileSync.mock.calls[0])[0], wireString, "test JSON value");
		expect(path).toContain("guard-rules.json");
		expect(path).not.toContain("local");
		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders).toHaveLength(0);
	});

	it("emits JSON envelope when removing a single reminder with --json", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "a/**", message: "a", id: "rem-a" }],
		});
		reminderRemoveCommand("rem-a", { json: true });

		const payload = JSON.parse(lastLog());
		expect(payload.removed.id).toBe("rem-a");
		expect(payload.removed.glob).toBe("a/**");
	});

	it("normal-mode single removal falls back to glob when the reminder has no id", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "no-id/**", message: "no id here" }],
		});
		reminderRemoveCommand("no-id/**", {});

		const out = lastLog();
		expect(out).toContain("no-id/**");
		expect(out).toContain("no id here");
	});

	it("--all emits a JSON count envelope with --json", () => {
		mockGuardRulesFile(true, {
			file_reminders: [
				{ glob: "a/**", message: "a", id: "rem-a" },
				{ glob: "b/**", message: "b", id: "rem-b" },
			],
		});
		reminderRemoveCommand(undefined, { all: true, json: true });

		const payload = JSON.parse(lastLog());
		expect(payload.removed).toBe(2);
	});

	it("--all reports the empty placeholder when there is nothing to remove", () => {
		mockGuardRulesFile(true, null);
		reminderRemoveCommand(undefined, { all: true });

		expect(lastLog()).toContain("No reminders to remove");
		// still writes an (empty) list back
		const written = JSON.parse(parseWire(nonNull(mockWriteFileSync.mock.calls[0])[1], wireString, "test JSON value"));
		expect(written.file_reminders).toHaveLength(0);
	});

	it("--all normal mode reports a positive removal count", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "a/**", message: "a", id: "rem-a" }],
		});
		reminderRemoveCommand(undefined, { all: true });

		expect(lastLog()).toContain("Removed");
		expect(lastLog()).toContain("1");
	});

	it("handles a rules file that exists but has no file_reminders key", () => {
		// existing file with unrelated content => read() truthy, file_reminders undefined
		mockGuardRulesFile(true, { rules: [], disabled_rules: [] });
		reminderRemoveCommand("anything", {});

		// nothing matched => error, no write
		expect(console.error).toHaveBeenCalledWith('Error: No reminder found matching "anything"');
		expect(mockWriteFileSync).not.toHaveBeenCalled();
	});

	it("--all on a file with no file_reminders key removes zero", () => {
		mockGuardRulesFile(true, { rules: [] });
		reminderRemoveCommand(undefined, { all: true });

		expect(lastLog()).toContain("No reminders to remove");
	});

	it("normal-mode single removal shows the reminder id when present", () => {
		mockGuardRulesFile(true, {
			file_reminders: [{ glob: "with-id/**", message: "has id", id: "rem-withid" }],
		});
		reminderRemoveCommand("rem-withid", {});

		expect(lastLog()).toContain("rem-withid");
	});
});
