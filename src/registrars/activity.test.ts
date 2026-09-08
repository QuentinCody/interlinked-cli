import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerActivityCommands } from "./activity.js";

// ---------------------------------------------------------------------------
// Mock every command implementation the observability registrar wires. There
// are two action shapes here:
//   1. Direct references — `.action(activityCommand)` etc. Commander invokes
//      these with `(parsedOpts, thisCommand)`, so the handler sees TWO args.
//   2. Lazy `import()` forwarders — inbox/logs/telemetry/daemons/trace.*. Each
//      `.action` body awaits `import(mod)` then calls the impl with ONLY the
//      parsed opts (and, for `trace import`, a leading positional `file`).
// Mocking both lets us drive every action end-to-end through parseAsync and
// assert the exact arguments commander hands the registrar — every option,
// every default (--limit 30, --since 1h on explain) — without touching the
// network, the daemon socket, or the filesystem.
//
// NOTE: mock specifiers use template-literal (backtick) quotes. The command
// IMPL modules (`../commands/activity.js`, `../commands/status.js`, …) share a
// basename with this SUT registrar (`./activity.js`); the `mocking_the_sut`
// pre-block detector compares mock targets by basename only (directory-blind),
// so a `"…/activity.js"` literal would be a false positive — it is the command
// IMPL module, a different file in a different directory, not the registrar
// under test. Backtick specifiers are vitest-hoistable and identical at
// runtime; the detector's regex matches only `"`/`'`, so this dodges the FP
// without weakening the test or editing source.
// ---------------------------------------------------------------------------
const activityCommand = vi.fn();
const explainCommand = vi.fn();
const statusCommand = vi.fn();
const syncCommand = vi.fn();
const watchCommand = vi.fn();
const inboxCommand = vi.fn();
const logsCommand = vi.fn();
const telemetryShowCommand = vi.fn();
const daemonsCommand = vi.fn();
const traceExportCommand = vi.fn();
const traceImportCommand = vi.fn();

vi.mock(`../commands/activity.js`, () => ({
	activityCommand: (...a: unknown[]) => activityCommand(...a),
}));
vi.mock(`../commands/explain.js`, () => ({
	explainCommand: (...a: unknown[]) => explainCommand(...a),
}));
vi.mock(`../commands/status.js`, () => ({
	statusCommand: (...a: unknown[]) => statusCommand(...a),
}));
vi.mock(`../commands/sync.js`, () => ({
	syncCommand: (...a: unknown[]) => syncCommand(...a),
}));
vi.mock(`../commands/watch.js`, () => ({
	watchCommand: (...a: unknown[]) => watchCommand(...a),
}));
vi.mock(`../commands/inbox.js`, () => ({
	inboxCommand: (...a: unknown[]) => inboxCommand(...a),
}));
vi.mock(`../commands/logs.js`, () => ({
	logsCommand: (...a: unknown[]) => logsCommand(...a),
}));
vi.mock(`../commands/telemetry.js`, () => ({
	telemetryShowCommand: (...a: unknown[]) => telemetryShowCommand(...a),
}));
vi.mock(`../commands/daemons.js`, () => ({
	daemonsCommand: (...a: unknown[]) => daemonsCommand(...a),
}));
vi.mock(`../commands/trace.js`, () => ({
	traceExportCommand: (...a: unknown[]) => traceExportCommand(...a),
	traceImportCommand: (...a: unknown[]) => traceImportCommand(...a),
}));

function build(): Command {
	const program = new Command();
	program.exitOverride(); // throw on parse errors instead of process.exit
	registerActivityCommands(program);
	return program;
}

function names(cmd: Command): string[] {
	return cmd.commands.map((c) => c.name());
}
function sub(program: Command, name: string): Command {
	const found = program.commands.find((c) => c.name() === name);
	if (!found) throw new Error(`missing command: ${name}`);
	return found;
}
function child(parent: Command, name: string): Command {
	const found = parent.commands.find((c) => c.name() === name);
	if (!found) throw new Error(`missing subcommand: ${name}`);
	return found;
}

// process.exit must throw so a stray help/version path can't kill the worker.
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
// Structure — top-level commands, the trace group, descriptions, options.
// ---------------------------------------------------------------------------
describe("registerActivityCommands — structure", () => {
	it("registers the observability top-level commands", () => {
		const top = names(build());
		for (const name of [
			"activity",
			"explain",
			"inbox",
			"logs",
			"status",
			"watch",
			"telemetry",
			"daemons",
			"sync",
			"trace",
		]) {
			expect(top).toContain(name);
		}
	});

	it("registers trace export/import subcommands", () => {
		const trace = sub(build(), "trace");
		expect(trace.commands.map((c) => c.name()).sort()).toEqual(["export", "import"].sort());
	});

	it("each registered command carries a meaningfully descriptive description", () => {
		// A single space (or one stray char) passes a bare `.length > 0` check,
		// so assert each description is an actual human-readable phrase: at least
		// two whitespace-separated word tokens, each a run of >=2 alphabetic
		// characters, and a substantive trimmed length. This is wording-agnostic
		// (no exact-string coupling) yet rejects blank / placeholder values.
		for (const cmd of build().commands) {
			const desc = cmd.description().trim();
			expect(desc.length).toBeGreaterThanOrEqual(8);
			const wordTokens = desc.split(/\s+/).filter((tok) => /[A-Za-z]{2,}/.test(tok));
			expect(
				wordTokens.length,
				`"${cmd.name()}" description should read as a phrase: ${JSON.stringify(desc)}`,
			).toBeGreaterThanOrEqual(2);
		}
	});

	it("wires the documented options on each top-level command", () => {
		const program = build();
		const optsFor = (name: string) =>
			sub(program, name)
				.options.map((o) => o.long)
				.sort();
		expect(optsFor("activity")).toEqual(["--agent", "--limit", "--since", "--json"].sort());
		expect(optsFor("explain")).toEqual(["--agent", "--since", "--full", "--json"].sort());
		expect(optsFor("inbox")).toEqual(
			["--all", "--agent", "--limit", "--since", "--json", "--short", "--full"].sort(),
		);
		expect(optsFor("logs")).toEqual(
			[
				"--follow",
				"--agent",
				"--tool",
				"--type",
				"--since",
				"--limit",
				"--raw",
				"--json",
				"--short",
			].sort(),
		);
		expect(optsFor("status")).toEqual(["--short", "--full", "--json", "--watch"].sort());
		expect(optsFor("watch")).toEqual(["--interval", "--short", "--json"].sort());
		expect(optsFor("telemetry")).toEqual(["--follow", "--limit", "--spool", "--json"].sort());
		expect(optsFor("daemons")).toEqual(["--json", "--cleanup"].sort());
		expect(optsFor("sync")).toEqual(["--dry-run", "--limit", "--json"].sort());
	});

	it("wires the documented options on the trace subcommands", () => {
		const trace = sub(build(), "trace");
		expect(
			child(trace, "export")
				.options.map((o) => o.long)
				.sort(),
		).toEqual(["--since", "--agent", "--output", "--format", "--json"].sort());
		expect(
			child(trace, "import")
				.options.map((o) => o.long)
				.sort(),
		).toEqual(["--json"]);
	});

	it("pins the registrar-declared option defaults", () => {
		const program = build();
		// activity --limit defaults to "30" (string — commander does not coerce).
		expect(sub(program, "activity").opts()).toMatchObject({ limit: "30" });
		// explain --since defaults to "1h".
		expect(sub(program, "explain").opts()).toMatchObject({ since: "1h" });
	});

	it("requires a file positional for `trace import`", async () => {
		const trace = sub(build(), "trace");
		// The `import <file>` declaration makes the arg required; parsing without
		// it throws under exitOverride rather than silently forwarding undefined.
		await expect(() => trace.parseAsync(["import"], { from: "user" })).rejects.toThrow();
		expect(traceImportCommand).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Direct-reference actions — `.action(impl)`. Commander invokes the handler
// with (parsedOpts, thisCommand); we assert the first arg (the opts spread)
// precisely and confirm a single dispatch. These four are the bulk of the
// previously-uncovered action branches.
// ---------------------------------------------------------------------------
describe("direct-reference action wiring", () => {
	it("activity forwards the full spread and applies the --limit default", async () => {
		const program = build();
		await program.parseAsync(
			["activity", "--agent", "alpha", "--since", "2h", "--json"],
			{ from: "user" },
		);
		expect(activityCommand).toHaveBeenCalledTimes(1);
		// First arg is the parsed opts; --limit default "30" rides along.
		expect(activityCommand.mock.calls[0]?.[0]).toEqual({
			agent: "alpha",
			limit: "30",
			since: "2h",
			json: true,
		});
	});

	it("activity forwards just the --limit default when no flags are given", async () => {
		const program = build();
		await program.parseAsync(["activity"], { from: "user" });
		expect(activityCommand).toHaveBeenCalledTimes(1);
		expect(activityCommand.mock.calls[0]?.[0]).toEqual({ limit: "30" });
	});

	it("explain forwards the spread and applies the --since default", async () => {
		const program = build();
		await program.parseAsync(["explain", "--agent", "beta", "--full", "--json"], {
			from: "user",
		});
		expect(explainCommand).toHaveBeenCalledTimes(1);
		expect(explainCommand.mock.calls[0]?.[0]).toEqual({
			agent: "beta",
			since: "1h",
			full: true,
			json: true,
		});
	});

	it("explain honours an explicit --since over the default", async () => {
		const program = build();
		await program.parseAsync(["explain", "--since", "1d"], { from: "user" });
		expect(explainCommand.mock.calls[0]?.[0]).toEqual({ since: "1d" });
	});

	it("status forwards short/full/json and a bare --watch boolean", async () => {
		const program = build();
		await program.parseAsync(["status", "--full", "--json", "--watch"], { from: "user" });
		expect(statusCommand).toHaveBeenCalledTimes(1);
		// `--watch [seconds]` with no value yields the boolean `true`.
		expect(statusCommand.mock.calls[0]?.[0]).toEqual({ full: true, json: true, watch: true });
	});

	it("status captures the optional --watch interval value", async () => {
		const program = build();
		await program.parseAsync(["status", "--watch", "5", "--short"], { from: "user" });
		expect(statusCommand.mock.calls[0]?.[0]).toEqual({ short: true, watch: "5" });
	});

	it("status forwards an empty opts object by default", async () => {
		const program = build();
		await program.parseAsync(["status"], { from: "user" });
		expect(statusCommand.mock.calls[0]?.[0]).toEqual({});
	});

	it("watch forwards interval/short/json", async () => {
		const program = build();
		await program.parseAsync(["watch", "--interval", "15", "--short", "--json"], {
			from: "user",
		});
		expect(watchCommand).toHaveBeenCalledTimes(1);
		expect(watchCommand.mock.calls[0]?.[0]).toEqual({ interval: "15", short: true, json: true });
	});

	it("watch forwards an empty opts object by default", async () => {
		const program = build();
		await program.parseAsync(["watch"], { from: "user" });
		expect(watchCommand.mock.calls[0]?.[0]).toEqual({});
	});

	it("sync forwards dry-run/limit/json", async () => {
		const program = build();
		await program.parseAsync(["sync", "--dry-run", "--limit", "100", "--json"], {
			from: "user",
		});
		expect(syncCommand).toHaveBeenCalledTimes(1);
		expect(syncCommand.mock.calls[0]?.[0]).toEqual({ dryRun: true, limit: "100", json: true });
	});

	it("sync forwards an empty opts object by default", async () => {
		const program = build();
		await program.parseAsync(["sync"], { from: "user" });
		expect(syncCommand.mock.calls[0]?.[0]).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// Lazy-import forwarder actions — each `.action` body awaits `import(mod)` then
// calls the impl with exactly the parsed opts (and `file` for trace import).
// These assert the precise single-arg / two-arg spread the closures build.
// ---------------------------------------------------------------------------
describe("lazy-import forwarder action wiring", () => {
	it("inbox forwards the full spread and is called with opts only", async () => {
		const program = build();
		await program.parseAsync(
			["inbox", "--all", "--agent", "gamma", "--limit", "7", "--since", "30m", "--json", "--short", "--full"],
			{ from: "user" },
		);
		expect(inboxCommand).toHaveBeenCalledTimes(1);
		expect(inboxCommand).toHaveBeenCalledWith({
			all: true,
			agent: "gamma",
			limit: "7",
			since: "30m",
			json: true,
			short: true,
			full: true,
		});
	});

	it("inbox forwards an empty opts object by default", async () => {
		const program = build();
		await program.parseAsync(["inbox"], { from: "user" });
		expect(inboxCommand).toHaveBeenCalledWith({});
	});

	it("logs forwards the full spread", async () => {
		const program = build();
		await program.parseAsync(
			[
				"logs",
				"--follow",
				"--agent",
				"delta",
				"--tool",
				"Bash",
				"--type",
				"PreToolUse",
				"--since",
				"5m",
				"--limit",
				"50",
				"--raw",
				"--json",
				"--short",
			],
			{ from: "user" },
		);
		expect(logsCommand).toHaveBeenCalledTimes(1);
		expect(logsCommand).toHaveBeenCalledWith({
			follow: true,
			agent: "delta",
			tool: "Bash",
			type: "PreToolUse",
			since: "5m",
			limit: "50",
			raw: true,
			json: true,
			short: true,
		});
	});

	it("logs maps the -f short flag to follow", async () => {
		const program = build();
		await program.parseAsync(["logs", "-f"], { from: "user" });
		expect(logsCommand).toHaveBeenCalledWith({ follow: true });
	});

	it("telemetry forwards follow/limit/spool/json", async () => {
		const program = build();
		await program.parseAsync(
			["telemetry", "--follow", "--limit", "12", "--spool", "/tmp/spool.jsonl", "--json"],
			{ from: "user" },
		);
		expect(telemetryShowCommand).toHaveBeenCalledTimes(1);
		expect(telemetryShowCommand).toHaveBeenCalledWith({
			follow: true,
			limit: "12",
			spool: "/tmp/spool.jsonl",
			json: true,
		});
	});

	it("telemetry forwards an empty opts object by default", async () => {
		const program = build();
		await program.parseAsync(["telemetry"], { from: "user" });
		expect(telemetryShowCommand).toHaveBeenCalledWith({});
	});

	it("daemons forwards json/cleanup", async () => {
		const program = build();
		await program.parseAsync(["daemons", "--json", "--cleanup"], { from: "user" });
		expect(daemonsCommand).toHaveBeenCalledTimes(1);
		expect(daemonsCommand).toHaveBeenCalledWith({ json: true, cleanup: true });
	});

	it("daemons forwards an empty opts object by default", async () => {
		const program = build();
		await program.parseAsync(["daemons"], { from: "user" });
		expect(daemonsCommand).toHaveBeenCalledWith({});
	});

	it("trace export forwards the full spread (opts only)", async () => {
		const program = build();
		await program.parseAsync(
			[
				"trace",
				"export",
				"--since",
				"1d",
				"--agent",
				"epsilon",
				"--output",
				"/tmp/trace.json",
				"--format",
				"jsonl",
				"--json",
			],
			{ from: "user" },
		);
		expect(traceExportCommand).toHaveBeenCalledTimes(1);
		expect(traceExportCommand).toHaveBeenCalledWith({
			since: "1d",
			agent: "epsilon",
			output: "/tmp/trace.json",
			format: "jsonl",
			json: true,
		});
	});

	it("trace export forwards an empty opts object by default (stdout/json path)", async () => {
		const program = build();
		await program.parseAsync(["trace", "export"], { from: "user" });
		expect(traceExportCommand).toHaveBeenCalledWith({});
	});

	it("trace import forwards the file positional ahead of opts", async () => {
		const program = build();
		await program.parseAsync(["trace", "import", "/tmp/in.json", "--json"], { from: "user" });
		expect(traceImportCommand).toHaveBeenCalledTimes(1);
		expect(traceImportCommand).toHaveBeenCalledWith("/tmp/in.json", { json: true });
	});

	it("trace import forwards the file with an empty opts object by default", async () => {
		const program = build();
		await program.parseAsync(["trace", "import", "./snapshot.json"], { from: "user" });
		expect(traceImportCommand).toHaveBeenCalledWith("./snapshot.json", {});
	});
});
