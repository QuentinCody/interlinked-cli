import { makeGuardRules } from "./__tests__/fixtures.js";
// Coverage for the production DEFAULT_DEPS wiring in commit-gate.ts (the
// `deps` parameter's default value) — `defaultCyclomaticFor`, its
// `runnerFor`/`readFile` closures, none of which any other commit-gate test
// exercises: every other suite (commit-gate.integration.test.ts,
// commit-gate-*.test.ts) injects its OWN `cyclomaticFor`/`runnerFor`/`readFile`
// stubs specifically so no real suite/git/analyzer runs.
//
// These tests call `checkCommitGate(event, rules)` with the THIRD argument
// omitted, so it really does exercise the production defaults:
//   - `readFile`'s catch branch (a real EACCES) — cheap, no suite spawn,
//     reached during `selectChangedSources` before any suite decision.
//   - `defaultCyclomaticFor("ts")` + `DEFAULT_DEPS.runnerFor("ts")` — reached
//     only after a REAL, successfully-measured coverage run, so this test
//     spawns the repo's own installed Vitest against a tiny throwaway
//     project (one trivial passing test) so it completes in well under a
//     second rather than running this repo's full suite.
//
// The throwaway git repos live under `<repo>/scratch/` per the scratchpad
// governance carve-out (agent-authored probes belong there, not in a host
// tmpdir) and are removed in `afterEach`.

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { checkCommitGate } from "./commit-gate.js";

const REPO_ROOT = realpathSync(join(__dirname, "..", "..", ".."));
const SCRATCH_ROOT = join(REPO_ROOT, "scratch");

let repoDir: string | null = null;

afterEach(() => {
	if (repoDir) rmSync(repoDir, { recursive: true, force: true });
	repoDir = null;
});

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function rules(overrides?: Partial<NonNullable<GuardRulesConfig["per_edit_coverage"]>>): GuardRulesConfig {
	return ({ ...makeGuardRules(),
		per_edit_coverage: { ...({ enabled: false, mode: "block", budget_ms: 25_000, languages: [] } satisfies NonNullable<GuardRulesConfig["per_edit_coverage"]>),
			enabled: true,
			mode: "block",
			budget_ms: 25_000,
			languages: ["js", "ts"],
			block_on_test_failure: true,
			block_on_crap: true,
			...overrides,
		},
	} satisfies GuardRulesConfig);
}

function commitEvent(cwd: string, command = 'git commit -m "test commit"'): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-defaults",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-08-06T00:00:00.000Z",
		cwd,
	};
}

function initRepo(name: string): string {
	const dir = join(SCRATCH_ROOT, name);
	mkdirSync(join(dir, "src"), { recursive: true });
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "test"]);
	repoDir = dir;
	return dir;
}

describe("checkCommitGate — production DEFAULT_DEPS", () => {
	it("degrades the readFile default to null on a real EACCES, and on a real missing file, without spawning a suite", async () => {
		const dir = initRepo(`commit-gate-defaults-eacces-${process.pid}`);
		const target = join(dir, "src", "locked.ts");
		const gone = join(dir, "src", "gone.ts");
		writeFileSync(target, "export const x = 1;\n");
		writeFileSync(gone, "export const y = 1;\n");
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "initial"]);

		// Modify + strip all read permission so the DEFAULT readFile's
		// `readFileSync` throws EACCES even though `existsSync` (a stat call)
		// still reports the path as present — the CATCH branch.
		writeFileSync(target, "export const x = 2;\n");
		chmodSync(target, 0o000);
		// A genuinely deleted tracked file — `existsSync` reports false, so
		// readFile takes the ternary's OTHER branch (never reaches
		// `readFileSync` at all) instead of the catch.
		unlinkSync(gone);

		try {
			// A compound `git add -A && git commit` CONSTRUCTS content broadly —
			// `resolveEvalTarget` then evaluates the REAL worktree directly
			// (no `git checkout-index` snapshot, which would re-materialize the
			// file with fresh, readable permissions and defeat the chmod). This
			// is also the only way to reach the real `readFile` default in the
			// FIRST place: a plain `git commit` always evaluates a materialized
			// snapshot copy.
			//
			// block_on_test_failure: false + the file reading as "deleted" (null
			// content, sourceCount 0) takes the zero-cost early-exit in
			// `noGatedSourcesDecision` — no suite spawn, but `readFile` (including
			// its catch) already ran during `selectChangedSources`.
			const decision = await checkCommitGate(
				commitEvent(dir, 'git add -A && git commit -m "test commit"'),
				rules({ block_on_test_failure: false }),
			);
			expect(decision).toBeNull();
		} finally {
			chmodSync(target, 0o644);
		}
	});

	it("runs the real defaultCyclomaticFor + runnerFor pipeline end to end (real Vitest, real git)", async () => {
		const dir = initRepo(`commit-gate-defaults-suite-${process.pid}`);
		// Symlink this repo's own node_modules in so the runner's local-bin
		// lookup (`<projectRoot>/node_modules/.bin/vitest`) resolves to the
		// real, already-installed Vitest — no network, no separate install.
		// Tracked (not gitignored) so `materializeIndexSnapshot`'s
		// `git checkout-index` carries the symlink into the evaluated snapshot
		// too (the gate always evaluates a materialized copy, never the live
		// worktree, for a plain index commit).
		symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
		writeFileSync(
			join(dir, "vitest.config.ts"),
			'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: {} });\n',
		);
		writeFileSync(
			join(dir, "src", "a.ts"),
			[
				"export function add(a: number, b: number): number {",
				"\treturn a + b;",
				"}",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(dir, "src", "a.test.ts"),
			[
				'import { expect, it } from "vitest";',
				'import { add } from "./a.js";',
				'it("adds", () => {',
				"\texpect(add(1, 2)).toBe(3);",
				"});",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(dir, "src", "b.js"),
			["export function triple(n) {", "\treturn n * 3;", "}", ""].join("\n"),
		);
		writeFileSync(
			join(dir, "src", "b.test.js"),
			[
				'import { expect, it } from "vitest";',
				'import { triple } from "./b.js";',
				'it("triples", () => {',
				"\texpect(triple(2)).toBe(6);",
				"});",
				"",
			].join("\n"),
		);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "initial"]);

		// A trivial, fully-covered, low-complexity CHANGE to BOTH a .ts and a
		// .js source file — staged for the commit the gate evaluates. Real
		// `defaultCyclomaticFor` runs against both via the real
		// `computeCyclomaticAst` (exercising the `case "ts"` AND `case "js"`
		// switch labels), and the real Vitest run reports both fully covered,
		// so the gate should ALLOW.
		writeFileSync(
			join(dir, "src", "a.ts"),
			[
				"export function add(a: number, b: number): number {",
				"\treturn a + b;",
				"}",
				"",
				"export function double(n: number): number {",
				"\treturn n * 2;",
				"}",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(dir, "src", "a.test.ts"),
			[
				'import { expect, it } from "vitest";',
				'import { add, double } from "./a.js";',
				'it("adds", () => {',
				"\texpect(add(1, 2)).toBe(3);",
				"});",
				'it("doubles", () => {',
				"\texpect(double(4)).toBe(8);",
				"});",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(dir, "src", "b.js"),
			[
				"export function triple(n) {",
				"\treturn n * 3;",
				"}",
				"",
				"export function quadruple(n) {",
				"\treturn n * 4;",
				"}",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(dir, "src", "b.test.js"),
			[
				'import { expect, it } from "vitest";',
				'import { triple, quadruple } from "./b.js";',
				'it("triples", () => {',
				"\texpect(triple(2)).toBe(6);",
				"});",
				'it("quadruples", () => {',
				"\texpect(quadruple(2)).toBe(8);",
				"});",
				"",
			].join("\n"),
		);
		git(dir, ["add", "-A"]);

		const decision = await checkCommitGate(commitEvent(dir), rules());
		// A fully-covered, low-complexity change against a green suite — the
		// gate allows. The point of this test is that it got here at all
		// through the REAL runnerFor/cyclomaticFor/readFile defaults, not a
		// mocked stand-in; a `null` (allow) confirms nothing degraded.
		expect(decision).toBeNull();
	}, 30_000);
});
