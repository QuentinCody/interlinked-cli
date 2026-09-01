// Co-located tests for evaluateWriteContentGuards + buildTscDiffOverlayBlockReason.
// Every collaborator (signatures, pre-block-gate, diff-overlay, transient-debt-guard,
// type-erasure-overlay, settings-validator, content-quality regex heuristics) is mocked
// so each guard's own branches can be driven independently — the function under test is
// pure orchestration over these collaborators' return shapes.

import { existsSync, readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		readFileSync: vi.fn(actual.readFileSync),
	};
});

vi.mock("../../lib/settings-validator.js", () => ({
	describeReason: vi.fn(() => "malformed reason"),
	findMalformedRulesIn: vi.fn(() => []),
	suggestRuleFix: vi.fn(() => null),
}));

vi.mock("../check-registry/index.js", () => ({
	buildAgentSafetyChecks: vi.fn(() => []),
	buildCheckInstructions: vi.fn(() => ({})),
}));

vi.mock("../diff-overlay.js", async (importOriginal) => ({
	evaluateBiomeDiffOverlay: vi.fn(() => ({ newFindings: [], elapsedMs: 0, exceededBudget: false })),
	evaluateTscDiffOverlay: vi.fn(() => ({
		newFindings: [],
		proposedFindings: null,
		elapsedMs: 0,
		exceededBudget: false,
	})),
	isTscFindingBlocking: vi.fn(() => true),
	// The REAL message builder — the NOT CHECKED tests below must pin the
	// shipped wording, not a stub of it (review 2026-08-28).
	tscUnavailableWarning: (await importOriginal<typeof import("../diff-overlay.js")>())
		.tscUnavailableWarning,
}));

vi.mock("../overlay-content.js", () => ({
	resolveProposedContent: vi.fn((_filePath: string, toolInput: Record<string, unknown>) =>
		typeof toolInput.new_string === "string" ? toolInput.new_string : (toolInput.content ?? ""),
	),
}));

vi.mock("./transient-debt-guard.js", () => ({
	applyTransientDebt: vi.fn(() => ({ decision: null, warnings: [] })),
	deferrableFromTsc: vi.fn(() => null),
}));

vi.mock("../pre-block-gate.js", () => ({
	preBlockIntroducedBlock: vi.fn(() => ({
		decision: "block",
		reason: "pre-block introduced",
		warnings: [],
		rule_id: "mock-pre-block",
	})),
	preexistingPreBlockWarnings: vi.fn(() => []),
	resolveDiskBaseline: vi.fn(() => null),
	runPreBlockRegistryGate: vi.fn(() => []),
}));

vi.mock("../quality-checks.js", () => ({
	findProjectRoot: vi.fn(() => undefined),
}));

vi.mock("../signatures.js", () => ({
	scanPromptInjection: vi.fn(() => []),
}));

vi.mock("./type-erasure-overlay.js", () => ({
	evaluateTypeErasureOverlay: vi.fn(() => ({ newFindings: [] })),
	STRICT_TYPING_RULE_ID: "strict-typing-overlay",
}));

vi.mock("./write-content-guards-content-quality.js", () => ({
	collectContentQualityWarnings: vi.fn(() => []),
	INJECTION_SCAN_MIN_CHARS: 10,
	isContentScanExempt: vi.fn(() => false),
}));

import { buildAgentSafetyChecks, buildCheckInstructions } from "../check-registry/index.js";
import { evaluateBiomeDiffOverlay, evaluateTscDiffOverlay, isTscFindingBlocking } from "../diff-overlay.js";
import { resolveProposedContent } from "../overlay-content.js";
import {
	preBlockIntroducedBlock,
	preexistingPreBlockWarnings,
	runPreBlockRegistryGate,
} from "../pre-block-gate.js";
import { findProjectRoot } from "../quality-checks.js";
import { scanPromptInjection } from "../signatures.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { applyTransientDebt, deferrableFromTsc } from "./transient-debt-guard.js";
import { evaluateTypeErasureOverlay } from "./type-erasure-overlay.js";
import { collectContentQualityWarnings, isContentScanExempt } from "./write-content-guards-content-quality.js";
import { buildTscDiffOverlayBlockReason, evaluateWriteContentGuards } from "./write-content-guards.js";

const BASE_RULES = { quality_checks: {} } as GuardRulesConfig;

function baseEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		cwd: "/repo",
		...overrides,
	} as unknown as HarnessEvent;
}

function baseSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "sess-1",
		agent_name: "claude",
		sensitivity_level: "Confidential",
		tool_call_count: 7,
		tool_sequence: ["Read:a.ts", "Edit:b.ts"],
		...overrides,
	} as unknown as SessionTrajectory;
}

function run(
	toolInput: Record<string, unknown>,
	opts: {
		toolName?: string;
		event?: HarnessEvent;
		rules?: GuardRulesConfig;
		session?: SessionTrajectory | undefined;
	} = {},
) {
	return evaluateWriteContentGuards({
		toolName: opts.toolName ?? "Write",
		toolInput: toolInput as never,
		event: opts.event ?? baseEvent(),
		rules: opts.rules ?? BASE_RULES,
		session: opts.session,
		pendingEscalation: undefined,
	});
}

// Review 2026-08-28: the LIVE PreToolUse path must never read "checker did not
// run" as clean. These drive the real evaluateWriteContentGuards production
// path with the overlay mocked to the sidecar's actual unavailable shape.
describe("tsc overlay unavailable — NOT CHECKED on the live path", () => {
	const mTscOverlay = evaluateTscDiffOverlay as unknown as ReturnType<typeof vi.fn>;

	it("P: checkerUnavailable ⇒ a loud NOT CHECKED warning on an otherwise-allowed edit", () => {
		mTscOverlay.mockReturnValueOnce({
			newFindings: [],
			proposedFindings: null,
			elapsedMs: 0,
			exceededBudget: false,
			checkerUnavailable: "sidecar spawn failed",
		});
		const result = run({ file_path: "src/a.ts", content: "export const a = 1;\n" });
		if (result.kind !== "ok") throw new Error("expected the ok path");
		const joined = result.warnings.join("\n");
		expect(joined).toContain("NOT CHECKED");
		expect(joined).toContain("sidecar spawn failed");
		expect(joined).toContain('"not looked at", not "clean"');
	});

	it("N: a checker that RAN clean emits no NOT CHECKED warning", () => {
		mTscOverlay.mockReturnValueOnce({
			newFindings: [],
			proposedFindings: null,
			elapsedMs: 5,
			exceededBudget: false,
		});
		const result = run({ file_path: "src/a.ts", content: "export const a = 1;\n" });
		if (result.kind !== "ok") throw new Error("expected the ok path");
		expect(result.warnings.join("\n")).not.toContain("NOT CHECKED");
	});
});

describe("buildTscDiffOverlayBlockReason", () => {
	it("returns just the head for a MultiEdit tool call", () => {
		const reason = buildTscDiffOverlayBlockReason(
			"MultiEdit",
			[{ ruleId: "TS2304", line: 5, column: 3, message: "Cannot find name 'foo'." }],
			"src/a.ts",
		);
		expect(reason).toBe(
			"BLOCKED by tsc diff-overlay: this edit introduces 1 new type error(s) in src/a.ts. " +
				"First: [TS2304] L5:3 — Cannot find name 'foo'.. " +
				"Fix the type error(s) in your edit, or retry without introducing them.",
		);
	});

	it("defaults the column to 1 when absent (?? branch)", () => {
		const reason = buildTscDiffOverlayBlockReason(
			"MultiEdit",
			[{ line: 9, message: "boom" }],
			"src/b.ts",
		);
		expect(reason).toContain("L9:1 — boom");
	});

	it("appends coordinated-refactor guidance when every blocking finding is a missing-name code", () => {
		const reason = buildTscDiffOverlayBlockReason(
			"Edit",
			[
				{ ruleId: "TS2304", line: 5, column: 3, message: "Cannot find name 'foo'." },
				{ ruleId: "TS2552", line: 8, column: 1, message: "Cannot find name 'bar'." },
			],
			"src/a.ts",
		);
		expect(reason).toBe(
			"BLOCKED by tsc diff-overlay: this edit introduces 2 new type error(s) in src/a.ts. " +
				"First: [TS2304] L5:3 — Cannot find name 'foo'. (+ 1 more). " +
				"Fix the type error(s) in your edit, or retry without introducing them. " +
				"All blocking errors are 'cannot find name' — the signature of a coordinated refactor whose missing symbols live in sibling edits that haven't landed yet. " +
				"Land the dependent edits together so the overlay only sees a compiling state: sequence them through an intermediate that still compiles (add the new import / declaration ALONGSIDE the old, switch the usages, then drop the old), or apply them as one batch if your toolset has a transactional multi-edit primitive.",
		);
	});

	it("uses the generic multi-edit nudge when not every finding is a missing-name code", () => {
		const reason = buildTscDiffOverlayBlockReason(
			"Edit",
			[{ ruleId: "TS2345", line: 5, column: 3, message: "Argument type mismatch." }],
			"src/a.ts",
		);
		expect(reason).toBe(
			"BLOCKED by tsc diff-overlay: this edit introduces 1 new type error(s) in src/a.ts. " +
				"First: [TS2345] L5:3 — Argument type mismatch.. " +
				"Fix the type error(s) in your edit, or retry without introducing them. " +
				"If this is a coordinated refactor (multiple symbols moving together), land the dependent edits as one unit — sequence them through an intermediate that still compiles, or use a transactional multi-edit primitive if your toolset exposes one — so the overlay checks only the final content.",
		);
	});

	it("treats a finding with no ruleId as not a missing-name code (?? '' branch)", () => {
		const reason = buildTscDiffOverlayBlockReason("Edit", [{ line: 1, message: "x" }], "src/a.ts");
		expect(reason).toContain("If this is a coordinated refactor");
	});
});

describe("evaluateWriteContentGuards", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(existsSync).mockReset();
		vi.mocked(readFileSync).mockReset();
		vi.mocked(resolveProposedContent).mockImplementation(
			(_filePath: string, toolInput: Record<string, unknown>) =>
				typeof toolInput.new_string === "string"
					? (toolInput.new_string as string)
					: ((toolInput.content as string) ?? ""),
		);
		vi.mocked(isContentScanExempt).mockReturnValue(false);
		vi.mocked(scanPromptInjection).mockReturnValue([]);
		vi.mocked(collectContentQualityWarnings).mockReturnValue([]);
		vi.mocked(buildAgentSafetyChecks).mockReturnValue([]);
		vi.mocked(buildCheckInstructions).mockReturnValue({});
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([]);
		vi.mocked(preexistingPreBlockWarnings).mockReturnValue([]);
		vi.mocked(findProjectRoot).mockReturnValue(null);
		vi.mocked(applyTransientDebt).mockReturnValue({ decision: null, warnings: [] });
		vi.mocked(deferrableFromTsc).mockReturnValue(null);
		vi.mocked(evaluateBiomeDiffOverlay).mockReturnValue({
			newFindings: [],
			elapsedMs: 0,
			exceededBudget: false,
		});
		vi.mocked(evaluateTscDiffOverlay).mockReturnValue({
			newFindings: [],
			proposedFindings: null,
			elapsedMs: 0,
			exceededBudget: false,
		});
		vi.mocked(isTscFindingBlocking).mockReturnValue(true);
		vi.mocked(evaluateTypeErasureOverlay).mockReturnValue({ newFindings: [], applicable: true });
	});

	beforeEach(async () => {
		const { findMalformedRulesIn, suggestRuleFix } = await import("../../lib/settings-validator.js");
		vi.mocked(findMalformedRulesIn).mockReturnValue([]);
		vi.mocked(suggestRuleFix).mockReturnValue(null);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── resolvePreEditContent (L146-164) ──────────────────────────────────

	it("passes old_string as preEditContent for an Edit call", () => {
		run({ file_path: "src/a.ts", old_string: "OLD", new_string: "NEW" }, { toolName: "Edit" });
		expect(vi.mocked(buildAgentSafetyChecks)).toHaveBeenCalledWith(
			"NEW",
			"src/a.ts",
			"pre_warn",
			"OLD",
		);
	});

	it("reads on-disk content as preEditContent for a Write when the file exists", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue("DISK CONTENT");
		run({ file_path: "src/a.ts", content: "NEW FULL FILE" }, { toolName: "Write" });
		expect(vi.mocked(buildAgentSafetyChecks)).toHaveBeenCalledWith(
			"NEW FULL FILE",
			"src/a.ts",
			"pre_warn",
			"DISK CONTENT",
		);
		// L158: readFileSync must be called with the "utf-8" encoding, not some
		// other/empty string — a string-literal mutant on the encoding arg.
		expect(readFileSync).toHaveBeenCalledWith("src/a.ts", "utf-8");
	});

	it("does not read a non-existent file: readFileSync is skipped when existsSync is false (L158 conditional)", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		run({ file_path: "src/a.ts", content: "NEW FULL FILE" }, { toolName: "Write" });
		expect(readFileSync).not.toHaveBeenCalled();
		expect(vi.mocked(buildAgentSafetyChecks)).toHaveBeenCalledWith(
			"NEW FULL FILE",
			"src/a.ts",
			"pre_warn",
			undefined,
		);
	});

	it("does not treat a non-string old_string as pre-edit content — falls through to the disk read (L152 ternary)", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockReturnValue("DISK CONTENT");
		run(
			{ file_path: "src/a.ts", old_string: 123, content: "NEW FULL FILE" },
			{ toolName: "Edit" },
		);
		expect(vi.mocked(buildAgentSafetyChecks)).toHaveBeenCalledWith(
			"NEW FULL FILE",
			"src/a.ts",
			"pre_warn",
			"DISK CONTENT",
		);
	});

	it("falls back to undefined preEditContent when the on-disk read throws (L160 catch)", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("EACCES");
		});
		run({ file_path: "src/a.ts", content: "NEW FULL FILE" }, { toolName: "Write" });
		expect(vi.mocked(buildAgentSafetyChecks)).toHaveBeenCalledWith(
			"NEW FULL FILE",
			"src/a.ts",
			"pre_warn",
			undefined,
		);
	});

	it("leaves preEditContent undefined for a Write with no file_path", () => {
		run({ content: "NEW" }, { toolName: "Write" });
		expect(vi.mocked(buildAgentSafetyChecks)).toHaveBeenCalledWith("NEW", "", "pre_warn", undefined);
		expect(existsSync).not.toHaveBeenCalled();
	});

	// ── injectionGuard (L207-242) ──────────────────────────────────────────

	it("skips injection scanning when content is at/under the min-char threshold", () => {
		run({ file_path: "src/a.ts", content: "short" });
		expect(scanPromptInjection).not.toHaveBeenCalled();
	});

	it("still skips injection scanning when content length is EXACTLY the threshold (L208 boundary <=)", () => {
		run({ file_path: "src/a.ts", content: "x".repeat(10) });
		expect(scanPromptInjection).not.toHaveBeenCalled();
	});

	it("passes a string event.cwd through to isContentScanExempt unchanged (L202 typeof guard, string case)", () => {
		run(
			{ file_path: "src/a.ts", content: "x".repeat(50) },
			{ event: baseEvent({ cwd: "/my/proj" }) },
		);
		expect(isContentScanExempt).toHaveBeenCalledWith("src/a.ts", "/my/proj");
	});

	it("passes undefined to isContentScanExempt when event.cwd is not a string (L202 typeof guard, non-string case)", () => {
		run(
			{ file_path: "src/a.ts", content: "x".repeat(50) },
			{ event: baseEvent({ cwd: 12345 as unknown as string }) },
		);
		expect(isContentScanExempt).toHaveBeenCalledWith("src/a.ts", undefined);
	});

	it("skips injection scanning when the path is exempt", () => {
		vi.mocked(isContentScanExempt).mockReturnValue(true);
		run({ file_path: "src/a.test.ts", content: "x".repeat(50) });
		expect(scanPromptInjection).not.toHaveBeenCalled();
	});

	it("returns null (no block, no escalation) when scanPromptInjection finds nothing", () => {
		const result = run({ file_path: "src/a.ts", content: "x".repeat(50) });
		expect(result.kind).toBe("ok");
	});

	it("treats mixed-severity matches as high confidence when only SOME are critical/high (L213 .some, not .every)", () => {
		vi.mocked(scanPromptInjection).mockReturnValue([
			{
				category: "prompt_injection",
				rule_id: "pi-a",
				severity: "low",
				description: "low one",
				matched_text: "x",
			},
			{
				category: "prompt_injection",
				rule_id: "pi-b",
				severity: "critical",
				description: "crit one",
				matched_text: "y",
			},
		]);
		const result = run({ file_path: "src/a.ts", content: "x".repeat(50) });
		expect(result.kind).toBe("block");
	});

	it("blocks on a critical-severity injection match (highConfidence true)", () => {
		vi.mocked(scanPromptInjection).mockReturnValue([
			{
				category: "prompt_injection",
				rule_id: "pi-1",
				severity: "critical",
				description: "ignore all previous instructions",
				matched_text: "ignore all previous instructions",
			},
		]);
		const result = run({ file_path: "src/a.ts", content: "x".repeat(50) });
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason:
					"BLOCKED: Prompt injection pattern detected in content being written to src/a.ts: ignore all previous instructions. This content may compromise agent behavior.",
				warnings: [],
				rule_id: "pretooluse-injection-scan",
				severity: "critical",
				category: "Security",
			},
		});
	});

	it("escalates (does not block) on a low-severity injection match, defaulting session-derived fields when session is undefined", () => {
		vi.mocked(scanPromptInjection).mockReturnValue([
			{
				category: "prompt_injection",
				rule_id: "pi-2",
				severity: "low",
				description: "suspicious phrasing",
				matched_text: "suspicious phrasing",
			},
		]);
		const result = run(
			{ file_path: "src/a.ts", content: "x".repeat(50) },
			{ toolName: "Write", session: undefined },
		);
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.escalation).toEqual({
			trigger: "post_injection_action",
			summary: "Partial prompt injection pattern detected in content for src/a.ts: suspicious phrasing",
			tool_name: "Write",
			tool_input_redacted: { file_path: "src/a.ts", content: "[REDACTED]" },
			sensitivity_level: "Public",
			step_number: 0,
			recent_tool_sequence: [],
		});
		expect(result.warnings).toEqual([
			"[interlinked:injection] Low-confidence injection pattern detected in src/a.ts: suspicious phrasing",
		]);
	});

	it("truncates recent_tool_sequence to the last 10 entries (L234 .slice(-10))", () => {
		vi.mocked(scanPromptInjection).mockReturnValue([
			{
				category: "prompt_injection",
				rule_id: "pi-4",
				severity: "low",
				description: "d",
				matched_text: "m",
			},
		]);
		const longSeq = Array.from({ length: 15 }, (_, i) => `Tool${i}`);
		const session = baseSession({ tool_sequence: longSeq });
		const result = run({ file_path: "src/a.ts", content: "x".repeat(50) }, { session });
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.escalation?.recent_tool_sequence).toEqual(longSeq.slice(-10));
	});

	it("escalates using the session's own fields when a session is present", () => {
		vi.mocked(scanPromptInjection).mockReturnValue([
			{
				category: "prompt_injection",
				rule_id: "pi-3",
				severity: "medium",
				description: "odd phrase",
				matched_text: "odd phrase",
			},
		]);
		const session = baseSession();
		const result = run({ file_path: "src/a.ts", content: "x".repeat(50) }, { session });
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.escalation).toEqual({
			trigger: "post_injection_action",
			summary: "Partial prompt injection pattern detected in content for src/a.ts: odd phrase",
			tool_name: "Write",
			tool_input_redacted: { file_path: "src/a.ts", content: "[REDACTED]" },
			sensitivity_level: "Confidential",
			step_number: 7,
			recent_tool_sequence: ["Read:a.ts", "Edit:b.ts"],
		});
	});

	// ── jsonAndClaudeSettingsGuard (L254-287) ───────────────────────────────

	it("pushes a warning for invalid JSON content and does not block", () => {
		const result = run({ file_path: "config.json", content: "{ not json" });
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toEqual([
			expect.stringContaining("[interlinked] Warning: Invalid JSON in config.json:"),
		]);
	});

	it("does not attempt JSON.parse on whitespace-only content (L256 .trim() truthiness)", () => {
		const result = run({ file_path: "config.json", content: "   \n  " });
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toEqual([]);
	});

	it("does not call findMalformedRulesIn for a plain (non-claude-settings) json file (L264 guard)", async () => {
		const { findMalformedRulesIn } = await import("../../lib/settings-validator.js");
		run({ file_path: "config.json", content: "{}" });
		expect(findMalformedRulesIn).not.toHaveBeenCalled();
	});

	it("does not call findMalformedRulesIn when JSON parsing failed, even for a real claude settings path (L264 parsedJson===undefined operand)", async () => {
		// A non-settings path short-circuits on the FIRST `||` operand, so it can
		// never observe a mutation to the SECOND operand (`parsedJson ===
		// undefined`) — this case forces the first operand false so the second
		// one is actually evaluated.
		const { findMalformedRulesIn } = await import("../../lib/settings-validator.js");
		run({ file_path: ".claude/settings.json", content: "{ not valid json" });
		expect(findMalformedRulesIn).not.toHaveBeenCalled();
	});

	it("does not warn or block for valid JSON on a non-settings path", () => {
		const result = run({ file_path: "config.json", content: '{"a":1}' });
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toEqual([]);
	});

	it("truncates a long JSON parse error message to 100 chars (L261 .slice(0,100))", () => {
		const longMsg = "A".repeat(100) + "OVERFLOW-TAIL-SHOULD-BE-CUT";
		const spy = vi.spyOn(JSON, "parse").mockImplementation(() => {
			throw new Error(longMsg);
		});
		try {
			const result = run({ file_path: "config.json", content: "{}" });
			if (result.kind !== "ok") throw new Error("unreachable");
			const warning = result.warnings.find((w) => w.includes("Invalid JSON"));
			expect(warning).toContain("A".repeat(100));
			expect(warning).not.toContain("OVERFLOW-TAIL-SHOULD-BE-CUT");
		} finally {
			spy.mockRestore();
		}
	});

	it("does not treat a path with .claude/settings.json in the MIDDLE (not at the true end) as a claude settings file (L138 $ anchor)", async () => {
		const { findMalformedRulesIn } = await import("../../lib/settings-validator.js");
		const result = run({
			file_path: "foo/.claude/settings.json/backup.json",
			content: "{}",
		});
		expect(result.kind).toBe("ok");
		expect(findMalformedRulesIn).not.toHaveBeenCalled();
	});

	it("blocks a malformed permission rule written to .claude/settings.json", async () => {
		const { findMalformedRulesIn, suggestRuleFix } = await import("../../lib/settings-validator.js");
		vi.mocked(findMalformedRulesIn).mockReturnValue([
			{ bucket: "allow", index: 0, rule: "Bash(", reason: "unbalanced-paren" },
			{ bucket: "allow", index: 1, rule: "Edit(", reason: "unbalanced-paren" },
		] as never);
		vi.mocked(suggestRuleFix).mockReturnValue("Bash(*)");
		const result = run({
			file_path: ".claude/settings.json",
			content: '{"permissions":{"allow":["Bash(","Edit("]}}',
		});
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason:
					'BLOCKED: Write to .claude/settings.json would add a malformed permission rule. permissions.allow[0] = "Bash(" (malformed reason) (and 1 more). Did you mean "Bash(*)"? ' +
					"Claude Code's /doctor would skip this rule at load time. Fix the rule string (or remove it) before retrying.",
				warnings: [],
				rule_id: "permission-rule-syntax",
				severity: "high",
				category: "settings-integrity",
			},
		});
	});

	it("omits the suggestion clause and the '(and N more)' suffix for a single malformed rule with no suggestion", async () => {
		const { findMalformedRulesIn, suggestRuleFix } = await import("../../lib/settings-validator.js");
		vi.mocked(findMalformedRulesIn).mockReturnValue([
			{ bucket: "deny", index: 0, rule: "Bash(*", reason: "unbalanced-paren" },
		] as never);
		vi.mocked(suggestRuleFix).mockReturnValue(null);
		const result = run({
			file_path: ".claude/settings.local.json",
			content: '{"permissions":{"deny":["Bash(*"]}}',
		});
		if (result.kind !== "block") throw new Error("expected block");
		expect(result.decision.reason).toBe(
			'BLOCKED: Write to .claude/settings.local.json would add a malformed permission rule. permissions.deny[0] = "Bash(*" (malformed reason). ' +
				"Claude Code's /doctor would skip this rule at load time. Fix the rule string (or remove it) before retrying.",
		);
	});

	// ── pathAndFormatGuard (L292-317) ───────────────────────────────────────

	it("blocks path traversal writes", () => {
		const result = run({ file_path: "../etc/passwd", content: "x" });
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason:
					"BLOCKED: Writing to ../etc/passwd — path traversal or system directory write detected. Agents should only write within the project directory.",
				warnings: [],
			},
		});
	});

	it("blocks writes to binary file extensions", () => {
		const result = run({ file_path: "assets/logo.png", content: "binarydata" });
		if (result.kind !== "block") throw new Error("expected block");
		expect(result.decision.reason).toBe(
			"BLOCKED: assets/logo.png is a binary file. Text editing tools should not write to binary formats — use the appropriate tool or command instead.",
		);
	});

	it("blocks a .jpg extension (L56 jpe?g — the ? makes the e optional, not literal)", () => {
		const result = run({ file_path: "assets/photo.jpg", content: "x" });
		expect(result.kind).toBe("block");
	});

	it("blocks a .woff extension without the trailing 2 (L56 woff2? — the ? makes the 2 optional)", () => {
		const result = run({ file_path: "assets/font.woff", content: "x" });
		expect(result.kind).toBe("block");
	});

	it("does not block a filename that merely CONTAINS a binary extension mid-path, not at the end (L56 $ anchor)", () => {
		const result = run({ file_path: "notes.pdf.md", content: "x" });
		expect(result.kind).not.toBe("block");
	});

	it("blocks writes containing merge-conflict markers", () => {
		const content = ["<<<<<<< HEAD", "mine", "=======", "theirs", ">>>>>>> branch"].join("\n");
		const result = run({ file_path: "src/a.ts", content });
		if (result.kind !== "block") throw new Error("expected block");
		expect(result.decision.reason).toBe(
			"BLOCKED: Merge conflict markers detected in src/a.ts. Resolve the conflict before writing.",
		);
	});

	// ── MERGE_CONFLICT_MARKER boundary tests (L59) — each isolates ONE marker
	// line so no OTHER (unmutated) alternative in the regex masks the mutant.

	it("does not treat a mid-line '<<<<<<< ' substring as a conflict marker (L59 requires ^ line-start)", () => {
		const content = 'const s = "embedded <<<<<<< marker mid-line";\n';
		const result = run({ file_path: "src/a.ts", content });
		expect(result.kind).not.toBe("block");
	});

	it("requires exactly 7 '<' characters, not just one, for the conflict-start marker (L59 <{7})", () => {
		const content = "< something not a real conflict marker\nexport const x = 1;\n";
		const result = run({ file_path: "src/a.ts", content });
		expect(result.kind).not.toBe("block");
	});

	it("requires whitespace immediately after the 7 '<' characters (L59 <{7}\\s, isolated: no other marker line present)", () => {
		const content = "<<<<<<< HEAD\nexport const x = 1;\n";
		const result = run({ file_path: "src/a.ts", content });
		expect(result.kind).toBe("block");
	});

	it("requires exactly 7 '=' filling the whole line, not just a 7-'=' prefix (L59 ^={7}$)", () => {
		const content = "======= extra text on the line, not a real conflict marker\nexport const x = 1;\n";
		const result = run({ file_path: "src/a.ts", content });
		expect(result.kind).not.toBe("block");
	});

	it("does not treat a trailing 7-'=' run NOT at line start as a conflict marker (L59 requires ^ before ={7}$)", () => {
		const content = "text=======\nexport const x = 1;\n";
		const result = run({ file_path: "src/a.ts", content });
		expect(result.kind).not.toBe("block");
	});

	it("requires exactly 7 '=' characters, not just one, for the divider marker (L59 ={7})", () => {
		const content = "=\nexport const x = 1;\n";
		const result = run({ file_path: "src/a.ts", content });
		expect(result.kind).not.toBe("block");
	});

	it("does not treat a mid-line '>>>>>>> ' substring as a conflict marker (L59 requires ^ line-start)", () => {
		const content = 'const s = "embedded >>>>>>> marker mid-line";\n';
		const result = run({ file_path: "src/a.ts", content });
		expect(result.kind).not.toBe("block");
	});

	it("requires exactly 7 '>' characters, not just one, for the conflict-end marker (L59 >{7})", () => {
		const content = "> something not a real conflict marker\nexport const x = 1;\n";
		const result = run({ file_path: "src/a.ts", content });
		expect(result.kind).not.toBe("block");
	});

	it("requires whitespace immediately after the 7 '>' characters (L59 >{7}\\s, isolated: no other marker line present)", () => {
		const content = ">>>>>>> branch\nexport const x = 1;\n";
		const result = run({ file_path: "src/a.ts", content });
		expect(result.kind).toBe("block");
	});

	it("blocks a write starting with /etc/ even when the path does not END with /etc/ (L293 startsWith, not endsWith)", () => {
		const result = run({ file_path: "/etc/shadow", content: "x" });
		expect(result.kind).toBe("block");
	});

	it("blocks a write starting with /usr/ even when the path does not END with /usr/ (L293 startsWith, not endsWith)", () => {
		const result = run({ file_path: "/usr/bin/evil", content: "x" });
		expect(result.kind).toBe("block");
	});

	// ── preBlockRegistryGuard + deferrableTransientGuard (L333-388) ────────

	it("returns null when the registry gate reports no outcomes", () => {
		const result = run({ file_path: "src/a.ts", content: "clean" });
		expect(result.kind).toBe("ok");
	});

	it("L343: preBlockRegistryGuard prefers findProjectRoot's result over event.cwd/process.cwd()", () => {
		vi.mocked(findProjectRoot).mockReturnValue("/found/root");
		run({ file_path: "src/a.ts", content: "clean" }, { event: baseEvent({ cwd: "/event/cwd" }) });
		expect(runPreBlockRegistryGate).toHaveBeenCalledWith(
			expect.objectContaining({ projectRoot: "/found/root" }),
		);
	});

	it("L343: preBlockRegistryGuard falls back to event.cwd (not process.cwd()) when findProjectRoot is null", () => {
		vi.mocked(findProjectRoot).mockReturnValue(null);
		run({ file_path: "src/a.ts", content: "clean" }, { event: baseEvent({ cwd: "/event/cwd" }) });
		expect(runPreBlockRegistryGate).toHaveBeenCalledWith(
			expect.objectContaining({ projectRoot: "/event/cwd" }),
		);
	});

	it("L343: findProjectRoot's own second argument is event.cwd (not event.cwd && process.cwd()) — checking the FIRST call specifically (isolated, no deferrable outcome)", () => {
		run(
			{ file_path: "src/a.ts", content: "clean" },
			{
				event: baseEvent({ cwd: "/event/cwd" }),
				rules: {
					quality_checks: { typescript: { enabled: false }, biome_lint: { enabled: false } },
				} as never,
			},
		);
		expect(findProjectRoot).toHaveBeenNthCalledWith(1, "src/a.ts", "/event/cwd");
	});

	it("blocks on a non-deferrable introduced finding", () => {
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "sql_injection",
				introduced: [{ line: 3, text: "raw sql" }],
				preexisting: [],
				instruction: "parametrize",
				deferrable: false,
			},
		] as never);
		const result = run({ file_path: "src/a.ts", content: "bad" });
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason: "pre-block introduced",
				warnings: [],
				rule_id: "mock-pre-block",
			},
		});
		expect(preBlockIntroducedBlock).toHaveBeenCalledTimes(1);
	});

	it("only folds DEFERRABLE outcomes into the transient ledger, not all outcomes (L352 .filter)", () => {
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "non_deferrable_check",
				introduced: [],
				preexisting: [{ line: 9, text: "old finding" }],
				instruction: "n/a",
				deferrable: false,
			},
			{
				checkId: "todo_comment",
				introduced: [{ line: 1, text: "TODO" }],
				preexisting: [],
				instruction: "resolve",
				deferrable: true,
			},
		] as never);
		run({ file_path: "src/a.ts", content: "// TODO" });
		expect(applyTransientDebt).toHaveBeenCalledWith(
			expect.objectContaining({
				findings: [{ detector: "todo_comment", line: 1, message: "TODO" }],
			}),
		);
	});

	it("folds a deferrable finding into the transient ledger and does not block when the ledger returns no decision", () => {
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "todo_comment",
				introduced: [{ line: 1, text: "TODO" }],
				preexisting: [{ line: 9, text: "old TODO" }],
				instruction: "resolve",
				deferrable: true,
			},
		] as never);
		vi.mocked(applyTransientDebt).mockReturnValue({ decision: null, warnings: ["[debt] noted"] });
		const result = run({ file_path: "src/a.ts", content: "// TODO" });
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toContain("[debt] noted");
		expect(applyTransientDebt).toHaveBeenCalledWith(
			expect.objectContaining({
				filePath: "src/a.ts",
				findings: [{ detector: "todo_comment", line: 1, message: "TODO" }, { detector: "todo_comment", line: 9, message: "old TODO" }],
			}),
		);
	});

	it("still surfaces pre-existing warnings when a deferrable finding's debt check returns no decision (L355 if(deferred) — true variant)", () => {
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "todo_comment",
				introduced: [{ line: 1, text: "TODO" }],
				preexisting: [{ line: 9, text: "old TODO" }],
				instruction: "resolve",
				deferrable: true,
			},
		] as never);
		vi.mocked(preexistingPreBlockWarnings).mockReturnValue(["[interlinked:pre-block] preexisting note"]);
		vi.mocked(applyTransientDebt).mockReturnValue({ decision: null, warnings: [] });
		const result = run({ file_path: "src/a.ts", content: "// TODO" });
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toContain("[interlinked:pre-block] preexisting note");
	});

	it("blocks when the transient ledger returns a due decision for a deferrable finding, isolated from the tsc overlay's own debt call (L355 if(deferred) — false variant)", () => {
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "todo_comment",
				introduced: [{ line: 1, text: "TODO" }],
				preexisting: [],
				instruction: "resolve",
				deferrable: true,
			},
		] as never);
		vi.mocked(applyTransientDebt).mockReturnValue({
			decision: { decision: "block", reason: "debt due", rule_id: "transient-debt" } as never,
			warnings: [],
		});
		const result = run(
			{ file_path: "src/a.ts", content: "// TODO" },
			{
				rules: {
					quality_checks: { typescript: { enabled: false }, biome_lint: { enabled: false } },
				} as never,
			},
		);
		expect(result).toEqual({
			kind: "block",
			decision: { decision: "block", reason: "debt due", rule_id: "transient-debt", warnings: [] },
		});
	});

	it("blocks when the transient ledger returns a due decision for a deferrable finding (L354-355, L385)", () => {
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "todo_comment",
				introduced: [{ line: 1, text: "TODO" }],
				preexisting: [],
				instruction: "resolve",
				deferrable: true,
			},
		] as never);
		vi.mocked(applyTransientDebt).mockReturnValue({
			decision: { decision: "block", reason: "debt due", rule_id: "transient-debt" } as never,
			warnings: [],
		});
		const result = run({ file_path: "src/a.ts", content: "// TODO" });
		expect(result).toEqual({
			kind: "block",
			decision: { decision: "block", reason: "debt due", rule_id: "transient-debt", warnings: [] },
		});
	});

	it("surfaces pre-existing (non-introduced, non-deferrable) findings as warnings", () => {
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "sql_injection",
				introduced: [],
				preexisting: [{ line: 4, text: "old raw sql" }],
				instruction: "parametrize",
				deferrable: false,
			},
		] as never);
		vi.mocked(preexistingPreBlockWarnings).mockReturnValue(["[interlinked:pre-block] preexisting"]);
		const result = run({ file_path: "src/a.ts", content: "clean" });
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toContain("[interlinked:pre-block] preexisting");
	});

	it("L371+L373: deferrableTransientGuard prefers findProjectRoot's result and normalizes dryRun via !! (isolated from the tsc/biome overlays' own debt calls)", () => {
		vi.mocked(findProjectRoot).mockReturnValue("/found/root");
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "todo_comment",
				introduced: [{ line: 1, text: "TODO" }],
				preexisting: [],
				instruction: "resolve",
				deferrable: true,
			},
		] as never);
		run(
			{ file_path: "src/a.ts", content: "// TODO" },
			{
				event: baseEvent({ cwd: "/event/cwd" }),
				rules: {
					quality_checks: { typescript: { enabled: false }, biome_lint: { enabled: false } },
				} as never,
			},
		);
		expect(applyTransientDebt).toHaveBeenCalledWith(
			expect.objectContaining({ projectRoot: "/found/root", dryRun: false }),
		);
	});

	it("L371: deferrableTransientGuard falls back to event.cwd (not process.cwd()) when findProjectRoot is null (isolated)", () => {
		vi.mocked(findProjectRoot).mockReturnValue(null);
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "todo_comment",
				introduced: [{ line: 1, text: "TODO" }],
				preexisting: [],
				instruction: "resolve",
				deferrable: true,
			},
		] as never);
		run(
			{ file_path: "src/a.ts", content: "// TODO" },
			{
				event: baseEvent({ cwd: "/event/cwd" }),
				rules: {
					quality_checks: { typescript: { enabled: false }, biome_lint: { enabled: false } },
				} as never,
			},
		);
		expect(applyTransientDebt).toHaveBeenCalledWith(
			expect.objectContaining({ projectRoot: "/event/cwd" }),
		);
	});

	it("L371: findProjectRoot's own second argument is event.cwd (not event.cwd && process.cwd()) — checking the SECOND call (deferrable path) specifically (isolated via call order)", () => {
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "todo_comment",
				introduced: [{ line: 1, text: "TODO" }],
				preexisting: [],
				instruction: "resolve",
				deferrable: true,
			},
		] as never);
		run(
			{ file_path: "src/a.ts", content: "// TODO" },
			{
				event: baseEvent({ cwd: "/event/cwd" }),
				rules: {
					quality_checks: { typescript: { enabled: false }, biome_lint: { enabled: false } },
				} as never,
			},
		);
		expect(findProjectRoot).toHaveBeenNthCalledWith(2, "src/a.ts", "/event/cwd");
	});

	it("passes the resolved project root through to the deferrable transient guard (L370)", () => {
		vi.mocked(findProjectRoot).mockReturnValue("/resolved/root");
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "todo_comment",
				introduced: [{ line: 1, text: "TODO" }],
				preexisting: [],
				instruction: "resolve",
				deferrable: true,
			},
		] as never);
		run({ file_path: "src/a.ts", content: "// TODO" });
		expect(applyTransientDebt).toHaveBeenCalledWith(
			expect.objectContaining({ projectRoot: "/resolved/root" }),
		);
	});

	// ── biomeDiffOverlayGuard (L393-421) ────────────────────────────────────

	it("L396: biomeDiffOverlayGuard prefers findProjectRoot's result over event.cwd/process.cwd()", () => {
		vi.mocked(findProjectRoot).mockReturnValue("/found/root");
		run({ file_path: "src/a.ts", content: "x" }, { event: baseEvent({ cwd: "/event/cwd" }) });
		expect(evaluateBiomeDiffOverlay).toHaveBeenCalledWith("src/a.ts", "x", "/found/root");
	});

	it("L396: biomeDiffOverlayGuard falls back to event.cwd (not process.cwd()) when findProjectRoot is null", () => {
		vi.mocked(findProjectRoot).mockReturnValue(null);
		run({ file_path: "src/a.ts", content: "x" }, { event: baseEvent({ cwd: "/event/cwd" }) });
		expect(evaluateBiomeDiffOverlay).toHaveBeenCalledWith("src/a.ts", "x", "/event/cwd");
	});

	it("L396: findProjectRoot's own second argument is event.cwd (not event.cwd && process.cwd()) — checking the biome-guard's call specifically (isolated via call order, tsc disabled)", () => {
		run(
			{ file_path: "src/a.ts", content: "x" },
			{
				event: baseEvent({ cwd: "/event/cwd" }),
				rules: { quality_checks: { typescript: { enabled: false } } } as never,
			},
		);
		expect(findProjectRoot).toHaveBeenNthCalledWith(2, "src/a.ts", "/event/cwd");
	});

	it("skips the biome overlay entirely when disabled by config", () => {
		run(
			{ file_path: "src/a.ts", content: "x" },
			{ rules: { quality_checks: { biome_lint: { enabled: false } } } as never },
		);
		expect(evaluateBiomeDiffOverlay).not.toHaveBeenCalled();
	});

	it("demotes to a warning (does not block) when the biome overlay exceeded its time budget", () => {
		vi.mocked(evaluateBiomeDiffOverlay).mockReturnValue({
			newFindings: [{ ruleId: "lint/x", line: 2, message: "bad thing" }] as never,
			elapsedMs: 750,
			exceededBudget: true,
		});
		const result = run({ file_path: "src/a.ts", content: "x" });
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toEqual([
			"[interlinked:biome-overlay] 1 new biome finding(s) in src/a.ts from this edit (first: bad thing at L2). Overlay 750ms exceeded 500ms budget — demoted to warning.",
		]);
	});

	it("blocks on new biome findings within budget, with a ruleId fallback and a '+N more' summary", () => {
		vi.mocked(evaluateBiomeDiffOverlay).mockReturnValue({
			newFindings: [{ line: 2, message: "no ruleId here" }, { ruleId: "lint/y", line: 5, message: "second" }] as never,
			elapsedMs: 5,
			exceededBudget: false,
		});
		const result = run({ file_path: "src/a.ts", content: "x" });
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason:
					"BLOCKED by biome diff-overlay: this edit introduces 2 new biome finding(s) in src/a.ts. " +
					"First: [biome] L2 — no ruleId here (+ 1 more). " +
					"Fix the new issue(s) in your edit, or retry without introducing them.",
				warnings: [],
				rule_id: "biome-diff-overlay",
				severity: "high",
				category: "pre-block",
			},
		});
	});

	it("does not include a '+N more' summary for a single biome finding", () => {
		vi.mocked(evaluateBiomeDiffOverlay).mockReturnValue({
			newFindings: [{ ruleId: "lint/z", line: 1, message: "only one" }] as never,
			elapsedMs: 5,
			exceededBudget: false,
		});
		const result = run({ file_path: "src/a.ts", content: "x" });
		if (result.kind !== "block") throw new Error("expected block");
		expect(result.decision.reason).toContain("First: [lint/z] L1 — only one. Fix the new issue(s)");
	});

	// ── tscDiffOverlayGuard (L426-465) ──────────────────────────────────────

	it("L429: tscDiffOverlayGuard prefers findProjectRoot's result over event.cwd/process.cwd()", () => {
		vi.mocked(findProjectRoot).mockReturnValue("/found/root");
		run({ file_path: "src/a.ts", content: "x" }, { event: baseEvent({ cwd: "/event/cwd" }) });
		expect(evaluateTscDiffOverlay).toHaveBeenCalledWith("src/a.ts", "x", "/found/root");
	});

	it("L429: tscDiffOverlayGuard falls back to event.cwd (not process.cwd()) when findProjectRoot is null", () => {
		vi.mocked(findProjectRoot).mockReturnValue(null);
		run({ file_path: "src/a.ts", content: "x" }, { event: baseEvent({ cwd: "/event/cwd" }) });
		expect(evaluateTscDiffOverlay).toHaveBeenCalledWith("src/a.ts", "x", "/event/cwd");
	});

	it("L429: findProjectRoot's own second argument is event.cwd (not event.cwd && process.cwd()) — checking the tsc-guard's call specifically (isolated via call order, biome disabled)", () => {
		run(
			{ file_path: "src/a.ts", content: "x" },
			{
				event: baseEvent({ cwd: "/event/cwd" }),
				rules: { quality_checks: { biome_lint: { enabled: false } } } as never,
			},
		);
		expect(findProjectRoot).toHaveBeenNthCalledWith(2, "src/a.ts", "/event/cwd");
	});

	it("filters warnOnly to exclude blocking findings (L432 .filter, not raw array)", () => {
		vi.mocked(isTscFindingBlocking).mockImplementation(
			(f: { ruleId?: string | undefined }) => f.ruleId === "TS2345",
		);
		vi.mocked(evaluateTscDiffOverlay).mockReturnValue({
			newFindings: [
				{ ruleId: "TS2345", line: 1, message: "blocking one" },
				{ ruleId: "TS7053", line: 2, message: "warn one" },
			] as never,
			proposedFindings: [] as never,
			elapsedMs: 1,
			exceededBudget: false,
		});
		const result = run({ file_path: "src/a.ts", content: "x" }, { toolName: "MultiEdit" });
		if (result.kind !== "block") throw new Error("expected block");
		expect(result.decision.warnings).toEqual([
			"[interlinked:tsc-overlay] src/a.ts:2 — TS7053 warn one. New in this edit (deferred, not dismissed).",
		]);
	});

	it("skips the tsc overlay entirely when disabled by config", () => {
		run(
			{ file_path: "src/a.ts", content: "x" },
			{ rules: { quality_checks: { typescript: { enabled: false } } } as never },
		);
		expect(evaluateTscDiffOverlay).not.toHaveBeenCalled();
	});

	it("warns (does not block) for a warn-only tsc finding and returns null when the debt ledger has no decision (L434, L454)", () => {
		vi.mocked(isTscFindingBlocking).mockReturnValue(false);
		vi.mocked(evaluateTscDiffOverlay).mockReturnValue({
			newFindings: [{ ruleId: "TS7053", line: 6, message: "implicit any" }] as never,
			proposedFindings: [],
			elapsedMs: 4,
			exceededBudget: false,
		});
		const result = run({ file_path: "src/a.ts", content: "x" });
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toContain(
			"[interlinked:tsc-overlay] src/a.ts:6 — TS7053 implicit any. New in this edit (deferred, not dismissed).",
		);
	});

	it("blocks when the debt ledger returns a decision and there are no blocking findings", () => {
		vi.mocked(evaluateTscDiffOverlay).mockReturnValue({
			newFindings: [],
			proposedFindings: [],
			elapsedMs: 4,
			exceededBudget: false,
		});
		vi.mocked(applyTransientDebt).mockReturnValue({
			decision: { decision: "block", reason: "tsc debt due", rule_id: "transient-debt-tsc" } as never,
			warnings: [],
		});
		const result = run({ file_path: "src/a.ts", content: "x" });
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason: "tsc debt due",
				rule_id: "transient-debt-tsc",
				warnings: [],
			},
		});
	});

	it("L442+L446: tscDiffOverlayGuard passes the full debt payload to applyTransientDebt, with dryRun normalized via !! (isolated — no deferrable pre-block outcome)", () => {
		vi.mocked(evaluateTscDiffOverlay).mockReturnValue({
			newFindings: [],
			proposedFindings: [{ ruleId: "TS7053", line: 6, message: "implicit any" }] as never,
			elapsedMs: 4,
			exceededBudget: false,
		});
		vi.mocked(deferrableFromTsc).mockReturnValue([
			{ detector: "tsc", line: 6, message: "implicit any" },
		] as never);
		vi.mocked(findProjectRoot).mockReturnValue("/found/root");
		const event = baseEvent({ session_id: "sess-xyz" });
		run(
			{ file_path: "src/a.ts", content: "x" },
			{ event, rules: { quality_checks: { transient_debt: { enabled: true } } } as never },
		);
		expect(applyTransientDebt).toHaveBeenCalledWith({
			filePath: "src/a.ts",
			projectRoot: "/found/root",
			sessionId: "sess-xyz",
			dryRun: false,
			findings: [{ detector: "tsc", line: 6, message: "implicit any" }],
			content: "x",
			config: { enabled: true },
		});
	});

	it("blocks on a genuinely new hard type error, outranking any debt decision", () => {
		vi.mocked(evaluateTscDiffOverlay).mockReturnValue({
			newFindings: [{ ruleId: "TS2345", line: 8, column: 2, message: "type mismatch" }] as never,
			proposedFindings: [{ ruleId: "TS2345", line: 8, message: "type mismatch" }] as never,
			elapsedMs: 4,
			exceededBudget: false,
		});
		vi.mocked(applyTransientDebt).mockReturnValue({
			decision: { decision: "block", reason: "should be outranked", rule_id: "transient-debt-tsc" } as never,
			warnings: [],
		});
		const result = run({ file_path: "src/a.ts", content: "x" }, { toolName: "MultiEdit" });
		if (result.kind !== "block") throw new Error("expected block");
		expect(result.decision.rule_id).toBe("tsc-diff-overlay");
		expect(result.decision.reason).toContain("BLOCKED by tsc diff-overlay");
	});

	it("pins the full block-decision shape from a hard tsc type error (decision/severity/category literals, L456/460/461)", () => {
		vi.mocked(evaluateTscDiffOverlay).mockReturnValue({
			newFindings: [{ ruleId: "TS2345", line: 8, column: 2, message: "type mismatch" }] as never,
			proposedFindings: [] as never,
			elapsedMs: 4,
			exceededBudget: false,
		});
		const result = run({ file_path: "src/a.ts", content: "x" }, { toolName: "MultiEdit" });
		if (result.kind !== "block") throw new Error("expected block");
		expect(result.decision.decision).toBe("block");
		expect(result.decision.severity).toBe("high");
		expect(result.decision.category).toBe("pre-block");
	});

	// ── strictTypingOverlayGuard (L475-500) ─────────────────────────────────

	it("skips strict-typing overlay when not explicitly enabled", () => {
		run({ file_path: "src/a.ts", content: "x" });
		expect(evaluateTypeErasureOverlay).not.toHaveBeenCalled();
	});

	it("blocks on new type-erasure findings when strict_typing_block is enabled, with a '+N more' summary", () => {
		vi.mocked(evaluateTypeErasureOverlay).mockReturnValue({
			applicable: true,
			newFindings: [
				{ ruleId: "as-any", line: 3, message: "as any used" },
				{ ruleId: "as-any", line: 9, message: "as any used again" },
			] as never,
		});
		const result = run(
			{ file_path: "src/a.ts", content: "x as any" },
			{ rules: { quality_checks: { strict_typing_block: { enabled: true } } } as never },
		);
		expect(result).toEqual({
			kind: "block",
			decision: {
				decision: "block",
				reason:
					"BLOCKED by strict-typing pre-overlay: this edit introduces 2 new type-erasure pattern(s) in src/a.ts (L3, L9). " +
					"First: [as-any] L3 — as any used (+ 1 more). " +
					"Fix the pattern(s) in your edit, or retry without introducing them. " +
					"Justification escapes are accepted: `// @ts-expect-error: <reason>` for suppression directives.",
				warnings: [],
				rule_id: "strict-typing-overlay",
				severity: "high",
				category: "pre-block",
			},
		});
	});

	it("does not block when strict_typing_block is enabled but there are no new findings", () => {
		vi.mocked(evaluateTypeErasureOverlay).mockReturnValue({ newFindings: [], applicable: true });
		const result = run(
			{ file_path: "src/a.ts", content: "x" },
			{ rules: { quality_checks: { strict_typing_block: { enabled: true } } } as never },
		);
		expect(result.kind).toBe("ok");
	});

	// ── runPreWarnRegistry (L509-522) ───────────────────────────────────────

	it("uses an empty instruction string when no instruction is registered for the check name (L516)", () => {
		vi.mocked(buildAgentSafetyChecks).mockReturnValue([
			{ name: "some_check", fn: () => [{ line: 3, text: "bad" }] },
		] as never);
		vi.mocked(buildCheckInstructions).mockReturnValue({});
		const result = run({ file_path: "src/a.ts", content: "x" });
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toEqual([
			"[interlinked:some_check] src/a.ts has 1 violation(s) at L3 — ",
		]);
	});

	it("uses the registered instruction and joins multiple match lines", () => {
		vi.mocked(buildAgentSafetyChecks).mockReturnValue([
			{ name: "some_check", fn: () => [{ line: 3, text: "bad" }, { line: 8, text: "worse" }] },
		] as never);
		vi.mocked(buildCheckInstructions).mockReturnValue({ some_check: "fix it please" });
		const result = run({ file_path: "src/a.ts", content: "x" });
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toEqual([
			"[interlinked:some_check] src/a.ts has 2 violation(s) at L3, L8 — fix it please",
		]);
	});

	it("skips a check whose fn returns no matches", () => {
		vi.mocked(buildAgentSafetyChecks).mockReturnValue([
			{ name: "quiet_check", fn: () => [] },
		] as never);
		const result = run({ file_path: "src/a.ts", content: "x" });
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toEqual([]);
	});

	// ── fallback-cwd branches (project root resolution `|| event.cwd || process.cwd()`) ──

	it("falls back through findProjectRoot and event.cwd to process.cwd() when neither is available", () => {
		vi.mocked(findProjectRoot).mockReturnValue(null);
		vi.mocked(runPreBlockRegistryGate).mockReturnValue([
			{
				checkId: "todo_comment",
				introduced: [{ line: 1, text: "TODO" }],
				preexisting: [],
				instruction: "resolve",
				deferrable: true,
			},
		] as never);
		const eventNoCwd = {
			hook_event: "PreToolUse",
			session_id: "sess-1",
			agent_source: "claude",
		} as unknown as HarnessEvent;
		const result = run(
			{ file_path: "src/a.ts", content: "// TODO" },
			{ event: eventNoCwd },
		);
		expect(result.kind).toBe("ok");
		expect(applyTransientDebt).toHaveBeenCalledWith(
			expect.objectContaining({ projectRoot: process.cwd() }),
		);
		expect(evaluateBiomeDiffOverlay).toHaveBeenCalledWith("src/a.ts", "// TODO", process.cwd());
		expect(evaluateTscDiffOverlay).toHaveBeenCalledWith("src/a.ts", "// TODO", process.cwd());
	});

	// ── jsonAndClaudeSettingsGuard: malformed.length === 0 branch (L266) ───

	it("does not block a valid .claude/settings.json with no malformed rules", () => {
		const result = run({
			file_path: ".claude/settings.json",
			content: '{"permissions":{"allow":["Bash(ls)"]}}',
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		expect(result.warnings).toEqual([]);
	});

	// ── strictTypingOverlayGuard: no '+N more' summary for a single finding (L481) ──

	it("truncates the strict-typing lineList to the first 5 findings (L482 .slice(0,5))", () => {
		const manyFindings = Array.from({ length: 8 }, (_, i) => ({
			ruleId: "as-any",
			line: i + 1,
			message: `as any used #${i + 1}`,
		}));
		vi.mocked(evaluateTypeErasureOverlay).mockReturnValue({
			applicable: true,
			newFindings: manyFindings as never,
		});
		const result = run(
			{ file_path: "src/a.ts", content: "x as any" },
			{ rules: { quality_checks: { strict_typing_block: { enabled: true } } } as never },
		);
		if (result.kind !== "block") throw new Error("expected block");
		expect(result.decision.reason).toContain("(L1, L2, L3, L4, L5)");
		expect(result.decision.reason).not.toContain("L6");
	});

	it("does not include a '+N more' summary for a single strict-typing finding", () => {
		vi.mocked(evaluateTypeErasureOverlay).mockReturnValue({
			applicable: true,
			newFindings: [{ ruleId: "as-any", line: 3, message: "as any used" }] as never,
		});
		const result = run(
			{ file_path: "src/a.ts", content: "x as any" },
			{ rules: { quality_checks: { strict_typing_block: { enabled: true } } } as never },
		);
		if (result.kind !== "block") throw new Error("expected block");
		expect(result.decision.reason).toContain("(L3). First: [as-any] L3 — as any used. Fix the pattern(s)");
	});

	// ── final fall-through: content-quality warnings + ok envelope ─────────

	it("appends legacy content-quality warnings and returns the accumulated escalation on the ok path", () => {
		vi.mocked(collectContentQualityWarnings).mockReturnValue(["[interlinked:legacy] heads up"]);
		const result = run({ file_path: "src/a.ts", content: "x" });
		expect(result).toEqual({
			kind: "ok",
			warnings: ["[interlinked:legacy] heads up"],
			escalation: undefined,
		});
	});
});
