import { makeGuardRules } from "./__tests__/fixtures.js";
// Tests for the new-file TDD gate.
//
// Shape of each case: build a tmpdir, optionally pre-seed companion tests or
// session state, call `evaluateTddNewFileGate`, assert the decision. No
// mocking — the gate only touches the filesystem and the session trajectory.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
import { readOpenDebts } from "../obligation-ledger-io.js";
import { resetRepoProfileCache } from "../repo-profile.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { companionTestCandidates } from "./companion-test.js";
import {
	evaluateTddNewFileGate,
	evaluateTddNewFileGateForEvent,
	hasTddExemptDirective,
} from "./tdd-new-file-gate.js";

let tmp: string;

function makeSession(writtenAbs: string[] = []): SessionTrajectory {
	return {
		...makeSessionFixture(),
		session_id: "t",
		agent_name: "t",
		started_at: "",
		files_written: new Set(writtenAbs),
	};
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "tdd-gate-"));
	mkdirSync(join(tmp, "src"), { recursive: true });
	// The gate is now repo-profile aware. Seed one unrelated colocated test
	// file so this shared fixture profiles as `testLayout: "colocated"` — the
	// layout every historical expectation below was written against. (An empty
	// tmpdir would profile as "none", which demotes the gate to warn-only.)
	// The marker matches no companion candidate of any file gated in these tests.
	writeFileSync(join(tmp, "repo-shape.spec.ts"), "");
	resetRepoProfileCache();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	resetRepoProfileCache();
});

describe("evaluateTddNewFileGate — mode gating", () => {
	it("N: returns null when test_first_mode is 'nudge' (below the gate's floor)", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "nudge",
		});
		expect(decision).toBeNull();
	});

	it("N: returns null when test_first_mode is undefined", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: undefined,
		});
		expect(decision).toBeNull();
	});

	// test-contract: behavior — balanced-mode ladder (2026-08-17): "warn" runs the
	// same missing-companion detection but resolves allow+warning, never a block.
	it("P: 'warn' mode surfaces the missing companion as an allow+warning", () => {
		// Seed a test layout so the repo-profile demotion path is not what fires.
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src/other.test.ts"), "import { it } from 'vitest';\n");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			content: "export function foo(): number { return 1; }\n",
			testFirstMode: "warn",
		});
		expect(decision?.decision).toBe("allow");
		expect(decision?.rule_id).toBe("tdd_new_file_gate");
		expect(decision?.warnings?.[0]).toContain("[interlinked:tdd]");
		expect(decision?.warnings?.[0]).toContain("foo.test.ts");
		expect(decision?.warnings?.[0]).toContain('test_first_mode "warn"');
	});

	it("N: 'warn' mode stays silent when the companion already exists", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src/foo.test.ts"), "import { it } from 'vitest';\n");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "warn",
		});
		expect(decision).toBeNull();
	});
});

describe("evaluateTddNewFileGate — happy paths (allow)", () => {
	it("allows when the companion .test.ts already exists on disk", () => {
		writeFileSync(join(tmp, "src/foo.test.ts"), "import { it } from 'vitest';\n");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("allows when a __tests__/ sibling test exists", () => {
		mkdirSync(join(tmp, "src/__tests__"), { recursive: true });
		writeFileSync(join(tmp, "src/__tests__/foo.test.ts"), "");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("allows when the companion test was written earlier in the session", () => {
		const session = makeSession([join(tmp, "src/foo.test.ts")]);
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("allows when editing an existing source file (only new files gated)", () => {
		writeFileSync(join(tmp, "src/foo.ts"), "export const x = 1;\n");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("allows when the new file carries the exempt directive in its first bytes", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/wrapper.ts"),
			cwd: tmp,
			session: undefined,
			content: "// interlinked-tdd: exempt\nexport const x = 1;\n",
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});
});

describe("evaluateTddNewFileGate — exempt paths", () => {
	const cases: Array<[string, string]> = [
		["type declaration", "src/types.d.ts"],
		["test file itself", "src/foo.test.ts"],
		["spec file itself", "src/foo.spec.ts"],
		["__tests__/ nested file", "src/__tests__/foo.ts"],
		["__fixtures__/ nested file", "src/__fixtures__/foo.ts"],
		["__mocks__/ nested file", "src/__mocks__/foo.ts"],
		["config file", "vite.config.ts"],
		["scripts/ file", "scripts/release.ts"],
		["scratch/ session script (2026-07-07 sanctioned scratch home)", "scratch/2026-07-07-probe/bucketize.ts"],
		["dist artifact", "dist/bundle.ts"],
		[".claude hook artifact", ".claude/hooks/activity.ts"],
		[".interlinked runtime", ".interlinked/harness/foo.ts"],
		["landing/ static-site worker", "landing/src/worker.ts"],
		["web/ static-site source", "web/src/index.ts"],
		["site/ docs source", "site/src/page.ts"],
	];
	for (const [label, rel] of cases) {
		it(`allows new file in exempt path (${label})`, () => {
			const decision = evaluateTddNewFileGate({
				filePath: join(tmp, rel),
				cwd: tmp,
				session: undefined,
				testFirstMode: "enforce",
			});
			expect(decision).toBeNull();
		});
	}
});

describe("evaluateTddNewFileGate — blocking", () => {
	it("blocks a brand-new .ts source with no companion on disk or in session", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: makeSession([]),
			testFirstMode: "enforce",
		});
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/companion test/i);
		expect(decision?.reason).toMatch(/interlinked-tdd: exempt/);
		expect(decision?.rule_id).toBe("tdd_new_file_gate");
		expect(decision?.severity).toBe("high");
	});

	it("blocks a brand-new .tsx source", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/Widget.tsx"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.decision).toBe("block");
	});

	it("blocks when only an unrelated test sibling exists", () => {
		writeFileSync(join(tmp, "src/other.test.ts"), "");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.decision).toBe("block");
	});

	it("block message lists all searched candidate paths", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.reason).toContain("src/foo.test.ts");
		expect(decision?.reason).toContain("__tests__/foo.test.ts");
		expect(decision?.reason).toContain(".spec.ts");
	});

	it("block message lists the public surface extracted from the impl content", () => {
		// Saves the agent a re-Read of the impl when authoring the test —
		// the gate already saw the content, so it can summarize what the
		// test should at minimum exercise.
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			content: [
				"export function ensureFlag(base: string): 'created' | 'preserved' {",
				"    return 'created';",
				"}",
				"export const NAMESPACE = 'features';",
				"export class FeatureRegistry {",
				"    register(name: string) {}",
				"}",
				"export interface Options {}",
				"export type Action = 'on' | 'off';",
			].join("\n"),
			testFirstMode: "enforce",
		});
		expect(decision?.reason).toContain("Public surface to test");
		expect(decision?.reason).toContain("ensureFlag");
		expect(decision?.reason).toContain("NAMESPACE");
		expect(decision?.reason).toContain("FeatureRegistry");
		// Type-only exports aren't testable at runtime — skip them.
		expect(decision?.reason).not.toContain("Options");
		expect(decision?.reason).not.toContain("Action");
	});

	it("block message omits the surface line when no content is provided", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.reason).not.toContain("Public surface to test");
	});

	it("block message omits the surface line when the file has no exports", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			content: "// just a side-effect module\nconsole.log('hi');\n",
			testFirstMode: "enforce",
		});
		expect(decision?.reason).not.toContain("Public surface to test");
	});
});

describe("evaluateTddNewFileGate — relative filePath / omitted cwd", () => {
	it("resolves a relative filePath against the provided cwd (isAbsolute false, cwd truthy)", () => {
		const decision = evaluateTddNewFileGate({
			filePath: "src/bar.ts",
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("src/bar.test.ts");
	});

	it("falls back to process.cwd() when cwd is omitted and filePath is relative", () => {
		const relPath = `zz-tdd-gate-omitted-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`;
		const decision = evaluateTddNewFileGate({
			filePath: relPath,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.decision).toBe("block");
		// companionHintPath's `dir && dir !== "."` is false for a root-level
		// relative path — the hint has no directory prefix.
		expect(decision?.reason).toContain(`Create ${relPath.replace(/\.ts$/, ".test.ts")} first`);
		// shortest() with cwd undefined returns the resolved absolute candidate path unchanged.
		const expectedAbs = resolve(process.cwd(), relPath.replace(/\.ts$/, ".test.ts"));
		expect(decision?.reason).toContain(`(Searched: ${expectedAbs}`);
	});
});

describe("evaluateTddNewFileGate — public surface extraction limit", () => {
	it("caps the extracted public surface at SURFACE_LIMIT (10) entries", () => {
		const content = Array.from({ length: 12 }, (_, i) => `export function fn${i}() {}`).join("\n");
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/many.ts"),
			cwd: tmp,
			session: undefined,
			content,
			testFirstMode: "enforce",
		});
		const searched = /Public surface to test \(extracted from your content\): (.*?)\./.exec(
			decision?.reason ?? "",
		);
		expect(searched?.[1]?.split(", ")).toEqual([
			"fn0",
			"fn1",
			"fn2",
			"fn3",
			"fn4",
			"fn5",
			"fn6",
			"fn7",
			"fn8",
			"fn9",
		]);
	});
});

describe("evaluateTddNewFileGateForEvent — missing tool_input / missing cwd", () => {
	it("treats a missing tool_input as an empty object (filePath resolves empty, gate no-ops)", () => {
		const decision = evaluateTddNewFileGateForEvent(
			{
				hook_event: "PreToolUse",
				session_id: "sess-noinput",
				agent_source: "claude",
				tool_name: "Write",
				cwd: tmp,
				timestamp: "t",
			},
			rulesFor(true),
			makeSession([]),
		);
		expect(decision).toBeNull();
	});

	it("returns the hard block unchanged when the event has no cwd (can't resolve the debt ledger)", () => {
		const relPath = `zz-tdd-gate-nocwd-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`;
		const decision = evaluateTddNewFileGateForEvent(
			{
				hook_event: "PreToolUse",
				session_id: "sess-nocwd",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: { file_path: relPath, content: "export const x = 1;\n" },
				timestamp: "t",
			},
			rulesFor(true),
			makeSession([]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("tdd_new_file_gate");
	});
});

describe("hasTddExemptDirective", () => {
	it("returns true when the exempt directive appears in the first bytes", () => {
		expect(hasTddExemptDirective("// interlinked-tdd: exempt\nexport const x = 1;\n")).toBe(true);
	});

	it("returns false when there is no exempt directive", () => {
		expect(hasTddExemptDirective("export const x = 1;\n")).toBe(false);
	});
});

describe("evaluateTddNewFileGate — non-source extensions", () => {
	it("returns null for a .js file (not our concern)", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.js"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("returns null for a .json file", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.json"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});

	it("returns null when filePath is empty", () => {
		const decision = evaluateTddNewFileGate({
			filePath: "",
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision).toBeNull();
	});
});

// ===========================================
// Event wrapper — debt-mode downgrade
// ===========================================
// When `per_edit_coverage.debt_mode` is on (now the default), a would-be
// new-file BLOCK is downgraded to an opened coverage debt + allow, so an agent
// can write a new source file then its companion test as two ordinary edits
// (the "Pair B" case). With debt_mode off the historical hard block is
// preserved. The `// interlinked-tdd: exempt` escape still allows with no debt.
// These exercise `evaluateTddNewFileGateForEvent`, which both resolves the
// block AND appends the open txn to `.interlinked/obligations.jsonl` under cwd.

function rulesFor(debtMode: boolean | undefined): GuardRulesConfig {
	// SAFETY: the wrapper reads only `structural_checks.test_first_mode` and
	// `per_edit_coverage.debt_mode`; every other GuardRulesConfig field is
	// unused on this path, so a two-field stand-in is sufficient for the test.
	return ({ ...makeGuardRules(),
		structural_checks: { ...makeGuardRules().structural_checks,  test_first_mode: "enforce" },
		...(debtMode === undefined ? {} : { per_edit_coverage: { enabled: true, mode: "block", budget_ms: 25_000, languages: ["ts"], debt_mode: debtMode } }),
	} satisfies GuardRulesConfig);
}

function writeEvent(absPath: string, content: string | undefined): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: content === undefined ? { file_path: absPath } : { file_path: absPath, content },
		cwd: tmp,
		timestamp: "t",
	};
}

describe("evaluateTddNewFileGateForEvent — debt-mode downgrade", () => {
	it("debt_mode ON: allows the new test-less source AND opens a coverage debt for it", () => {
		const abs = join(tmp, "src/foo.ts");
		const decision = evaluateTddNewFileGateForEvent(
			writeEvent(abs, "export const x = 1;\n"),
			rulesFor(true),
			makeSession([]),
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.[0]).toMatch(/Opened coverage debt for src\/foo\.ts/);
		expect(decision?.warnings?.[0]).toMatch(/companion test \(src\/foo\.test\.ts\)/);

		const debts = readOpenDebts(tmp);
		expect(debts).toHaveLength(1);
		expect(debts[0]?.file).toBe("src/foo.ts");
		expect(debts[0]?.kind).toBe("coverage");
	});

	it("debt_mode OFF: still hard-blocks the new test-less source (unchanged) and opens no debt", () => {
		const abs = join(tmp, "src/foo.ts");
		const decision = evaluateTddNewFileGateForEvent(
			writeEvent(abs, "export const x = 1;\n"),
			rulesFor(false),
			makeSession([]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/companion test/i);
		expect(decision?.rule_id).toBe("tdd_new_file_gate");
		expect(readOpenDebts(tmp)).toHaveLength(0);
	});

	it("debt_mode default-absent: hard-blocks (no per_edit_coverage config means no downgrade)", () => {
		const abs = join(tmp, "src/foo.ts");
		const decision = evaluateTddNewFileGateForEvent(
			writeEvent(abs, "export const x = 1;\n"),
			rulesFor(undefined),
			makeSession([]),
		);
		expect(decision?.decision).toBe("block");
		expect(readOpenDebts(tmp)).toHaveLength(0);
	});

	it("exempt directive: allows with no block and no debt even when debt_mode is on", () => {
		const abs = join(tmp, "src/wrapper.ts");
		const decision = evaluateTddNewFileGateForEvent(
			writeEvent(abs, "// interlinked-tdd: exempt\nexport const x = 1;\n"),
			rulesFor(true),
			makeSession([]),
		);
		expect(decision).toBeNull();
		expect(readOpenDebts(tmp)).toHaveLength(0);
	});

	it("debt_mode ON but companion already on disk: allows with no block and no debt", () => {
		writeFileSync(join(tmp, "src/foo.test.ts"), "import './foo.js';\n");
		const abs = join(tmp, "src/foo.ts");
		const decision = evaluateTddNewFileGateForEvent(
			writeEvent(abs, "export const x = 1;\n"),
			rulesFor(true),
			makeSession([]),
		);
		expect(decision).toBeNull();
		expect(readOpenDebts(tmp)).toHaveLength(0);
	});
});

// ===========================================
// Repo-profile conditional enforcement (portability, 2026-07-06)
// ===========================================
// Foreign-shaped repos: separate test trees get mirrored companion candidates;
// repos with no tests at all get warn-only demotion. Colocated repos (every
// fixture above) keep the historical behavior byte-for-byte.

/** A fresh repo root per test so `getRepoProfile`'s memo never sees stale layout. */
function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(repo, "src/lib"), { recursive: true });
	return repo;
}

function gateAt(repo: string, rel: string) {
	return evaluateTddNewFileGate({
		filePath: join(repo, rel),
		cwd: repo,
		session: undefined,
		testFirstMode: "enforce",
	});
}

describe("evaluateTddNewFileGate — separate-tree layout (mirrored candidates)", () => {
	let repo: string;

	beforeEach(() => {
		repo = makeRepo("tdd-gate-sep-");
		resetRepoProfileCache();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		resetRepoProfileCache();
	});

	it("allows when the first-segment-stripped mirror exists (tests/lib/foo.test.ts)", () => {
		mkdirSync(join(repo, "tests/lib"), { recursive: true });
		writeFileSync(join(repo, "tests/lib/foo.test.ts"), "");
		expect(gateAt(repo, "src/lib/foo.ts")).toBeNull();
	});

	it("allows when the full-path mirror exists (tests/src/lib/foo.test.ts)", () => {
		mkdirSync(join(repo, "tests/src/lib"), { recursive: true });
		writeFileSync(join(repo, "tests/src/lib/foo.test.ts"), "");
		expect(gateAt(repo, "src/lib/foo.ts")).toBeNull();
	});

	it("allows when a flat test-root candidate exists (tests/foo.test.ts)", () => {
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests/foo.test.ts"), "");
		expect(gateAt(repo, "src/lib/foo.ts")).toBeNull();
	});

	it("allows a .spec mirror under a `test/` root (test/lib/foo.spec.ts)", () => {
		mkdirSync(join(repo, "test/lib"), { recursive: true });
		writeFileSync(join(repo, "test/lib/foo.spec.ts"), "");
		expect(gateAt(repo, "src/lib/foo.ts")).toBeNull();
	});

	it("still blocks when the separate tree has tests but no mirror for this file", () => {
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests/other.test.ts"), "");
		const decision = gateAt(repo, "src/lib/foo.ts");
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("tdd_new_file_gate");
		// The block message advertises the mirrored candidates it searched.
		expect(decision?.reason).toContain(join("tests", "lib", "foo.test.ts"));
		expect(decision?.reason).toContain(join("tests", "src", "lib", "foo.test.ts"));
	});

	it("still honors a colocated companion in a separate-tree repo (union, not replacement)", () => {
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests/other.test.ts"), "");
		writeFileSync(join(repo, "src/lib/foo.test.ts"), "");
		expect(gateAt(repo, "src/lib/foo.ts")).toBeNull();
	});

	it("handles a source file at the separate-tree project root (relDir === '.', flat candidate only)", () => {
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests/other.test.ts"), "");
		const decision = gateAt(repo, "index.ts");
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain(join("tests", "index.test.ts"));
	});

	it("returns no mirrored candidates when the source lives outside the project root", () => {
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests/other.test.ts"), "");
		const outside = join(
			tmpdir(),
			`tdd-outside-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
		);
		const decision = evaluateTddNewFileGate({
			filePath: outside,
			cwd: repo,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.decision).toBe("block");
		// shortest() falls back to the raw absolute path since it isn't under `repo`.
		expect(decision?.reason).toContain(outside.replace(/\.ts$/, ".test.ts"));
	});
});

describe("companionTestCandidates — profile-conditional shapes", () => {
	let repo: string;

	beforeEach(() => {
		repo = makeRepo("tdd-cand-");
		resetRepoProfileCache();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		resetRepoProfileCache();
	});

	it("without a projectRoot: exactly the historical four colocated candidates", () => {
		const abs = join(repo, "src/lib/foo.ts");
		expect(companionTestCandidates(abs)).toEqual([
			join(repo, "src/lib/foo.test.ts"),
			join(repo, "src/lib/__tests__/foo.test.ts"),
			join(repo, "src/lib/foo.spec.ts"),
			join(repo, "src/lib/__tests__/foo.spec.ts"),
		]);
	});

	it("colocated repo with projectRoot: still exactly the historical four", () => {
		writeFileSync(join(repo, "src/lib/existing.test.ts"), "");
		const abs = join(repo, "src/lib/foo.ts");
		expect(companionTestCandidates(abs, repo)).toEqual(companionTestCandidates(abs));
	});

	it("separate-tree repo: appends full-mirror, stripped-mirror, and flat shapes per root", () => {
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests/other.test.ts"), "");
		const abs = join(repo, "src/lib/foo.ts");
		const candidates = companionTestCandidates(abs, repo);
		// Historical colocated set is preserved as the head of the list.
		expect(candidates.slice(0, 4)).toEqual(companionTestCandidates(abs));
		expect(candidates).toContain(join(repo, "tests/src/lib/foo.test.ts"));
		expect(candidates).toContain(join(repo, "tests/lib/foo.test.ts"));
		expect(candidates).toContain(join(repo, "tests/foo.test.ts"));
		expect(candidates).toContain(join(repo, "tests/lib/foo.spec.ts"));
	});
});

describe("evaluateTddNewFileGate — layout 'none' demotes to warn-only", () => {
	let repo: string;

	beforeEach(() => {
		// No test files anywhere: this repo never opted into TDD.
		repo = makeRepo("tdd-gate-none-");
		resetRepoProfileCache();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
		resetRepoProfileCache();
	});

	it("emits an allow+warning instead of a block", () => {
		const decision = gateAt(repo, "src/lib/foo.ts");
		expect(decision?.decision).toBe("allow");
		expect(decision?.reason).toBeUndefined();
		expect(decision?.rule_id).toBe("tdd_new_file_gate");
		expect(decision?.warnings).toHaveLength(1);
		expect(decision?.warnings?.[0]).toMatch(/no companion test/);
		expect(decision?.warnings?.[0]).toMatch(/demoted to a warning/);
	});

	it("event wrapper + debt_mode ON: warns and opens NO debt", () => {
		const decision = evaluateTddNewFileGateForEvent(
			{
				hook_event: "PreToolUse",
				session_id: "sess-none",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: { file_path: join(repo, "src/lib/foo.ts"), content: "export const x = 1;\n" },
				cwd: repo,
				timestamp: "t",
			},
			rulesFor(true),
			makeSession([]),
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.[0]).toMatch(/no companion test/);
		expect(readOpenDebts(repo)).toHaveLength(0);
	});

	it("event wrapper + debt_mode OFF: still warn-only, never a hard block", () => {
		const decision = evaluateTddNewFileGateForEvent(
			{
				hook_event: "PreToolUse",
				session_id: "sess-none",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: { file_path: join(repo, "src/lib/foo.ts"), content: "export const x = 1;\n" },
				cwd: repo,
				timestamp: "t",
			},
			rulesFor(false),
			makeSession([]),
		);
		expect(decision?.decision).toBe("allow");
		expect(readOpenDebts(repo)).toHaveLength(0);
	});

	it("a repo that grows its first test file re-enters enforce mode (fresh profile)", () => {
		writeFileSync(join(repo, "src/lib/existing.test.ts"), "");
		resetRepoProfileCache();
		const decision = gateAt(repo, "src/lib/foo.ts");
		expect(decision?.decision).toBe("block");
	});
});

describe("evaluateTddNewFileGate — profile error path (conservative fallback)", () => {
	it("hard-blocks as before when profile detection cannot read the root", () => {
		// A nonexistent cwd makes the profile walk throw ENOENT, which yields
		// the fail-toward-enforcement profile (colocated) — current behavior.
		const missingRoot = join(tmpdir(), `tdd-gate-missing-${Date.now()}`, "nope");
		resetRepoProfileCache();
		const decision = evaluateTddNewFileGate({
			filePath: join(missingRoot, "src/foo.ts"),
			cwd: missingRoot,
			session: undefined,
			testFirstMode: "enforce",
		});
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/companion test/i);
		resetRepoProfileCache();
	});
});

describe("evaluateTddNewFileGate — colocated repo byte-identity", () => {
	it("candidate list in the block message stays exactly the historical four", () => {
		const decision = evaluateTddNewFileGate({
			filePath: join(tmp, "src/foo.ts"),
			cwd: tmp,
			session: undefined,
			testFirstMode: "enforce",
		});
		const searched = /\(Searched: (.*?)\.\)/.exec(decision?.reason ?? "");
		expect(searched?.[1]?.split(", ")).toEqual([
			"src/foo.test.ts",
			"src/__tests__/foo.test.ts",
			"src/foo.spec.ts",
			"src/__tests__/foo.spec.ts",
		]);
	});
});
