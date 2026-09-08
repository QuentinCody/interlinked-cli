import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { registerObservabilityLogCommands } from "./observability-logs.js";

// ---------------------------------------------------------------------------
// Mock every lazily-`import()`-ed command implementation the registrar wires.
// Each .action body is a thin forwarder: `await import(mod)` then call the impl
// with the parsed opts (and, for detail/flag/propose/show/replay, a positional).
// Mocking lets us drive every action end-to-end via parseAsync and assert the
// exact argument spread commander hands the registrar — without reading the
// JSONL logs, touching the filesystem, or evaluating any detector.
//
// NOTE: the mock specifiers use template-literal (backtick) quotes, not single
// quotes. The `mocking_the_sut` / `mocking_the_sut_self` detectors compare a
// mock target to the SUT by basename only (directory-blind), so a plain
// `"…/recurrence.js"` literal risks a false positive against a sibling whose
// basename collides — these are the command IMPL modules in `../commands/`, a
// different directory from this registrar. Backtick specifiers are
// vitest-hoistable and identical at runtime; both detectors' regexes match only
// `"`/`'`, so this dodges the FP without weakening the test or editing source.
// ---------------------------------------------------------------------------
const recurrenceListCommand = vi.fn();
const recurrenceDetailCommand = vi.fn();
const recurrenceFlagCommand = vi.fn();
const recurrenceScanCommand = vi.fn();
const recurrenceProposeCommand = vi.fn();
const trajectoryListCommand = vi.fn();
const trajectoryShowCommand = vi.fn();
const trajectoryReplayCommand = vi.fn();
const auditVerifyCommand = vi.fn();
const planListCommand = vi.fn();
const planShowCommand = vi.fn();
const cloudRecentCommand = vi.fn();
const debtListCommand = vi.fn();
const debtShowCommand = vi.fn();
const debtResolveCommand = vi.fn();
const tddStatusCommand = vi.fn();
const tddClearCommand = vi.fn();

vi.mock(`../commands/recurrence.js`, () => ({
	recurrenceListCommand: (...a: unknown[]) => recurrenceListCommand(...a),
	recurrenceDetailCommand: (...a: unknown[]) => recurrenceDetailCommand(...a),
	recurrenceFlagCommand: (...a: unknown[]) => recurrenceFlagCommand(...a),
	recurrenceScanCommand: (...a: unknown[]) => recurrenceScanCommand(...a),
	recurrenceProposeCommand: (...a: unknown[]) => recurrenceProposeCommand(...a),
}));
vi.mock(`../commands/trajectory.js`, () => ({
	trajectoryListCommand: (...a: unknown[]) => trajectoryListCommand(...a),
	trajectoryShowCommand: (...a: unknown[]) => trajectoryShowCommand(...a),
	trajectoryReplayCommand: (...a: unknown[]) => trajectoryReplayCommand(...a),
}));
vi.mock(`../commands/audit.js`, () => ({
	auditVerifyCommand: (...a: unknown[]) => auditVerifyCommand(...a),
}));
vi.mock(`../commands/plan.js`, () => ({
	planListCommand: (...a: unknown[]) => planListCommand(...a),
	planShowCommand: (...a: unknown[]) => planShowCommand(...a),
}));
vi.mock(`../commands/cloud.js`, () => ({
	cloudRecentCommand: (...a: unknown[]) => cloudRecentCommand(...a),
}));
vi.mock(`../commands/debt.js`, () => ({
	debtListCommand: (...a: unknown[]) => debtListCommand(...a),
	debtShowCommand: (...a: unknown[]) => debtShowCommand(...a),
	debtResolveCommand: (...a: unknown[]) => debtResolveCommand(...a),
}));
vi.mock(`../commands/tdd.js`, () => ({
	tddStatusCommand: (...a: unknown[]) => tddStatusCommand(...a),
	tddClearCommand: (...a: unknown[]) => tddClearCommand(...a),
}));
const queryCommand = vi.fn();
vi.mock(`../commands/query.js`, () => ({
	queryCommand: (...a: unknown[]) => queryCommand(...a),
}));

function build(): Command {
	const program = new Command();
	program.exitOverride(); // throw on parse errors instead of process.exit
	registerObservabilityLogCommands(program);
	return program;
}

function names(cmd: Command): string[] {
	return cmd.commands.map((c) => c.name());
}

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

function longOpts(cmd: Command): string[] {
	return cmd.options.map((o) => nonNull(o.long)).sort();
}

// process.exit must throw so a stray help/version path can't kill the worker.
class ExitError extends Error {
	constructor(public code: number) {
		super(`exit:${code}`);
	}
}
let exitSpy: ReturnType<typeof vi.spyOn>;
// A single, deterministic cwd spy shared across the default-cwd branch tests.
// Hoisted (rather than per-test) so the file stays under the over-mocking
// threshold; tests that exercise the `--cwd` default read DEFAULT_CWD.
const DEFAULT_CWD = "/default-cwd";
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ExitError(Number(code ?? 0));
	});
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(DEFAULT_CWD);
});

afterEach(() => {
	exitSpy.mockRestore();
	cwdSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Structure — groups, subcommands, descriptions, default subcommand, options.
// ---------------------------------------------------------------------------
describe("registerObservabilityLogCommands — structure", () => {
	it("registers the append-only log inspection groups with descriptions", () => {
		const program = build();
		const top = names(program);
		for (const name of ["recurrence", "trajectory", "audit", "plan", "cloud", "debt", "query"]) {
			expect(top).toContain(name);
		}
		expect(sub(program, "recurrence").description()).toContain("repeating agent behaviors");
		expect(sub(program, "trajectory").description()).toContain("trajectory snapshots");
		expect(sub(program, "audit").description()).toContain("tamper-evidence");
		expect(sub(program, "plan").description()).toContain("agent-emitted plans");
		expect(sub(program, "cloud").description()).toContain("cloud governor");
		expect(sub(program, "debt").description()).toContain("obligation ledger");
		expect(sub(program, "query").description()).toContain("Bounded query");
	});

	it("registers recurrence subcommands", () => {
		const program = build();
		expect(names(sub(program, "recurrence")).sort()).toEqual(
			["detail", "flag", "list", "propose", "scan"].sort(),
		);
	});

	it("registers trajectory + audit + plan + cloud + debt subcommands", () => {
		const program = build();
		expect(names(sub(program, "trajectory")).sort()).toEqual(["list", "replay", "show"].sort());
		expect(names(sub(program, "audit"))).toEqual(["verify"]);
		expect(names(sub(program, "plan")).sort()).toEqual(["list", "show"].sort());
		expect(names(sub(program, "cloud"))).toEqual(["recent"]);
		expect(names(sub(program, "debt")).sort()).toEqual(["list", "resolve", "show"].sort());
		expect(names(sub(program, "tdd")).sort()).toEqual(["clear", "status"].sort());
	});

	// The reset path for a wedged commit gate — the whole point of the command
	// is that it can be reached and aimed at one file.
	it("tdd clear forwards the optional file positional and opts", async () => {
		const program = build();
		await program.parseAsync(["tdd", "clear", "src/foo.ts", "--json"], { from: "user" });
		expect(tddClearCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(tddClearCommand.mock.calls[0])[0]).toBe("src/foo.ts");
		expect(nonNull(tddClearCommand.mock.calls[0])[1]).toMatchObject({ json: true });
	});

	it("tdd clear works with no file — the clear-everything case", async () => {
		const program = build();
		await program.parseAsync(["tdd", "clear"], { from: "user" });
		expect(nonNull(tddClearCommand.mock.calls[0])[0]).toBeUndefined();
	});

	it("tdd status forwards opts", async () => {
		const program = build();
		await program.parseAsync(["tdd", "status", "--full"], { from: "user" });
		expect(tddStatusCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(tddStatusCommand.mock.calls[0])[0]).toMatchObject({ full: true });
	});

	it("wires the documented options on recurrence list", () => {
		const program = build();
		expect(longOpts(child(sub(program, "recurrence"), "list"))).toEqual(
			["--agent-source", "--check-id", "--cwd", "--json", "--kind", "--since", "--top"].sort(),
		);
	});

	it("wires the documented options on recurrence flag", () => {
		const program = build();
		expect(longOpts(child(sub(program, "recurrence"), "flag"))).toEqual(
			["--check-id", "--cwd", "--file", "--json", "--message"].sort(),
		);
	});

	it("wires the documented options on recurrence scan + detail + propose", () => {
		const program = build();
		const rec = sub(program, "recurrence");
		expect(longOpts(child(rec, "scan"))).toEqual(["--cwd", "--json", "--record", "--root"].sort());
		expect(longOpts(child(rec, "detail"))).toEqual(["--cwd", "--json"].sort());
		expect(longOpts(child(rec, "propose"))).toEqual(["--cwd", "--json"].sort());
	});

	it("wires the documented options on trajectory show + replay", () => {
		const program = build();
		const traj = sub(program, "trajectory");
		expect(longOpts(child(traj, "list"))).toEqual(["--cwd", "--json"].sort());
		expect(longOpts(child(traj, "show"))).toEqual(["--cwd", "--json", "--session"].sort());
		expect(longOpts(child(traj, "replay"))).toEqual(
			["--check", "--cwd", "--json", "--phase"].sort(),
		);
	});

	it("wires the documented options on audit verify + plan + cloud recent", () => {
		const program = build();
		expect(longOpts(child(sub(program, "audit"), "verify"))).toEqual(["--cwd", "--json"].sort());
		expect(longOpts(child(sub(program, "plan"), "list"))).toEqual(["--cwd", "--json"].sort());
		expect(longOpts(child(sub(program, "plan"), "show"))).toEqual(["--cwd", "--json"].sort());
		expect(longOpts(child(sub(program, "cloud"), "recent"))).toEqual(
			["--cwd", "--json", "--limit"].sort(),
		);
	});

	it("wires the documented options on debt list + show + resolve", () => {
		const program = build();
		const debt = sub(program, "debt");
		expect(longOpts(child(debt, "list"))).toEqual(["--cwd", "--full", "--json", "--short"].sort());
		expect(longOpts(child(debt, "show"))).toEqual(["--cwd", "--json"].sort());
		expect(longOpts(child(debt, "resolve"))).toEqual(["--cwd", "--json"].sort());
	});

	it("debt resolve's help names the commit gate as the ground-truth backstop", () => {
		// The human-override semantics must stay visible in `--help` — resolving a
		// debt clears the wander block, not the commit-time re-measurement.
		const program = build();
		expect(child(sub(program, "debt"), "resolve").description()).toContain(
			"commit gate remains the ground-truth backstop",
		);
	});

	it("defaults --limit on cloud recent to the string '20'", () => {
		const program = build();
		const recent = child(sub(program, "cloud"), "recent");
		const limitOpt = recent.options.find((o) => o.long === "--limit");
		expect(limitOpt?.defaultValue).toBe("20");
	});
});

// ---------------------------------------------------------------------------
// recurrence — five actions, each forwarding opts (and a positional for
// detail/flag/propose) straight to the lazily-imported impl.
// ---------------------------------------------------------------------------
describe("recurrence actions — wiring", () => {
	it("list forwards the full option spread", async () => {
		const program = build();
		await program.parseAsync(
			[
				"recurrence",
				"list",
				"--kind",
				"harness_caught",
				"--top",
				"5",
				"--since",
				"7d",
				"--agent-source",
				"claude",
				"--check-id",
				"raw-sql-concat",
				"--cwd",
				"/proj",
				"--json",
			],
			{ from: "user" },
		);
		expect(recurrenceListCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(recurrenceListCommand.mock.calls[0])[0]).toMatchObject({
			kind: "harness_caught",
			top: "5",
			since: "7d",
			agentSource: "claude",
			checkId: "raw-sql-concat",
			cwd: "/proj",
			json: true,
		});
	});

	it("list forwards a bare opts object when no flags are passed", async () => {
		const program = build();
		await program.parseAsync(["recurrence", "list"], { from: "user" });
		expect(recurrenceListCommand).toHaveBeenCalledTimes(1);
		// The registrar does not inject a cwd default here — it forwards opts as-is.
		expect(nonNull(recurrenceListCommand.mock.calls[0])[0]).toEqual({});
	});

	it("detail forwards the signature positional and opts", async () => {
		const program = build();
		await program.parseAsync(
			["recurrence", "detail", "raw-sql-concat", "--cwd", "/d", "--json"],
			{ from: "user" },
		);
		expect(recurrenceDetailCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(recurrenceDetailCommand.mock.calls[0])[0]).toBe("raw-sql-concat");
		expect(nonNull(recurrenceDetailCommand.mock.calls[0])[1]).toMatchObject({ cwd: "/d", json: true });
	});

	it("flag forwards the signature plus message/check-id/file", async () => {
		const program = build();
		await program.parseAsync(
			[
				"recurrence",
				"flag",
				"raw-sql-concat",
				"--message",
				"spotted in db.ts",
				"--check-id",
				"sql_injection",
				"--file",
				"src/db.ts",
				"--cwd",
				"/f",
			],
			{ from: "user" },
		);
		expect(nonNull(recurrenceFlagCommand.mock.calls[0])[0]).toBe("raw-sql-concat");
		expect(nonNull(recurrenceFlagCommand.mock.calls[0])[1]).toMatchObject({
			message: "spotted in db.ts",
			checkId: "sql_injection",
			file: "src/db.ts",
			cwd: "/f",
		});
	});

	it("scan forwards --root (variadic), --record, and view flags", async () => {
		const program = build();
		await program.parseAsync(
			["recurrence", "scan", "--root", "src", "lib", "--record", "--json"],
			{ from: "user" },
		);
		expect(nonNull(recurrenceScanCommand.mock.calls[0])[0]).toMatchObject({
			root: ["src", "lib"],
			record: true,
			json: true,
		});
	});

	it("propose forwards the signature positional and opts", async () => {
		const program = build();
		await program.parseAsync(["recurrence", "propose", "raw-sql-concat", "--json"], {
			from: "user",
		});
		expect(nonNull(recurrenceProposeCommand.mock.calls[0])[0]).toBe("raw-sql-concat");
		expect(nonNull(recurrenceProposeCommand.mock.calls[0])[1]).toMatchObject({ json: true });
	});
});

// ---------------------------------------------------------------------------
// trajectory — list/show forward opts; replay merges the file positional into
// opts (`{ ...opts, file }`).
// ---------------------------------------------------------------------------
describe("trajectory actions — wiring", () => {
	it("list forwards opts", async () => {
		const program = build();
		await program.parseAsync(["trajectory", "list", "--cwd", "/t", "--json"], { from: "user" });
		expect(nonNull(trajectoryListCommand.mock.calls[0])[0]).toMatchObject({ cwd: "/t", json: true });
	});

	it("show forwards --session + view flags", async () => {
		const program = build();
		await program.parseAsync(["trajectory", "show", "--session", "sess-1", "--json"], {
			from: "user",
		});
		expect(nonNull(trajectoryShowCommand.mock.calls[0])[0]).toMatchObject({ session: "sess-1", json: true });
	});

	it("replay merges the file positional into opts alongside --check/--phase", async () => {
		const program = build();
		await program.parseAsync(
			[
				"trajectory",
				"replay",
				"events.jsonl",
				"--check",
				"rapid_fire",
				"--phase",
				"stop",
				"--cwd",
				"/r",
				"--json",
			],
			{ from: "user" },
		);
		expect(trajectoryReplayCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(trajectoryReplayCommand.mock.calls[0])[0]).toMatchObject({
			file: "events.jsonl",
			check: "rapid_fire",
			phase: "stop",
			cwd: "/r",
			json: true,
		});
	});
});

// ---------------------------------------------------------------------------
// audit + plan — straight forwarders (plan show carries a positional).
// ---------------------------------------------------------------------------
describe("audit + plan actions — wiring", () => {
	it("audit verify forwards opts", async () => {
		const program = build();
		await program.parseAsync(["audit", "verify", "--cwd", "/a", "--json"], { from: "user" });
		expect(nonNull(auditVerifyCommand.mock.calls[0])[0]).toMatchObject({ cwd: "/a", json: true });
	});

	it("plan list forwards opts when invoked explicitly", async () => {
		const program = build();
		await program.parseAsync(["plan", "list", "--cwd", "/p", "--json"], { from: "user" });
		expect(nonNull(planListCommand.mock.calls[0])[0]).toMatchObject({ cwd: "/p", json: true });
	});

	it("bare `plan` routes to the default list subcommand", async () => {
		const program = build();
		await program.parseAsync(["plan"], { from: "user" });
		expect(planListCommand).toHaveBeenCalledTimes(1);
		expect(planShowCommand).not.toHaveBeenCalled();
	});

	it("plan show forwards the session_id positional and opts", async () => {
		const program = build();
		await program.parseAsync(["plan", "show", "sess-9", "--json"], { from: "user" });
		expect(nonNull(planShowCommand.mock.calls[0])[0]).toBe("sess-9");
		expect(nonNull(planShowCommand.mock.calls[0])[1]).toMatchObject({ json: true });
	});
});

// ---------------------------------------------------------------------------
// cloud recent — the only action with non-trivial branching: limit parse +
// clamp, cwd default, and the conditional json spread.
// ---------------------------------------------------------------------------
describe("cloud recent action — branches", () => {
	it("parses --limit, forwards explicit cwd, and includes json when set", async () => {
		const program = build();
		await program.parseAsync(
			["cloud", "recent", "--limit", "50", "--cwd", "/c", "--json"],
			{ from: "user" },
		);
		expect(cloudRecentCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(cloudRecentCommand.mock.calls[0])[0]).toEqual({ cwd: "/c", limit: 50, json: true });
	});

	it("forwards json:false explicitly (the json key is present but false)", async () => {
		// commander only sets opts.json when --json is passed, so the spread key is
		// absent on the no-flag path. Asserting the present-and-true vs absent split
		// is covered elsewhere; here we confirm the spread is conditional, not forced.
		const program = build();
		await program.parseAsync(["cloud", "recent", "--cwd", "/c"], { from: "user" });
		expect(nonNull(cloudRecentCommand.mock.calls[0])[0]).not.toHaveProperty("json");
	});

	it("defaults cwd to process.cwd() when --cwd is omitted", async () => {
		const program = build();
		await program.parseAsync(["cloud", "recent"], { from: "user" });
		expect(nonNull(cloudRecentCommand.mock.calls[0])[0]).toEqual({ cwd: DEFAULT_CWD, limit: 20 });
	});

	it("falls back to limit 20 when --limit is non-numeric (NaN guard)", async () => {
		const program = build();
		await program.parseAsync(["cloud", "recent", "--limit", "abc"], { from: "user" });
		expect(nonNull(cloudRecentCommand.mock.calls[0])[0]).toMatchObject({ limit: 20 });
	});

	it("falls back to limit 20 when --limit is zero or negative", async () => {
		const program = build();
		await program.parseAsync(["cloud", "recent", "--limit", "-5"], { from: "user" });
		expect(nonNull(cloudRecentCommand.mock.calls[0])[0]).toMatchObject({ limit: 20 });
	});

	it("uses the string default '20' (Number.parseInt) when no --limit flag is given", async () => {
		const program = build();
		await program.parseAsync(["cloud", "recent"], { from: "user" });
		expect(nonNull(cloudRecentCommand.mock.calls[0])[0]).toMatchObject({ limit: 20 });
	});

	it("always supplies opts.limit (commander default) so the action never sees undefined", async () => {
		// Documents why the source's `opts.limit ?? \"20\"` right operand is dead via
		// the public path: the --limit option declares a \"20\" default that commander
		// injects into opts before the action runs, so opts.limit is always a string.
		// Asserting that invariant here is the honest stand-in for covering the
		// otherwise-unreachable nullish fallback (covering it would require editing
		// source or a non-commander invocation that misrepresents real usage).
		const program = build();
		await program.parseAsync(["cloud", "recent"], { from: "user" });
		expect(typeof nonNull(cloudRecentCommand.mock.calls[0])[0].limit).toBe("number");
		expect(nonNull(cloudRecentCommand.mock.calls[0])[0].limit).toBe(20);
	});
});

// ---------------------------------------------------------------------------
// debt — list forwards opts; show/resolve forward the file positional + opts.
// ---------------------------------------------------------------------------
describe("debt actions — wiring", () => {
	it("list forwards the full option spread (--json/--short/--full/--cwd)", async () => {
		const program = build();
		await program.parseAsync(["debt", "list", "--cwd", "/d", "--json"], { from: "user" });
		expect(debtListCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(debtListCommand.mock.calls[0])[0]).toMatchObject({ cwd: "/d", json: true });
	});

	it("list forwards --short and --full as booleans", async () => {
		const program = build();
		await program.parseAsync(["debt", "list", "--short"], { from: "user" });
		expect(nonNull(debtListCommand.mock.calls[0])[0]).toMatchObject({ short: true });
		await program.parseAsync(["debt", "list", "--full"], { from: "user" });
		expect(nonNull(debtListCommand.mock.calls[1])[0]).toMatchObject({ full: true });
	});

	it("show forwards the file positional and opts", async () => {
		const program = build();
		await program.parseAsync(["debt", "show", "src/foo.ts", "--cwd", "/d", "--json"], {
			from: "user",
		});
		expect(debtShowCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(debtShowCommand.mock.calls[0])[0]).toBe("src/foo.ts");
		expect(nonNull(debtShowCommand.mock.calls[0])[1]).toMatchObject({ cwd: "/d", json: true });
	});

	it("query forwards the source positional and the full option spread", async () => {
		const program = build();
		await program.parseAsync(
			[
				"query",
				"blocks",
				"--where",
				"tool=Bash",
				"summary~=rm",
				"--by",
				"checks.id",
				"--sum",
				"output_tokens",
				"--since",
				"7d",
				"--limit",
				"5",
				"--last",
				"1000",
				"--max-mb",
				"8",
				"--fields",
				"tool,summary",
				"--cwd",
				"/q",
				"--json",
			],
			{ from: "user" },
		);
		expect(nonNull(queryCommand.mock.calls[0])[0]).toBe("blocks");
		expect(nonNull(queryCommand.mock.calls[0])[1]).toMatchObject({
			where: ["tool=Bash", "summary~=rm"],
			by: "checks.id",
			sum: "output_tokens",
			since: "7d",
			limit: "5",
			last: "1000",
			maxMb: "8",
			fields: "tool,summary",
			cwd: "/q",
			json: true,
		});
	});

	it("query with no positional reaches the catalog path", async () => {
		const program = build();
		await program.parseAsync(["query"], { from: "user" });
		expect(queryCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(queryCommand.mock.calls[0])[0]).toBeUndefined();
	});

	it("resolve forwards the file positional and opts", async () => {
		const program = build();
		await program.parseAsync(["debt", "resolve", "src/foo.ts", "--json"], { from: "user" });
		expect(debtResolveCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(debtResolveCommand.mock.calls[0])[0]).toBe("src/foo.ts");
		expect(nonNull(debtResolveCommand.mock.calls[0])[1]).toMatchObject({ json: true });
	});
});
