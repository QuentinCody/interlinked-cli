import { makeGuardRules } from "./__tests__/fixtures.js";
// Mutation-kill companion for src/harness/evaluator/spec-pre-gates.ts.
//
// Targets the 58 StringLiteral/ConditionalExpression/LogicalOperator/
// EqualityOperator/MethodExpression/ArrayDeclaration/ArrowFunction/
// BooleanLiteral/OptionalChaining/Regex survivors recorded against this file
// (fleet W8, 2026-08-14). Every case below was chosen because it distinguishes
// an OBSERVABLE behavior of the exported evaluateSpecPreGates/
// projectAfterContent surface — never "kills the mutant" as the reason; the
// adjacent `// test-contract:` receipt names the real behavior instead.
// Empirically confirmed via scratch/fleet-r3/spec-pre-gates-shadow-verify.mts
// (a hand-built shadow-mutation harness; see
// scratch/fleet-r3/receipts/src_harness_evaluator_spec-pre-gates.ts.jsonl for
// the mutant-by-mutant classification this file backs).
//
// Every internal helper this file targets (markerConflict, selfConflict,
// collectMarkerConflicts, checkIntroducedMarkerDrift, warnRemovedAnchors,
// driftKey, warnIntroducedDrift) is unexported — every case below goes
// through the two exported entry points, evaluateSpecPreGates and
// projectAfterContent, exactly as the real PreToolUse gate is called.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setSharedSpecLedgerForTesting } from "../server/spec-ledger-phase.js";
import { SpecLedger } from "../spec/ledger.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { evaluateSpecPreGates, projectAfterContent } from "./spec-pre-gates.js";

// SAFETY: the gate reads only rules.spec_checks; a minimal config suffices.
const ENABLED = ({ ...makeGuardRules(),  spec_checks: { enabled: true } } satisfies GuardRulesConfig);

const roots: string[] = [];
afterEach(() => {
	setSharedSpecLedgerForTesting(null);
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "spec-pregate-mk-"));
	roots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		writeFileSync(join(root, rel), content);
	}
	setSharedSpecLedgerForTesting(SpecLedger.build(root, () => false));
	return root;
}

// SAFETY: the gate reads only tool_input from the event; the remaining
// HarnessEvent fields are irrelevant to this unit (same convention as the
// companion spec-pre-gates.test.ts).
function writeEvent(filePath: string, content: string): HarnessEvent {
	return ({ agent_source: "claude", timestamp: "2026-09-01T00:00:00Z",
		hook_event: "PreToolUse",
		session_id: "s",
		tool_name: "Write",
		tool_input: { file_path: filePath, content },
	} satisfies HarnessEvent);
}
// SAFETY: same rationale as writeEvent — only tool_input/tool_name matter.
function customEvent(toolName: string, toolInput: Record<string, unknown>): HarnessEvent {
	return ({ agent_source: "claude", timestamp: "2026-09-01T00:00:00Z",  hook_event: "PreToolUse", session_id: "s", tool_name: toolName, tool_input: toolInput } satisfies HarnessEvent);
}

describe("projectAfterContent — malformed Edit-shape observables", () => {
	// test-contract: boundary — an Edit whose new_string is not a string must
	// refuse the whole edit (return null), never fall through to a
	// String()-coerced replacement that would write the literal text
	// "undefined" into the file.
	it("new_string non-string (old_string present) refuses instead of coercing", () => {
		expect(projectAfterContent("Edit", { old_string: "x", new_string: undefined }, "prefix x suffix")).toBeNull();
	});

	// test-contract: boundary — an Edit whose old_string is not a string must
	// refuse (return null) rather than coerce it to a string and search/replace
	// with the coerced value.
	it("old_string non-string (new_string present) refuses instead of coercing", () => {
		expect(projectAfterContent("Edit", { old_string: 123, new_string: "y" }, "abc123def")).toBeNull();
	});

	// test-contract: public-api — a well-formed Edit still applies normally;
	// this is the control case the two cases above are compared against.
	it("a well-formed Edit still applies (control)", () => {
		expect(projectAfterContent("Edit", { old_string: "a", new_string: "b" }, "a a")).toBe("b a");
	});
});

describe("evaluateSpecPreGates — gate-0 admission checks", () => {
	// test-contract: boundary — a non-string, truthy tool_input.file_path (e.g.
	// a number) must be rejected before it ever reaches a string-only API
	// (isSpecEligibleFile calls .lastIndexOf on it) — never throw out of the gate.
	it("a non-string file_path is rejected without throwing", () => {
		setup({ "a.md": "# A" });
		const warnings: string[] = [];
		expect(() => {
			const d = evaluateSpecPreGates(customEvent("Write", { file_path: 42, content: "x" }), "Write", ENABLED, warnings);
			expect(d).toBeNull();
		}).not.toThrow();
	});

	// test-contract: boundary — a non-eligible extension (.ts) must be
	// completely ignored, even when its content would otherwise conflict with
	// another file's declared fact — the eligibility check runs BEFORE any
	// fact extraction.
	//
	// b.ts is pre-created on disk (not spec-eligible, so it plays no ledger
	// role either way) so canonical()'s realpathSync resolves it through the
	// SAME /var -> /private/var hop the already-built ledger's repoRoot took;
	// a path that has never existed on disk falls back to the unresolved
	// literal, which would otherwise diverge from repoRoot's resolved prefix
	// for a reason unrelated to the eligibility check itself.
	it("non-eligible extension is ignored even with a conflicting marker", () => {
		const root = setup({
			"a.md": "cap <!-- fact:qq -->500<!-- /fact:qq -->",
			"b.md": "cap <!-- fact:qq -->500<!-- /fact:qq -->",
			"b.ts": "// placeholder",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "b.ts"), "cap <!-- fact:qq -->900<!-- /fact:qq -->"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
	});

	// test-contract: boundary — an edit outside the ledger's repo root must be
	// ignored completely, even when the edited content is internally
	// self-contradictory (two different values for the same declared-fact
	// name in one file) — the out-of-repo check runs before any fact
	// extraction at all.
	it("an out-of-repo path is ignored even when self-contradictory", () => {
		setup({ "a.md": "# A" });
		const sibling = mkdtempSync(join(tmpdir(), "spec-pregate-sibling-"));
		roots.push(sibling);
		const outside = join(sibling, "outside.md");
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(outside, "cap <!-- fact:zz -->1<!-- /fact:zz --> <!-- fact:zz -->2<!-- /fact:zz -->"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
	});

	// test-contract: security — a non-write tool (e.g. Bash) must never be
	// processed as a write, even when its tool_input happens to carry an
	// edits-shaped payload that projectAfterContent would otherwise apply.
	it("a non-write tool name is ignored even with edits-shaped input", () => {
		const root = setup({
			"a.md": "cap <!-- fact:qq -->500<!-- /fact:qq -->",
			"b.md": "cap <!-- fact:qq -->500<!-- /fact:qq -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			customEvent("Bash", { file_path: join(root, "a.md"), edits: [{ old_string: "500", new_string: "900" }] }),
			"Bash",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
	});
});

describe("evaluateSpecPreGates — no-op / stale-content short-circuit", () => {
	// test-contract: invariant — when the projected content exactly equals
	// what is already on disk, the gate must stop BEFORE computing any drift —
	// even against a ledger snapshot that is stale relative to disk (an
	// out-of-band change the ledger never saw). A no-op write must produce
	// zero warnings, not a spurious "introduced" drift finding manufactured by
	// comparing the ledger's stale cache to the fresh disk read.
	it("after === before short-circuits even with a stale ledger snapshot", () => {
		const root = setup({
			"a.md": "cap <!-- fact:zz -->100<!-- /fact:zz -->",
			"b.md": "cap <!-- fact:zz -->100<!-- /fact:zz -->",
		});
		// Out-of-band disk change AFTER the ledger snapshot, bypassing refresh —
		// the ledger still thinks a.md holds "100".
		writeFileSync(join(root, "a.md"), "cap <!-- fact:zz -->200<!-- /fact:zz -->");
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "a.md"), "cap <!-- fact:zz -->200<!-- /fact:zz -->"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings).toEqual([]);
	});
});

describe("evaluateSpecPreGates — WRITE_TOOLS recognizes Edit and MultiEdit", () => {
	// test-contract: public-api — "Edit" is a write tool the gate processes,
	// not just "Write" — a marker conflict via Edit must still ask.
	it("toolName=Edit is processed like a write", () => {
		const root = setup({
			"a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
			"b.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			customEvent("Edit", { file_path: join(root, "a.md"), old_string: "500", new_string: "800" }),
			"Edit",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
	});

	// test-contract: public-api — "MultiEdit" is a write tool the gate
	// processes too.
	it("toolName=MultiEdit is processed like a write", () => {
		const root = setup({
			"a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
			"b.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			customEvent("MultiEdit", { file_path: join(root, "a.md"), edits: [{ old_string: "500", new_string: "800" }] }),
			"MultiEdit",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
	});
});

describe("evaluateSpecPreGates — gate 1: declared-marker conflict evidence", () => {
	// test-contract: invariant — a marker value UNCHANGED by this edit must
	// never be reported as an introduced conflict, even when it already
	// disagrees with another file (the introduced-only PreToolUse contract);
	// this exercises the cross-file case of that rule (the existing companion
	// test only covers the same-file case).
	it("an unchanged value with a pre-existing cross-file conflict does not ask", () => {
		const root = setup({
			"a.md": "cap <!-- fact:zz -->500<!-- /fact:zz -->",
			"b.md": "cap <!-- fact:zz -->800<!-- /fact:zz -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "a.md"), "cap <!-- fact:zz -->500<!-- /fact:zz --> extra unrelated text"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
	});

	// test-contract: invariant — a brand-new fact name (never declared in this
	// file before) that has no other-file conflict must not ask, and must not
	// swallow an UNRELATED gate-2 warning in the same edit — the optional
	// chain guarding "was this value already declared" must not throw when
	// there is no prior declaration to look up.
	it("a brand-new fact name alongside an unrelated heading removal still surfaces the heading warning", () => {
		const root = setup({
			"plan.md": "# Plan\n## Storage Model\ncontent",
			"README.md": "see [storage](./plan.md#storage-model)",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "plan.md"), "# Plan\ncontent\ncap <!-- fact:newone -->1<!-- /fact:newone -->"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings.some((w) => w.includes("README.md:1"))).toBe(true);
	});

	// test-contract: public-api — when MULTIPLE other files hold DIFFERENT
	// conflicting values, every distinct value is listed, comma-separated —
	// not concatenated together.
	it("lists every distinct other-file value, comma-separated", () => {
		const root = setup({
			"a.md": "cap <!-- fact:zz -->100<!-- /fact:zz -->",
			"b.md": "cap <!-- fact:zz -->500<!-- /fact:zz -->",
			"c.md": "cap <!-- fact:zz -->800<!-- /fact:zz -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "a.md"), "cap <!-- fact:zz -->999<!-- /fact:zz -->"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
		expect(d?.reason).toMatch(/"(500|800)", "(500|800)"/);
	});

	// test-contract: public-api — multiple conflict lines in one "ask" are
	// joined by a real newline, one bullet per line — not concatenated onto
	// one line.
	it("multiple conflicting facts render as separate newline-joined lines", () => {
		const root = setup({
			"a.md": "cap <!-- fact:p -->1<!-- /fact:p --> and <!-- fact:q -->1<!-- /fact:q -->",
			"b.md": "cap <!-- fact:p -->1<!-- /fact:p --> and <!-- fact:q -->1<!-- /fact:q -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "a.md"), "cap <!-- fact:p -->2<!-- /fact:p --> and <!-- fact:q -->2<!-- /fact:q -->"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
		const bulletLines = (d?.reason?.split("\n") ?? []).filter((l) => l.startsWith("  - fact:"));
		expect(bulletLines).toHaveLength(2);
	});

	// test-contract: public-api — the "ask" reason always carries the
	// remediation sentence telling the agent to update every site.
	it("the ask reason carries the update-every-site remediation text", () => {
		const root = setup({
			"a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
			"b.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "a.md"), "cap <!-- fact:line_cap -->800<!-- /fact:line_cap -->"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
		expect(d?.reason).toContain("Update every site of the fact");
	});

	// test-contract: invariant — the per-fact conflict scan is capped at
	// MAX_PRE_WARNINGS (3): with 4 simultaneously-conflicting facts, only the
	// first 3 are reported, never 4 — an unbounded scan could grow the "ask"
	// reason without limit on a large multi-fact edit.
	//
	// a.md is pre-created (see the gate-0 eligibility test's note on
	// canonical()'s realpath mismatch for never-yet-written paths).
	it("caps simultaneously-conflicting facts at 3, not 4", () => {
		const root = setup({
			"a.md": "placeholder",
			"b.md": ["f1", "f2", "f3", "f4"].map((n) => `<!-- fact:${n} -->y<!-- /fact:${n} -->`).join("\n"),
		});
		const newContent = ["f1", "f2", "f3", "f4"].map((n) => `<!-- fact:${n} -->x<!-- /fact:${n} -->`).join("\n");
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(writeEvent(join(root, "a.md"), newContent), "Write", ENABLED, warnings);
		expect(d?.decision).toBe("ask");
		const mentioned = new Set(d?.reason?.match(/fact:f\d/g) ?? []);
		expect(mentioned.size).toBe(3);
	});
});

describe("evaluateSpecPreGates — same-file self-conflict rendering", () => {
	// test-contract: public-api — when an edit worsens a same-file conflict
	// with a third value, the ask reason lists EVERY declared value for that
	// name (not an empty/placeholder list), comma-separated and quoted.
	it("a worsened same-file conflict lists all declared values, quoted and comma-separated", () => {
		const before = "cap <!-- fact:line_cap -->500<!-- /fact:line_cap --> <!-- fact:line_cap -->800<!-- /fact:line_cap -->";
		const root = setup({ "a.md": before });
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "a.md"), `${before} <!-- fact:line_cap -->900<!-- /fact:line_cap -->`),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
		expect(d?.reason).toContain('"500", "800", "900"');
	});
});

describe("evaluateSpecPreGates — gate 2: removed-heading anchor warnings", () => {
	// test-contract: invariant — a heading that is KEPT (still present after
	// the edit) must never be reported as removed, even though its body text
	// changed and other files link to it.
	it("a kept heading (body edited, heading untouched) does not warn", () => {
		const root = setup({
			"plan.md": "# Plan\n## Storage Model\ncontent",
			"README.md": "see [storage](./plan.md#storage-model)",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "plan.md"), "# Plan\n## Storage Model\nMORE content"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings).toEqual([]);
	});

	// test-contract: invariant — a removed heading with NO external referrers
	// must not warn at all.
	it("a removed heading with zero external referrers does not warn", () => {
		const root = setup({
			"plan.md": "# Plan\n## Storage Model\ncontent",
			"README.md": "no links here",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(writeEvent(join(root, "plan.md"), "# Plan\ncontent"), "Write", ENABLED, warnings);
		expect(d).toBeNull();
		expect(warnings).toEqual([]);
	});

	// test-contract: public-api — with exactly 3 referrers (== the display
	// cap), the warning lists all 3 with no "+N more" suffix and no stray
	// placeholder text in the empty-suffix branch.
	it("exactly 3 referrers: no +more suffix, no stray placeholder text", () => {
		const root = setup({
			"plan.md": "# Plan\n## Storage Model\ncontent",
			"r1.md": "see [x](./plan.md#storage-model)",
			"r2.md": "see [x](./plan.md#storage-model)",
			"r3.md": "see [x](./plan.md#storage-model)",
		});
		const warnings: string[] = [];
		evaluateSpecPreGates(writeEvent(join(root, "plan.md"), "# Plan\ncontent"), "Write", ENABLED, warnings);
		const w = warnings.find((x) => x.includes("spec-xref"));
		expect(w).toBeDefined();
		expect(w).not.toMatch(/\+\d+ more/);
		const mentioned = (w?.match(/r\d\.md/g) ?? []).length;
		expect(mentioned).toBe(3);
	});

	// test-contract: public-api — with 4 referrers (one over the display cap),
	// only 3 are shown, comma-separated, followed by an accurate "+1 more".
	it("4 referrers: shows 3, comma-separated, with an accurate +1 more suffix", () => {
		const root = setup({
			"plan.md": "# Plan\n## Storage Model\ncontent",
			"r1.md": "see [x](./plan.md#storage-model)",
			"r2.md": "see [x](./plan.md#storage-model)",
			"r3.md": "see [x](./plan.md#storage-model)",
			"r4.md": "see [x](./plan.md#storage-model)",
		});
		const warnings: string[] = [];
		evaluateSpecPreGates(writeEvent(join(root, "plan.md"), "# Plan\ncontent"), "Write", ENABLED, warnings);
		const w = warnings.find((x) => x.includes("spec-xref"));
		expect(w).toBeDefined();
		expect(w).toMatch(/\+1 more/);
		const shownPart = (w ?? "").split("link to: ")[1]?.split(". Update")[0] ?? "";
		expect(shownPart).toContain(", "); // real separator between entries
		const mentioned = (shownPart.match(/r\d\.md/g) ?? []).length;
		expect(mentioned).toBe(3);
	});
});

describe("evaluateSpecPreGates — gate 3: introduced cross-file drift", () => {
	// test-contract: invariant — a drift finding that ALREADY existed before
	// this edit (unchanged by it) must never be re-reported as newly
	// introduced — the dedup-vs-current-state check must correctly recognize
	// it as already known.
	it("a pre-existing, unchanged broken link is not re-warned as introduced", () => {
		const root = setup({ "a.md": "# A\nsee [x](./missing.md)" });
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "a.md"), "# A\nsee [x](./missing.md)\nunrelated addition"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings).toEqual([]);
	});

	// test-contract: public-api — a brand-new broken link to a file that does
	// not exist is tagged [proven] (xref_missing_file is a compiler/parser-
	// exact finding kind).
	it("a brand-new missing-file link is tagged [proven]", () => {
		const root = setup({ "a.md": "# A\nsome content" });
		const warnings: string[] = [];
		evaluateSpecPreGates(writeEvent(join(root, "a.md"), "# A\nsee [x](./missing-target.md)"), "Write", ENABLED, warnings);
		expect(warnings.some((w) => w.includes("[interlinked:spec-drift][proven]") && w.includes("does not exist"))).toBe(true);
	});

	// test-contract: public-api — a declared-fact conflict introduced via a
	// stale ledger snapshot (the fact-drift analog of the no-op short-circuit
	// test above, but WITH a genuinely new drift finding this time) is tagged
	// [proven] too.
	it("an introduced declared-fact drift is tagged [proven]", () => {
		const root = setup({
			"a.md": "cap <!-- fact:dd -->1<!-- /fact:dd -->",
			"b.md": "cap <!-- fact:dd -->1<!-- /fact:dd -->",
		});
		writeFileSync(join(root, "a.md"), "cap <!-- fact:dd -->2<!-- /fact:dd -->");
		const warnings: string[] = [];
		evaluateSpecPreGates(
			writeEvent(join(root, "a.md"), "cap <!-- fact:dd -->2<!-- /fact:dd --> extra unrelated text"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(warnings.some((w) => w.includes("[interlinked:spec-drift][proven]") && w.includes("dd"))).toBe(true);
	});

	// test-contract: public-api — a count-claim drift (heuristic census
	// binding, not compiler-exact) is tagged [heuristic], not [proven] —
	// exercises the companion test's existing "warns on introduced cross-file
	// drift" scenario with an explicit tag assertion.
	it("an introduced count-claim drift is tagged [heuristic]", () => {
		const root = setup({
			"plan.md": ["# Plan", "## The four bets", "- B1 a", "- B2 b", "- B3 c", "- B4 d"].join("\n"),
			"README.md": "# README\nintro\n",
		});
		const warnings: string[] = [];
		evaluateSpecPreGates(
			writeEvent(join(root, "README.md"), "# README\nThe roadmap ships three bets.\n"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(warnings.some((w) => w.includes("[interlinked:spec-drift][heuristic]"))).toBe(true);
	});

	// test-contract: invariant — the introduced-drift scan is capped at
	// MAX_PRE_WARNINGS (3) and dedupes findings correctly: with 4
	// simultaneously-introduced broken links, exactly 3 spec-drift warnings
	// are pushed, never 4 and never fewer (a broken dedup key would collapse
	// distinct findings into 1).
	it("caps simultaneous introduced drift findings at 3, not 4 and not 1", () => {
		const root = setup({
			"plan.md": "# Plan\n## H A\nc\n## H B\nc\n## H C\nc\n## H D\nc",
			"r1.md": "[x](./plan.md#h-a)",
			"r2.md": "[x](./plan.md#h-b)",
			"r3.md": "[x](./plan.md#h-c)",
			"r4.md": "[x](./plan.md#h-d)",
		});
		const warnings: string[] = [];
		evaluateSpecPreGates(writeEvent(join(root, "plan.md"), "# Plan\nc\nc\nc\nc"), "Write", ENABLED, warnings);
		const driftWarnings = warnings.filter((w) => w.includes("spec-drift"));
		expect(driftWarnings).toHaveLength(3);
		expect(driftWarnings.some((w) => w.includes("[proven]"))).toBe(true);
	});

	// test-contract: invariant — the dedup key used to compare "before" and
	// "after" drift must ignore line-number digits regardless of digit count:
	// a pre-existing finding whose fact declaration merely SHIFTS line (10 ->
	// 23, both multi-digit — a single-digit-only normalizer would leave a
	// residual digit behind and fail to dedupe them) must still be recognized
	// as the SAME finding, not reported as newly introduced.
	it("a pre-existing multi-digit-line finding that only shifts line is not re-warned", () => {
		const pad = (n: number) => Array.from({ length: n }, () => "x").join("\n");
		const before = `${pad(9)}\ncap <!-- fact:zz -->100<!-- /fact:zz -->`; // fact at line 10
		const root = setup({
			"a.md": before,
			"b.md": "cap <!-- fact:zz -->200<!-- /fact:zz -->", // pre-existing conflict, unchanged by this edit
		});
		const after = `${pad(22)}\ncap <!-- fact:zz -->100<!-- /fact:zz -->`; // same fact, now at line 23
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(writeEvent(join(root, "a.md"), after), "Write", ENABLED, warnings);
		expect(d).toBeNull();
		expect(warnings.some((w) => w.includes("spec-drift") && w.includes("zz"))).toBe(false);
	});
});
