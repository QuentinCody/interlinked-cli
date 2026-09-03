// ===========================================
// verify-tools unit tests
// ===========================================
// Two halves:
//   1. Pins the external-tool spec table shape (`TOOLS_TO_RUN`).
//   2. Behavioral coverage of `streamExternalTools` — the streaming runner.
//      The real subprocess runners (`runToolWithSpinner` / `runToolSilent`)
//      and the output parsers are mocked so every branch (tool present/absent,
//      pass/fail, --only filter, dep-audit ternary, single vs parallel path,
//      suppression filtering, detail rendering, file-overflow, gitleaks/
//      semgrep/knip status short-circuits, tsc-zero special case) runs without
//      spawning a process or touching disk.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CheckEngine } from "../../harness/check-engine/index.js";
import type {
	AuditResult,
	CheckResult,
	ToolAvailability,
} from "../../harness/check-engine/types.js";
import { nonNull } from "../../lib/non-null.js";

// ----- mocks --------------------------------------------------------------

// suppressions: default to "nothing suppressed" (empty set). Individual tests
// override the implementation to suppress a specific (file, check) pair.
const loadFileSuppressions = vi.fn<(dir: string, file: string) => Set<string>>(
	() => new Set<string>(),
);
vi.mock("../../harness/suppressions.js", () => ({
	loadFileSuppressions: (dir: string, file: string) => loadFileSuppressions(dir, file),
}));

// output-parsers: each parser is a spy returning whatever the current test
// queued. parseToolOutput in the SUT decides WHETHER to call the parser; these
// stubs decide WHAT a called parser yields. parseNpmAuditJson returns an
// AuditResult | null directly (no array wrapping in the SUT's dep-audit path).
let parserReturn: CheckResult[] = [];
let npmAuditReturn: AuditResult | null = null;
const parseTscOutput = vi.fn<(o: string) => CheckResult[]>(() => parserReturn);
const parseBiomeOutput = vi.fn<(o: string) => CheckResult[]>(() => parserReturn);
const parseEslintOutput = vi.fn<(o: string) => CheckResult[]>(() => parserReturn);
const parseKnipJson = vi.fn<(o: string) => CheckResult[]>(() => parserReturn);
const parseSemgrepJson = vi.fn<(o: string, cwd: string) => CheckResult[]>(() => parserReturn);
const parseGitleaksJson = vi.fn<(o: string) => CheckResult[]>(() => parserReturn);
const parseOxlintJson = vi.fn<(o: string) => CheckResult[]>(() => parserReturn);
const parseNpmAuditJson = vi.fn<(o: string) => AuditResult | null>(() => npmAuditReturn);
const parseDocsCheckOutput = vi.fn<(o: string) => CheckResult[]>(() => parserReturn);
const parseGoTestOutput = vi.fn<(o: string, status: number) => CheckResult[]>(
	() => parserReturn,
);
vi.mock("../../harness/check-engine/output-parsers.js", () => ({
	parseTscOutput: (o: string) => parseTscOutput(o),
	parseBiomeOutput: (o: string) => parseBiomeOutput(o),
	parseEslintOutput: (o: string) => parseEslintOutput(o),
	parseKnipJson: (o: string) => parseKnipJson(o),
	parseSemgrepJson: (o: string, cwd: string) => parseSemgrepJson(o, cwd),
	parseGitleaksJson: (o: string) => parseGitleaksJson(o),
	parseOxlintJson: (o: string) => parseOxlintJson(o),
	parseNpmAuditJson: (o: string) => parseNpmAuditJson(o),
	parseDocsCheckOutput: (o: string) => parseDocsCheckOutput(o),
	parseGoTestOutput: (o: string, s: number) => parseGoTestOutput(o, s),
}));

// streaming-output: the two subprocess runners + spinner frames. Each runner
// invokes the SUT-provided `parseOutput(output, exitCode)` closure with a value
// queued per-binary, so `parseToolOutput` (and through it the mocked parsers)
// runs exactly as in production — minus the spawn. SPINNER_FRAMES must be a
// real non-empty array because the parallel path indexes it modulo length.
interface RunArgs {
	cmd: string[];
	parseOutput: (output: string, exitCode: number | null) => unknown[];
}
// queue of {output, status} keyed by cmd[1] (the verb) or cmd[0] for non-npx.
let runnerScript: Record<string, { output: string; status: number | null }>;
function runnerKey(cmd: string[]): string {
	// "npx tsc ..." -> "tsc"; "gitleaks detect ..." -> "gitleaks";
	// "node scripts/check-docs.mjs" -> "docs-check"; "npm audit" -> "audit".
	if (cmd[0] === "npx") return cmd[1] === "--yes" ? "biome" : (cmd[1] ?? "");
	if (cmd[0] === "node") return "docs-check";
	if (cmd[0] === "npm") return "audit";
	return cmd[0] ?? "";
}
// When true, runner promises resolve only after a 200ms timer, so the 80ms
// parallel spinner interval gets to fire at least once while work is pending
// (exercises the spinner-body branch). Default: resolve synchronously.
let deferRunners = false;
// Per-key override (keyed the same way as runnerScript, e.g. "tsc"/"dep audit"'s
// npm-audit key "audit") for tests that need staggered completion times to
// observe an intermediate spinner frame (partial completed/total, partial
// "waiting:" set) rather than just "eventually resolves".
let perKeyDelayMs: Record<string, number> = {};
function fakeRun(args: RunArgs): Promise<{ items: unknown[]; elapsedMs: string }> {
	const key = runnerKey(args.cmd);
	const scripted = runnerScript[key] ?? { output: "", status: 0 };
	const items = args.parseOutput(scripted.output, scripted.status);
	const value = { items, elapsedMs: "0.0s" };
	const delay = perKeyDelayMs[key] ?? (deferRunners ? 200 : 0);
	if (delay > 0) {
		return new Promise((resolve) => {
			setTimeout(() => resolve(value), delay);
		});
	}
	return Promise.resolve(value);
}
const runToolWithSpinner = vi.fn(fakeRun);
const runToolSilent = vi.fn(fakeRun);
vi.mock("./streaming-output.js", () => ({
	SPINNER_FRAMES: ["a", "b"],
	runToolWithSpinner: (args: RunArgs) => runToolWithSpinner(args),
	runToolSilent: (args: RunArgs) => runToolSilent(args),
}));

import { streamExternalTools, TOOLS_TO_RUN, type ToolSpec } from "./verify-tools.js";

// ----- harness ------------------------------------------------------------

let stderr: string[];
let origErr: typeof process.stderr.write;

beforeEach(() => {
	vi.clearAllMocks();
	parserReturn = [];
	npmAuditReturn = null;
	runnerScript = {};
	deferRunners = false;
	perKeyDelayMs = {};
	loadFileSuppressions.mockImplementation(() => new Set<string>());
	stderr = [];
	origErr = process.stderr.write;
	process.stderr.write = ((chunk: string) => {
		stderr.push(chunk);
		return true;
	}) as typeof process.stderr.write;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	process.stderr.write = origErr;
});

/** Build a fake CheckEngine whose discoverTools() marks `ids` available. */
function fakeEngine(ids: string[]): CheckEngine {
	const all: ToolAvailability[] = TOOLS_TO_RUN.map((t) => ({
		id: t.id,
		available: ids.includes(t.id),
	}));
	return { discoverTools: () => all } as unknown as CheckEngine;
}

interface RunOpts {
	available: string[];
	only?: string;
	skip?: string[];
	details?: boolean;
}

/**
 * Drive streamExternalTools with fake timers. The parallel path arms a
 * setInterval spinner and awaits Promise.all; advancing timers + flushing
 * microtasks lets the awaited promises settle so the function returns.
 */
async function run(opts: RunOpts): Promise<{
	summary: Array<{ label: string; count: number; color: string }>;
	flagged: Set<string>;
	out: string;
}> {
	const summary: Array<{ label: string; count: number; color: string }> = [];
	const flagged = new Set<string>();
	const p = streamExternalTools({
		engine: fakeEngine(opts.available),
		cwd: "/proj",
		opts: { ...(opts.only !== undefined ? { only: opts.only } : {}) },
		skipChecks: new Set(opts.skip ?? []),
		summary,
		allFlaggedFiles: flagged,
		details: opts.details ?? false,
	});
	await vi.runAllTimersAsync();
	await p;
	return { summary, flagged, out: stderr.join("") };
}

function result(over: Partial<CheckResult>): CheckResult {
	return {
		tool: "tsc",
		severity: "error",
		file: "a.ts",
		line: 1,
		message: "boom",
		...over,
	};
}

// =========================================================================
// 1. Spec table (kept from the original file — genuine data guards)
// =========================================================================

describe("TOOLS_TO_RUN", () => {
	it("includes the core external verifiers", () => {
		const ids = TOOLS_TO_RUN.map((t) => t.id);
		expect(ids).toContain("tsc");
		expect(ids).toContain("biome");
		expect(ids).toContain("oxlint");
		expect(ids).toContain("semgrep");
		expect(ids).toContain("gitleaks");
		expect(ids).toContain("docs-check");
	});

	it("gives every tool a non-empty command vector and ANSI severity color", () => {
		for (const tool of TOOLS_TO_RUN) {
			expect(tool.cmd.length).toBeGreaterThan(0);
			expect(tool.cmd.every((arg) => typeof arg === "string")).toBe(true);
			expect(["31", "33"]).toContain(tool.severity);
			expect(tool.label.length).toBeGreaterThan(0);
			expect(tool.passLabel.length).toBeGreaterThan(0);
			expect(tool.noun.length).toBeGreaterThan(0);
		}
	});

	it("has unique tool ids", () => {
		const ids = TOOLS_TO_RUN.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("exposes a structurally-typed ToolSpec", () => {
		const sample: ToolSpec = nonNull(TOOLS_TO_RUN[0]);
		expect(sample).toHaveProperty("id");
		expect(sample).toHaveProperty("cmd");
	});
});

describe("streamExternalTools — go-test command resolution", () => {
	it("--only go-test spawns the project's configured go_test argv (build tags)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "verify-go-test-"));
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "tool-commands.json"),
			JSON.stringify({ go_test: { base_args: ["-tags", "dev", "devaccounts", "./..."] } }),
			"utf-8",
		);
		try {
			runnerScript["go-test"] = { output: "ok", status: 0 };
			const summary: Array<{ label: string; count: number; color: string }> = [];
			const flagged = new Set<string>();
			const p = streamExternalTools({
				engine: fakeEngine(["go-test"]),
				cwd: tmp,
				opts: { only: "go-test" },
				skipChecks: new Set(["sca", "dep-audit"]),
				summary,
				allFlaggedFiles: flagged,
				details: false,
			});
			await vi.runAllTimersAsync();
			await p;
			// The static placeholder cmd is replaced by the resolved argv.
			const call = nonNull(runToolWithSpinner.mock.calls[0]);
			const args = nonNull(call[0]) as { cmd: string[] };
			expect(args.cmd).toEqual(["go", "test", "-tags", "dev", "devaccounts", "./..."]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// =========================================================================
// 2. streamExternalTools — single-tool fast path
// =========================================================================

describe("streamExternalTools — single available tool (spinner fast path)", () => {
	it("routes through runToolWithSpinner (not the parallel runner) and prints the pass label", async () => {
		// tsc available, nothing else; dep-audit skipped so toolCount === 1.
		runnerScript.tsc = { output: "", status: 0 };
		const { out, summary, flagged } = await run({
			available: ["tsc"],
			skip: ["sca", "dep-audit"],
		});
		expect(runToolWithSpinner).toHaveBeenCalledTimes(1);
		expect(runToolSilent).not.toHaveBeenCalled();
		// status 0 + tsc still runs the parser (the tsc special-case), but the
		// parser returned [] -> pass label.
		expect(parseTscOutput).toHaveBeenCalledOnce();
		expect(out).toContain("typescript");
		expect(out).toContain("no errors");
		expect(out).toContain("✓"); // ✓
		expect(summary).toEqual([]);
		expect(flagged.size).toBe(0);
	});

	it("renders findings, populates summary, and collects flagged files", async () => {
		runnerScript.tsc = { output: "err", status: 2 };
		parserReturn = [
			result({ file: "a.ts", line: 3, message: "type error A" }),
			result({ file: "b.ts", line: 9, message: "type error B" }),
		];
		const { out, summary, flagged } = await run({
			available: ["tsc"],
			skip: ["sca", "dep-audit"],
		});
		expect(out).toContain("✗"); // ✗
		expect(out).toContain("2"); // count
		expect(out).toContain("a.ts");
		expect(out).toContain("b.ts");
		expect(summary).toEqual([{ label: "2 typescript errors", count: 2, color: "31" }]);
		expect(flagged).toEqual(new Set(["a.ts", "b.ts"]));
	});

	it("with details=true prints per-line messages truncated to the cap", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		const longMsg = "Z".repeat(200);
		parserReturn = [result({ file: "a.ts", line: 42, message: longMsg })];
		const { out } = await run({
			available: ["tsc"],
			skip: ["sca", "dep-audit"],
			details: true,
		});
		expect(out).toContain("L42:");
		expect(out).toContain("Z".repeat(120));
		expect(out).not.toContain("Z".repeat(121)); // sliced to 120
	});

	it("with details=false omits per-line messages", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		parserReturn = [result({ file: "a.ts", line: 42, message: "secret detail" })];
		const { out } = await run({
			available: ["tsc"],
			skip: ["sca", "dep-audit"],
			details: false,
		});
		expect(out).toContain("a.ts");
		expect(out).not.toContain("L42:");
		expect(out).not.toContain("secret detail");
	});

	it("truncates the file list past MAX_LISTED_FILES and prints the overflow line", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		// 23 distinct files -> 20 listed + "... and 3 more files".
		parserReturn = Array.from({ length: 23 }, (_v, i) =>
			result({ file: `f${String(i).padStart(2, "0")}.ts`, message: "e" }),
		);
		const { out, summary } = await run({
			available: ["tsc"],
			skip: ["sca", "dep-audit"],
			details: true,
		});
		expect(out).toContain("... and 3 more files");
		expect(summary[0]).toMatchObject({ count: 23 });
	});

	it("caps per-file detail lines at MAX_FILE_DETAIL_LINES", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		// 7 findings on ONE file -> only first 5 detail lines render.
		parserReturn = Array.from({ length: 7 }, (_v, i) =>
			result({ file: "same.ts", line: i + 1, message: `m${i}` }),
		);
		const { out } = await run({
			available: ["tsc"],
			skip: ["sca", "dep-audit"],
			details: true,
		});
		expect(out).toContain("L1:");
		expect(out).toContain("L5:");
		expect(out).not.toContain("L6:");
		expect(out).not.toContain("L7:");
	});

	it("drops findings whose file suppresses this tool, then prints the pass label", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		parserReturn = [result({ file: "ignored.ts", line: 1, message: "e" })];
		// Suppress tsc for ignored.ts -> filteredItems empty -> pass branch.
		loadFileSuppressions.mockImplementation((_dir, file) =>
			file === "ignored.ts" ? new Set(["tsc"]) : new Set(),
		);
		const { out, summary, flagged } = await run({
			available: ["tsc"],
			skip: ["sca", "dep-audit"],
		});
		expect(out).toContain("no errors");
		expect(summary).toEqual([]);
		expect(flagged.size).toBe(0);
		// loadFileSuppressions was consulted against the project's .interlinked dir.
		expect(loadFileSuppressions).toHaveBeenCalledWith("/proj/.interlinked", "ignored.ts");
	});
});

// =========================================================================
// 3. parseToolOutput branches (driven through the runner's parseOutput closure)
// =========================================================================

describe("streamExternalTools — parseToolOutput status short-circuits", () => {
	it("status 0 on a non-tsc tool short-circuits to [] without calling the parser", async () => {
		// oxlint alone, exit 0 -> parseToolOutput returns [] before parser.
		runnerScript.oxlint = { output: "{}", status: 0 };
		parserReturn = [result({ file: "should-not.ts" })];
		const { out, summary } = await run({
			available: ["oxlint"],
			skip: ["sca", "dep-audit"],
		});
		expect(parseOxlintJson).not.toHaveBeenCalled();
		expect(out).toContain("no issues");
		expect(summary).toEqual([]);
	});

	it("tsc exit 0 STILL runs the parser (the tsc special case)", async () => {
		// tsc can print errors yet exit 0 in some configs, so status 0 is not
		// a clean signal for tsc -> parser runs.
		runnerScript.tsc = { output: "a.ts(1,1): error TS1", status: 0 };
		parserReturn = [result({ file: "a.ts", message: "TS1" })];
		const { summary } = await run({
			available: ["tsc"],
			skip: ["sca", "dep-audit"],
		});
		expect(parseTscOutput).toHaveBeenCalledOnce();
		expect(summary[0]).toMatchObject({ label: "1 typescript errors" });
	});

	it("gitleaks exit 1 with an FTL/no-such-file banner is treated as clean", async () => {
		runnerScript.gitleaks = { output: "FTL no such file or directory", status: 1 };
		parserReturn = [result({ tool: "gitleaks", file: "x.ts" })];
		const { out, summary } = await run({
			available: ["gitleaks"],
			skip: ["sca", "dep-audit"],
		});
		expect(parseGitleaksJson).not.toHaveBeenCalled();
		expect(out).toContain("no secrets detected");
		expect(summary).toEqual([]);
	});

	it("gitleaks exit 1 with real JSON findings is parsed (not the FTL branch)", async () => {
		runnerScript.gitleaks = { output: '[{"x":1}]', status: 1 };
		parserReturn = [result({ tool: "gitleaks", file: "leak.ts", message: "AWS key" })];
		const { summary, flagged } = await run({
			available: ["gitleaks"],
			skip: ["sca", "dep-audit"],
		});
		expect(parseGitleaksJson).toHaveBeenCalledOnce();
		expect(summary[0]).toMatchObject({ label: "1 gitleaks (secrets) secrets" });
		expect(flagged.has("leak.ts")).toBe(true);
	});

	it("semgrep exit 2 (internal error) is treated as clean", async () => {
		runnerScript.semgrep = { output: "boom", status: 2 };
		parserReturn = [result({ tool: "semgrep", file: "x.ts" })];
		const { out } = await run({
			available: ["semgrep"],
			skip: ["sca", "dep-audit"],
		});
		expect(parseSemgrepJson).not.toHaveBeenCalled();
		expect(out).toContain("no findings");
	});

	it("knip exit 2 is treated as clean", async () => {
		runnerScript.knip = { output: "boom", status: 2 };
		parserReturn = [result({ file: "x.ts" })];
		const { out } = await run({
			available: ["knip"],
			skip: ["sca", "dep-audit"],
		});
		expect(parseKnipJson).not.toHaveBeenCalled();
		expect(out).toContain("no unused exports or files");
	});

	it("semgrep non-zero status passes cwd through to the parser", async () => {
		runnerScript.semgrep = { output: '{"results":[]}', status: 1 };
		parserReturn = [result({ tool: "semgrep", file: "s.ts" })];
		await run({ available: ["semgrep"], skip: ["sca", "dep-audit"] });
		expect(parseSemgrepJson).toHaveBeenCalledWith('{"results":[]}', "/proj");
	});

	// Each TOOLS_TO_RUN id maps to a parser-dispatch arrow in `toolParsers`.
	// Drive each remaining tool through `parser(output)` with a non-short-
	// circuiting status so every arrow (and thus every parser) executes.
	it("oxlint non-zero status dispatches to parseOxlintJson", async () => {
		runnerScript.oxlint = { output: "{}", status: 1 };
		parserReturn = [result({ tool: "oxlint", file: "o.ts", message: "lint" })];
		const { summary } = await run({ available: ["oxlint"], skip: ["sca", "dep-audit"] });
		expect(parseOxlintJson).toHaveBeenCalledWith("{}");
		expect(summary[0]).toMatchObject({ label: "1 oxlint issues" });
	});

	it("knip non-zero (but not 2) status dispatches to parseKnipJson", async () => {
		runnerScript.knip = { output: "{}", status: 1 };
		parserReturn = [result({ file: "k.ts", message: "unused" })];
		const { summary } = await run({ available: ["knip"], skip: ["sca", "dep-audit"] });
		expect(parseKnipJson).toHaveBeenCalledWith("{}");
		expect(summary[0]).toMatchObject({ label: "1 knip (dead code) issues" });
	});

	it("eslint non-zero status dispatches to parseEslintOutput", async () => {
		runnerScript.eslint = { output: "out", status: 1 };
		parserReturn = [result({ tool: "eslint", file: "e.ts", message: "no-undef" })];
		const { summary } = await run({ available: ["eslint"], skip: ["sca", "dep-audit"] });
		expect(parseEslintOutput).toHaveBeenCalledWith("out");
		expect(summary[0]).toMatchObject({ label: "1 eslint issues" });
	});

	it("docs-check non-zero status dispatches to parseDocsCheckOutput", async () => {
		runnerScript["docs-check"] = { output: "drift!", status: 1 };
		parserReturn = [result({ file: "README.md", message: "gen marker drift" })];
		const { summary } = await run({ available: ["docs-check"], skip: ["sca", "dep-audit"] });
		expect(parseDocsCheckOutput).toHaveBeenCalledWith("drift!");
		expect(summary[0]).toMatchObject({ label: "1 docs:check (gen-marker drift) drifts" });
	});
});

// =========================================================================
// 4. availableTools filtering: --only and skipChecks
// =========================================================================

describe("streamExternalTools — tool selection", () => {
	it("returns immediately (toolCount === 0) when no tools are available and dep-audit skipped", async () => {
		const { out, summary } = await run({
			available: [],
			skip: ["sca", "dep-audit"],
		});
		expect(out).toBe("");
		expect(summary).toEqual([]);
		expect(runToolWithSpinner).not.toHaveBeenCalled();
		expect(runToolSilent).not.toHaveBeenCalled();
	});

	it("--only matches by tool id, excluding every other available tool", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		parserReturn = [result({ file: "a.ts" })];
		const { summary } = await run({
			available: ["tsc", "biome", "oxlint"],
			only: "tsc",
			skip: ["sca", "dep-audit"],
		});
		// Only tsc ran -> single-tool fast path.
		expect(runToolWithSpinner).toHaveBeenCalledTimes(1);
		expect(runToolSilent).not.toHaveBeenCalled();
		expect(summary[0]).toMatchObject({ label: "1 typescript errors" });
	});

	it("--only matches by human label as well as id", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		await run({
			available: ["tsc", "biome"],
			only: "typescript", // tsc's label
			skip: ["sca", "dep-audit"],
		});
		expect(runToolWithSpinner).toHaveBeenCalledTimes(1);
	});

	it("--only with no matching tool runs nothing", async () => {
		const { out } = await run({
			available: ["tsc", "biome"],
			only: "nonexistent",
			skip: ["sca", "dep-audit"],
		});
		expect(out).toBe("");
		expect(runToolWithSpinner).not.toHaveBeenCalled();
	});

	it("skipChecks removes a tool from the available set", async () => {
		runnerScript.biome = { output: "", status: 0 };
		await run({
			available: ["tsc", "biome"],
			skip: ["tsc", "sca", "dep-audit"], // drop tsc -> only biome left
		});
		// biome alone -> fast path; cmd routed to the biome key.
		expect(runToolWithSpinner).toHaveBeenCalledTimes(1);
		const arg = runToolWithSpinner.mock.calls[0]?.[0] as RunArgs;
		expect(arg.cmd).toContain("biome");
	});

	it("excludes a tool whose discoverTools entry is unavailable", async () => {
		// tsc requested available; biome NOT in available set -> filtered out by
		// the `avail?.available` check.
		runnerScript.tsc = { output: "", status: 0 };
		await run({
			available: ["tsc"],
			skip: ["sca", "dep-audit"],
		});
		expect(runToolWithSpinner).toHaveBeenCalledTimes(1);
		const arg = runToolWithSpinner.mock.calls[0]?.[0] as RunArgs;
		expect(arg.cmd).toContain("tsc");
	});
});

// =========================================================================
// 5. dep-audit gating ternary + parallel path
// =========================================================================

describe("streamExternalTools — dependency audit gating", () => {
	it("runs dep-audit by default (no --only, not skipped) — forces the parallel path", async () => {
		// One real tool + dep-audit => toolCount 2 => parallel path even though
		// only one TOOLS_TO_RUN entry is available.
		runnerScript.tsc = { output: "", status: 0 };
		npmAuditReturn = null; // no vulns
		const { out } = await run({ available: ["tsc"] });
		expect(runToolSilent).toHaveBeenCalledTimes(2); // tsc + npm audit
		expect(runToolWithSpinner).not.toHaveBeenCalled();
		expect(out).toContain("dependency audit (SCA)");
		expect(out).toContain("no known vulnerabilities");
		expect(out).toContain("all tools completed");
		expect(out).toContain("(parallel)");
	});

	it("renders dep-audit vulnerabilities with red severity when critical/high present", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		npmAuditReturn = {
			tool: "npm",
			total: 4,
			critical: 1,
			high: 0,
			moderate: 2,
			low: 1,
			detail: "1 critical, 2 moderate, 1 low",
		};
		const { out, summary } = await run({ available: ["tsc"] });
		expect(out).toContain("4");
		expect(out).toContain("1 critical, 2 moderate, 1 low");
		expect(summary).toContainEqual({ label: "4 dep vulnerabilities", count: 4, color: "31" });
	});

	it("uses yellow severity when only moderate/low vulnerabilities exist", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		npmAuditReturn = {
			tool: "npm",
			total: 2,
			critical: 0,
			high: 0,
			moderate: 1,
			low: 1,
			detail: "1 moderate, 1 low",
		};
		const { summary } = await run({ available: ["tsc"] });
		expect(summary).toContainEqual({ label: "2 dep vulnerabilities", count: 2, color: "33" });
	});

	it("--only sca runs ONLY dep-audit (no TOOLS_TO_RUN entries)", async () => {
		npmAuditReturn = null;
		const { out } = await run({ available: ["tsc", "biome"], only: "sca" });
		// availableTools is empty (only !== any tool id) but runDepAudit true.
		expect(runToolSilent).toHaveBeenCalledTimes(1);
		const arg = runToolSilent.mock.calls[0]?.[0] as RunArgs;
		expect(arg.cmd).toEqual(["npm", "audit", "--json", "--audit-level=moderate"]);
		expect(out).toContain("dependency audit (SCA)");
	});

	it("skipChecks 'sca' disables dep-audit", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		const { out } = await run({ available: ["tsc"], skip: ["sca"] });
		// dep-audit off + single tsc -> fast path, no SCA section.
		expect(runToolWithSpinner).toHaveBeenCalledTimes(1);
		expect(out).not.toContain("dependency audit (SCA)");
	});

	it("skipChecks 'dep-audit' (alias) disables dep-audit", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		const { out } = await run({ available: ["tsc"], skip: ["dep-audit"] });
		expect(runToolWithSpinner).toHaveBeenCalledTimes(1);
		expect(out).not.toContain("dependency audit (SCA)");
	});

	it("--only on a non-sca tool suppresses dep-audit", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		const { out } = await run({ available: ["tsc"], only: "tsc" });
		// only === "tsc" !== "sca" -> runDepAudit false -> fast path.
		expect(runToolWithSpinner).toHaveBeenCalledTimes(1);
		expect(out).not.toContain("dependency audit (SCA)");
	});
});

// =========================================================================
// 6. parallel path with multiple real tools + spinner
// =========================================================================

describe("streamExternalTools — parallel multi-tool path", () => {
	it("fans out across tools via runToolSilent and renders each result block", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		runnerScript.biome = { output: "{}", status: 1 };
		// Both parsers share parserReturn; give each a finding.
		parserReturn = [result({ file: "shared.ts", message: "issue" })];
		const { out, summary, flagged } = await run({
			available: ["tsc", "biome"],
			skip: ["sca", "dep-audit"],
		});
		expect(runToolSilent).toHaveBeenCalledTimes(2);
		expect(runToolWithSpinner).not.toHaveBeenCalled();
		expect(out).toContain("typescript");
		expect(out).toContain("biome");
		expect(out).toContain("all tools completed");
		// Each tool contributed a summary row.
		expect(summary).toHaveLength(2);
		expect(flagged.has("shared.ts")).toBe(true);
	});

	it("drives the spinner interval at least once before completion", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		runnerScript.biome = { output: "", status: 0 };
		// Hold the runners pending past the 80ms spinner tick so its body runs.
		deferRunners = true;
		const { out } = await run({
			available: ["tsc", "biome"],
			skip: ["sca", "dep-audit"],
		});
		// The spinner writes a "waiting:" progress line counting completed/total.
		expect(out).toContain("waiting:");
		expect(out).toContain("0/2");
		// Both pass labels still printed after the spinner is cleared.
		expect(out).toContain("no errors");
		expect(out).toContain("no issues");
	});

	it("parallel path: per-tool suppression still filters findings to the pass branch", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		runnerScript.biome = { output: "{}", status: 1 };
		parserReturn = [result({ file: "sup.ts", message: "issue" })];
		loadFileSuppressions.mockImplementation((_d, file) =>
			file === "sup.ts" ? new Set(["tsc", "biome"]) : new Set(),
		);
		const { summary, flagged } = await run({
			available: ["tsc", "biome"],
			skip: ["sca", "dep-audit"],
		});
		expect(summary).toEqual([]);
		expect(flagged.size).toBe(0);
	});
});

// =========================================================================
// 7. TOOLS_TO_RUN — exact command vectors (hand-transcribed, not derived
//    from the source's own constants — kills every StringLiteral mutant in
//    the table in one shot).
// =========================================================================

describe("TOOLS_TO_RUN — exact command vectors", () => {
	it("matches the hand-transcribed expected id -> cmd table exactly", () => {
		const expected: Record<string, string[]> = {
			oxlint: ["npx", "oxlint", "--format=json", "."],
			gitleaks: [
				"gitleaks",
				"detect",
				"--no-git",
				"--no-banner",
				"--report-format",
				"json",
				"--report-path",
				"/dev/stdout",
				"--source",
				".",
			],
			biome: [
				"npx",
				"--yes",
				"--package",
				"@biomejs/biome",
				"biome",
				"check",
				"--no-errors-on-unmatched",
				".",
			],
			eslint: ["npx", "eslint", "--no-error-on-unmatched-pattern", "--format", "unix", "."],
			tsc: ["npx", "tsc", "--noEmit", "--pretty", "false"],
			semgrep: [
				"semgrep",
				"scan",
				"--quiet",
				"--no-git-ignore",
				"--metrics",
				"off",
				"--config",
				"p/default",
				"--json",
				".",
			],
			knip: ["npx", "knip", "--no-progress", "--reporter", "json"],
			"docs-check": ["node", "scripts/check-docs.mjs"],
			// Static placeholder — streamExternalTools resolves the real argv
			// from .interlinked/tool-commands*.json before spawning.
			"go-test": ["go", "test", "./..."],
		};
		const actual: Record<string, string[]> = {};
		for (const t of TOOLS_TO_RUN) actual[t.id] = t.cmd;
		expect(actual).toEqual(expected);
	});
});

// =========================================================================
// 8. Tool-availability lookup (line 196: `avail?.available`)
// =========================================================================

describe("streamExternalTools — availability lookup", () => {
	it("filters out every tool when discoverTools() reports no entries at all (avail undefined, no throw)", async () => {
		// discoverTools() returns [] -> Array#find yields undefined for every
		// tool id, not `{ available: false }`. If `avail?.available` regresses to
		// `avail.available` this throws a TypeError inside the filter callback
		// and the whole streamExternalTools() promise rejects instead of
		// resolving to an empty, no-op run.
		const engine = { discoverTools: () => [] } as unknown as CheckEngine;
		const summary: Array<{ label: string; count: number; color: string }> = [];
		const flagged = new Set<string>();
		const p = streamExternalTools({
			engine,
			cwd: "/proj",
			opts: {},
			skipChecks: new Set(["sca", "dep-audit"]),
			summary,
			allFlaggedFiles: flagged,
			details: false,
		});
		await vi.runAllTimersAsync();
		await expect(p).resolves.toBeUndefined();
		expect(runToolWithSpinner).not.toHaveBeenCalled();
		expect(runToolSilent).not.toHaveBeenCalled();
	});
});

// =========================================================================
// 9. File-list ordering, truncation, and per-file detail isolation
//    (lines 233, 236, 237, 245)
// =========================================================================

describe("streamExternalTools — file list rendering", () => {
	it("lists flagged files in sorted (not discovery) order", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		// Insertion order is zeta, alpha, mid — sorted order is alpha, mid, zeta.
		parserReturn = [
			result({ file: "zeta.ts", message: "z" }),
			result({ file: "alpha.ts", message: "a" }),
			result({ file: "mid.ts", message: "m" }),
		];
		const { out } = await run({ available: ["tsc"], skip: ["sca", "dep-audit"] });
		const ia = out.indexOf("alpha.ts");
		const im = out.indexOf("mid.ts");
		const iz = out.indexOf("zeta.ts");
		expect(ia).toBeGreaterThan(-1);
		expect(ia).toBeLessThan(im);
		expect(im).toBeLessThan(iz);
	});

	it("prints at most MAX_LISTED_FILES (20) file lines even when more are flagged", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		parserReturn = Array.from({ length: 23 }, (_v, i) =>
			result({ file: `f${String(i).padStart(2, "0")}.ts`, message: "e" }),
		);
		const { out } = await run({ available: ["tsc"], skip: ["sca", "dep-audit"] });
		const fileLineMatches = out.match(/f\d\d\.ts/g) ?? [];
		expect(fileLineMatches.length).toBe(20);
	});

	it("does not show the overflow line at exactly MAX_LISTED_FILES (20) files", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		parserReturn = Array.from({ length: 20 }, (_v, i) =>
			result({ file: `g${String(i).padStart(2, "0")}.ts`, message: "e" }),
		);
		const { out, summary } = await run({ available: ["tsc"], skip: ["sca", "dep-audit"] });
		expect(out).not.toContain("more files");
		expect(summary[0]).toMatchObject({ count: 20 });
	});

	it("with details=true, per-file detail lines are isolated to their own file's block", async () => {
		runnerScript.tsc = { output: "x", status: 2 };
		parserReturn = [
			result({ file: "a.ts", line: 1, message: "MSGA1" }),
			result({ file: "a.ts", line: 2, message: "MSGA2" }),
			result({ file: "a.ts", line: 3, message: "MSGA3" }),
			result({ file: "b.ts", line: 1, message: "MSGB1" }),
			result({ file: "b.ts", line: 2, message: "MSGB2" }),
		];
		const { out } = await run({
			available: ["tsc"],
			skip: ["sca", "dep-audit"],
			details: true,
		});
		// If the per-file `.filter((r) => r.file === file)` collapses to
		// unfiltered `filteredItems`, EVERY file's block prints ALL 5 findings
		// (sliced to MAX_FILE_DETAIL_LINES=5), so "MSGB1" would appear once
		// under a.ts's block AND once under b.ts's block -> count 2 instead of 1.
		const countB1 = (out.match(/MSGB1/g) ?? []).length;
		const countA1 = (out.match(/MSGA1/g) ?? []).length;
		expect(countB1).toBe(1);
		expect(countA1).toBe(1);
	});
});

// =========================================================================
// 10. Dependency-audit severity + header text (lines 255, 257)
// =========================================================================

describe("streamExternalTools — dep-audit rendering detail", () => {
	it("prints the 'dependency audit (SCA)' header on the vulnerabilities-found branch", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		npmAuditReturn = {
			tool: "npm",
			total: 1,
			critical: 1,
			high: 0,
			moderate: 0,
			low: 0,
			detail: "1 critical",
		};
		const { out } = await run({ available: ["tsc"] });
		expect(out).toContain("dependency audit (SCA)");
	});

	it("uses red severity when only `high` (not `critical`) vulnerabilities exist", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		npmAuditReturn = {
			tool: "npm",
			total: 2,
			critical: 0,
			high: 2,
			moderate: 0,
			low: 0,
			detail: "2 high",
		};
		const { summary } = await run({ available: ["tsc"] });
		expect(summary).toContainEqual({ label: "2 dep vulnerabilities", count: 2, color: "31" });
	});
});

// =========================================================================
// 11. gitleaks status/output short-circuit logical structure (lines 277-279)
// =========================================================================

describe("streamExternalTools — gitleaks short-circuit is scoped to gitleaks only", () => {
	it("a non-gitleaks tool at status 1 with 'FTL' output is NOT treated as clean (rules out tool.id||status short-circuit)", async () => {
		runnerScript.oxlint = { output: "FTL something unrelated", status: 1 };
		parserReturn = [result({ tool: "oxlint", file: "o.ts", message: "lint issue" })];
		const { out } = await run({ available: ["oxlint"], skip: ["sca", "dep-audit"] });
		expect(parseOxlintJson).toHaveBeenCalled();
		expect(out).toContain("issues");
		expect(out).not.toContain("no issues");
	});

	it("gitleaks at status 2 (not 1) still runs the parser (rules out status===1 forced true)", async () => {
		runnerScript.gitleaks = { output: "FTL banner but status 2", status: 2 };
		parserReturn = [result({ tool: "gitleaks", file: "leak.ts", message: "AWS key" })];
		const { out } = await run({ available: ["gitleaks"], skip: ["sca", "dep-audit"] });
		expect(parseGitleaksJson).toHaveBeenCalled();
		expect(out).toContain("secrets");
		expect(out).not.toContain("no secrets detected");
	});

	it("gitleaks status 1 with only 'FTL' (no 'no such file') is still treated as clean (rules out && for the FTL/no-such-file OR)", async () => {
		runnerScript.gitleaks = { output: "FTL", status: 1 };
		parserReturn = [result({ tool: "gitleaks", file: "leak.ts", message: "AWS key" })];
		const { out } = await run({ available: ["gitleaks"], skip: ["sca", "dep-audit"] });
		expect(parseGitleaksJson).not.toHaveBeenCalled();
		expect(out).toContain("no secrets detected");
	});
});

// =========================================================================
// 12. Single-tool fast-path routing boundary (line 289)
// =========================================================================

describe("streamExternalTools — fast-path routing does not misfire on empty tool sets", () => {
	it("dep-audit-only run (0 TOOLS_TO_RUN entries, toolCount 1) resolves via the parallel runner, not the fast path", async () => {
		// availableTools.length === 0, so the fast-path guard
		// (toolCount<=1 && availableTools.length===1 && !runDepAudit) must be
		// false. If forced to `true`, `nonNull(availableTools[0])` throws on the
		// empty array and the returned promise rejects instead of resolving.
		npmAuditReturn = null;
		const p = (async () => {
			const summary: Array<{ label: string; count: number; color: string }> = [];
			const flagged = new Set<string>();
			const inner = streamExternalTools({
				engine: fakeEngine([]),
				cwd: "/proj",
				opts: { only: "sca" },
				skipChecks: new Set(),
				summary,
				allFlaggedFiles: flagged,
				details: false,
			});
			await vi.runAllTimersAsync();
			await inner;
			return { summary };
		})();
		await expect(p).resolves.toMatchObject({ summary: [] });
		expect(runToolSilent).toHaveBeenCalledTimes(1);
		expect(runToolWithSpinner).not.toHaveBeenCalled();
	});
});

// =========================================================================
// 13. Spinner "waiting:" label list (lines 305, 306, 311)
// =========================================================================

describe("streamExternalTools — spinner waiting-list text", () => {
	it("includes both queued tool labels and 'dep audit', comma-joined, when dep-audit is enabled", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		npmAuditReturn = null;
		perKeyDelayMs = { tsc: 100, audit: 100 };
		const { out } = await run({ available: ["tsc"] });
		expect(out).toContain("waiting: typescript, dep audit");
	});

	it("never mentions 'dep audit' in the waiting list when dep-audit is disabled", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		runnerScript.biome = { output: "", status: 0 };
		perKeyDelayMs = { tsc: 100, biome: 100 };
		const { out } = await run({ available: ["tsc", "biome"], skip: ["sca", "dep-audit"] });
		// TOOLS_TO_RUN order (not the `available:` array order) determines
		// iteration order -> biome precedes tsc in the table.
		expect(out).toContain("waiting: biome, typescript");
		expect(out).not.toContain("dep audit");
	});
});

// =========================================================================
// 14. Spinner frame indexing + elapsed-time arithmetic (lines 309, 310, 315, 359)
// =========================================================================

describe("streamExternalTools — spinner frame + elapsed-time arithmetic", () => {
	it("cycles frames via modulo (never indexes out of bounds) and reports correct elapsed seconds", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		runnerScript.biome = { output: "", status: 0 };
		// 300ms delay -> spinner ticks at 80/160/240ms (frame 0,1,2 -> 'a','b','a'
		// via SPINNER_FRAMES=["a","b"]) before both resolve at 300ms.
		perKeyDelayMs = { tsc: 300, biome: 300 };
		const { out } = await run({ available: ["tsc", "biome"], skip: ["sca", "dep-audit"] });
		// frame%length must select 'b' at the second tick; frame*length or
		// frame-- both eventually index out of SPINNER_FRAMES bounds ->
		// `${f}` interpolates the literal string "undefined".
		expect(out).not.toContain("undefined");
		expect(out).toContain("\x1b[36mb\x1b[0m");
		// Elapsed-seconds arithmetic: at an 80ms tick, (Date.now()-parallelStart)
		// / 1000 rounds to "0"; `* 1000` or `Date.now() + parallelStart` instead
		// of `-` produce a huge, wrong number.
		expect(out).toContain("0s — waiting:");
		// Final aggregate elapsed line uses the same arithmetic shape at 1 d.p.
		expect(out).toContain("all tools completed in 0.3s (parallel)");
	});
});

// =========================================================================
// 15. `completed` counter increments (lines 330, 349 — tool loop vs dep-audit)
// =========================================================================

describe("streamExternalTools — completed counter", () => {
	it("increments (not decrements) when a TOOLS_TO_RUN entry finishes first (line 330)", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		runnerScript.biome = { output: "", status: 0 };
		perKeyDelayMs = { tsc: 0, biome: 150 };
		const { out } = await run({ available: ["tsc", "biome"], skip: ["sca", "dep-audit"] });
		expect(out).toContain("\x1b[1m1/2\x1b[0m");
		expect(out).not.toContain("\x1b[1m-1/2\x1b[0m");
	});

	it("increments (not decrements) when dep-audit finishes first (line 349)", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		npmAuditReturn = null;
		perKeyDelayMs = { tsc: 150, audit: 0 };
		const { out } = await run({ available: ["tsc"] });
		expect(out).toContain("\x1b[1m1/2\x1b[0m");
		expect(out).not.toContain("\x1b[1m-1/2\x1b[0m");
	});
});

// =========================================================================
// 15b. `remaining.delete("dep audit")` actually removes the right key
//      (line 350) — if the string literal regresses to "", dep-audit never
//      leaves `remaining`, so a still-pending tool's spinner tick keeps
//      showing "dep audit" as waiting even after it completed.
// =========================================================================

describe("streamExternalTools — dep-audit is removed from the waiting set on completion", () => {
	it("stops listing 'dep audit' as waiting once it resolves, while another tool is still pending", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		npmAuditReturn = null;
		// dep-audit finishes well before the first 80ms spinner tick; tsc lingers.
		perKeyDelayMs = { tsc: 300, audit: 10 };
		const { out } = await run({ available: ["tsc"] });
		const waitingLines = out.split("\r\x1b[K").filter((s) => s.includes("waiting:"));
		expect(waitingLines.length).toBeGreaterThan(0);
		for (const line of waitingLines) {
			expect(line).not.toContain("dep audit");
		}
	});
});

// =========================================================================
// 16. Cursor clear-line escape sequences (lines 328, 347, 357)
// =========================================================================

describe("streamExternalTools — clear-line escape sequence counts", () => {
	it("emits one clear per completed TOOLS_TO_RUN entry plus one final clear (no dep-audit)", async () => {
		runnerScript.tsc = { output: "", status: 0 };
		runnerScript.biome = { output: "", status: 0 };
		const { out } = await run({ available: ["tsc", "biome"], skip: ["sca", "dep-audit"] });
		// 2 per-tool clears (line 328, once per tool) + 1 final clear (line 357).
		// If either is blanked to "", this count drops.
		const clears = (out.match(/\r\x1b\[K/g) ?? []).length;
		expect(clears).toBe(3);
	});

	it("emits one clear for dep-audit plus one final clear (dep-audit only)", async () => {
		npmAuditReturn = null;
		const { out } = await run({ available: [], only: "sca" });
		// 1 dep-audit clear (line 347) + 1 final clear (line 357).
		const clears = (out.match(/\r\x1b\[K/g) ?? []).length;
		expect(clears).toBe(2);
	});
});
