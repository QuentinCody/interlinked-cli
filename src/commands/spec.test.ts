// One real absolute path is designated to throw on its SECOND readFileSync
// call within a single `spec agenda` action — the first call is SpecLedger's
// own walk (which must succeed so the file lands in the ledger), the second
// is `contentsFor`'s re-read (which must fail to exercise its catch). Every
// other path, and every other read of the same path, is delegated to the
// real implementation.
let failOnSecondReadPath: string | null = null;
const readAttempts = new Map<string, number>();
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
			const [p] = args;
			if (typeof p === "string" && p === failOnSecondReadPath) {
				const n = (readAttempts.get(p) ?? 0) + 1;
				readAttempts.set(p, n);
				if (n >= 2) {
					throw new Error("EACCES: simulated unreadable-on-second-pass for coverage");
				}
			}
			return actual.readFileSync(...args);
		},
	};
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFinding, recordFinding } from "../harness/findings/corpus.js";
import { resetReviewReconcileCacheForTesting } from "../harness/server/review-reconcile-phase.js";
import { registerSpecCommands } from "./spec.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
	failOnSecondReadPath = null;
	readAttempts.clear();
});

beforeEach(() => resetReviewReconcileCacheForTesting());

describe("interlinked spec agenda", () => {
	it("writes the review-agenda artifact for the repo's markdown corpus", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spec-cli-")));
		roots.push(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(
			join(cwd, "PLAN.md"),
			// FG-INV sits under its OWN heading so "## The seven bets" binds only to
			// B — a shared section would spuriously bind "bet"→FG-INV (sol-max #14).
			"## The seven bets\n- B1 a\n- B2 b\n- B3 c\n- B4 d\n- B5 e\n- B6 f\n- B7 g\n## Invariants\n| FG-INV-01 | x |\n| FG-INV-02 | y |",
		);
		writeFileSync(
			join(cwd, "README.md"),
			// "Six bets" on its OWN line: co-locating it with the FG-INV ids would
			// bind "bet"→FG-INV by same-line co-occurrence and re-poison the noun.
			"Six bets do the work.\nFG-INV-01 and FG-INV-02 both apply here.",
		);
		// SPY, not process.chdir(): chdir THROWS in a worker thread
		// ("process.chdir() is not supported in workers"), and Stryker's vitest
		// runner pins its own pool, so a real chdir here fails the mutation dry
		// run for any file whose graph-selected test scope includes this one.
		// The spec command action handlers read `process.cwd()` explicitly, so
		// the spy exercises the same path; `cwd` is already realpathSync'd
		// above, matching what a real chdir would have resolved through.
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const program = new Command();
			registerSpecCommands(program);
			await program.parseAsync(["node", "interlinked", "spec", "agenda"]);
		} finally {
			cwdSpy.mockRestore();
			log.mockRestore();
		}
		const path = join(cwd, ".interlinked", "review-agenda.md");
		expect(existsSync(path)).toBe(true);
		const agenda = readFileSync(path, "utf8");
		expect(agenda).toContain("# Review agenda");
		expect(agenda).toContain("Compose-checks");
		expect(agenda).toContain("FG-INV");
		expect(agenda).toContain("Six bets");
	});
});

describe("interlinked spec invariants", () => {
	it("extracts a markdown registry into a taxonomy artifact", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spec-inv-")));
		roots.push(cwd);
		writeFileSync(
			join(cwd, "plan.md"),
			"| **FG-INV-18** | indexes never authoritative |\nThe commit stream MUST remain sole truth for recovery.",
		);
		// SPY, not process.chdir(): chdir THROWS in a worker thread
		// ("process.chdir() is not supported in workers"), and Stryker's vitest
		// runner pins its own pool, so a real chdir here fails the mutation dry
		// run for any file whose graph-selected test scope includes this one.
		// The spec command action handler reads `process.cwd()` explicitly for
		// the OUTPUT dir, so the spy covers that; but it also does
		// `readFileSync(file, ...)` on the raw <file> arg, which Node resolves
		// against the REAL OS cwd (not the process.cwd() spy) — so the input
		// path is passed absolute instead. `basename(file)` (used for the
		// output artifact name) is unaffected by that, so the assertions below
		// are unchanged.
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const program = new Command();
			registerSpecCommands(program);
			await program.parseAsync([
				"node",
				"interlinked",
				"spec",
				"invariants",
				join(cwd, "plan.md"),
			]);
		} finally {
			cwdSpy.mockRestore();
			log.mockRestore();
		}
		const artifact = readFileSync(
			join(cwd, ".interlinked", "policies", "plan.md.invariants.md"),
			"utf8",
		);
		expect(artifact).toContain("FG-INV-18");
		expect(artifact).toContain("doctrine");
		expect(artifact).toContain("sole truth");
	});
});

describe("interlinked spec agenda — unreadable-file accounting", () => {
	it("counts a ledger file that fails its re-read instead of silently dropping it", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spec-unreadable-")));
		roots.push(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const flaky = join(cwd, "FLAKY.md");
		writeFileSync(flaky, "## Six bets\n- B1 a");
		// First readFileSync (SpecLedger's walk) succeeds so the file lands in
		// the ledger; the second (contentsFor's re-read) throws — the TOCTOU
		// gap the try/catch at spec.ts's contentsFor exists to survive.
		failOnSecondReadPath = flaky;
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		let printed = "";
		try {
			const program = new Command();
			registerSpecCommands(program);
			await program.parseAsync(["node", "interlinked", "spec", "agenda"]);
			// Read the recorded calls BEFORE mockRestore() below — restoring a spy
			// also clears its call history, so reading afterward always sees [].
			printed = log.mock.calls.map((c) => String(c[0])).join("\n");
		} finally {
			cwdSpy.mockRestore();
			log.mockRestore();
		}
		expect(printed).toContain("(1 file(s) unreadable, omitted)");
	});
});

describe("interlinked spec agenda — open review findings", () => {
	it("renders an open review finding as a line naming its file, line, and message", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spec-openfind-")));
		roots.push(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(join(cwd, "README.md"), "Nothing special here.");
		const finding = makeFinding(
			{
				bug_class: "review_probe",
				message: "PROBE_MESSAGE_TEXT",
				file: "docs/probe.md",
				line: 7,
				source_runner: "spec-test",
			},
			cwd,
		);
		recordFinding(finding, cwd, { mirrorGlobal: false });
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const program = new Command();
			registerSpecCommands(program);
			await program.parseAsync(["node", "interlinked", "spec", "agenda"]);
		} finally {
			cwdSpy.mockRestore();
			log.mockRestore();
		}
		const agenda = readFileSync(join(cwd, ".interlinked", "review-agenda.md"), "utf8");
		// Literal text assembled by the `f.line ? ... : ""` ternary's TRUE arm:
		// inverting it (always/never appending ":7") would drop this exact
		// substring.
		expect(agenda).toContain("docs/probe.md:7 — PROBE_MESSAGE_TEXT");
	});
});
