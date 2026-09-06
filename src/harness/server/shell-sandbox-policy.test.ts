import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { appendShellSandboxAdvisory, assessShellSandbox } from "./shell-sandbox-policy.js";

let root: string;

function event(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "codex",
		tool_name: "Bash",
		tool_input: { command: "npm test" },
		timestamp: new Date().toISOString(),
		...over,
	};
}

function session(): SessionTrajectory {
	return { acknowledged_checks: new Set() } as unknown as SessionTrajectory;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-sandbox-policy-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("shell sandbox evidence", () => {
	// test-contract: public-api — an explicit per-call sandbox attestation or full-access mode determines the observable evidence
	it("recognizes explicit per-call sandbox evidence and danger-full-access", () => {
		expect(
			assessShellSandbox(
				event({ agent_source: "claude", tool_input: { command: "x", sandboxed: true } }),
				root,
			),
		).toEqual({ evidence: "attested", detail: "the runner marked this call sandboxed" });
		expect(
			assessShellSandbox(
				event({ agent_source: "claude", tool_input: { command: "x", sandbox_mode: "danger-full-access" } }),
				root,
			),
		).toEqual({ evidence: "disabled", detail: "the runner reported danger-full-access" });
	});

	// test-contract: public-api — explicit sandboxed=false evidence takes precedence over a restrictive configured sandbox mode
	it("reports explicit per-call unsandboxed evidence despite restrictive Codex config", () => {
		mkdirSync(join(root, ".codex"));
		writeFileSync(join(root, ".codex", "config.toml"), 'sandbox_mode = "workspace-write"\n');
		expect(
			assessShellSandbox(event({ tool_input: { command: "x", sandboxed: false } }), root),
		).toEqual({ evidence: "disabled", detail: "the runner marked this call unsandboxed" });
	});

	// test-contract: public-api — Claude’s fail-closed settings produce the documented strict configured evidence
	it("reports a strict Claude sandbox configuration", () => {
		mkdirSync(join(root, ".claude"));
		writeFileSync(
			join(root, ".claude", "settings.local.json"),
			JSON.stringify({
				sandbox: {
					enabled: true,
					failIfUnavailable: true,
					allowUnsandboxedCommands: false,
					excludedCommands: [],
				},
			}),
		);
		expect(assessShellSandbox(event({ agent_source: "claude" }), root)).toEqual({
			evidence: "configured",
			detail: "strict sandbox configuration found",
		});
	});

	// test-contract: boundary — Claude’s configured escape gaps remain configured evidence while naming every observable gap
	it("reports Claude sandbox escape gaps without treating them as disabled", () => {
		mkdirSync(join(root, ".claude"));
		writeFileSync(
			join(root, ".claude", "settings.local.json"),
			JSON.stringify({
				sandbox: {
					enabled: true,
					failIfUnavailable: false,
					allowUnsandboxedCommands: true,
					excludedCommands: ["git"],
				},
			}),
		);
		const assessment = assessShellSandbox(event({ agent_source: "claude" }), root);
		expect(assessment.evidence).toBe("configured");
		expect(assessment.detail).toContain("failIfUnavailable is not true");
		expect(assessment.detail).toContain("the unsandboxed escape hatch remains enabled");
		expect(assessment.detail).toContain("1 command exclusion(s) run outside the sandbox");
	});

	// test-contract: public-api — an explicitly disabled Claude sandbox is surfaced as disabled evidence
	it("reports a disabled Claude sandbox setting", () => {
		mkdirSync(join(root, ".claude"));
		writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify({ sandbox: { enabled: false } }));
		expect(assessShellSandbox(event({ agent_source: "claude" }), root)).toMatchObject({
			evidence: "disabled",
			detail: expect.stringContaining("sandbox.enabled=false"),
		});
	});

	// test-contract: public-api — Gemini’s tools.sandbox setting is reported as configured when enabled
	it("reports a configured Gemini sandbox", () => {
		mkdirSync(join(root, ".gemini"));
		writeFileSync(join(root, ".gemini", "settings.json"), JSON.stringify({ tools: { sandbox: true } }));
		expect(assessShellSandbox(event({ agent_source: "gemini" }), root)).toMatchObject({ evidence: "configured" });
	});

	// test-contract: public-api — Gemini’s tools.sandbox=false setting disables tool sandboxing
	it("reports Gemini tools sandboxing as disabled", () => {
		mkdirSync(join(root, ".gemini"));
		writeFileSync(join(root, ".gemini", "settings.json"), JSON.stringify({ tools: { sandbox: false } }));
		expect(assessShellSandbox(event({ agent_source: "gemini" }), root)).toMatchObject({
			evidence: "disabled",
			detail: expect.stringContaining("disables Gemini tool sandboxing"),
		});
	});

	// test-contract: boundary — Gemini’s security.toolSandboxing=false signal disables sandboxing even when tools.sandbox is truthy
	it("reports Gemini security tool sandboxing as disabled", () => {
		mkdirSync(join(root, ".gemini"));
		writeFileSync(
			join(root, ".gemini", "settings.json"),
			JSON.stringify({ tools: { sandbox: true }, security: { toolSandboxing: false } }),
		);
		expect(assessShellSandbox(event({ agent_source: "gemini" }), root)).toMatchObject({ evidence: "disabled" });
	});

	// test-contract: public-api — Codex’s top-level danger-full-access mode is exposed as disabled evidence
	it("reports Codex danger-full-access configuration as disabled", () => {
		mkdirSync(join(root, ".codex"));
		writeFileSync(join(root, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n');
		expect(assessShellSandbox(event(), root)).toEqual({
			evidence: "disabled",
			detail: "configured sandbox_mode is danger-full-access",
		});
	});

	// test-contract: boundary — Codex profile-only sandbox modes remain unknown because the hook reads only top-level configuration
	it("does not infer Codex sandbox evidence from a profile-only mode", () => {
		mkdirSync(join(root, ".codex"));
		writeFileSync(
			join(root, ".codex", "config.toml"),
			'[profiles.strict]\nsandbox_mode = "workspace-write"\n',
		);
		expect(assessShellSandbox(event(), root)).toMatchObject({
			evidence: "unknown",
			detail: expect.stringContaining("no readable Codex sandbox_mode"),
		});
	});

	it("distinguishes a configured Codex sandbox from per-call attestation", () => {
		mkdirSync(join(root, ".codex"));
		writeFileSync(join(root, ".codex", "config.toml"), 'sandbox_mode = "workspace-write"\n');
		expect(assessShellSandbox(event(), root)).toMatchObject({ evidence: "configured" });
		expect(
			assessShellSandbox(event({ tool_input: { command: "x", sandbox_mode: "workspace-write" } }), root),
		).toMatchObject({ evidence: "attested" });
	});

	it("reports explicit sandbox escape requests even when config is restrictive", () => {
		expect(
			assessShellSandbox(
				event({ tool_input: { command: "x", sandbox_permissions: "require_escalated" } }),
				root,
			),
		).toMatchObject({ evidence: "disabled" });
	});

	it("advises once per session for unknown state but repeats explicit disabled evidence", () => {
		const s = session();
		const first: HarnessDecision = { decision: "allow" };
		appendShellSandboxAdvisory(event(), s, first, root);
		expect(first.warnings?.[0]).toContain("evidence=unknown");
		const second: HarnessDecision = { decision: "allow" };
		appendShellSandboxAdvisory(event(), s, second, root);
		expect(second.warnings).toBeUndefined();
		const escaped: HarnessDecision = { decision: "allow" };
		appendShellSandboxAdvisory(
			event({ tool_input: { command: "x", dangerouslyDisableSandbox: true } }),
			s,
			escaped,
			root,
		);
		expect(escaped.warnings?.[0]).toContain("evidence=disabled");
	});

	// test-contract: public-api — an ask-capable Bash decision receives the same sandbox evidence advisory as an allowed call
	it("adds a sandbox advisory to an ask Bash decision", () => {
		const asking: HarnessDecision = { decision: "ask" };
		appendShellSandboxAdvisory(
			event({ tool_input: { command: "x", sandboxed: true } }),
			session(),
			asking,
			root,
		);
		expect(asking.warnings).toHaveLength(1);
		expect(asking.warnings?.[0]).toContain("evidence=attested");
	});

	// test-contract: boundary — a blocked Bash decision remains warning-free even when sandbox evidence is available
	it("does not add a sandbox advisory to a blocked Bash call", () => {
		const blocked: HarnessDecision = { decision: "block" };
		const blockedEvent = event({ tool_input: { command: "x", sandboxed: true } });
		appendShellSandboxAdvisory(blockedEvent, session(), blocked, root);
		expect(blocked.warnings).toBeUndefined();
		expect(blockedEvent.sandbox_evidence).toBeUndefined();
	});

	// test-contract: boundary — non-shell tools do not receive shell-specific sandbox advisories
	it("does not add a sandbox advisory to non-shell tools", () => {
		const s = session();
		const writeDecision: HarnessDecision = { decision: "allow" };
		appendShellSandboxAdvisory(event({ tool_name: "Write" }), s, writeDecision, root);
		expect(writeDecision.warnings).toBeUndefined();
	});

	// test-contract: boundary — an unreadable Codex config yields unknown evidence instead of propagating the read error
	it("reports unknown Codex evidence when the config path cannot be read", () => {
		// A directory where config.toml is expected: existsSync passes, readFileSync throws EISDIR.
		mkdirSync(join(root, ".codex", "config.toml"), { recursive: true });
		expect(assessShellSandbox(event(), root)).toEqual({
			evidence: "unknown",
			detail: "no readable Codex sandbox_mode was found for this project/user",
		});
	});

	// test-contract: boundary — a Gemini settings file without tools.sandbox is skipped rather than read for other sandbox keys
	it("reports unknown Gemini evidence when no settings file declares tools.sandbox", () => {
		mkdirSync(join(root, ".gemini"));
		writeFileSync(
			join(root, ".gemini", "settings.json"),
			JSON.stringify({ tools: { web_search: true }, security: { toolSandboxing: false } }),
		);
		expect(assessShellSandbox(event({ agent_source: "gemini" }), root)).toEqual({
			evidence: "unknown",
			detail: "no Gemini sandbox setting was found",
		});
	});

	// test-contract: boundary — a runner with no sandbox attestation surface is not assessed against another runner's config
	it("reports unknown evidence for a runner that exposes no attestation", () => {
		mkdirSync(join(root, ".codex"));
		writeFileSync(join(root, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n');
		mkdirSync(join(root, ".claude"));
		writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ sandbox: { enabled: false } }));
		expect(assessShellSandbox(event({ agent_source: "copilot" }), root)).toEqual({
			evidence: "unknown",
			detail: "this runner does not expose per-call sandbox attestation to the hook",
		});
	});
});
