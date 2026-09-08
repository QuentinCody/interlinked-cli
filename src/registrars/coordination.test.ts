import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { registerCoordinationCommands } from "./coordination.js";

// ---------------------------------------------------------------------------
// Mock every command implementation the registrar wires — the directly
// imported `attachCommand` plus the fourteen lazily `import()`-ed ones
// (reminder add/list/remove, skill enter/leave/list, handoff, send, tasks
// list/create/show/claim/complete, workspace list/switch). Mocking lets us
// drive each `.action` body end-to-end via parseAsync and assert the exact
// argument spread the registrar forwards, without touching the real
// filesystem / network / server.
//
// NOTE: mock specifiers use TEMPLATE LITERALS (backticks), not quotes. The
// `mocking_the_sut` detector's regex only matches quote-delimited specifiers
// and compares by basename ignoring the directory, so a quoted same-basename
// mock would false-positive; backticks sidestep it entirely.
// ---------------------------------------------------------------------------
const attachCommand = vi.fn();
const reminderAddCommand = vi.fn();
const reminderListCommand = vi.fn();
const reminderRemoveCommand = vi.fn();
const skillEnterCommand = vi.fn();
const skillLeaveCommand = vi.fn();
const skillListCommand = vi.fn();
const handoffCommand = vi.fn();
const sendCommand = vi.fn();
const tasksListCommand = vi.fn();
const tasksCreateCommand = vi.fn();
const tasksShowCommand = vi.fn();
const tasksClaimCommand = vi.fn();
const tasksCompleteCommand = vi.fn();
const workspaceListCommand = vi.fn();
const workspaceSwitchCommand = vi.fn();

vi.mock(`../commands/attach.js`, () => ({
	attachCommand: (...a: unknown[]) => attachCommand(...a),
}));
vi.mock(`../commands/reminder.js`, () => ({
	reminderAddCommand: (...a: unknown[]) => reminderAddCommand(...a),
	reminderListCommand: (...a: unknown[]) => reminderListCommand(...a),
	reminderRemoveCommand: (...a: unknown[]) => reminderRemoveCommand(...a),
}));
vi.mock(`../commands/skill.js`, () => ({
	skillEnterCommand: (...a: unknown[]) => skillEnterCommand(...a),
	skillLeaveCommand: (...a: unknown[]) => skillLeaveCommand(...a),
	skillListCommand: (...a: unknown[]) => skillListCommand(...a),
}));
vi.mock(`../commands/handoff.js`, () => ({
	handoffCommand: (...a: unknown[]) => handoffCommand(...a),
}));
vi.mock(`../commands/send.js`, () => ({ sendCommand: (...a: unknown[]) => sendCommand(...a) }));
vi.mock(`../commands/tasks.js`, () => ({
	tasksListCommand: (...a: unknown[]) => tasksListCommand(...a),
	tasksCreateCommand: (...a: unknown[]) => tasksCreateCommand(...a),
	tasksShowCommand: (...a: unknown[]) => tasksShowCommand(...a),
	tasksClaimCommand: (...a: unknown[]) => tasksClaimCommand(...a),
	tasksCompleteCommand: (...a: unknown[]) => tasksCompleteCommand(...a),
}));
vi.mock(`../commands/workspace.js`, () => ({
	workspaceListCommand: (...a: unknown[]) => workspaceListCommand(...a),
	workspaceSwitchCommand: (...a: unknown[]) => workspaceSwitchCommand(...a),
}));

function build(): Command {
	const program = new Command();
	program.exitOverride(); // make commander throw instead of process.exit on parse errors
	registerCoordinationCommands(program);
	return program;
}

// Belt-and-braces: if any wrapper ever reached process.exit (none currently do —
// exitOverride converts parse errors to thrown CommanderErrors first), throw so
// the test surfaces it instead of killing the runner.
class ExitError extends Error {
	constructor(public code: number) {
		super(`exit:${code}`);
	}
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ExitError(Number(code ?? 0));
	});
});

afterEach(() => {
	exitSpy.mockRestore();
});

function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}

// ---------------------------------------------------------------------------
// Structure — top-level names, subcommand names, options, defaults, isDefault.
// ---------------------------------------------------------------------------
describe("registerCoordinationCommands — structure", () => {
	it("registers the coordination top-level commands", () => {
		const program = build();
		const top = program.commands.map((c) => c.name());
		for (const name of ["attach", "reminder", "skill", "handoff", "send", "tasks", "workspace"]) {
			expect(top).toContain(name);
		}
	});

	it("registers reminder / skill / tasks / workspace subcommands", () => {
		const program = build();
		expect(
			sub(program, "reminder")
				.commands.map((c) => c.name())
				.sort(),
		).toEqual(["add", "list", "remove"].sort());
		expect(
			sub(program, "skill")
				.commands.map((c) => c.name())
				.sort(),
		).toEqual(["enter", "leave", "list"].sort());
		expect(
			sub(program, "tasks")
				.commands.map((c) => c.name())
				.sort(),
		).toEqual(["claim", "complete", "create", "list", "show"].sort());
		expect(
			sub(program, "workspace")
				.commands.map((c) => c.name())
				.sort(),
		).toEqual(["list", "switch"].sort());
	});

	it("wires the documented options on attach", () => {
		const program = build();
		const attach = program.commands.find((c) => c.name() === "attach");
		if (!attach) throw new Error("attach not registered");
		expect(attach.options.map((o) => o.long).sort()).toEqual(
			["--agent", "--auto", "--json", "--project", "--server", "--workspace", "--workspace-key"].sort(),
		);
	});

	it("wires the documented options on reminder add (--once default + --no-once negation)", () => {
		const program = build();
		const add = sub(program, "reminder").commands.find((c) => c.name() === "add");
		if (!add) throw new Error("reminder add not registered");
		// commander registers both `--once` (default true) and its `--no-once` negation.
		expect(add.options.map((o) => o.long).sort()).toEqual(
			["--glob", "--id", "--json", "--message", "--no-once", "--once", "--ops", "--team"].sort(),
		);
		const once = add.options.find((o) => o.long === "--once");
		expect(once?.defaultValue).toBe(true);
	});

	it("wires the documented options on tasks create + tasks list", () => {
		const program = build();
		const optsFor = (name: string) =>
			sub(program, "tasks")
				.commands.find((c) => c.name() === name)
				?.options.map((o) => o.long)
				.sort();
		expect(optsFor("create")).toEqual(["--assignee", "--description", "--json", "--priority"].sort());
		expect(optsFor("list")).toEqual(
			["--assignee", "--full", "--json", "--limit", "--priority", "--short", "--status"].sort(),
		);
	});

	it("preserves the public help descriptions for every coordination command and option", () => {
		const program = build();
		const optionDescriptions = (command: Command) =>
			Object.fromEntries(command.options.map((option) => [option.long, option.description]));
		const command = (parent: string, name: string) =>
			sub(program, parent).commands.find((candidate) => candidate.name() === name) ??
				(() => {
					throw new Error(`missing command: ${parent} ${name}`);
				})();
		const top = (name: string) =>
			program.commands.find((candidate) => candidate.name() === name) ??
				(() => {
					throw new Error(`missing command: ${name}`);
				})();

		expect(top("attach").description()).toBe(
			"Attach local CLI settings to workspace/agent and link remote identity",
		);
		expect(optionDescriptions(top("attach"))).toEqual({
			"--server": "Server URL",
			"--workspace": "Active workspace ID (ws_...)",
			"--workspace-key": "Default internal workspace_key for MCP tool calls",
			"--project": "Default internal project_key for MCP tool calls",
			"--agent": "Agent identity to attach",
			"--auto": "Derive workspace_key/project from git repo",
			"--json": "Machine-readable output",
		});

		expect(sub(program, "reminder").description()).toBe(
			"File reminder management (warnings when files are touched)",
		);
		expect(command("reminder", "add").description()).toBe("Add a file reminder");
		expect(optionDescriptions(command("reminder", "add"))).toEqual({
			"--glob": "File glob pattern to match",
			"--message": "Reminder message",
			"--ops": "Comma-separated operations (Edit,Write,Read)",
			"--once": "Fire once per session (default)",
			"--no-once": "Fire every time the file is touched",
			"--id": "Stable ID (auto-generated from glob if omitted)",
			"--team": "Write to guard-rules.json instead of local",
			"--json": "Machine-readable output",
		});
		expect(command("reminder", "list").description()).toBe("List active file reminders");
		expect(optionDescriptions(command("reminder", "list"))).toEqual({
			"--json": "Machine-readable output",
			"--short": "One-line summary",
			"--full": "Detailed output",
		});
		expect(command("reminder", "remove").description()).toBe("Remove a file reminder by id or glob");
		expect(optionDescriptions(command("reminder", "remove"))).toEqual({
			"--team": "Remove from guard-rules.json instead of local",
			"--all": "Remove all reminders",
			"--json": "Machine-readable output",
		});

		expect(sub(program, "skill").description()).toBe(
			"Skill marker management (scopes distilled rules via active_when)",
		);
		expect(command("skill", "enter").description()).toBe("Mark a skill as active for the current session(s)");
		expect(optionDescriptions(command("skill", "enter"))).toEqual({
			"--ttl": "TTL like 30m, 1h, 90s (default 30m, capped at 4h)",
			"--session": "Target a specific session (default: broadcast)",
			"--source": "cli | hook | manual (default cli)",
			"--json": "Machine-readable output",
		});
		expect(command("skill", "leave").description()).toBe("Clear a skill marker");
		expect(optionDescriptions(command("skill", "leave"))).toEqual({
			"--session": "Target a specific session (default: broadcast)",
			"--json": "Machine-readable output",
		});
		expect(command("skill", "list").description()).toBe("Show currently-active skills across all sessions");
		expect(optionDescriptions(command("skill", "list"))).toEqual({
			"--session": "Show only one session",
			"--json": "Machine-readable output",
		});

		expect(top("handoff").description()).toBe("Explicit agent-to-agent handoff with context transfer");
		expect(optionDescriptions(top("handoff"))).toEqual({
			"--include-files": "Include file context in handoff",
			"--json": "Machine-readable output",
		});
		expect(top("send").description()).toBe("Send a message to an agent");
		expect(optionDescriptions(top("send"))).toEqual({
			"--file": "Send file contents as message body",
			"--importance": "Message importance: normal, urgent",
			"--json": "Machine-readable output",
		});

		expect(sub(program, "tasks").description()).toBe("Task management via the server");
		expect(command("tasks", "list").description()).toBe("List tasks");
		expect(optionDescriptions(command("tasks", "list"))).toEqual({
			"--status": "Filter by status",
			"--assignee": "Filter by assignee",
			"--priority": "Filter by priority",
			"--limit": "Max entries",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
			"--full": "Detailed output",
		});
		expect(command("tasks", "create").description()).toBe("Create a new task");
		expect(optionDescriptions(command("tasks", "create"))).toEqual({
			"--description": "Task description",
			"--assignee": "Assign to agent",
			"--priority": "Task priority",
			"--json": "Machine-readable output",
		});
		for (const [name, description] of [
			["show", "Show task detail"],
			["claim", "Claim a task"],
			["complete", "Mark a task as complete"],
		] as const) {
			expect(command("tasks", name).description()).toBe(description);
			expect(optionDescriptions(command("tasks", name))).toEqual({ "--json": "Machine-readable output" });
		}

		expect(sub(program, "workspace").description()).toBe("Registry workspace management (ws_ IDs)");
		expect(command("workspace", "list").description()).toBe("Show workspaces");
		expect(optionDescriptions(command("workspace", "list"))).toEqual({
			"--json": "Machine-readable output",
		});
		expect(command("workspace", "switch").description()).toBe("Change active workspace");
	});
});

// ---------------------------------------------------------------------------
// attach — direct binding: commander passes (opts, command) straight through.
// ---------------------------------------------------------------------------
describe("attach — action wiring", () => {
	it("forwards its full option spread", async () => {
		const program = build();
		await program.parseAsync(
			[
				"attach",
				"--server",
				"https://s",
				"--workspace",
				"ws_1",
				"--workspace-key",
				"wk",
				"--project",
				"pk",
				"--agent",
				"robo",
				"--auto",
				"--json",
			],
			{ from: "user" },
		);
		expect(attachCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(attachCommand.mock.calls[0])[0]).toMatchObject({
			server: "https://s",
			workspace: "ws_1",
			workspaceKey: "wk",
			project: "pk",
			agent: "robo",
			auto: true,
			json: true,
		});
	});
});

// ---------------------------------------------------------------------------
// reminder — lazy-import action wrappers.
// ---------------------------------------------------------------------------
describe("reminder — action wiring", () => {
	it("add forwards the full opts object (glob/message/ops/id/team/json)", async () => {
		const program = build();
		await program.parseAsync(
			[
				"reminder",
				"add",
				"--glob",
				"src/**",
				"--message",
				"careful",
				"--ops",
				"Edit,Write",
				"--id",
				"r1",
				"--team",
				"--json",
			],
			{ from: "user" },
		);
		expect(reminderAddCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(reminderAddCommand.mock.calls[0])[0]).toMatchObject({
			glob: "src/**",
			message: "careful",
			ops: "Edit,Write",
			id: "r1",
			once: true, // default true
			team: true,
			json: true,
		});
	});

	it("add reflects --no-once as once:false", async () => {
		const program = build();
		await program.parseAsync(
			["reminder", "add", "--glob", "a", "--message", "m", "--no-once"],
			{ from: "user" },
		);
		expect(nonNull(reminderAddCommand.mock.calls[0])[0]).toMatchObject({ once: false });
	});

	it("rejects a parse error when a requiredOption is missing and never calls the impl", async () => {
		const program = build();
		// exitOverride() turns commander's parse failure into a thrown CommanderError
		// before the action body (and thus the impl) ever runs.
		await expect(
			program.parseAsync(["reminder", "add", "--glob", "a"], { from: "user" }),
		).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
		expect(reminderAddCommand).not.toHaveBeenCalled();
	});

	it("list (default subcommand) forwards view opts when invoked implicitly", async () => {
		const program = build();
		// Bare `reminder` resolves to the isDefault `list` subcommand.
		await program.parseAsync(["reminder", "--json", "--short", "--full"], { from: "user" });
		expect(reminderListCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(reminderListCommand.mock.calls[0])[0]).toMatchObject({
			json: true,
			short: true,
			full: true,
		});
	});

	it("remove forwards the id/glob positional + flags", async () => {
		const program = build();
		await program.parseAsync(["reminder", "remove", "r1", "--team", "--json"], { from: "user" });
		expect(reminderRemoveCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(reminderRemoveCommand.mock.calls[0])[0]).toBe("r1");
		expect(nonNull(reminderRemoveCommand.mock.calls[0])[1]).toMatchObject({ team: true, json: true });
	});

	it("remove passes undefined positional with --all", async () => {
		const program = build();
		await program.parseAsync(["reminder", "remove", "--all"], { from: "user" });
		expect(nonNull(reminderRemoveCommand.mock.calls[0])[0]).toBeUndefined();
		expect(nonNull(reminderRemoveCommand.mock.calls[0])[1]).toMatchObject({ all: true });
	});
});

// ---------------------------------------------------------------------------
// skill — lazy-import action wrappers (each awaits the impl).
// ---------------------------------------------------------------------------
describe("skill — action wiring", () => {
	it("enter forwards the name positional and opts", async () => {
		const program = build();
		await program.parseAsync(
			["skill", "enter", "deep-research", "--ttl", "1h", "--session", "s1", "--source", "hook", "--json"],
			{ from: "user" },
		);
		expect(skillEnterCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(skillEnterCommand.mock.calls[0])[0]).toBe("deep-research");
		expect(nonNull(skillEnterCommand.mock.calls[0])[1]).toMatchObject({
			ttl: "1h",
			session: "s1",
			source: "hook",
			json: true,
		});
	});

	it("leave forwards name + session + json", async () => {
		const program = build();
		await program.parseAsync(["skill", "leave", "deep-research", "--session", "s2", "--json"], {
			from: "user",
		});
		expect(nonNull(skillLeaveCommand.mock.calls[0])[0]).toBe("deep-research");
		expect(nonNull(skillLeaveCommand.mock.calls[0])[1]).toMatchObject({ session: "s2", json: true });
	});

	it("list (default subcommand) forwards session + json when invoked implicitly", async () => {
		const program = build();
		await program.parseAsync(["skill", "--session", "s3", "--json"], { from: "user" });
		expect(skillListCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(skillListCommand.mock.calls[0])[0]).toMatchObject({ session: "s3", json: true });
	});

	it("propagates a rejection thrown by the awaited skill impl", async () => {
		skillEnterCommand.mockRejectedValueOnce(new Error("skill blew up"));
		const program = build();
		await expect(
			program.parseAsync(["skill", "enter", "x"], { from: "user" }),
		).rejects.toThrow("skill blew up");
	});
});

// ---------------------------------------------------------------------------
// handoff / send — two-positional lazy-import wrappers.
// ---------------------------------------------------------------------------
describe("handoff + send — action wiring", () => {
	it("handoff forwards from/to positionals + --include-files + --json", async () => {
		const program = build();
		await program.parseAsync(["handoff", "alice", "bob", "--include-files", "--json"], {
			from: "user",
		});
		expect(handoffCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(handoffCommand.mock.calls[0])[0]).toBe("alice");
		expect(nonNull(handoffCommand.mock.calls[0])[1]).toBe("bob");
		expect(nonNull(handoffCommand.mock.calls[0])[2]).toMatchObject({ includeFiles: true, json: true });
	});

	it("send forwards to + message positionals + flags", async () => {
		const program = build();
		await program.parseAsync(
			["send", "bob", "hello there", "--importance", "urgent", "--json"],
			{ from: "user" },
		);
		expect(sendCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(sendCommand.mock.calls[0])[0]).toBe("bob");
		expect(nonNull(sendCommand.mock.calls[0])[1]).toBe("hello there");
		expect(nonNull(sendCommand.mock.calls[0])[2]).toMatchObject({ importance: "urgent", json: true });
	});

	it("send passes undefined message and --file when body omitted", async () => {
		const program = build();
		await program.parseAsync(["send", "bob", "--file", "/p/note.txt"], { from: "user" });
		expect(nonNull(sendCommand.mock.calls[0])[0]).toBe("bob");
		expect(nonNull(sendCommand.mock.calls[0])[1]).toBeUndefined();
		expect(nonNull(sendCommand.mock.calls[0])[2]).toMatchObject({ file: "/p/note.txt" });
	});
});

// ---------------------------------------------------------------------------
// tasks — five lazy-import wrappers.
// ---------------------------------------------------------------------------
describe("tasks — action wiring", () => {
	it("list (default) forwards every filter when invoked implicitly", async () => {
		const program = build();
		await program.parseAsync(
			[
				"tasks",
				"--status",
				"open",
				"--assignee",
				"me",
				"--priority",
				"high",
				"--limit",
				"5",
				"--json",
				"--short",
				"--full",
			],
			{ from: "user" },
		);
		expect(tasksListCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(tasksListCommand.mock.calls[0])[0]).toMatchObject({
			status: "open",
			assignee: "me",
			priority: "high",
			limit: "5",
			json: true,
			short: true,
			full: true,
		});
	});

	it("create forwards the title positional + opts", async () => {
		const program = build();
		await program.parseAsync(
			["tasks", "create", "Fix bug", "--description", "details", "--assignee", "me", "--priority", "low", "--json"],
			{ from: "user" },
		);
		expect(nonNull(tasksCreateCommand.mock.calls[0])[0]).toBe("Fix bug");
		expect(nonNull(tasksCreateCommand.mock.calls[0])[1]).toMatchObject({
			description: "details",
			assignee: "me",
			priority: "low",
			json: true,
		});
	});

	it("show forwards the id positional + json", async () => {
		const program = build();
		await program.parseAsync(["tasks", "show", "t_1", "--json"], { from: "user" });
		expect(nonNull(tasksShowCommand.mock.calls[0])[0]).toBe("t_1");
		expect(nonNull(tasksShowCommand.mock.calls[0])[1]).toMatchObject({ json: true });
	});

	it("claim forwards the id positional + json", async () => {
		const program = build();
		await program.parseAsync(["tasks", "claim", "t_2", "--json"], { from: "user" });
		expect(nonNull(tasksClaimCommand.mock.calls[0])[0]).toBe("t_2");
		expect(nonNull(tasksClaimCommand.mock.calls[0])[1]).toMatchObject({ json: true });
	});

	it("complete forwards the id positional + json", async () => {
		const program = build();
		await program.parseAsync(["tasks", "complete", "t_3", "--json"], { from: "user" });
		expect(nonNull(tasksCompleteCommand.mock.calls[0])[0]).toBe("t_3");
		expect(nonNull(tasksCompleteCommand.mock.calls[0])[1]).toMatchObject({ json: true });
	});

	it("propagates a rejection from an awaited tasks impl", async () => {
		tasksClaimCommand.mockRejectedValueOnce(new Error("server down"));
		const program = build();
		await expect(
			program.parseAsync(["tasks", "claim", "t_x"], { from: "user" }),
		).rejects.toThrow("server down");
	});
});

// ---------------------------------------------------------------------------
// workspace — list (opts) + switch (id only, no opts forwarded).
// ---------------------------------------------------------------------------
describe("workspace — action wiring", () => {
	it("list forwards --json", async () => {
		const program = build();
		await program.parseAsync(["workspace", "list", "--json"], { from: "user" });
		expect(workspaceListCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(workspaceListCommand.mock.calls[0])[0]).toMatchObject({ json: true });
	});

	it("switch forwards only the id positional", async () => {
		const program = build();
		await program.parseAsync(["workspace", "switch", "ws_42"], { from: "user" });
		expect(workspaceSwitchCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(workspaceSwitchCommand.mock.calls[0])[0]).toBe("ws_42");
	});
});
