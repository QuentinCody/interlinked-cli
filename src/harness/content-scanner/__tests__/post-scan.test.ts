import { describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import type { HarnessEvent, SessionTrajectory } from "../../types.js";
import { compileAllowlist } from "../allowlist.js";
import { runPostToolScan, type PostScanRules } from "../post-scan.js";
import type { ContentScanner, ContentScannerConfig, ScanFinding } from "../types.js";

const NO_ALLOWLIST = compileAllowlist(undefined);

// ===========================================
// Fixtures
// ===========================================

function makeScannerConfig(overrides: Partial<ContentScannerConfig> = {}): ContentScannerConfig {
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
			sidecar_script: "/tmp/opf.py",
			startup_timeout_ms: 45_000,
			scan_timeout_ms: 1500,
			idle_shutdown_ms: 1_800_000,
			max_restarts: 3,
		},
		huggingface: { model: "x", api_key_env: "HF_TOKEN", timeout_ms: 4000 },
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 100_000,
		...overrides,
	};
}

function makeRules(scanner: ContentScannerConfig | undefined): PostScanRules {
	return {
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
		content_scanner: scanner,
	};
}

function makeSession(): SessionTrajectory {
	return {
		session_id: "s",
		agent_name: "agent",
		started_at: "2026-04-24T00:00:00Z",
		tool_call_count: 5,
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
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		agent_name: "agent",
		tool_name: "Read",
		tool_input: { file_path: "/x.txt" },
		tool_response: "",
		timestamp: "2026-04-24T00:00:00Z",
		...overrides,
	};
}

function makeScanner(findings: ScanFinding[]): ContentScanner {
	return {
		name: "stub",
		runtime: "local",
		ready: async () => true,
		scan: vi.fn(async (_req) => findings),
		shutdown: async () => {},
	};
}

// ===========================================
// Tests
// ===========================================

describe("runPostToolScan — applicability", () => {
	it("returns empty when scanner is undefined", async () => {
		const r = await runPostToolScan({
			event: makeEvent(),
			session: makeSession(),
			rules: makeRules(makeScannerConfig()),
			scanner: undefined,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.warnings).toEqual([]);
		expect(r.findings).toEqual([]);
	});

	it("returns empty when content_scanner is disabled", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: "x" }),
			session: makeSession(),
			rules: makeRules(makeScannerConfig({ enabled: false })),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toEqual([]);
	});

	it("returns empty when read_grep_taint scan point is off", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const cfg = makeScannerConfig();
		cfg.scan_points.read_grep_taint = false;
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: "x" }),
			session: makeSession(),
			rules: makeRules(cfg),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toEqual([]);
	});

	it("returns empty for non-Read tool names", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_name: "Write", tool_response: "secret" }),
			session: makeSession(),
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toEqual([]);
	});

	it("returns empty when tool_response is empty", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: "" }),
			session: makeSession(),
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toEqual([]);
	});
});

describe("runPostToolScan — taint ratchet + warnings", () => {
	it("ratchets to Confidential and warns when non-critical PII is detected", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 7, text: "a@b.com", source: "" },
		]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: "email: a@b.com" }),
			session,
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});

		expect(session.sensitivity_level).toBe("Confidential");
		expect(session.pii_detected_steps).toContain(5);
		expect(r.ratcheted_to).toBe("Confidential");
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("Confidential");
		expect(r.warnings[0]).toContain("private_email(1)");
	});

	it("does not ratchet or warn when all findings are below min_score", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{
				label: "private_email",
				start: 0,
				end: 7,
				text: "a@b.com",
				score: 0.4,
				source: "",
			},
		]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: "email: a@b.com" }),
			session,
			rules: makeRules(makeScannerConfig({ min_score: 0.9 })),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});

		expect(r.findings).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.ratcheted_to).toBeUndefined();
		expect(session.sensitivity_level).toBe("Public");
		expect(session.pii_detected_steps).toEqual([]);
	});

	it("ratchets to HighlyConfidential when a secret is present", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 7, text: "a@b.com", source: "" },
			{ label: "secret", start: 10, end: 22, text: "sk_live_abc", source: "" },
		]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: "a@b.com sk_live_abc" }),
			session,
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});

		expect(session.sensitivity_level).toBe("HighlyConfidential");
		expect(r.ratcheted_to).toBe("HighlyConfidential");
		expect(r.warnings[0]).toContain("HighlyConfidential");
		expect(r.warnings[0]).toContain("private_email(1), secret(1)");
	});

	it("ratchets to HighlyConfidential when only an account_number is present", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "account_number", start: 0, end: 9, text: "021000021", source: "" },
		]);
		await runPostToolScan({
			event: makeEvent({ tool_response: "routing 021000021" }),
			session,
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(session.sensitivity_level).toBe("HighlyConfidential");
	});

	it("pushes the tool-call step to pii_detected_steps even when the ratchet is a no-op", async () => {
		const session = makeSession();
		session.sensitivity_level = "HighlyConfidential"; // already at top
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 7, text: "a@b.com", source: "" },
		]);
		await runPostToolScan({
			event: makeEvent({ tool_response: "a@b.com" }),
			session,
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		// Sensitivity stays at the existing top level...
		expect(session.sensitivity_level).toBe("HighlyConfidential");
		// ...but we still record detection so PreToolUse gating can fire.
		expect(session.pii_detected_steps).toContain(5);
	});

	it("fails open when the scanner throws (no warning, no ratchet)", async () => {
		const session = makeSession();
		const scanner: ContentScanner = {
			name: "broken",
			runtime: "local",
			ready: async () => true,
			scan: async () => {
				throw new Error("boom");
			},
			shutdown: async () => {},
		};
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: "secret" }),
			session,
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.warnings).toEqual([]);
		expect(session.sensitivity_level).toBe("Public");
		expect(session.pii_detected_steps).toEqual([]);
	});

	it("no warning when the scanner returns no findings", async () => {
		const session = makeSession();
		const scanner = makeScanner([]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: "hello world" }),
			session,
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.warnings).toEqual([]);
		expect(session.sensitivity_level).toBe("Public");
	});

	it("respects max_scan_bytes by truncating before calling the scanner", async () => {
		const session = makeSession();
		const big = "x".repeat(200_000);
		const scanner = makeScanner([]);
		const cfg = makeScannerConfig();
		cfg.max_scan_bytes = 50_000;
		await runPostToolScan({
			event: makeEvent({ tool_response: big }),
			session,
			rules: makeRules(cfg),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		const scanSpy = vi.mocked(scanner.scan);
		expect(nonNull(scanSpy.mock.calls[0])[0].text.length).toBe(50_000);
	});

	it("falls back to a synthesized <tool-response> label when tool_input has no file_path", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "secret", start: 0, end: 3, text: "sk_", source: "" },
		]);
		const r = await runPostToolScan({
			event: makeEvent({
				tool_name: "Grep",
				tool_input: { pattern: "sk_" },
				tool_response: "line 1: sk_live_abc",
			}),
			session,
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toHaveLength(1);
		// The ratchet must have been keyed off the synthesized label, not a
		// missing file_path — session state changed, proving the fallback ran.
		expect(session.sensitivity_level).toBe("HighlyConfidential");
	});

	it("scans Grep tool results (not just Read)", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "secret", start: 0, end: 3, text: "sk_", source: "" },
		]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_name: "Grep", tool_response: "line 1: sk_live_abc" }),
			session,
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toHaveLength(1);
	});
});

describe("runPostToolScan — response shape + fallback branches", () => {
	it("returns empty when tool_response is null", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: null }),
			session: makeSession(),
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toEqual([]);
	});

	it("returns empty when tool_response is undefined", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: undefined }),
			session: makeSession(),
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toEqual([]);
	});

	it("serializes a structured (non-string) tool_response via JSON.stringify", async () => {
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 7, text: "a@b.com", source: "" },
		]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: { matches: ["a@b.com"] } }),
			session: makeSession(),
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toHaveLength(1);
		const scanSpy = vi.mocked(scanner.scan);
		expect(nonNull(scanSpy.mock.calls[0])[0].text).toBe(JSON.stringify({ matches: ["a@b.com"] }));
	});

	it("returns empty when a serialized structured response is too short to scan", async () => {
		// `null` serializes to "null" (4 chars) which clears MIN_SERIALIZED_LENGTH,
		// but a structured value with a shorter serialization (e.g. `{}` → 2 chars)
		// must not be scanned.
		const scanner = makeScanner([]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: {} }),
			session: makeSession(),
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toEqual([]);
		const scanSpy = vi.mocked(scanner.scan);
		expect(scanSpy).not.toHaveBeenCalled();
	});

	it("returns empty when tool_response cannot be JSON.stringified (circular reference)", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: circular }),
			session: makeSession(),
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toEqual([]);
		const scanSpy = vi.mocked(scanner.scan);
		expect(scanSpy).not.toHaveBeenCalled();
	});

	it("defaults tool_name to empty string and skips applicability when absent", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const event = makeEvent({ tool_response: "secret" });
		event.tool_name = undefined;
		const r = await runPostToolScan({
			event,
			session: makeSession(),
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		expect(r.findings).toEqual([]);
	});

	it("falls back to output_scanning.max_scan_bytes when content_scanner.max_scan_bytes is unset", async () => {
		const session = makeSession();
		const scanner = makeScanner([]);
		const cfg = makeScannerConfig({ max_scan_bytes: 0 });
		const rules = makeRules(cfg);
		rules.output_scanning = { ...nonNull(rules.output_scanning), max_scan_bytes: 30_000 };
		const big = "x".repeat(50_000);
		await runPostToolScan({
			event: makeEvent({ tool_response: big }),
			session,
			rules,
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		const scanSpy = vi.mocked(scanner.scan);
		expect(nonNull(scanSpy.mock.calls[0])[0].text.length).toBe(30_000);
	});

	it("falls back to DEFAULT_MAX_SCAN_BYTES when neither config specifies a limit", async () => {
		const session = makeSession();
		const scanner = makeScanner([]);
		const cfg = makeScannerConfig({ max_scan_bytes: 0 });
		const rules = makeRules(cfg);
		rules.output_scanning = { ...nonNull(rules.output_scanning), max_scan_bytes: 0 };
		const big = "x".repeat(200_000);
		await runPostToolScan({
			event: makeEvent({ tool_response: big }),
			session,
			rules,
			scanner,
			compiledAllowlist: NO_ALLOWLIST,
		});
		const scanSpy = vi.mocked(scanner.scan);
		expect(nonNull(scanSpy.mock.calls[0])[0].text.length).toBe(100_000);
	});

	it("falls back to DEFAULT_SCAN_TIMEOUT_MS when scan_timeout_ms is unset (0)", async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		try {
			const session = makeSession();
			const scanner = makeScanner([]);
			const cfg = makeScannerConfig();
			cfg.local = { ...cfg.local, scan_timeout_ms: 0 };
			const r = await runPostToolScan({
				event: makeEvent({ tool_response: "hello" }),
				session,
				rules: makeRules(cfg),
				scanner,
				compiledAllowlist: NO_ALLOWLIST,
			});
			expect(r.findings).toEqual([]);
			expect(scanner.scan).toHaveBeenCalledTimes(1);
			expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(1500);
		} finally {
			timeoutSpy.mockRestore();
		}
	});
});

// Regression for the FP-suppression gap left by 73e1c1f. The allowlist
// was wired into the PreToolUse Write/Edit/Bash branch but not into
// post-scan, so a Read of a file containing `noreply@anthropic.com`
// would still ratchet sensitivity. With the allowlist threaded through,
// the same finding gets dropped before the policy decides.
describe("runPostToolScan — allowlist suppression (gap fix)", () => {
	it("suppresses findings the allowlist matches before warning or ratcheting", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 21, text: "noreply@anthropic.com", source: "" },
		]);
		const r = await runPostToolScan({
			event: makeEvent({ tool_response: "Contact: noreply@anthropic.com" }),
			session,
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: compileAllowlist([
				{ kind: "prefix", pattern: "noreply@", label: "private_email" },
			]),
		});
		expect(r.findings).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.ratcheted_to).toBeUndefined();
		expect(session.sensitivity_level).toBe("Public");
		expect(session.pii_detected_steps).toEqual([]);
	});

	it("keeps findings the allowlist does not cover", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 21, text: "noreply@anthropic.com", source: "" },
			{ label: "private_email", start: 30, end: 47, text: "real-user@x.example", source: "" },
		]);
		const r = await runPostToolScan({
			event: makeEvent({
				tool_response: "noreply@anthropic.com and also real-user@x.example",
			}),
			session,
			rules: makeRules(makeScannerConfig()),
			scanner,
			compiledAllowlist: compileAllowlist([
				{ kind: "prefix", pattern: "noreply@", label: "private_email" },
			]),
		});
		expect(r.findings).toHaveLength(1);
		expect(r.findings[0]?.text).toBe("real-user@x.example");
		expect(session.sensitivity_level).toBe("Confidential");
	});
});
