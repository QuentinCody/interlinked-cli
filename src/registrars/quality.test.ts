import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { registerQualityCommands } from "./quality.js";

// ---------------------------------------------------------------------------
// Mock every lazily-imported command implementation so the .action bodies run
// end-to-end (option spreads, default cwd, verify target-merge, sync vs await
// baseline calls) without touching the real filesystem, git tree, or network.
// ---------------------------------------------------------------------------
const checkCommand = vi.fn();
const searchCommand = vi.fn();
const multiEditCommand = vi.fn();
const verifyCommand = vi.fn();
const verifyChangesetCommand = vi.fn();
const writeCommand = vi.fn();
const structureInitCommand = vi.fn();
const structureScanCommand = vi.fn();
const structureStatusCommand = vi.fn();
const structureAcceptCommand = vi.fn();
const structureDoctorCommand = vi.fn();
const structureBaselineCommand = vi.fn();
const coverageCheckCommand = vi.fn();
const coverageBaselineCommand = vi.fn();
const metricsCommand = vi.fn();
const metricsCouplingCommand = vi.fn();
const metricsArchCommand = vi.fn();
const metricsReworkCommand = vi.fn();
const mutationCheckCommand = vi.fn();
const mutationBaselineCommand = vi.fn();
const mutationAcceptCommand = vi.fn();
const mutationMeasureCommand = vi.fn();
const mutationSurvivorsCommand = vi.fn();
const mutationSweepCommand = vi.fn();
const mutationCloudV3OnboardCommand = vi.fn();
const mutationCloudV3SubmitEditCommand = vi.fn();
const mutationCloudV3SubmitCommand = vi.fn();
const mutationCloudV3ProcessCommand = vi.fn();
const mutationCloudV3DeadLettersCommand = vi.fn();
const mutationCloudV3RedriveCommand = vi.fn();
const mutationDispositionCommand = vi.fn();
const deadcodeCommand = vi.fn();
const designCommand = vi.fn();

vi.mock("../commands/check.js", () => ({
	checkCommand: (...args: unknown[]) => checkCommand(...args),
}));
vi.mock("../commands/search.js", () => ({
	searchCommand: (...args: unknown[]) => searchCommand(...args),
}));
vi.mock("../commands/multi-edit.js", () => ({
	multiEditCommand: (...args: unknown[]) => multiEditCommand(...args),
}));
vi.mock("../commands/verify.js", () => ({
	verifyCommand: (...args: unknown[]) => verifyCommand(...args),
}));
vi.mock("../commands/verify-changeset.js", () => ({
	verifyChangesetCommand: (...args: unknown[]) => verifyChangesetCommand(...args),
}));
vi.mock("../commands/write.js", () => ({
	writeCommand: (...args: unknown[]) => writeCommand(...args),
}));
vi.mock("../commands/structure.js", () => ({
	structureInitCommand: (...args: unknown[]) => structureInitCommand(...args),
	structureScanCommand: (...args: unknown[]) => structureScanCommand(...args),
	structureStatusCommand: (...args: unknown[]) => structureStatusCommand(...args),
	structureAcceptCommand: (...args: unknown[]) => structureAcceptCommand(...args),
	structureDoctorCommand: (...args: unknown[]) => structureDoctorCommand(...args),
	structureBaselineCommand: (...args: unknown[]) => structureBaselineCommand(...args),
}));
vi.mock("../commands/coverage.js", () => ({
	coverageCheckCommand: (...args: unknown[]) => coverageCheckCommand(...args),
	coverageBaselineCommand: (...args: unknown[]) => coverageBaselineCommand(...args),
}));
vi.mock("../commands/metrics.js", () => ({
	metricsCommand: (...args: unknown[]) => metricsCommand(...args),
}));
vi.mock("../commands/metrics-coupling.js", () => ({
	metricsCouplingCommand: (...args: unknown[]) => metricsCouplingCommand(...args),
}));
vi.mock("../commands/metrics-arch.js", () => ({
	metricsArchCommand: (...args: unknown[]) => metricsArchCommand(...args),
}));
vi.mock("../commands/metrics-rework.js", () => ({
	metricsReworkCommand: (...args: unknown[]) => metricsReworkCommand(...args),
}));
vi.mock("../commands/mutation.js", () => ({
	mutationCheckCommand: (...args: unknown[]) => mutationCheckCommand(...args),
	mutationBaselineCommand: (...args: unknown[]) => mutationBaselineCommand(...args),
	mutationAcceptCommand: (...args: unknown[]) => mutationAcceptCommand(...args),
	mutationMeasureCommand: (...args: unknown[]) => mutationMeasureCommand(...args),
}));
vi.mock("../commands/mutation-survivors.js", () => ({
	mutationSurvivorsCommand: (...args: unknown[]) => mutationSurvivorsCommand(...args),
}));
vi.mock("../commands/mutation-sweep.js", () => ({
	mutationSweepCommand: (...args: unknown[]) => mutationSweepCommand(...args),
}));
vi.mock("../commands/mutation-cloud-v3.js", () => ({
	mutationCloudV3OnboardCommand: (...args: unknown[]) => mutationCloudV3OnboardCommand(...args),
	mutationCloudV3SubmitEditCommand: (...args: unknown[]) => mutationCloudV3SubmitEditCommand(...args),
	mutationCloudV3SubmitCommand: (...args: unknown[]) => mutationCloudV3SubmitCommand(...args),
	mutationCloudV3ProcessCommand: (...args: unknown[]) => mutationCloudV3ProcessCommand(...args),
	mutationCloudV3DeadLettersCommand: (...args: unknown[]) => mutationCloudV3DeadLettersCommand(...args),
	mutationCloudV3RedriveCommand: (...args: unknown[]) => mutationCloudV3RedriveCommand(...args),
}));
vi.mock("../commands/mutation-disposition.js", () => ({
	mutationDispositionCommand: (...args: unknown[]) => mutationDispositionCommand(...args),
}));
vi.mock("../commands/deadcode.js", () => ({
	deadcodeCommand: (...args: unknown[]) => deadcodeCommand(...args),
}));
vi.mock("../commands/design.js", () => ({
	designCommand: (...args: unknown[]) => designCommand(...args),
}));

function sub(program: Command, parent: string): Command {
	const found = program.commands.find((c) => c.name() === parent);
	if (!found) throw new Error(`missing parent command: ${parent}`);
	return found;
}

function build(): Command {
	const program = new Command();
	program.exitOverride(); // throw instead of process.exit on parse errors
	registerQualityCommands(program);
	return program;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ===========================================================================
// Structure (registration shape) — kept from the original suite, extended.
// ===========================================================================
describe("registerQualityCommands — structure", () => {
	it("registers the quality / edit top-level commands", () => {
		const program = new Command();
		registerQualityCommands(program);
		const top = program.commands.map((c) => c.name());
		for (const name of [
			"check",
			"search",
			"multi-edit",
			"verify",
			"write",
			"structure",
			"coverage",
			"mutation",
			"metrics",
			"design",
		]) {
			expect(top).toContain(name);
		}
	});

	it("registers structure / coverage / mutation subcommands", () => {
		const program = new Command();
		registerQualityCommands(program);
		expect(sub(program, "structure").commands.map((c) => c.name()).sort()).toEqual(
			["accept", "baseline", "doctor", "init", "scan", "status"].sort(),
		);
		expect(sub(program, "coverage").commands.map((c) => c.name()).sort()).toEqual(
			["baseline", "check"].sort(),
		);
		// `accept` (2026-07-29) is the audited equivalent-mutant annotation for the
		// LIVE per-edit manifest — the escape the gate's block message promises.
		expect(sub(program, "mutation").commands.map((c) => c.name()).sort()).toEqual(
			// `measure` (2026-08-01) closed the gap where out-of-band re-measurement
			// reported to a human but never reached the manifest, so campaign work
			// was invisible to the ratchet (files hardened 261 -> 25 survivors still
			// read 261). Read-only by default; `--record` writes via applyMeasuredRun.
			// `survivors` (2026-08-09) is the READ verb for the same manifest: every
			// mutant the runner already failed to kill was recorded and unreadable,
			// so standing mutation debt was reachable only by hand-written JSON
			// scripts. State only — no runner, no re-measurement.
			// `sweep` (2026-08-09) drives that work-list back through the SAME
			// single-file pipeline `measure` uses (`measureOneFile`), so the
			// RED-suite pre-flight exists once. Sequential per box; `--shard i/n`
			// is how a fleet splits the list with no coordinator.
			// `disposition` (2026-08-15, plan 18 M0) is the WRITE verb for the durable
			// disposition sidecar ledger (.interlinked/mutation-dispositions.json) — a
			// sidecar, NOT the manifest, because a re-measure rebuilds every MutantRecord
			// and drops its disposition (plan 18 §1.3). Records dead_code/unresolved
			// without touching status; supports --list / --show; monotonic under
			// baseline_integrity_gate so a hand-added record is blocked (§1.4).
			["accept", "baseline", "check", "cloud", "disposition", "measure", "survivors", "sweep"].sort(),
		);
		expect(sub(sub(program, "mutation"), "cloud").commands.map((c) => c.name()).sort()).toEqual(
			["dead-letters", "onboard", "process", "redrive", "submit", "submit-edit"],
		);
	});

	it("wires the documented options on each top-level command", () => {
		const program = build();
		const optsOf = (name: string) =>
			program.commands
				.find((c) => c.name() === name)
				?.options.map((o) => o.long)
				.sort();
		expect(optsOf("check")).toEqual(["--cwd", "--json", "--only", "--report", "--tools"].sort());
		expect(optsOf("search")).toEqual(
			["--context", "--engine", "--full", "--glob", "--json", "--limit", "--path", "--short", "--type"].sort(),
		);
		expect(optsOf("multi-edit")).toEqual(["--json", "--manifest", "--stdin"].sort());
		expect(optsOf("verify")).toEqual(
			[
				"--adoption-gate",
				"--all-checks",
				"--branch",
				"--cwd",
				"--dead-code",
				"--details",
				"--json",
				"--only",
				"--show-suppressions",
				"--skip",
				"--structure",
				"--structure-only",
				"--subdir",
				"--suggestions",
				"--suppress",
			].sort(),
		);
		expect(optsOf("write")).toEqual(
			["--batch", "--from-file", "--json", "--stdin", "--unsafe-outside-repo"].sort(),
		);
		expect(optsOf("metrics")).toEqual([
			"--cwd",
			"--full",
			"--include-tests",
			"--json",
			"--short",
			"--top",
		].sort());
	});

	it("wires the documented options on structure subcommands", () => {
		const program = build();
		const struct = sub(program, "structure");
		const optsOf = (name: string) =>
			struct.commands
				.find((c) => c.name() === name)
				?.options.map((o) => o.long)
				.sort();
		expect(optsOf("init")).toEqual(["--json", "--mode", "--with", "--write"].sort());
		expect(optsOf("scan")).toEqual(["--full", "--incremental", "--json"].sort());
		expect(optsOf("status")).toEqual(["--json"]);
		expect(optsOf("accept")).toEqual(["--json"]);
		expect(optsOf("doctor")).toEqual(["--json"]);
		expect(optsOf("baseline")).toEqual(["--json"]);
	});

	it("wires the documented options on coverage / mutation subcommands", () => {
		const program = build();
		const cov = sub(program, "coverage");
		const mut = sub(program, "mutation");
		const optsOf = (parent: Command, name: string) =>
			parent.commands
				.find((c) => c.name() === name)
				?.options.map((o) => o.long)
				.sort();
		// Reconciled 2026-09: the registered set is now exactly the set of
		// `opts.*` keys `coverageCheckCommand` reads. `--summary` / `--baseline`
		// were registered but never read (silently ignored); `--strict` /
		// `--changed-files` / `--cwd` were read but never registered, so
		// commander refused `--strict` outright. See coverage-flag-parity.test.ts.
		expect(optsOf(cov, "check")).toEqual(
			["--changed-files", "--cwd", "--json", "--report", "--strict", "--update-baseline"].sort(),
		);
		expect(optsOf(cov, "baseline")).toEqual(["--json"]);
		expect(optsOf(mut, "check")).toEqual(
			["--baseline", "--json", "--report", "--update-baseline"].sort(),
		);
		expect(optsOf(mut, "baseline")).toEqual(["--json"]);
	});

	it("applies the documented default option values", () => {
		const program = build();
		const defOf = (cmd: Command | undefined, long: string) =>
			cmd?.options.find((o) => o.long === long)?.defaultValue;
		const structInit = sub(program, "structure").commands.find((c) => c.name() === "init");
		const covCheck = sub(program, "coverage").commands.find((c) => c.name() === "check");
		const mutCheck = sub(program, "mutation").commands.find((c) => c.name() === "check");
		expect(defOf(structInit, "--mode")).toBe("standard");
		// `coverage check --report` deliberately has NO default: an explicit path
		// SUPPRESSES the multi-report LCOV + istanbul merge in resolveReportPaths,
		// so defaulting it would silently narrow every run to one file.
		expect(defOf(covCheck, "--report")).toBeUndefined();
		expect(defOf(mutCheck, "--report")).toBe("reports/mutation/mutation.json");
	});
});

// ===========================================================================
// check — action wiring
// ===========================================================================
describe("check — action wiring", () => {
	it("forwards all options to checkCommand", async () => {
		const program = build();
		await program.parseAsync(
			["check", "--only", "tsc", "--tools", "biome,eslint", "--report", "--json", "--cwd", "/c"],
			{ from: "user" },
		);
		expect(checkCommand).toHaveBeenCalledWith({
			only: "tsc",
			tools: "biome,eslint",
			report: true,
			json: true,
			cwd: "/c",
		});
	});

	it("passes empty opts to checkCommand by default", async () => {
		const program = build();
		await program.parseAsync(["check"], { from: "user" });
		expect(checkCommand).toHaveBeenCalledWith({});
	});

	it("treats --tools as a boolean flag when its optional value is omitted", async () => {
		const program = build();
		await program.parseAsync(["check", "--tools"], { from: "user" });
		expect(checkCommand).toHaveBeenCalledWith({ tools: true });
	});
});

// ===========================================================================
// search — action wiring (required <query> arg)
// ===========================================================================
describe("search — action wiring", () => {
	it("forwards query + all options to searchCommand", async () => {
		const program = build();
		await program.parseAsync(
			[
				"search",
				"needle",
				"--path",
				"/src",
				"--glob",
				"*.ts",
				"--type",
				"ts",
				"--limit",
				"50",
				"--context",
				"3",
				"--engine",
				"ripgrep",
				"--json",
			],
			{ from: "user" },
		);
		expect(searchCommand).toHaveBeenCalledWith("needle", {
			path: "/src",
			glob: "*.ts",
			type: "ts",
			limit: "50",
			context: "3",
			engine: "ripgrep",
			json: true,
		});
	});

	it("forwards the query with empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["search", "foo"], { from: "user" });
		expect(searchCommand).toHaveBeenCalledWith("foo", {});
	});

	it("supports the --short / --full output flags", async () => {
		const program = build();
		await program.parseAsync(["search", "bar", "--short", "--full"], { from: "user" });
		expect(searchCommand).toHaveBeenCalledWith("bar", { short: true, full: true });
	});
});

// ===========================================================================
// multi-edit — action wiring (optional [path] arg)
// ===========================================================================
describe("multi-edit — action wiring", () => {
	it("forwards path + options to multiEditCommand", async () => {
		const program = build();
		await program.parseAsync(
			["multi-edit", "src/a.ts", "--manifest", "m.json", "--json"],
			{ from: "user" },
		);
		expect(multiEditCommand).toHaveBeenCalledWith("src/a.ts", {
			manifest: "m.json",
			json: true,
		});
	});

	it("passes undefined path and the --stdin flag when path omitted", async () => {
		const program = build();
		await program.parseAsync(["multi-edit", "--stdin"], { from: "user" });
		expect(multiEditCommand).toHaveBeenCalledWith(undefined, { stdin: true });
	});

	it("passes undefined path and empty opts when nothing supplied", async () => {
		const program = build();
		await program.parseAsync(["multi-edit"], { from: "user" });
		expect(multiEditCommand).toHaveBeenCalledWith(undefined, {});
	});
});

// ===========================================================================
// verify — action wiring (target folded into the opts object; both branches)
// ===========================================================================
describe("verify — action wiring + target merge", () => {
	it("merges an explicit target into the opts object", async () => {
		const program = build();
		await program.parseAsync(["verify", "/repo", "--only", "tsc", "--json"], { from: "user" });
		expect(verifyCommand).toHaveBeenCalledWith({ only: "tsc", json: true, target: "/repo" });
	});

	it("omits the target key entirely when no target is given", async () => {
		const program = build();
		await program.parseAsync(["verify", "--all-checks"], { from: "user" });
		expect(verifyCommand).toHaveBeenCalledWith({ allChecks: true });
		// belt-and-suspenders: the false branch of the spread must not add `target`.
		expect(verifyCommand.mock.calls[0]?.[0]).not.toHaveProperty("target");
	});

	it("forwards the full option surface (camelCased) plus variadic --suppress", async () => {
		const program = build();
		await program.parseAsync(
			[
				"verify",
				"https://github.com/o/r",
				"--only",
				"biome",
				"--suggestions",
				"--json",
				"--details",
				"--cwd",
				"/w",
				"--branch",
				"main",
				"--subdir",
				"pkg",
				"--skip",
				"semgrep,knip",
				"--suppress",
				"a.ts:rule",
				"b.ts:rule:why",
				"--show-suppressions",
				"--structure",
				"--structure-only",
				"--adoption-gate",
				"--all-checks",
				"--dead-code",
			],
			{ from: "user" },
		);
		expect(verifyCommand).toHaveBeenCalledWith({
			target: "https://github.com/o/r",
			only: "biome",
			suggestions: true,
			json: true,
			details: true,
			cwd: "/w",
			branch: "main",
			subdir: "pkg",
			skip: "semgrep,knip",
			suppress: ["a.ts:rule", "b.ts:rule:why"],
			showSuppressions: true,
			structure: true,
			structureOnly: true,
			adoptionGate: true,
			allChecks: true,
			deadCode: true,
		});
	});
});

// ===========================================================================
// verify-changeset — action wiring (the agent-callable self-gate preview)
// ===========================================================================
describe("verify-changeset — action wiring", () => {
	it("forwards all options to verifyChangesetCommand", async () => {
		const program = build();
		await program.parseAsync(
			["verify-changeset", "--file", "changeset.json", "--warnings", "--json"],
			{ from: "user" },
		);
		expect(verifyChangesetCommand).toHaveBeenCalledWith({
			file: "changeset.json",
			warnings: true,
			json: true,
		});
	});

	it("passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["verify-changeset"], { from: "user" });
		expect(verifyChangesetCommand).toHaveBeenCalledWith({});
	});

	it("supports --stdin in place of --file", async () => {
		const program = build();
		await program.parseAsync(["verify-changeset", "--stdin"], { from: "user" });
		expect(verifyChangesetCommand).toHaveBeenCalledWith({ stdin: true });
	});
});

// ===========================================================================
// write — action wiring (optional [path] arg)
// ===========================================================================
describe("write — action wiring", () => {
	it("forwards path + all options to writeCommand", async () => {
		const program = build();
		await program.parseAsync(
			[
				"write",
				"src/x.ts",
				"--stdin",
				"--from-file",
				"src.txt",
				"--batch",
				"b.json",
				"--unsafe-outside-repo",
				"--json",
			],
			{ from: "user" },
		);
		expect(writeCommand).toHaveBeenCalledWith("src/x.ts", {
			stdin: true,
			fromFile: "src.txt",
			batch: "b.json",
			unsafeOutsideRepo: true,
			json: true,
		});
	});

	it("passes undefined path and empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["write"], { from: "user" });
		expect(writeCommand).toHaveBeenCalledWith(undefined, {});
	});
});

// ===========================================================================
// structure subcommands — action wiring
// ===========================================================================
describe("structure subcommands — action wiring", () => {
	it("init forwards options including the default --mode standard", async () => {
		const program = build();
		await program.parseAsync(["structure", "init"], { from: "user" });
		expect(structureInitCommand).toHaveBeenCalledWith({ mode: "standard" });
	});

	it("init forwards explicit options", async () => {
		const program = build();
		await program.parseAsync(
			["structure", "init", "--mode", "strict", "--with", "module,env", "--write", "--json"],
			{ from: "user" },
		);
		expect(structureInitCommand).toHaveBeenCalledWith({
			mode: "strict",
			with: "module,env",
			write: true,
			json: true,
		});
	});

	it("scan forwards its options", async () => {
		const program = build();
		await program.parseAsync(["structure", "scan", "--full", "--incremental", "--json"], {
			from: "user",
		});
		expect(structureScanCommand).toHaveBeenCalledWith({
			full: true,
			incremental: true,
			json: true,
		});
	});

	it("scan passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["structure", "scan"], { from: "user" });
		expect(structureScanCommand).toHaveBeenCalledWith({});
	});

	it("status forwards --json", async () => {
		const program = build();
		await program.parseAsync(["structure", "status", "--json"], { from: "user" });
		expect(structureStatusCommand).toHaveBeenCalledWith({ json: true });
	});

	it("accept forwards --json", async () => {
		const program = build();
		await program.parseAsync(["structure", "accept", "--json"], { from: "user" });
		expect(structureAcceptCommand).toHaveBeenCalledWith({ json: true });
	});

	it("doctor passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["structure", "doctor"], { from: "user" });
		expect(structureDoctorCommand).toHaveBeenCalledWith({});
	});

	it("baseline forwards the action arg and opts", async () => {
		const program = build();
		await program.parseAsync(["structure", "baseline", "save", "--json"], { from: "user" });
		expect(structureBaselineCommand).toHaveBeenCalledWith("save", { json: true });
	});

	it("baseline forwards the action arg with empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["structure", "baseline", "clear"], { from: "user" });
		expect(structureBaselineCommand).toHaveBeenCalledWith("clear", {});
	});
});

// ===========================================================================
// coverage subcommands — action wiring (check is awaited; baseline is sync)
// ===========================================================================
describe("coverage subcommands — action wiring", () => {
	it("check forwards an EMPTY opts object with no flags (no option carries a default)", async () => {
		const program = build();
		await program.parseAsync(["coverage", "check"], { from: "user" });
		expect(coverageCheckCommand).toHaveBeenCalledWith({});
	});

	it("check forwards explicit options", async () => {
		const program = build();
		await program.parseAsync(
			[
				"coverage",
				"check",
				"--report",
				"cov.json",
				"--changed-files",
				"src/a.ts,src/b.ts",
				"--cwd",
				"/repo",
				"--strict",
				"--update-baseline",
				"--json",
			],
			{ from: "user" },
		);
		expect(coverageCheckCommand).toHaveBeenCalledWith({
			report: "cov.json",
			changedFiles: "src/a.ts,src/b.ts",
			cwd: "/repo",
			strict: true,
			updateBaseline: true,
			json: true,
		});
	});

	it("runs check as the default subcommand of `coverage`", async () => {
		const program = build();
		await program.parseAsync(["coverage"], { from: "user" });
		expect(coverageCheckCommand).toHaveBeenCalledWith({});
	});

	it("baseline forwards --json (sync call)", async () => {
		const program = build();
		await program.parseAsync(["coverage", "baseline", "--json"], { from: "user" });
		expect(coverageBaselineCommand).toHaveBeenCalledWith({ json: true });
	});

	it("baseline passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["coverage", "baseline"], { from: "user" });
		expect(coverageBaselineCommand).toHaveBeenCalledWith({});
	});
});

// ===========================================================================
// metrics — action wiring
// ===========================================================================
describe("metrics — action wiring", () => {
	it("forwards all options to metricsCommand", async () => {
		const program = build();
		await program.parseAsync(
			[
				"metrics",
				"--cwd",
				"/m",
				"--top",
				"10",
				"--include-tests",
				"--json",
				"--short",
				"--full",
			],
			{ from: "user" },
		);
		expect(metricsCommand).toHaveBeenCalledWith({
			cwd: "/m",
			top: "10",
			includeTests: true,
			json: true,
			short: true,
			full: true,
		});
	});

	it("passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["metrics"], { from: "user" });
		expect(metricsCommand).toHaveBeenCalledWith({});
	});
});

// ===========================================================================
// metrics coupling — action wiring
// ===========================================================================
describe("metrics coupling — action wiring", () => {
	it("forwards all options to metricsCouplingCommand", async () => {
		const program = build();
		await program.parseAsync(
			[
				"metrics",
				"coupling",
				"--cwd",
				"/m",
				"--since",
				"30 days ago",
				"--min-support",
				"2",
				"--max-commit-files",
				"10",
				"--min-strength",
				"50",
				"--limit",
				"5",
				"--json",
			],
			{ from: "user" },
		);
		expect(metricsCouplingCommand).toHaveBeenCalledWith({
			cwd: "/m",
			since: "30 days ago",
			minSupport: "2",
			maxCommitFiles: "10",
			minStrength: "50",
			limit: "5",
			json: true,
		});
	});

	it("dispatches with empty opts by default and leaves the bare `metrics` action intact", async () => {
		const program = build();
		await program.parseAsync(["metrics", "coupling"], { from: "user" });
		expect(metricsCouplingCommand).toHaveBeenCalledWith({});
		expect(metricsCommand).not.toHaveBeenCalled();
	});

	it("falls back to {} (not a throw) when the subcommand has no registered parent", async () => {
		// Defensive branch: `cmd.parent?.opts() ?? {}` guards against a detached
		// subcommand (e.g. one built and invoked outside the normal `metrics`
		// tree). `.parent` is Commander's own public, mutable property — set it
		// to null to simulate that shape for real, then invoke the ORPHANED
		// command directly (parseAsync on it, not on `program`).
		const program = build();
		const coupling = nonNull(
			sub(program, "metrics").commands.find((c) => c.name() === "coupling"),
			"missing coupling subcommand",
		);
		coupling.parent = null;
		await coupling.parseAsync(["--json"], { from: "user" });
		expect(metricsCouplingCommand).toHaveBeenCalledWith({ json: true });
	});
});

// ===========================================================================
// metrics arch / rework — action wiring
// ===========================================================================
describe("metrics arch — action wiring", () => {
	it("forwards options, merging parent-owned --cwd/--json", async () => {
		const program = build();
		await program.parseAsync(
			["metrics", "arch", "--cwd", "/m", "--depth", "3", "--include-tests", "--json"],
			{ from: "user" },
		);
		expect(metricsArchCommand).toHaveBeenCalledWith({
			cwd: "/m",
			depth: "3",
			includeTests: true,
			json: true,
		});
	});

	it("falls back to {} when the subcommand has no registered parent", async () => {
		const program = build();
		const arch = nonNull(
			sub(program, "metrics").commands.find((c) => c.name() === "arch"),
			"missing arch subcommand",
		);
		arch.parent = null;
		await arch.parseAsync(["--json"], { from: "user" });
		expect(metricsArchCommand).toHaveBeenCalledWith({ json: true });
	});
});

describe("metrics rework — action wiring", () => {
	it("forwards options, merging parent-owned --cwd/--json", async () => {
		const program = build();
		await program.parseAsync(
			[
				"metrics",
				"rework",
				"--cwd",
				"/m",
				"--days",
				"60",
				"--window",
				"7",
				"--max-commits",
				"50",
				"--max-commit-files",
				"20",
				"--json",
			],
			{ from: "user" },
		);
		expect(metricsReworkCommand).toHaveBeenCalledWith({
			cwd: "/m",
			days: "60",
			window: "7",
			maxCommits: "50",
			maxCommitFiles: "20",
			json: true,
		});
	});

	it("falls back to {} when the subcommand has no registered parent", async () => {
		const program = build();
		const rework = nonNull(
			sub(program, "metrics").commands.find((c) => c.name() === "rework"),
			"missing rework subcommand",
		);
		rework.parent = null;
		await rework.parseAsync(["--json"], { from: "user" });
		expect(metricsReworkCommand).toHaveBeenCalledWith({ json: true });
	});
});

// ===========================================================================
// mutation subcommands — action wiring (check is awaited; baseline is sync)
// ===========================================================================
describe("mutation subcommands — action wiring", () => {
	it("check forwards options including the default --report", async () => {
		const program = build();
		await program.parseAsync(["mutation", "check"], { from: "user" });
		expect(mutationCheckCommand).toHaveBeenCalledWith({
			report: "reports/mutation/mutation.json",
		});
	});

	it("check forwards explicit options", async () => {
		const program = build();
		await program.parseAsync(
			[
				"mutation",
				"check",
				"--report",
				"mut.json",
				"--baseline",
				"mb.json",
				"--update-baseline",
				"--json",
			],
			{ from: "user" },
		);
		expect(mutationCheckCommand).toHaveBeenCalledWith({
			report: "mut.json",
			baseline: "mb.json",
			updateBaseline: true,
			json: true,
		});
	});

	it("runs check as the default subcommand of `mutation`", async () => {
		const program = build();
		await program.parseAsync(["mutation"], { from: "user" });
		expect(mutationCheckCommand).toHaveBeenCalledWith({
			report: "reports/mutation/mutation.json",
		});
	});

	it("baseline forwards --json (sync call)", async () => {
		const program = build();
		await program.parseAsync(["mutation", "baseline", "--json"], { from: "user" });
		expect(mutationBaselineCommand).toHaveBeenCalledWith({ json: true });
	});

	it("baseline passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["mutation", "baseline"], { from: "user" });
		expect(mutationBaselineCommand).toHaveBeenCalledWith({});
	});

	it("accept forwards the three required options plus --json to mutationAcceptCommand", async () => {
		const program = build();
		await program.parseAsync(
			[
				"mutation",
				"accept",
				"--file",
				"src/foo.ts",
				"--id",
				"m1",
				"--reason",
				"unobservable arm",
				"--json",
			],
			{ from: "user" },
		);
		expect(mutationAcceptCommand).toHaveBeenCalledWith({
			file: "src/foo.ts",
			id: "m1",
			reason: "unobservable arm",
			json: true,
		});
	});

	it("accept rejects when a required option is missing (commander enforces before the action runs)", async () => {
		const program = build();
		await expect(
			program.parseAsync(["mutation", "accept", "--file", "src/foo.ts", "--id", "m1"], {
				from: "user",
			}),
		).rejects.toThrow();
		expect(mutationAcceptCommand).not.toHaveBeenCalled();
	});

	it("measure forwards the file argument plus flags to mutationMeasureCommand", async () => {
		const program = build();
		await program.parseAsync(
			["mutation", "measure", "src/foo.ts", "--record", "--skip-preflight", "--json"],
			{ from: "user" },
		);
		expect(mutationMeasureCommand).toHaveBeenCalledWith("src/foo.ts", {
			record: true,
			skipPreflight: true,
			json: true,
		});
	});

	it("measure passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["mutation", "measure", "src/foo.ts"], { from: "user" });
		expect(mutationMeasureCommand).toHaveBeenCalledWith("src/foo.ts", {});
	});

	it("survivors forwards filter/shard/display options to mutationSurvivorsCommand", async () => {
		const program = build();
		await program.parseAsync(
			[
				"mutation",
				"survivors",
				"--file",
				"src/foo.ts",
				"--mutator",
				"ConditionalExpression",
				"--top",
				"5",
				"--shard",
				"1/3",
				"--include-dispositioned",
				"--include-stale",
				"--json",
			],
			{ from: "user" },
		);
		expect(mutationSurvivorsCommand).toHaveBeenCalledWith({
			file: "src/foo.ts",
			mutator: "ConditionalExpression",
			top: "5",
			shard: "1/3",
			includeDispositioned: true,
			includeStale: true,
			json: true,
		});
	});

	it("survivors passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["mutation", "survivors"], { from: "user" });
		expect(mutationSurvivorsCommand).toHaveBeenCalledWith({});
	});

	it("sweep forwards a single --runner-url as a one-element array to mutationSweepCommand", async () => {
		const program = build();
		await program.parseAsync(
			["mutation", "sweep", "--runner-url", "http://box-a:9000", "--limit", "3", "--dry-run"],
			{ from: "user" },
		);
		expect(mutationSweepCommand).toHaveBeenCalledWith({
			runnerUrl: ["http://box-a:9000"],
			limit: "3",
			dryRun: true,
		});
	});

	it("sweep accumulates repeated --runner-url flags into one array (fan-out)", async () => {
		const program = build();
		await program.parseAsync(
			[
				"mutation",
				"sweep",
				"--runner-url",
				"http://box-a:9000",
				"--runner-url",
				"http://box-b:9000",
				"--unqualified-only",
				"--skip-preflight",
			],
			{ from: "user" },
		);
		expect(mutationSweepCommand).toHaveBeenCalledWith({
			runnerUrl: ["http://box-a:9000", "http://box-b:9000"],
			unqualifiedOnly: true,
			skipPreflight: true,
		});
	});

	it("sweep passes empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["mutation", "sweep"], { from: "user" });
		expect(mutationSweepCommand).toHaveBeenCalledWith({});
	});

	it("cloud submit forwards only explicit local opt-in inputs", async () => {
		const program = build();
		await program.parseAsync([
			"mutation",
			"cloud",
			"submit",
			"--request",
			"request.json",
			"--artifact",
			"source.bundle",
			"--cwd",
			"/repo",
			"--json",
		], { from: "user" });
		expect(mutationCloudV3SubmitCommand).toHaveBeenCalledWith({
			request: "request.json",
			artifact: "source.bundle",
			config: ".interlinked/mutation-cloud-v3.local.json",
			cwd: "/repo",
			json: true,
		});
	});

	it("cloud submit-edit exposes only one target plus local opt-in runtime options", async () => {
		const program = build();
		const command = sub(sub(sub(program, "mutation"), "cloud"), "submit-edit");
		expect(command.options.map(({ long }) => long).sort()).toEqual(["--config", "--cwd", "--json"]);
		await program.parseAsync([
			"mutation",
			"cloud",
			"submit-edit",
			"src/answer.ts",
			"--cwd",
			"/repo",
			"--json",
		], { from: "user" });
		expect(mutationCloudV3SubmitEditCommand).toHaveBeenCalledWith("src/answer.ts", {
			config: ".interlinked/mutation-cloud-v3.local.json",
			cwd: "/repo",
			json: true,
		});
	});

	it("cloud onboard exposes no request, artifact, or adoption-intent options", async () => {
		const program = build();
		const cloud = sub(sub(program, "mutation"), "cloud");
		const onboard = sub(cloud, "onboard");
		expect(onboard.options.map(({ long }) => long).sort()).toEqual(["--config", "--cwd", "--json"]);
		await program.parseAsync([
			"mutation",
			"cloud",
			"onboard",
			"src/answer.ts",
			"--cwd",
			"/repo",
			"--json",
		], { from: "user" });
		expect(mutationCloudV3OnboardCommand).toHaveBeenCalledWith("src/answer.ts", {
			config: ".interlinked/mutation-cloud-v3.local.json",
			cwd: "/repo",
			json: true,
		});
	});

	it("cloud process forwards the durable runtime config without enabling the edit gate", async () => {
		const program = build();
		await program.parseAsync([
			"mutation",
			"cloud",
			"process",
			"--config",
			"custom.local.json",
		], { from: "user" });
		expect(mutationCloudV3ProcessCommand).toHaveBeenCalledWith({ config: "custom.local.json" });
	});

	it("cloud dead-letters forwards the bounded list options", async () => {
		const program = build();
		await program.parseAsync([
			"mutation",
			"cloud",
			"dead-letters",
			"--limit",
			"7",
			"--cwd",
			"/repo",
			"--json",
		], { from: "user" });
		expect(mutationCloudV3DeadLettersCommand).toHaveBeenCalledWith({
			limit: "7",
			config: ".interlinked/mutation-cloud-v3.local.json",
			cwd: "/repo",
			json: true,
		});
	});

	it("cloud redrive forwards the job id and fencing token without processing", async () => {
		const program = build();
		await program.parseAsync([
			"mutation",
			"cloud",
			"redrive",
			"job-dead-1",
			"--redrive-token",
			"token-1",
			"--config",
			"custom.local.json",
		], { from: "user" });
		expect(mutationCloudV3RedriveCommand).toHaveBeenCalledWith("job-dead-1", {
			redriveToken: "token-1",
			config: "custom.local.json",
		});
		expect(mutationCloudV3ProcessCommand).not.toHaveBeenCalled();
	});

	it("cloud redrive requires its fencing token before dispatch", async () => {
		const program = build();
		await expect(
			program.parseAsync(["mutation", "cloud", "redrive", "job-dead-1"], { from: "user" }),
		).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
		expect(mutationCloudV3RedriveCommand).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// mutation disposition — action wiring (the WRITE verb for the sidecar ledger)
// ===========================================================================
describe("mutation disposition — action wiring", () => {
	it("forwards a dead_code record's fields, camelCasing --budget-ms", async () => {
		const program = build();
		await program.parseAsync(
			[
				"mutation",
				"disposition",
				"--file",
				"src/foo.ts",
				"--id",
				"m1",
				"--kind",
				"dead_code",
				"--resolution",
				"delete",
				"--issue",
				"ILK-12",
				"--budget-ms",
				"5000",
				"--cwd",
				"/repo",
				"--json",
			],
			{ from: "user" },
		);
		expect(mutationDispositionCommand).toHaveBeenCalledWith({
			file: "src/foo.ts",
			id: "m1",
			kind: "dead_code",
			resolution: "delete",
			issue: "ILK-12",
			budgetMs: "5000",
			cwd: "/repo",
			json: true,
		});
	});

	it("forwards the read-only --list flag alone, with no record fields", async () => {
		const program = build();
		await program.parseAsync(["mutation", "disposition", "--list"], { from: "user" });
		expect(mutationDispositionCommand).toHaveBeenCalledWith({ list: true });
	});
});

// ===========================================================================
// deadcode — action wiring (the only action that publishes an exit code)
// ===========================================================================
describe("deadcode — action wiring", () => {
	let priorExitCode: typeof process.exitCode;

	beforeEach(() => {
		priorExitCode = process.exitCode;
	});

	afterEach(() => {
		process.exitCode = priorExitCode;
	});

	it("forwards all options to deadcodeCommand", async () => {
		deadcodeCommand.mockResolvedValue(0);
		const program = build();
		await program.parseAsync(["deadcode", "--cwd", "/repo", "--categorize", "--json"], {
			from: "user",
		});
		expect(deadcodeCommand).toHaveBeenCalledWith({ cwd: "/repo", categorize: true, json: true });
	});

	it("passes empty opts by default", async () => {
		deadcodeCommand.mockResolvedValue(0);
		const program = build();
		await program.parseAsync(["deadcode"], { from: "user" });
		expect(deadcodeCommand).toHaveBeenCalledWith({});
	});

	it("publishes the scan's resolved exit code on process.exitCode", async () => {
		deadcodeCommand.mockResolvedValue(2);
		const program = build();
		await program.parseAsync(["deadcode"], { from: "user" });
		expect(process.exitCode).toBe(2);
	});
});

// ===========================================================================
// design — action wiring (optional [path] arg; sync designCommand)
// ===========================================================================
describe("design — action wiring", () => {
	it("forwards path + flags to designCommand", async () => {
		const program = build();
		await program.parseAsync(["design", "src/", "--gpt", "--gemini", "--json"], { from: "user" });
		expect(designCommand).toHaveBeenCalledWith("src/", { gpt: true, gemini: true, json: true });
	});

	it("passes undefined path + empty opts by default", async () => {
		const program = build();
		await program.parseAsync(["design"], { from: "user" });
		expect(designCommand).toHaveBeenCalledWith(undefined, {});
	});
});
