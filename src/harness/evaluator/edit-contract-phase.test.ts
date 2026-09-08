import { makeGuardRules } from "./__tests__/fixtures.js";
// Companion tests for edit-contract-phase.ts — the composed LG-1…LG-5 slot:
// ordering (stale warning rides on a doom block), config gating, measure-vs-
// warn blind-edit tiers, and the recurrence rows every observation lands.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordFileView } from "../read-provenance.js";
import { createFreshSession } from "../session-state-mutators.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { evaluateEditContractPhase } from "./edit-contract-phase.js";

let dir: string;
let target: string;

const CONTENT = ["alpha();", "beta();", "gamma();", ""].join("\n");
// SAFETY: the phase reads only `rules.edit_contract`; every other key is unused.
const BASE_RULES = ({ ...makeGuardRules(), } satisfies GuardRulesConfig);

function makeEvent(overrides: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "phase-test",
		agent_source: "claude",
		timestamp: new Date().toISOString(),
		cwd: dir,
		...overrides,
	};
}

function makeSession(): SessionTrajectory {
	return createFreshSession(makeEvent({}), "phase-test");
}

function seedWholeFileView(session: SessionTrajectory): void {
	recordFileView(
		session,
		makeEvent({
			hook_event: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: target },
			tool_outcome: "success",
		}),
	);
}

function recurrenceRows(): unknown[] {
	const path = join(dir, ".interlinked", "recurrences.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l): unknown => JSON.parse(l));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "edit-phase-"));
	target = join(dir, "mod.ts");
	writeFileSync(target, CONTENT);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("evaluateEditContractPhase", () => {
	it("blocks a doomed edit, sets rule_id, counts mechanics, and lands a recurrence row", () => {
		const session = makeSession();
		const warnings: string[] = [];
		const d = evaluateEditContractPhase(
			makeEvent({ tool_name: "Edit" }),
			session,
			BASE_RULES,
			"Edit",
			{ file_path: target, old_string: "delta();", new_string: "x" },
			warnings,
		);
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("edit_doom_missing_anchor");
		expect(session.edit_mechanics?.doomed).toBe(1);
		expect(session.edit_mechanics?.last_doom?.file).toBe(target);
		expect(recurrenceRows()).toEqual(expect.arrayContaining([expect.objectContaining({ check_id: "edit-doomed-missing-anchor" })]));
	});

	it("a stale-read warning rides on the doom block's warnings", () => {
		const session = makeSession();
		seedWholeFileView(session);
		writeFileSync(target, CONTENT.replace("beta();", "beta(1);")); // out-of-band drift
		const warnings: string[] = [];
		const d = evaluateEditContractPhase(
			makeEvent({ tool_name: "Edit" }),
			session,
			BASE_RULES,
			"Edit",
			{ file_path: target, old_string: "beta();", new_string: "beta(2);" },
			warnings,
		);
		expect(d?.decision).toBe("block"); // beta(); no longer exists — doomed
		expect(warnings.some((w) => w.includes("[interlinked:stale-read]"))).toBe(true);
		expect(recurrenceRows()).toEqual(expect.arrayContaining([expect.objectContaining({ check_id: "edit-stale-read" })]));
	});

	it("stale_read: 'off' silences the drift warning", () => {
		const session = makeSession();
		seedWholeFileView(session);
		writeFileSync(target, CONTENT.replace("beta();", "beta(1);"));
		const warnings: string[] = [];
		evaluateEditContractPhase(
			makeEvent({ tool_name: "Edit" }),
			session,
			// SAFETY: phase reads only edit_contract.
			({ ...makeGuardRules(),  edit_contract: { stale_read: "off" } } satisfies GuardRulesConfig),
			"Edit",
			{ file_path: target, old_string: "alpha();", new_string: "x" },
			warnings,
		);
		expect(warnings.some((w) => w.includes("stale-read"))).toBe(false);
	});

	it("blind-edit default is measure-only: recurrence row, no warning", () => {
		const session = makeSession();
		recordFileView(
			session,
			makeEvent({
				hook_event: "PostToolUse",
				tool_name: "Read",
				tool_input: { file_path: target, offset: 1, limit: 1 }, // saw line 1 only
				tool_outcome: "success",
			}),
		);
		const warnings: string[] = [];
		const d = evaluateEditContractPhase(
			makeEvent({ tool_name: "Edit" }),
			session,
			BASE_RULES,
			"Edit",
			{ file_path: target, old_string: "gamma();", new_string: "x" },
			warnings,
		);
		expect(d).toBeNull(); // anchor exists — no doom
		expect(warnings).toEqual([]);
		expect(session.edit_mechanics?.blind_edits).toBe(1);
		expect(recurrenceRows()).toEqual(expect.arrayContaining([expect.objectContaining({ check_id: "edit-blind-lines" })]));
	});

	it("blind_edit: 'warn' surfaces the warning too", () => {
		const session = makeSession();
		recordFileView(
			session,
			makeEvent({
				hook_event: "PostToolUse",
				tool_name: "Read",
				tool_input: { file_path: target, offset: 1, limit: 1 },
				tool_outcome: "success",
			}),
		);
		const warnings: string[] = [];
		evaluateEditContractPhase(
			makeEvent({ tool_name: "Edit" }),
			session,
			// SAFETY: phase reads only edit_contract.
			({ ...makeGuardRules(),  edit_contract: { blind_edit: "warn" } } satisfies GuardRulesConfig),
			"Edit",
			{ file_path: target, old_string: "gamma();", new_string: "x" },
			warnings,
		);
		expect(warnings.some((w) => w.includes("[interlinked:blind-edit]"))).toBe(true);
	});

	it("apply_patch mismatch warns without blocking and lands its row", () => {
		const warnings: string[] = [];
		const d = evaluateEditContractPhase(
			makeEvent({ tool_name: "apply_patch" }),
			makeSession(),
			BASE_RULES,
			"apply_patch",
			{
				command: [
					"*** Begin Patch",
					`*** Update File: ${target}`,
					" nope();",
					"-beta();",
					"+beta(9);",
					"*** End Patch",
				].join("\n"),
			},
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings.some((w) => w.includes("apply-patch-doom"))).toBe(true);
		expect(recurrenceRows()).toEqual(expect.arrayContaining([expect.objectContaining({ check_id: "edit-applypatch-context" })]));
	});

	it("a clean, fully-grounded edit passes silently with no rows", () => {
		const session = makeSession();
		seedWholeFileView(session);
		const warnings: string[] = [];
		const d = evaluateEditContractPhase(
			makeEvent({ tool_name: "Edit" }),
			session,
			BASE_RULES,
			"Edit",
			{ file_path: target, old_string: "beta();", new_string: "beta(1);" },
			warnings,
		);
		expect(d).toBeNull();
		expect(warnings).toEqual([]);
		expect(recurrenceRows()).toEqual([]);
	});
});
