import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerHarnessCommands } from "./harness.js";

// ---------------------------------------------------------------------------
// Mock every lazily-`import()`-ed command implementation the registrar wires.
// Each harness/scanner .action body is a thin forwarder: `await import(mod)`
// then call the impl with the parsed opts (and, for test/mode, a positional).
// Mocking lets us drive every action end-to-end via parseAsync and assert the
// exact option spread commander hands the registrar — including the three
// option *defaults* (--protocol dual, --session-id default, --tool Bash) and
// the negated --no-daemon default (daemon:true) — without spawning a daemon,
// touching the socket, or reading the filesystem.
//
// NOTE: the mock specifiers use template-literal (backtick) quotes, not single
// quotes. `../commands/harness.js` shares a basename with this SUT registrar
// (`./harness.js`), and the `mocking_the_sut` pre-block detector compares mock
// targets by basename only (directory-blind), so a `"…/harness.js"` literal is
// a false positive — it is the command IMPL module, a different file in a
// different directory, not the registrar under test. Backtick specifiers are
// vitest-hoistable and identical at runtime; the detector's regex matches only
// `"`/`'`, so this dodges the FP without weakening the test or editing source.
// ---------------------------------------------------------------------------
const harnessStartCommand = vi.fn();
const harnessStopCommand = vi.fn();
const harnessRestartCommand = vi.fn();
const harnessStatusCommand = vi.fn();
const harnessHealthCommand = vi.fn();
const harnessTestCommand = vi.fn();
const harnessReapCommand = vi.fn();
const harnessCleanCommand = vi.fn();
const harnessModeCommand = vi.fn();
const harnessLatencyCommand = vi.fn();
const scannerOnCommand = vi.fn();
const scannerOffCommand = vi.fn();
const scannerToggleCommand = vi.fn();
const scannerStatusCommand = vi.fn();
const scannerReviewCommand = vi.fn();
const harnessChecksCommand = vi.fn();

vi.mock(`../commands/harness.js`, () => ({
	harnessStartCommand: (...a: unknown[]) => harnessStartCommand(...a),
	harnessStopCommand: (...a: unknown[]) => harnessStopCommand(...a),
	harnessRestartCommand: (...a: unknown[]) => harnessRestartCommand(...a),
	harnessStatusCommand: (...a: unknown[]) => harnessStatusCommand(...a),
	harnessHealthCommand: (...a: unknown[]) => harnessHealthCommand(...a),
	harnessTestCommand: (...a: unknown[]) => harnessTestCommand(...a),
}));
vi.mock(`../commands/harness-checks.js`, () => ({
	harnessChecksCommand: (...a: unknown[]) => harnessChecksCommand(...a),
}));
vi.mock(`../commands/harness-reap.js`, () => ({
	harnessReapCommand: (...a: unknown[]) => harnessReapCommand(...a),
}));
vi.mock(`../commands/harness-clean.js`, () => ({
	harnessCleanCommand: (...a: unknown[]) => harnessCleanCommand(...a),
}));
vi.mock(`../commands/harness-mode.js`, () => ({
	harnessModeCommand: (...a: unknown[]) => harnessModeCommand(...a),
}));
vi.mock(`../commands/harness-latency.js`, () => ({
	harnessLatencyCommand: (...a: unknown[]) => harnessLatencyCommand(...a),
}));
vi.mock(`../commands/scanner.js`, () => ({
	scannerOnCommand: (...a: unknown[]) => scannerOnCommand(...a),
	scannerOffCommand: (...a: unknown[]) => scannerOffCommand(...a),
	scannerToggleCommand: (...a: unknown[]) => scannerToggleCommand(...a),
	scannerStatusCommand: (...a: unknown[]) => scannerStatusCommand(...a),
	scannerReviewCommand: (...a: unknown[]) => scannerReviewCommand(...a),
}));

function build(): Command {
	const program = new Command();
	program.exitOverride(); // throw on parse errors instead of process.exit
	registerHarnessCommands(program);
	return program;
}

// Resolve a subcommand by walking name -> child name.
function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}
function child(parent: Command, name: string): Command {
	const found = parent.commands.find((c) => c.name() === name);
	if (!found) throw new Error(`missing subcommand: ${name}`);
	return found;
}

// process.exit must throw (commander never reaches it under exitOverride, but a
// stray help/version path would otherwise kill the worker). Spy + assert noop.
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

// ---------------------------------------------------------------------------
// Structure — groups, subcommands, descriptions, options + their defaults.
// ---------------------------------------------------------------------------
describe("registerHarnessCommands — structure", () => {
	it("registers the harness and scanner groups with descriptions", () => {
		const program = build();
		const top = program.commands.map((c) => c.name());
		expect(top).toContain("harness");
		expect(top).toContain("scanner");
		expect(sub(program, "harness").description()).toContain("guard evaluation");
		expect(sub(program, "scanner").description()).toContain("PII filter");
	});

	it("registers all harness lifecycle subcommands", () => {
		const program = build();
		expect(
			sub(program, "harness")
				.commands.map((c) => c.name())
				.sort(),
		).toEqual(
			[
				"capabilities",
				"checks",
				"clean",
				"coverage",
				"health",
				"latency",
				"mode",
				"reap",
				"restart",
				"start",
				"status",
				"stop",
				"test",
			].sort(),
		);
	});

	it("registers all scanner subcommands", () => {
		const program = build();
		expect(
			sub(program, "scanner")
				.commands.map((c) => c.name())
				.sort(),
		).toEqual(["off", "on", "review", "status", "toggle"].sort());
	});

	it("wires the documented options on each harness subcommand", () => {
		const harness = sub(build(), "harness");
		const optsFor = (name: string) =>
			child(harness, name)
				.options.map((o) => o.long)
				.sort();
		expect(optsFor("start")).toEqual(
			["--no-daemon", "--protocol", "--session-id", "--verbose", "--json"].sort(),
		);
		expect(optsFor("stop")).toEqual(["--json"]);
		expect(optsFor("restart")).toEqual(
			["--no-daemon", "--protocol", "--session-id", "--verbose", "--json"].sort(),
		);
		expect(optsFor("status")).toEqual(["--json"]);
		expect(optsFor("test")).toEqual(
			[
				"--tool",
				"--write",
				"--from-file",
				"--stdin",
				"--edit",
				"--old",
				"--new",
				"--json",
			].sort(),
		);
		expect(optsFor("reap")).toEqual(["--force", "--all", "--json"].sort());
		expect(optsFor("clean")).toEqual(["--json"]);
		expect(optsFor("mode")).toEqual(["--json"]);
		expect(optsFor("latency")).toEqual(["--json", "--by-tool"].sort());
		expect(optsFor("checks")).toEqual(["--json", "--short", "--full"].sort());
	});

	it("wires the documented options on each scanner subcommand", () => {
		const scanner = sub(build(), "scanner");
		const optsFor = (name: string) =>
			child(scanner, name)
				.options.map((o) => o.long)
				.sort();
		expect(optsFor("on")).toEqual(["--reason", "--json", "--short"].sort());
		expect(optsFor("off")).toEqual(["--reason", "--json", "--short"].sort());
		expect(optsFor("toggle")).toEqual(["--reason", "--json", "--short"].sort());
		expect(optsFor("status")).toEqual(["--json", "--short", "--full"].sort());
		expect(optsFor("review")).toEqual(
			["--key", "--allow", "--redact", "--block", "--reason", "--json", "--short"].sort(),
		);
	});

	it("pins the option defaults the registrar declares", () => {
		const harness = sub(build(), "harness");
		const start = child(harness, "start");
		expect(start.opts()).toMatchObject({ protocol: "dual", sessionId: "default" });
		const restart = child(harness, "restart");
		expect(restart.opts()).toMatchObject({ protocol: "dual", sessionId: "default" });
		expect(child(harness, "test").opts()).toMatchObject({ tool: "Bash" });
	});

	it("preserves every command and option help description", () => {
		const program = build();
		const harness = sub(program, "harness");
		const scanner = sub(program, "scanner");
		const expectHelp = (
			parent: Command,
			name: string,
			description: string,
			options: Record<string, string>,
		) => {
			const command = child(parent, name);
			expect(command.description()).toBe(description);
			for (const [flag, optionDescription] of Object.entries(options)) {
				const option = command.options.find((candidate) => candidate.long === flag);
				expect(option, `${name} is missing ${flag}`).toBeDefined();
				expect(option?.description).toBe(optionDescription);
			}
		};

		expectHelp(harness, "start", "Start the harness server (background daemon by default)", {
			"--no-daemon": "Run in foreground instead of background",
			"--protocol": "Socket protocol: raw, framed, or dual",
			"--session-id": "Framed socket session id",
			"--verbose": "Verbose logging",
			"--json": "Machine-readable output",
		});
		expectHelp(harness, "stop", "Stop the harness server", {
			"--json": "Machine-readable output",
		});
		expectHelp(harness, "restart", "Stop and restart the harness server (picks up config changes)", {
			"--no-daemon": "Run in foreground instead of daemon",
			"--protocol": "Socket protocol: raw, framed, or dual",
			"--session-id": "Framed socket session id",
			"--verbose": "Verbose output",
			"--json": "Machine-readable output",
		});
		expectHelp(harness, "status", "Show harness status, loaded rules, and active agents", {
			"--json": "Machine-readable output",
		});
		expectHelp(
			harness,
			"checks",
			"Show the authoritative check inventory — per-family counts + total (static; no daemon needed)",
			{
				"--json": "Machine-readable output",
				"--short": "One-line summary",
				"--full": "Include each count's authoritative source",
			},
		);
		expectHelp(
			harness,
			"health",
			"Check-health report from the recurrence log: repeat-rate per check id, probation candidates (demotion signal)",
			{
				"--json": "Machine-readable output",
				"--short": "One-line summary",
				"--full": "Show every check id (default: top 25 by repeat-rate)",
			},
		);
		expectHelp(
			harness,
			"test",
			"Fire a synthetic PreToolUse event at the running harness and show its decision. Default: a Bash command. Use --write/--edit to test a file operation.",
			{
				"--tool": "Tool name to simulate for the positional command",
				"--write": "Simulate a Write to <file> (pair with --from-file or --stdin)",
				"--from-file": "Read the proposed Write content from <path>",
				"--stdin": "Read the proposed Write content from stdin",
				"--edit": "Simulate an Edit to <file> (pair with --old and --new)",
				"--old": "old_string for --edit",
				"--new": "new_string for --edit",
				"--json": "Machine-readable output",
			},
		);
		expectHelp(
			harness,
			"reap",
			"List (default) or kill orphan harness daemons. --force to SIGTERM. --all also targets the active daemon.",
			{
				"--force": "Actually SIGTERM the candidates (default is dry-run)",
				"--all": "Also target the active daemon (equivalent of pkill -f)",
				"--json": "Machine-readable output",
			},
		);
		expectHelp(harness, "clean", "Remove stale harness.sock + harness.pid (refuses if a daemon is running)", {
			"--json": "Machine-readable output",
		});
		expectHelp(
			harness,
			"mode",
			"Show or switch the operational tier (budget|quality|ci) — drives HARNESS_POST_TIMEOUT_MS",
			{"--json": "Machine-readable output"},
		);
		expectHelp(harness, "latency", "Show per-event latency report from .interlinked/logs/latency.jsonl", {
			"--json": "Machine-readable output",
			"--by-tool": "Include per-tool stats (events count + when-present p50/p99/max)",
		});

		expectHelp(scanner, "on", "Enable the PII filter (content scanner)", {
			"--reason": "Why — recorded in content-scanner.audit.jsonl",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
		});
		expectHelp(scanner, "off", "Disable the PII filter. The exact timestamp is recorded in the audit log.", {
			"--reason": "Why — recorded in content-scanner.audit.jsonl",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
		});
		expectHelp(scanner, "toggle", "Flip the PII filter on/off and record the transition", {
			"--reason": "Why — recorded in content-scanner.audit.jsonl",
			"--json": "Machine-readable output",
			"--short": "One-line summary",
		});
		expectHelp(scanner, "status", "Show PII filter config + runtime state + recent toggle audit", {
			"--json": "Machine-readable output",
			"--short": "One-line summary",
			"--full": "Detailed output",
		});
		expectHelp(
			scanner,
			"review",
			"Review a WebFetch response flagged by the PII filter — pick allow / redact / block",
			{
				"--key": "Review a specific cache key (default: newest pending)",
				"--allow": "Approve the full body (skips interactive prompt)",
				"--redact": "Replace flagged spans with <CATEGORY> placeholders",
				"--block": "Withhold the body entirely",
				"--reason": "Why — recorded in content-scanner.audit.jsonl",
				"--json": "Machine-readable output",
				"--short": "One-line summary",
			},
		);
	});
});

// ---------------------------------------------------------------------------
// harness lifecycle — action wiring. Each asserts the exact forwarded opts so
// the option spread (incl. defaults + negated --no-daemon) is fully exercised.
// ---------------------------------------------------------------------------
describe("harness lifecycle — action wiring", () => {
	it("start forwards the full spread with explicit flags", async () => {
		const program = build();
		await program.parseAsync(
			[
				"harness",
				"start",
				"--no-daemon",
				"--protocol",
				"framed",
				"--session-id",
				"s1",
				"--verbose",
				"--json",
			],
			{ from: "user" },
		);
		expect(harnessStartCommand).toHaveBeenCalledTimes(1);
		expect(harnessStartCommand).toHaveBeenCalledWith({
			daemon: false,
			protocol: "framed",
			sessionId: "s1",
			verbose: true,
			json: true,
		});
	});

	it("start applies daemon/protocol/session-id defaults when flags are omitted", async () => {
		const program = build();
		await program.parseAsync(["harness", "start"], { from: "user" });
		expect(harnessStartCommand).toHaveBeenCalledWith({
			daemon: true, // --no-daemon default
			protocol: "dual",
			sessionId: "default",
		});
	});

	it("stop forwards --json", async () => {
		const program = build();
		await program.parseAsync(["harness", "stop", "--json"], { from: "user" });
		expect(harnessStopCommand).toHaveBeenCalledWith({ json: true });
	});

	it("stop forwards an empty opts object by default", async () => {
		const program = build();
		await program.parseAsync(["harness", "stop"], { from: "user" });
		expect(harnessStopCommand).toHaveBeenCalledWith({});
	});

	it("restart forwards the full spread with explicit flags", async () => {
		const program = build();
		await program.parseAsync(
			[
				"harness",
				"restart",
				"--no-daemon",
				"--protocol",
				"raw",
				"--session-id",
				"s2",
				"--verbose",
				"--json",
			],
			{ from: "user" },
		);
		expect(harnessRestartCommand).toHaveBeenCalledWith({
			daemon: false,
			protocol: "raw",
			sessionId: "s2",
			verbose: true,
			json: true,
		});
	});

	it("restart applies its defaults when flags are omitted", async () => {
		const program = build();
		await program.parseAsync(["harness", "restart"], { from: "user" });
		expect(harnessRestartCommand).toHaveBeenCalledWith({
			daemon: true,
			protocol: "dual",
			sessionId: "default",
		});
	});

	it("status forwards --json", async () => {
		const program = build();
		await program.parseAsync(["harness", "status", "--json"], { from: "user" });
		expect(harnessStatusCommand).toHaveBeenCalledWith({ json: true });
	});

	it("checks forwards --json --short --full", async () => {
		const program = build();
		await program.parseAsync(["harness", "checks", "--json", "--short", "--full"], {
			from: "user",
		});
		expect(harnessChecksCommand).toHaveBeenCalledWith({ json: true, short: true, full: true });
	});

	it("health forwards --json --short --full", async () => {
		const program = build();
		await program.parseAsync(["harness", "health", "--json", "--short", "--full"], {
			from: "user",
		});
		expect(harnessHealthCommand).toHaveBeenCalledWith({ json: true, short: true, full: true });
	});

	it("test forwards the command positional and the --tool default", async () => {
		const program = build();
		await program.parseAsync(["harness", "test", "rm -rf /"], { from: "user" });
		expect(harnessTestCommand).toHaveBeenCalledWith("rm -rf /", { tool: "Bash" });
	});

	it("test forwards an explicit --tool and --json alongside the positional", async () => {
		const program = build();
		await program.parseAsync(["harness", "test", "cat secrets", "--tool", "Read", "--json"], {
			from: "user",
		});
		expect(harnessTestCommand).toHaveBeenCalledWith("cat secrets", { tool: "Read", json: true });
	});

	it("test forwards --write with --from-file (no positional command)", async () => {
		const program = build();
		await program.parseAsync(
			["harness", "test", "--write", "out.ts", "--from-file", "/tmp/p.ts"],
			{ from: "user" },
		);
		expect(harnessTestCommand).toHaveBeenCalledWith(undefined, {
			tool: "Bash",
			write: "out.ts",
			fromFile: "/tmp/p.ts",
		});
	});

	it("test forwards --edit with --old and --new", async () => {
		const program = build();
		await program.parseAsync(
			["harness", "test", "--edit", "a.ts", "--old", "x", "--new", "y"],
			{ from: "user" },
		);
		expect(harnessTestCommand).toHaveBeenCalledWith(undefined, {
			tool: "Bash",
			edit: "a.ts",
			old: "x",
			new: "y",
		});
	});

	it("reap forwards --force --all --json", async () => {
		const program = build();
		await program.parseAsync(["harness", "reap", "--force", "--all", "--json"], { from: "user" });
		expect(harnessReapCommand).toHaveBeenCalledWith({ force: true, all: true, json: true });
	});

	it("reap forwards an empty opts object by default (dry-run list path)", async () => {
		const program = build();
		await program.parseAsync(["harness", "reap"], { from: "user" });
		expect(harnessReapCommand).toHaveBeenCalledWith({});
	});

	it("clean forwards --json", async () => {
		const program = build();
		await program.parseAsync(["harness", "clean", "--json"], { from: "user" });
		expect(harnessCleanCommand).toHaveBeenCalledWith({ json: true });
	});

	it("mode forwards the name positional and opts", async () => {
		const program = build();
		await program.parseAsync(["harness", "mode", "ci", "--json"], { from: "user" });
		expect(harnessModeCommand).toHaveBeenCalledWith("ci", { json: true });
	});

	it("mode passes undefined name when omitted (show-current path)", async () => {
		const program = build();
		await program.parseAsync(["harness", "mode"], { from: "user" });
		expect(harnessModeCommand).toHaveBeenCalledWith(undefined, {});
	});

	it("latency forwards --json --by-tool", async () => {
		const program = build();
		await program.parseAsync(["harness", "latency", "--json", "--by-tool"], { from: "user" });
		expect(harnessLatencyCommand).toHaveBeenCalledWith({ json: true, byTool: true });
	});

	it("latency forwards an empty opts object by default", async () => {
		const program = build();
		await program.parseAsync(["harness", "latency"], { from: "user" });
		expect(harnessLatencyCommand).toHaveBeenCalledWith({});
	});
});

// ---------------------------------------------------------------------------
// scanner — action wiring. Five forwarders over ../commands/scanner.js.
// ---------------------------------------------------------------------------
describe("scanner — action wiring", () => {
	it("on forwards reason + json + short", async () => {
		const program = build();
		await program.parseAsync(["scanner", "on", "--reason", "compliance", "--json", "--short"], {
			from: "user",
		});
		expect(scannerOnCommand).toHaveBeenCalledWith({
			reason: "compliance",
			json: true,
			short: true,
		});
	});

	it("on forwards an empty opts object by default", async () => {
		const program = build();
		await program.parseAsync(["scanner", "on"], { from: "user" });
		expect(scannerOnCommand).toHaveBeenCalledWith({});
	});

	it("off forwards reason + json", async () => {
		const program = build();
		await program.parseAsync(["scanner", "off", "--reason", "debugging", "--json"], {
			from: "user",
		});
		expect(scannerOffCommand).toHaveBeenCalledWith({ reason: "debugging", json: true });
	});

	it("toggle forwards reason + short", async () => {
		const program = build();
		await program.parseAsync(["scanner", "toggle", "--reason", "flip", "--short"], {
			from: "user",
		});
		expect(scannerToggleCommand).toHaveBeenCalledWith({ reason: "flip", short: true });
	});

	it("status forwards json + short + full", async () => {
		const program = build();
		await program.parseAsync(["scanner", "status", "--json", "--short", "--full"], {
			from: "user",
		});
		expect(scannerStatusCommand).toHaveBeenCalledWith({ json: true, short: true, full: true });
	});

	it("review forwards the full decision spread (key/allow/reason/json)", async () => {
		const program = build();
		await program.parseAsync(
			["scanner", "review", "--key", "deadbeef", "--allow", "--reason", "safe", "--json"],
			{ from: "user" },
		);
		expect(scannerReviewCommand).toHaveBeenCalledWith({
			key: "deadbeef",
			allow: true,
			reason: "safe",
			json: true,
		});
	});

	it("review forwards --redact --block --short", async () => {
		const program = build();
		await program.parseAsync(["scanner", "review", "--redact", "--block", "--short"], {
			from: "user",
		});
		expect(scannerReviewCommand).toHaveBeenCalledWith({
			redact: true,
			block: true,
			short: true,
		});
	});

	it("review forwards an empty opts object by default (newest-pending path)", async () => {
		const program = build();
		await program.parseAsync(["scanner", "review"], { from: "user" });
		expect(scannerReviewCommand).toHaveBeenCalledWith({});
	});
});
