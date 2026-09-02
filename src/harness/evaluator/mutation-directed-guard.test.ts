import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSERTION_WAIVER_ENV, ASSERTION_WAIVER_LOG } from "../assertion-waiver-log.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { evaluateMutationDirectedProfile } from "./mutation-directed-guard.js";

// Same fixture pattern as write-content-guards.test.ts's BASE_RULES: the
// functions under test only ever read specific optional-chained fields, so
// an empty object cast to the full config type is the established shortcut
// for these guard tests rather than stubbing every required field.
// SAFETY: evaluateMutationDirectedProfile only reads
// rules.mutation_directed_strict_profile?.enabled off this object; every
// other GuardRulesConfig field is unused by the code under test, so the
// empty-object cast never observes a missing field.
const BASE_RULES = {} as GuardRulesConfig;
// SAFETY: same rationale as BASE_RULES — only mutation_directed_strict_profile
// is read; the `as never` step exists solely to bypass the (unused-here)
// structural excess-property check on the literal.
const STRICT_ON = { mutation_directed_strict_profile: { enabled: true } } as never as GuardRulesConfig;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mdp-guard-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeEvent(filePath: string, content: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: filePath, content },
		cwd: dir,
		timestamp: "t",
	};
}

describe("evaluateMutationDirectedProfile — file-class scoping", () => {
	// test-contract: boundary — the profile must only ever act on files
	// matching the mutation-directed naming convention.
	it("N1: a non-mutation-directed file is a no-op regardless of flag state", () => {
		const filePath = join(dir, "widget.test.ts");
		const event = writeEvent(filePath, 'it("x", () => expect(1).toBeTruthy());');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings).toEqual([]);
	});

	// test-contract: boundary — a Read-shaped tool_input (no content/new_string)
	// must never be treated as a write to evaluate.
	it("N2: a read-shaped call (no content/new_string) is a no-op", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Write",
			tool_input: { file_path: filePath },
			cwd: dir,
			timestamp: "t",
		};
		const warnings: string[] = [];
		expect(
			evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings),
		).toBeNull();
	});
});

describe("evaluateMutationDirectedProfile — GATE 1 (severity remap, flag-gated)", () => {
	// test-contract: invariant — GATE 1 remapping is strictly opt-in; the
	// default (flag off) profile must never block on this finding class.
	it("flag OFF: an introduced receipt-missing finding does not block", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts"); // no on-disk baseline
		const event = writeEvent(filePath, 'it("covers survivor", () => expect(render()).toEqual("Empty"));');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, BASE_RULES, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
	});

	// test-contract: public-api — with the strict profile enabled, an
	// introduced receipt-missing finding must block under the
	// test_legitimacy rule id (the agent's actionable signal).
	it("flag ON: an introduced receipt-missing finding blocks with rule_id test_legitimacy", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts"); // no on-disk baseline ⇒ strict/introduced
		const event = writeEvent(filePath, 'it("covers survivor", () => expect(render()).toEqual("Empty"));');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("test_legitimacy");
	});

	// test-contract: invariant — a finding already present on disk before
	// the edit (nothing introduced) must warn, never block.
	it("flag ON: a pre-existing (unchanged) finding warns but does not block", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		const content = 'it("covers survivor", () => expect(render()).toEqual("Empty"));';
		writeFileSync(filePath, content, "utf-8"); // baseline == proposed ⇒ nothing introduced
		const event = writeEvent(filePath, content);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("pre-existing"))).toBe(true);
	});
});

describe("evaluateMutationDirectedProfile — GATE 2 (assertion-removal delta)", () => {
	// test-contract: invariant — GATE 2's warning fires regardless of the
	// strict-profile flag; only the block decision is flag-gated.
	it("warns unconditionally (flag OFF) when an edit removes an assertion line", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		writeFileSync(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});', "utf-8");
		const event = writeEvent(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n});');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, BASE_RULES, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull(); // flag off ⇒ never blocks
		expect(warnings.some((w) => w.includes("mutation_directed_assertion_removal"))).toBe(true);
	});

	// test-contract: public-api — with the strict profile enabled, an edit
	// that deletes an assertion line must block under rule_id
	// mutation_directed_assertion_removal.
	it("blocks (flag ON) when an edit removes an assertion line", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		writeFileSync(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});', "utf-8");
		const event = writeEvent(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n});');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("mutation_directed_assertion_removal");
	});

	// test-contract: boundary — a pure addition (no removed line) must not
	// trip GATE 2's removal-delta detector at all.
	it("does not warn or block when nothing is removed (pure addition)", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		writeFileSync(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n});', "utf-8");
		const event = writeEvent(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("mutation_directed_assertion_removal"))).toBe(false);
	});
});

describe("evaluateMutationDirectedProfile — GATE 2 exact message text", () => {
	// test-contract: public-api — the warning is agent-visible instruction text;
	// every substring must survive, including the resolved removal line number.
	it("N-warning-text: warning text matches exactly, including the resolved removal line number", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		writeFileSync(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});', "utf-8");
		const event = writeEvent(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n});');
		const warnings: string[] = [];
		evaluateMutationDirectedProfile(event, BASE_RULES, "Write", event.tool_input!, warnings);
		expect(warnings).toEqual([
			`[interlinked:mutation_directed_assertion_removal] ${filePath} removes 1 test-case/assertion ` +
				"line(s) vs the on-disk baseline (first at L3). Mutation-directed files are graded on kill " +
				"evidence — confirm this removal is a legitimate refactor, not evidence going missing.",
		]);
	});

	// test-contract: public-api — the block reason is the agent's only signal
	// for what to fix; severity/category/rule_id are consumed by callers too.
	it("N-block-text: block decision matches exactly (reason, severity, category, rule_id) for 1 removed line", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		writeFileSync(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});', "utf-8");
		const event = writeEvent(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n});');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toEqual({
			decision: "block",
			reason:
				"BLOCKED by [mutation_directed_assertion_removal]. This edit removes 1 test-case/assertion " +
				`line(s) from ${filePath} vs the on-disk baseline. First: L3 — "expect(b).toBe(2);". ` +
				"Mutation-directed files are graded on kill evidence — restore the assertion, or if this is " +
				"a deliberate consolidation/rename, keep the replacement case's assertion count at or above " +
				'what it replaces. File-level escape hatch: add an entry for "mutation_directed_assertion_removal" ' +
				`to .interlinked/verify-suppressions.json for ${filePath}.`,
			warnings,
			rule_id: "mutation_directed_assertion_removal",
			severity: "high",
			category: "pre-block",
		});
	});

	// test-contract: invariant — restSummary must appear only when more than
	// one assertion/case line was removed (the ternary's true branch).
	it("N-restSummary: block reason includes the '+N more' summary when more than one line is removed", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		writeFileSync(
			filePath,
			'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n  expect(c).toBe(3);\n});',
			"utf-8",
		);
		const event = writeEvent(filePath, 'it("x", () => {\n});');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision?.reason).toContain("(+ 2 more at L2, L3, L4)");
	});
});

describe("evaluateMutationDirectedProfile — projectRoot resolution", () => {
	// test-contract: boundary — projectRoot must resolve to the file's own
	// nested marker directory (via findProjectRoot), not silently fall back to
	// event.cwd/process.cwd()/false, because it gates
	// `.interlinked/verify-suppressions.json` resolution for GATE 2.
	it("N-projectRoot: a suppression file at the resolved nested project root is honored, not a parent/repo fallback", () => {
		const nestedDir = join(dir, "sub");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(join(nestedDir, "tsconfig.json"), "{}", "utf-8");
		mkdirSync(join(nestedDir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(nestedDir, ".interlinked", "verify-suppressions.json"),
			JSON.stringify({
				"widget.mutation-kill.test.ts": {
					mutation_directed_assertion_removal: { reason: "x", by: "cli", at: "n" },
				},
			}),
			"utf-8",
		);
		const filePath = join(nestedDir, "widget.mutation-kill.test.ts");
		writeFileSync(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});', "utf-8");
		const event = writeEvent(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n});'); // event.cwd == dir (parent of nestedDir)
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, BASE_RULES, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings).toEqual([]);
	});
});

describe("evaluateMutationDirectedProfile — GATE 1 pre-existing message text", () => {
	// test-contract: public-api — the pre-existing-signal warning text is the
	// agent's only explanation for "why didn't this block"; it must name the
	// exact check id and exact line(s), not a mutated/blanked substitute.
	it("N-preexisting-text: pre-existing warning text matches exactly for a single unchanged finding", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		const content =
			"// test-contract: public-api — covers the render happy path with real output\n" +
			'it("covers survivor", () => expect(render()).toEqual("Empty"));';
		writeFileSync(filePath, content, "utf-8"); // baseline == proposed ⇒ nothing introduced, only pre-existing
		const event = writeEvent(filePath, content);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings).toEqual([
			`[interlinked:mutation-directed-profile] ${filePath} carries 1 pre-existing ` +
				"[test_missing_sut_import] instance(s) at L1 — not introduced by this edit, so the strict " +
				"profile did not block.",
		]);
	});
});

describe("evaluateMutationDirectedProfile — GATE 1 zero-finding loop", () => {
	// test-contract: invariant — the preexisting-signal warning loop must be
	// gated on `preexisting.length > 0`; a zero-finding outcome must not
	// synthesize a spurious warning.
	it("N-zero-preexisting: STRICT_ON with a clean mutation-directed file (no it/test blocks) emits no warning", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		const content = 'import "./widget.js";\n'; // satisfies the SUT-import check; no it/test lines at all
		writeFileSync(filePath, content, "utf-8");
		const event = writeEvent(filePath, content);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings).toEqual([]);
	});
});

// ─── GATE 2 assertion MOVES + campaign waiver ─────────────────────────────────

const TWO_ASSERTIONS = 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});';
const ONE_ASSERTION = 'it("x", () => {\n  expect(a).toBe(1);\n});';

/** A mutation-directed file seeded with TWO_ASSERTIONS on disk. */
function seedPrimary(): string {
	const filePath = join(dir, "widget.mutation-kill.test.ts");
	writeFileSync(filePath, TWO_ASSERTIONS, "utf-8");
	return filePath;
}

function ledgerPath(): string {
	return join(dir, ".interlinked", ASSERTION_WAIVER_LOG);
}

describe("evaluateMutationDirectedProfile — GATE 2 assertion moves — positive (must fire)", () => {
	// test-contract: invariant — a plain removal (nothing equivalent added in
	// the edit) blocks exactly as before the move-awareness landed.
	it("P1: a plain removal with nothing added still blocks (flag ON)", () => {
		const filePath = seedPrimary();
		const event = writeEvent(filePath, ONE_ASSERTION);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("mutation_directed_assertion_removal");
	});

	// test-contract: boundary — an added assertion with a different expected
	// value is not equivalent; the removal still blocks.
	it("P2: a removal paired with a NON-equivalent addition still blocks", () => {
		const filePath = seedPrimary();
		const event = writeEvent(filePath, 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(3);\n});');
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision?.decision).toBe("block");
	});

	// test-contract: boundary — an `edits[]` entry WITHOUT its own file_path
	// is a same-file MultiEdit entry, not a sibling; it contributes nothing.
	it("P3: an edits[] entry with no file_path is not a sibling and cannot pay for the removal", () => {
		const filePath = seedPrimary();
		const event = writeEvent(filePath, ONE_ASSERTION);
		event.tool_input = { ...event.tool_input, edits: [{ old_string: "", new_string: "expect(z).toBe(2);" }] };
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input, warnings);
		expect(decision?.decision).toBe("block");
	});

	// test-contract: security — the review's counter-example: kill evidence
	// (`expect(killed).toBe(true)`) deleted from one case and a trivial
	// same-matcher assertion on a DIFFERENT subject added to an unrelated case
	// must still block; the subject is part of the equivalence key.
	it("P4: a low-entropy literal re-asserted on another subject in an unrelated block still blocks", () => {
		const filePath = join(dir, "widget.mutation-kill.test.ts");
		writeFileSync(filePath, 'it("mutant 12 dies", () => {\n  expect(killed).toBe(true);\n});', "utf-8");
		const receipt = "// test-contract: invariant — flag is set";
		const event = writeEvent(filePath, `it("mutant 12 dies", () => {\n});\n${receipt}\nit("other", () => {\n  expect(flag).toBe(true);\n});`);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain('"expect(killed).toBe(true);"');
	});
});

describe("evaluateMutationDirectedProfile — GATE 2 assertion moves — negative (must not fire)", () => {
	// test-contract: public-api — moving an assertion into another test block
	// (same file, same subject, different spacing) is a move: no warning, no block.
	it("N1: a same-file move into another test block passes silently", () => {
		const filePath = seedPrimary();
		// The new case carries a receipt so GATE 1 (test_legitimacy) stays quiet
		// and only GATE 2's verdict is under test here.
		const receipt = "// test-contract: invariant — b stays 2 after the move";
		const event = writeEvent(filePath, `${ONE_ASSERTION}\n${receipt}\nit("y", () => {\n  expect( b ).toBe( 2 );\n});`);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("mutation_directed_assertion_removal"))).toBe(false);
	});

	// test-contract: public-api — a sibling file in the same edit payload
	// (`edits[]` entry with its own file_path) that ADDS the equivalent
	// assertion pays for the removal here.
	it("N2: a cross-file move into a sibling of the same edit passes silently", () => {
		const filePath = seedPrimary();
		const siblingPath = join(dir, "other.mutation-kill.test.ts");
		writeFileSync(siblingPath, 'it("y", () => {\n  expect(c).toBe(3);\n});', "utf-8");
		const event = writeEvent(filePath, ONE_ASSERTION);
		event.tool_input = {
			...event.tool_input,
			edits: [{ file_path: siblingPath, content: 'it("y", () => {\n  expect(c).toBe(3);\n  expect(b).toBe(2);\n});' }],
		};
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("mutation_directed_assertion_removal"))).toBe(false);
	});
});

describe("evaluateMutationDirectedProfile — campaign waiver (INTERLINKED_ASSERTION_MOVE_WAIVER) — positive (must fire)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// test-contract: invariant — a waiver with no ledger to land in is not a
	// waiver: the block stands and the warning says why.
	it("P1: waiver set but no .interlinked directory ⇒ block as usual", () => {
		vi.stubEnv(ASSERTION_WAIVER_ENV, "1");
		const filePath = seedPrimary();
		const event = writeEvent(filePath, ONE_ASSERTION);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision?.decision).toBe("block");
		expect(warnings.some((w) => w.includes("waiver NOT honored"))).toBe(true);
	});

	// test-contract: boundary — the waiver only ever converts a BLOCK; with the
	// flag off the removal WARNING still fires and nothing is written because
	// nothing would have blocked.
	it("P2: waiver set but strict profile off ⇒ warn only, no ledger row", () => {
		vi.stubEnv(ASSERTION_WAIVER_ENV, "1");
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const filePath = seedPrimary();
		const event = writeEvent(filePath, ONE_ASSERTION);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, BASE_RULES, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("removes 1 test-case/assertion"))).toBe(true);
		expect(existsSync(ledgerPath())).toBe(false);
	});

	// test-contract: boundary — the second call of a cross-file move redeems
	// only an EQUIVALENT line; a different subject leaves the pending row
	// pending and writes no redemption row.
	it("P3: a later addition with a different subject redeems nothing", () => {
		vi.stubEnv(ASSERTION_WAIVER_ENV, "1");
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const first = writeEvent(seedPrimary(), ONE_ASSERTION);
		expect(evaluateMutationDirectedProfile(first, STRICT_ON, "Write", first.tool_input!, [])).toBeNull();
		const otherPath = join(dir, "other.mutation-kill.test.ts");
		const second = writeEvent(otherPath, 'it("y", () => {\n  expect(flag).toBe(2);\n});');
		const warnings: string[] = [];
		evaluateMutationDirectedProfile(second, STRICT_ON, "Write", second.tool_input!, warnings);
		expect(warnings.some((w) => w.includes("REDEEMED"))).toBe(false);
		const rows = readFileSync(ledgerPath(), "utf-8").trimEnd().split("\n");
		expect(rows).toHaveLength(1);
	});
});

describe("evaluateMutationDirectedProfile — campaign waiver (INTERLINKED_ASSERTION_MOVE_WAIVER) — negative (must not fire)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// test-contract: public-api — with the waiver set, a would-be block becomes
	// an allow and every removal is recorded to the ledger with file, line,
	// assertion text and session id.
	it("N1: waiver set ⇒ allow + one ledger row per removed line", () => {
		vi.stubEnv(ASSERTION_WAIVER_ENV, "1");
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const filePath = seedPrimary();
		const event = writeEvent(filePath, ONE_ASSERTION);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("WAIVED 1 assertion removal(s)"))).toBe(true);
		const rows = readFileSync(ledgerPath(), "utf-8").trimEnd().split("\n").map((l) => JSON.parse(l));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			file: filePath,
			line: 3,
			assertion: "expect(b).toBe(2);",
			session_id: "s",
			rule_id: "mutation_directed_assertion_removal",
		});
	});

	// test-contract: invariant — a dry run must not move the gate: the waiver
	// verdict is computed, but no ledger row is written.
	it("N2: dry_run ⇒ allow, nothing persisted", () => {
		vi.stubEnv(ASSERTION_WAIVER_ENV, "1");
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const filePath = seedPrimary();
		const event = { ...writeEvent(filePath, ONE_ASSERTION), dry_run: true };
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(event, STRICT_ON, "Write", event.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("dry run: not persisted"))).toBe(true);
		expect(existsSync(ledgerPath())).toBe(false);
	});

	// test-contract: public-api — the cross-file move as Claude Code sends it
	// (two calls): the waived removal in call 1 is REDEEMED by call 2's
	// equivalent addition in another mutation-directed file — a `redeemed_by`
	// row is appended and the warning names the source file.
	it("N3: a later same-session addition in another file redeems the waived removal", () => {
		vi.stubEnv(ASSERTION_WAIVER_ENV, "1");
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const primary = seedPrimary();
		const first = writeEvent(primary, ONE_ASSERTION);
		expect(evaluateMutationDirectedProfile(first, STRICT_ON, "Write", first.tool_input!, [])).toBeNull();
		const otherPath = join(dir, "other.mutation-kill.test.ts");
		const receipt = "// test-contract: invariant — b stays 2 after the move";
		// SUT import + receipt keep GATE 1 quiet so only redemption is under test.
		const second = writeEvent(otherPath, `import "./other.js";\n${receipt}\nit("y", () => {\n  expect( b ).toBe( 2 );\n});`);
		const warnings: string[] = [];
		const decision = evaluateMutationDirectedProfile(second, STRICT_ON, "Write", second.tool_input!, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes(`REDEEMED 1 waived removal(s) from ${primary}`))).toBe(true);
		const rows = readFileSync(ledgerPath(), "utf-8").trimEnd().split("\n").map((l) => JSON.parse(l));
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ file: primary, line: 3, assertion: "expect(b).toBe(2);", redeemed_by: otherPath });
	});

	// test-contract: invariant — a dry-run addition reports the redemption
	// but writes no row (a dry run must not move the gate).
	it("N4: a dry-run addition reports the redemption without persisting it", () => {
		vi.stubEnv(ASSERTION_WAIVER_ENV, "1");
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const first = writeEvent(seedPrimary(), ONE_ASSERTION);
		expect(evaluateMutationDirectedProfile(first, STRICT_ON, "Write", first.tool_input!, [])).toBeNull();
		const otherPath = join(dir, "other.mutation-kill.test.ts");
		const second = { ...writeEvent(otherPath, 'it("y", () => {\n  expect(b).toBe(2);\n});'), dry_run: true };
		const warnings: string[] = [];
		evaluateMutationDirectedProfile(second, STRICT_ON, "Write", second.tool_input!, warnings);
		expect(warnings.some((w) => w.includes("REDEEMED 1") && w.includes("dry run: not persisted"))).toBe(true);
		expect(readFileSync(ledgerPath(), "utf-8").trimEnd().split("\n")).toHaveLength(1);
	});
});
