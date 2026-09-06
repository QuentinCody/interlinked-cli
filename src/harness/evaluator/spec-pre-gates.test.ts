import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setSharedSpecLedgerForTesting } from "../server/spec-ledger-phase.js";
import { SpecLedger } from "../spec/ledger.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { evaluateSpecPreGates, projectAfterContent } from "./spec-pre-gates.js";

// SAFETY: the gate reads only rules.spec_checks; a minimal config suffices.
const ENABLED = { spec_checks: { enabled: true } } as unknown as GuardRulesConfig;
// SAFETY: same minimal shape, disabled — exercises the config off-switch.
const DISABLED = { spec_checks: { enabled: false } } as unknown as GuardRulesConfig;

const roots: string[] = [];
afterEach(() => {
	setSharedSpecLedgerForTesting(null);
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "spec-pregate-"));
	roots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		writeFileSync(join(root, rel), content);
	}
	setSharedSpecLedgerForTesting(SpecLedger.build(root, () => false));
	return root;
}

function writeEvent(filePath: string, content: string): HarnessEvent {
	// SAFETY: the gate reads only tool_input from the event; the remaining
	// HarnessEvent fields are irrelevant to this unit.
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		tool_name: "Write",
		tool_input: { file_path: filePath, content },
	} as unknown as HarnessEvent;
}

describe("projectAfterContent", () => {
	it("projects Write, Edit, replace_all, and MultiEdit shapes", () => {
		expect(projectAfterContent("Write", { content: "new" }, "old")).toBe("new");
		expect(
			projectAfterContent("Edit", { old_string: "a", new_string: "b" }, "a a"),
		).toBe("b a");
		expect(
			projectAfterContent(
				"Edit",
				{ old_string: "a", new_string: "b", replace_all: true },
				"a a",
			),
		).toBe("b b");
		expect(
			projectAfterContent(
				"MultiEdit",
				{ edits: [{ old_string: "a", new_string: "b" }, { old_string: "b", new_string: "c" }] },
				"a",
			),
		).toBe("c");
	});

	it("returns null on missing old_string or malformed shapes", () => {
		expect(projectAfterContent("Edit", { old_string: "zz", new_string: "b" }, "a")).toBeNull();
		expect(projectAfterContent("Edit", { new_string: "b" }, "a")).toBeNull();
		expect(projectAfterContent("Write", {}, "a")).toBeNull();
	});
});

describe("evaluateSpecPreGates", () => {
	it("asks on a one-sided declared-marker change (gate 1, pre_block-grade)", () => {
		const root = setup({
			"a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
			"b.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(
				join(root, "a.md"),
				"cap <!-- fact:line_cap -->800<!-- /fact:line_cap -->",
			),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
		expect(d?.reason).toContain("line_cap");
		expect(d?.reason).not.toMatch(/auto-?fix/i);
	});

	it("asks when adding a NEW distinct value to an already-disputed marker (round-5 #2)", () => {
		const root = setup({
			"a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
			"b.md": "cap <!-- fact:line_cap -->800<!-- /fact:line_cap -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(
				join(root, "a.md"),
				"cap <!-- fact:line_cap -->900<!-- /fact:line_cap -->",
			),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
		expect(d?.reason).toContain('"900"');
	});

	it("asks when one file declares a marker with two conflicting values (round-2 #17)", () => {
		const root = setup({ "a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->" });
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(
				join(root, "a.md"),
				"cap <!-- fact:line_cap -->500<!-- /fact:line_cap --> and <!-- fact:line_cap -->800<!-- /fact:line_cap -->",
			),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
		expect(d?.reason).toContain("conflicting values");
	});

	it("does not block a pre-existing same-file marker conflict on an unrelated edit (round-broaden sol #1)", () => {
		const before = "cap <!-- fact:line_cap -->500<!-- /fact:line_cap --> <!-- fact:line_cap -->800<!-- /fact:line_cap -->";
		const root = setup({ "a.md": before });
		const warnings: string[] = [];
		// The conflict already existed; this edit only appends unrelated prose.
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "a.md"), `${before}\n\nunrelated prose added here`),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull(); // introduced-only: a legacy conflict must not brick edits
	});

	it("asks when an edit WORSENS a legacy same-file conflict with a new value (sol-max #3)", () => {
		const before = "cap <!-- fact:line_cap -->500<!-- /fact:line_cap --> <!-- fact:line_cap -->800<!-- /fact:line_cap -->";
		const root = setup({ "a.md": before });
		const warnings: string[] = [];
		// Introducing a THIRD contradictory value is a new contradiction → ask.
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "a.md"), `${before} <!-- fact:line_cap -->900<!-- /fact:line_cap -->`),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
		expect(d?.reason).toContain("conflicting values");
	});

	it("never asks when converging onto a value another file already holds", () => {
		const root = setup({
			"a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
			"b.md": "cap <!-- fact:line_cap -->800<!-- /fact:line_cap -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(
				join(root, "a.md"),
				"cap <!-- fact:line_cap -->800<!-- /fact:line_cap -->",
			),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
	});

	it("warns when deleting a heading other files link to (gate 2)", () => {
		const root = setup({
			"plan.md": "# Plan\n## Storage Model\ncontent",
			"README.md": "see [storage](./plan.md#storage-model)",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "plan.md"), "# Plan\ncontent"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings.some((w) => w.includes("README.md:1"))).toBe(true);
	});

	it("warns on introduced cross-file drift (gate 3)", () => {
		const root = setup({
			// The plan is the registry home: "four bets" binds bet→B and enumerates
			// B1..B4. README carries NO local B ids, so the drift is genuinely
			// cross-file (not a local contradiction the inline check owns; sol-max #13).
			"plan.md": ["# Plan", "## The four bets", "- B1 a", "- B2 b", "- B3 c", "- B4 d"].join("\n"),
			"README.md": "# README\nintro\n",
		});
		const warnings: string[] = [];
		// The edit introduces a README claim of THREE bets — drift vs the plan's four.
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "README.md"), "# README\nThe roadmap ships three bets.\n"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings.some((w) => w.includes("spec-drift"))).toBe(true);
	});

	it("first-split marker changes still ask (base case unchanged)", () => {
		const root = setup({
			"a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
			"b.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(
				join(root, "a.md"),
				"cap <!-- fact:line_cap -->800<!-- /fact:line_cap -->",
			),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d?.decision).toBe("ask");
		expect(d?.reason).toContain('other files hold "500"');
	});

	it("spec_checks.enabled:false disables every ask and warning (deep-round #5)", () => {
		const root = setup({
			"a.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
			"b.md": "cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->",
		});
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(
				join(root, "a.md"),
				"cap <!-- fact:line_cap -->800<!-- /fact:line_cap -->",
			),
			"Write",
			DISABLED,
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings).toEqual([]);
	});

	it("canonicalizes symlink-alias paths so a file's own ledger entry isn't a false conflict (sol-max #4)", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "spec-pregate-sym-")));
		roots.push(root);
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "docs", "a.md"), "cap <!-- fact:x -->1<!-- /fact:x -->");
		symlinkSync(join(root, "docs"), join(root, "alias"));
		setSharedSpecLedgerForTesting(SpecLedger.build(root, () => false));
		const warnings: string[] = [];
		// Change fact:x THROUGH the alias — no OTHER file declares x, so the
		// edited file's own canonical entry must not count as a conflict.
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "alias", "a.md"), "cap <!-- fact:x -->2<!-- /fact:x -->"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
	});

	it("handles a brand-new markdown file (canonical falls back when the path does not exist yet)", () => {
		const root = setup({ "a.md": "# A" });
		const warnings: string[] = [];
		// new.md does not exist on disk → realpath throws → canonical returns the
		// path as-is; a benign new file introduces no conflict.
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "new.md"), "# New\ncap <!-- fact:z -->7<!-- /fact:z -->"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
	});

	it("fails open: no ledger, non-markdown, unchanged content, out-of-repo", () => {
		const root = setup({ "a.md": "# A" });
		const warnings: string[] = [];
		expect(
			evaluateSpecPreGates(writeEvent(join(root, "x.ts"), "code"), "Write", ENABLED, warnings),
		).toBeNull();
		expect(
			evaluateSpecPreGates(writeEvent(join(root, "a.md"), "# A"), "Write", ENABLED, warnings),
		).toBeNull();
		setSharedSpecLedgerForTesting(null);
		expect(
			evaluateSpecPreGates(writeEvent(join(root, "a.md"), "# B"), "Write", ENABLED, warnings),
		).toBeNull();
		expect(warnings).toEqual([]);
	});

	it("fails open when the target path is a directory (I/O error reading it)", () => {
		const root = setup({ "a.md": "# A" });
		// existsSync is true for a directory, but readFileSync throws (EISDIR) —
		// this is the catch-and-fail-open path, distinct from the "doesn't
		// exist yet" branch covered above.
		mkdirSync(join(root, "dir.md"));
		const warnings: string[] = [];
		const d = evaluateSpecPreGates(
			writeEvent(join(root, "dir.md"), "irrelevant"),
			"Write",
			ENABLED,
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings).toEqual([]);
	});
});
