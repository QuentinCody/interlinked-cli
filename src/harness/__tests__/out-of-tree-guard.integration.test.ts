// Regression test for the out-of-tree PostToolUse guard.
//
// The harness PostToolUse handler in `server.ts` runs three project-rooted
// analysis surfaces on every Edit/Write:
//   1. the project-wide sweep (cross-file tsc/biome over CWD),
//   2. `runStructureChecks` (artifact-graph build rooted at the project),
//   3. the subprocess `command`-based quality checks (tsc/biome/gitleaks),
//      which `quality-checks.ts` runs against a resolved project root.
// All three walk the filesystem from the edited file's project. When the
// edited file is OUTSIDE the harness's own project (CWD) — e.g. a file
// under `~/.claude/...` — the project root falls back to CWD and these
// surfaces would build/refresh THIS repo's graph and run THIS repo's
// tooling for a foreign file: wrong result, and an 11-19s tree walk.
//
// The guard skips all three for out-of-tree edits (gated on
// `editedFileInRepo`), while keeping the `markPhase(...)` calls firing so a
// skipped phase records ~0ms naturally. Inline content checks still run.
//
// This test drives a real harness daemon over its unix socket (the only
// path that exercises the `processEvent` PostToolUse handler and builds
// `phase_breakdown` / `tool_breakdown`). It asserts that out-of-tree edits
// skip the project-rooted surfaces and in-tree edits still trigger them. A
// declared glossary sentinel in every target file makes structure execution
// observable as a deterministic `glossary_residue` result; the assertion does
// not depend on how many milliseconds a graph walk happens to take.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessDecision, HarnessEvent } from "../types.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SERVER_ENTRY = join("src", "harness", "server.ts");

// Unique scratch root per process so parallel test files cannot collide on
// the socket path or the temp project tree.
const SCRATCH = join(tmpdir(), `interlinked-otg-${process.pid}`);
const PROJECT = join(SCRATCH, "proj"); // the harness's own project (CWD)
const OUTSIDE = join(SCRATCH, "elsewhere"); // a sibling tree, NOT under PROJECT
const FAKE_HOME = join(SCRATCH, "fake-home"); // mimics ~/.claude/...
const SOCKET = join(SCRATCH, "harness.sock");

// These budgets bound REAL subprocess work — including a biome run — so they
// are load-sensitive by nature, not resolution-sensitive. Measured 2026-08-05:
// the suite failed 4 tests here
// whenever anything else was busy (a second vitest worker, the repo's own
// harness daemon at ~566MB, a concurrent mutation run), and the file even
// flaked 1-in-2 running ALONE on a loaded box. A controlled bisect ruled out
// cross-test pollution: pairing the file with a trivial no-op test reproduced
// the failures identically, so no other test's state is involved.
//
// The budgets are generous rather than tight on purpose. Structure execution
// and skipping are proven from result presence/absence, so a larger ceiling
// weakens nothing the test checks; it only stops a busy machine from being
// reported as a broken guard.
const SERVER_STARTUP_TIMEOUT_MS = 120_000;
const SEND_TIMEOUT_MS = 120_000;
const STRUCTURE_SENTINEL = "obsolete_structure_sentinel";
const STRUCTURE_FINDING = "glossary_residue";

let server: ChildProcess;

/** Resolve when the harness prints its startup banner on stderr. */
function waitForServerReady(proc: ChildProcess): Promise<void> {
	return new Promise<void>((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			rejectPromise(new Error("harness did not start within timeout"));
		}, SERVER_STARTUP_TIMEOUT_MS);
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf-8").includes("Harness started")) {
				clearTimeout(timer);
				resolvePromise();
			}
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			rejectPromise(err);
		});
		proc.on("exit", (code) => {
			clearTimeout(timer);
			rejectPromise(new Error(`harness exited early (code ${code})`));
		});
	});
}

/** Send one newline-delimited event to the daemon, resolve with its decision. */
function sendEvent(event: HarnessEvent): Promise<HarnessDecision> {
	return new Promise<HarnessDecision>((resolvePromise, rejectPromise) => {
		const sock = connect(SOCKET);
		let buffer = "";
		const timer = setTimeout(() => {
			sock.destroy();
			rejectPromise(new Error("no response from harness within timeout"));
		}, SEND_TIMEOUT_MS);
		sock.on("connect", () => sock.write(`${JSON.stringify(event)}\n`));
		sock.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			const newlineIdx = buffer.indexOf("\n");
			if (newlineIdx !== -1) {
				clearTimeout(timer);
				sock.destroy();
				try {
					resolvePromise(JSON.parse(buffer.slice(0, newlineIdx)) as HarnessDecision);
				} catch {
					rejectPromise(new Error(`unparseable harness response: ${buffer.slice(0, 200)}`));
				}
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			rejectPromise(err);
		});
	});
}

/** Build a PostToolUse Edit event for a file path. */
function editEvent(filePath: string, sessionId: string): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: sessionId,
		agent_source: "claude",
		agent_name: "out-of-tree-guard-test",
		tool_name: "Edit",
		tool_input: { file_path: filePath, old_string: "1", new_string: "3" },
		timestamp: new Date(1_700_000_000_000).toISOString(),
		cwd: PROJECT,
	};
}

/** True when `phase_breakdown` carries the given phase key (regardless of ms). */
function hasPhase(decision: HarnessDecision, phase: string): boolean {
	return decision.phase_breakdown != null && phase in decision.phase_breakdown;
}

/** True when the declared glossary sentinel proves structure analysis ran. */
function hasStructureSentinelFinding(decision: HarnessDecision): boolean {
	return (
		decision.check_results?.some(
			(result) => result.source === "structure" && result.name === STRUCTURE_FINDING,
		) ?? false
	);
}

/** Valid TypeScript whose comment deterministically triggers the glossary rule. */
function structureSentinelSource(declaration: string): string {
	return `${declaration}\n// ${STRUCTURE_SENTINEL}\n`;
}

beforeAll(async () => {
	rmSync(SCRATCH, { recursive: true, force: true });
	mkdirSync(join(PROJECT, "src", "nested"), { recursive: true });
	mkdirSync(join(PROJECT, ".interlinked"), { recursive: true });
	mkdirSync(join(PROJECT, "interlinked", "artifacts"), { recursive: true });
	mkdirSync(OUTSIDE, { recursive: true });
	mkdirSync(join(FAKE_HOME, ".claude", "hooks"), { recursive: true });

	// Keep one command-based check enabled as the subprocess-surface
	// discriminator. `biome_lint` is backed by this package's npm dependency,
	// so CI and local runs don't depend on optional system binaries such as
	// gitleaks being installed.
	writeFileSync(
		join(PROJECT, ".interlinked", "guard-rules.json"),
		JSON.stringify({
			quality_checks: {
				typescript: { enabled: false },
				biome_lint: { enabled: true },
				biome_check: { enabled: false },
				semgrep: { enabled: false },
				eslint: { enabled: false },
				gitleaks: { enabled: false },
			},
		}),
	);
	writeFileSync(join(PROJECT, "biome.json"), JSON.stringify({ files: { ignoreUnknown: true } }));

	// Make structure execution observable without timing it. The glossary rule
	// reads every changed file and emits a fully deterministic result when it
	// finds this declared deprecated sentinel. Every in-tree and out-of-tree
	// target contains it, so presence proves execution and absence proves the
	// out-of-tree gate skipped the structure branch.
	writeFileSync(
		join(PROJECT, "interlinked", "structure.json"),
		JSON.stringify({
			version: 1,
			mode: "standard",
			artifacts: { glossary: "artifacts/glossary.json" },
		}),
	);
	writeFileSync(
		join(PROJECT, "interlinked", "artifacts", "glossary.json"),
		JSON.stringify({
			version: 1,
			terms: [
				{
					id: "preferred-structure-term",
					canonical: "preferred_structure_term",
					aliases: [],
					deprecated: [STRUCTURE_SENTINEL],
					docs: [],
				},
			],
		}),
	);

	// In-tree edit targets.
	writeFileSync(
		join(PROJECT, "src", "thing.ts"),
		structureSentinelSource("export const x: number = 1;"),
	);
	writeFileSync(
		join(PROJECT, "src", "nested", "deep.ts"),
		structureSentinelSource("export const z: number = 9;"),
	);
	// Out-of-tree edit targets: a sibling tree and a fake `~/.claude/...` path.
	writeFileSync(
		join(OUTSIDE, "foreign.ts"),
		structureSentinelSource("export const a: number = 1;"),
	);
	writeFileSync(
		join(FAKE_HOME, ".claude", "hooks", "hook.ts"),
		structureSentinelSource("export const b: number = 2;"),
	);

	server = spawn(
		TSX_BIN,
		[SERVER_ENTRY, "--socket", SOCKET, "--cwd", PROJECT, "--idle-timeout", "120000"],
		// `detached: true` makes the daemon its own process-group leader. tsx forks
		// the real `node server.ts` as a child, so a plain `server.kill()` in
		// afterAll only signals the launcher and ORPHANS the daemon — which then
		// lingers for the full --idle-timeout (2 min), leaking across the suite and
		// deadlocking the Linux CI run (finding 2026-06). afterAll signals the whole
		// group (negative pid) so the forked daemon dies with the launcher.
		{ cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"], detached: true },
	);
	await waitForServerReady(server);
}, SERVER_STARTUP_TIMEOUT_MS + 10_000);

afterAll(() => {
	// Signal the whole process group (negative pid) so the tsx-forked `node
	// server.ts` daemon dies with its launcher; fall back to a direct kill if the
	// group send fails (e.g. already reaped). A plain server.kill() left the
	// forked daemon orphaned and leaking (finding 2026-06).
	if (server?.pid !== undefined) {
		try {
			process.kill(-server.pid, "SIGKILL");
		} catch (e) {
			void e;
			try {
				server.kill("SIGKILL");
			} catch (e2) {
				void e2;
			}
		}
	}
	rmSync(SCRATCH, { recursive: true, force: true });
});

// 120s, overriding the global 30s. Without this the raised socket budgets above
// are dead letters: vitest would abort the test at 30s before the send timeout
// could fire, so the flake would persist while looking like a different bug.
// `write.test.ts` sets a 60s override for the same reason — real subprocess work
// does not fit the default.
describe("out-of-tree PostToolUse guard", { timeout: 400_000 }, () => {
	it("still runs subprocess + structure analysis for an in-tree edit", async () => {
		const decision = await sendEvent(
			editEvent(join(PROJECT, "src", "thing.ts"), "otg-in-abs"),
		);

		// Subprocess `command`-based check (biome_lint) ran: a per-tool breakdown
		// is present, and the `inline_biome_lint` phase mark fired.
		expect(decision.tool_breakdown).toBeDefined();
		expect(decision.tool_breakdown?.some((t) => t.tool === "biome")).toBe(true);
		expect(hasPhase(decision, "inline_biome_lint")).toBe(true);

		// Structure analysis ran: the declared glossary sentinel in the edited
		// file produced a deterministic structure result. This is independent of
		// whether the graph build takes 1ms or 100ms.
		expect(decision.checks_ran).toContain("structure");
		expect(hasStructureSentinelFinding(decision)).toBe(true);

		// Marks present here too (the in-tree path also goes through them).
		expect(hasPhase(decision, "project_wide_sweep")).toBe(true);
		expect(hasPhase(decision, "scored_suggestions")).toBe(true);
	});

	it("skips subprocess + structure analysis for an edit in a sibling tree", async () => {
		const decision = await sendEvent(
			editEvent(join(OUTSIDE, "foreign.ts"), "otg-out-sibling"),
		);

		// Subprocess `command`-based checks are skipped: no per-tool breakdown,
		// and the `inline_biome_lint` phase mark (fired only after the command
		// check actually runs) is absent.
		expect(decision.tool_breakdown ?? null).toBeNull();
		expect(hasPhase(decision, "inline_biome_lint")).toBe(false);

		// The file contains the same glossary sentinel as the in-tree control.
		// No structure result therefore proves the out-of-tree gate skipped the
		// structure branch, rather than merely completing it quickly.
		expect(decision.checks_ran ?? []).not.toContain("structure");
		expect(hasStructureSentinelFinding(decision)).toBe(false);

		// The phase marks still fire (skip the work, not the marks).
		expect(hasPhase(decision, "project_wide_sweep")).toBe(true);
		expect(hasPhase(decision, "scored_suggestions")).toBe(true);
		// The pre-gate boundary still fires for the same check — proving the
		// check was reached and then deliberately gated, not merely disabled.
		expect(hasPhase(decision, "yield_biome_lint")).toBe(true);
	});

	it("skips subprocess + structure analysis for an edit under a foreign ~/.claude path", async () => {
		const decision = await sendEvent(
			editEvent(join(FAKE_HOME, ".claude", "hooks", "hook.ts"), "otg-out-home"),
		);

		expect(decision.tool_breakdown ?? null).toBeNull();
		expect(hasPhase(decision, "inline_biome_lint")).toBe(false);
		expect(decision.checks_ran ?? []).not.toContain("structure");
		expect(hasStructureSentinelFinding(decision)).toBe(false);
		expect(hasPhase(decision, "project_wide_sweep")).toBe(true);
		expect(hasPhase(decision, "scored_suggestions")).toBe(true);
	});

	it("skips subprocess + structure analysis for a path that escapes CWD via ..", async () => {
		// `PROJECT/../escape.ts` resolves OUTSIDE PROJECT — confirms the guard
		// normalizes paths (`resolve`) rather than matching on a literal prefix.
		const escapePath = join(PROJECT, "..", "escape.ts");
		writeFileSync(
			escapePath,
			structureSentinelSource("export const c: number = 3;"),
		);

		const decision = await sendEvent(editEvent(escapePath, "otg-out-traversal"));

		expect(decision.tool_breakdown ?? null).toBeNull();
		expect(hasPhase(decision, "inline_biome_lint")).toBe(false);
		expect(decision.checks_ran ?? []).not.toContain("structure");
		expect(hasStructureSentinelFinding(decision)).toBe(false);
		expect(hasPhase(decision, "project_wide_sweep")).toBe(true);
		expect(hasPhase(decision, "scored_suggestions")).toBe(true);
	});

	it("still runs subprocess analysis for a nested in-tree edit", async () => {
		const decision = await sendEvent(
			editEvent(join(PROJECT, "src", "nested", "deep.ts"), "otg-in-nested"),
		);

		expect(decision.tool_breakdown).toBeDefined();
		expect(decision.tool_breakdown?.some((t) => t.tool === "biome")).toBe(true);
		expect(hasPhase(decision, "inline_biome_lint")).toBe(true);
		expect(hasStructureSentinelFinding(decision)).toBe(true);
	});

	it("still runs subprocess analysis for an in-tree edit given as a relative path", async () => {
		// A bare relative path (no leading slash) resolves within CWD — the
		// guard treats it as in-tree.
		const decision = await sendEvent(editEvent("src/thing.ts", "otg-in-relative"));

		expect(decision.tool_breakdown).toBeDefined();
		expect(decision.tool_breakdown?.some((t) => t.tool === "biome")).toBe(true);
		expect(hasPhase(decision, "inline_biome_lint")).toBe(true);
		expect(hasStructureSentinelFinding(decision)).toBe(true);
	});

	it("never crashes the PostToolUse pipeline for out-of-tree edits", async () => {
		// A correct, fast result is still returned — just without the
		// project-graph / sweep / subprocess phases.
		const decision = await sendEvent(
			editEvent(join(OUTSIDE, "foreign.ts"), "otg-out-result-shape"),
		);
		expect(decision.decision).toBe("allow");
		expect(decision.phase_breakdown).toBeDefined();
	});
});
