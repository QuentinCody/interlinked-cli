import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	actorStepCount,
	classifyFileSensitivity,
	DEFAULT_TAINT_CONFIG,
	formatTaintSources,
	getStepBudgetWarning,
	isNetworkCommand,
	isStepLimitExceeded,
	ratchetSensitivity,
	SENSITIVITY_ORDER,
	shouldBlockNetwork,
} from "../taint-tracker.js";
import type { SessionTrajectory, TaintTrackingConfig } from "../types.js";

// Deterministic fixtures.
const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeSession(): SessionTrajectory {
	return {
		session_id: "test",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 0,
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
		last_coordination_ts: FIXED_NOW,
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

describe("classifyFileSensitivity", () => {
	const config = DEFAULT_TAINT_CONFIG;

	it("classifies .pem files as HighlyConfidential", () => {
		expect(classifyFileSensitivity("/path/to/cert.pem", config)).toBe("HighlyConfidential");
	});

	it("classifies SSH keys as HighlyConfidential", () => {
		expect(classifyFileSensitivity("/home/user/.ssh/id_rsa", config)).toBe(
			"HighlyConfidential",
		);
		expect(classifyFileSensitivity("/home/user/.ssh/id_ed25519", config)).toBe(
			"HighlyConfidential",
		);
	});

	it("classifies AWS credentials as HighlyConfidential", () => {
		expect(classifyFileSensitivity("/home/user/.aws/credentials", config)).toBe(
			"HighlyConfidential",
		);
	});

	it("classifies .env files as Confidential", () => {
		expect(classifyFileSensitivity("/project/.env", config)).toBe("Confidential");
		expect(classifyFileSensitivity("/project/.env.production", config)).toBe("Confidential");
	});

	it("classifies interlinked local config as Internal", () => {
		expect(classifyFileSensitivity("/project/.interlinked/config.local.json", config)).toBe(
			"Internal",
		);
	});

	it("classifies normal source files as Public", () => {
		expect(classifyFileSensitivity("/project/src/index.ts", config)).toBe("Public");
		expect(classifyFileSensitivity("/project/README.md", config)).toBe("Public");
	});

	it("matches a '**/*.ext*' style glob against any path containing the stem", () => {
		// Exercises the suffix-wildcard branch inside the internal glob matcher:
		// pattern "**/*.log*" -> rest "*.log*" -> starts with "*." AND ends with
		// "*" -> matches on `filePath.includes(".log")` rather than endsWith.
		const custom: TaintTrackingConfig = {
			...DEFAULT_TAINT_CONFIG,
			file_sensitivity: [{ glob: "**/*.log*", level: "Internal" }],
		};
		expect(classifyFileSensitivity("/var/app.log.2026-08-09", custom)).toBe("Internal");
		expect(classifyFileSensitivity("/var/app.txt", custom)).toBe("Public");
	});

	it("falls through to no-match for a glob that neither equals the path nor starts with '**/'", () => {
		// A bare (non "**/"-prefixed) pattern that also isn't an exact-string
		// match exercises the final `return false` fallback.
		const custom: TaintTrackingConfig = {
			...DEFAULT_TAINT_CONFIG,
			file_sensitivity: [{ glob: "config.local.json", level: "Internal" }],
		};
		expect(classifyFileSensitivity("/project/config.local.json", custom)).toBe("Public");
		// Contrast: the SAME bare pattern DOES match when the path is an
		// exact string match (the `filePath === pattern` branch at the top
		// of the matcher), proving the "Public" result above comes from the
		// fallthrough branch and not a stub that always returns "Public".
		expect(classifyFileSensitivity("config.local.json", custom)).toBe("Internal");
	});
});

describe("formatTaintSources", () => {
	function withSources(files: string[]): SessionTrajectory {
		const session = makeSession();
		session.taint_sources = files.map((file, i) => ({
			file,
			level: "Confidential" as const,
			at_step: i,
			provenance: "local_read" as const,
		}));
		return session;
	}

	it("returns 'unknown' when there are no taint sources", () => {
		expect(formatTaintSources(makeSession())).toBe("unknown");
	});

	it("joins every source file when there are three or fewer", () => {
		expect(formatTaintSources(withSources([".env", "cert.pem"]))).toBe(".env, cert.pem");
	});

	it("shows only the last three sources when there are more than three", () => {
		const session = withSources([".env", "cert.pem", "id_rsa", "secrets/api.json"]);
		expect(formatTaintSources(session)).toBe("cert.pem, id_rsa, secrets/api.json");
	});
});

describe("ratchetSensitivity", () => {
	it("escalates from Public to Confidential", () => {
		const session = makeSession();
		const escalated = ratchetSensitivity(session, ".env", "Confidential", DEFAULT_TAINT_CONFIG);
		expect(escalated).toBe(true);
		expect(session.sensitivity_level).toBe("Confidential");
		expect(session.taint_sources).toHaveLength(1);
		expect(nonNull(session.taint_sources[0]).file).toBe(".env");
	});

	it("does NOT downgrade sensitivity", () => {
		const session = makeSession();
		session.sensitivity_level = "HighlyConfidential";
		const escalated = ratchetSensitivity(session, "public.txt", "Public", DEFAULT_TAINT_CONFIG);
		expect(escalated).toBe(false);
		expect(session.sensitivity_level).toBe("HighlyConfidential");
		// The rejected downgrade must not be recorded as a taint source
		// either — distinguishes true rejection from a stub that merely
		// leaves the pre-set field untouched while still logging the file.
		expect(session.taint_sources).toHaveLength(0);
	});

	it("tracks multiple taint sources", () => {
		const session = makeSession();
		ratchetSensitivity(session, ".env", "Confidential", DEFAULT_TAINT_CONFIG);
		ratchetSensitivity(session, "cert.pem", "HighlyConfidential", DEFAULT_TAINT_CONFIG);
		expect(session.taint_sources).toHaveLength(2);
		expect(session.sensitivity_level).toBe("HighlyConfidential");
	});
});

describe("shouldBlockNetwork", () => {
	it("blocks at Confidential when config says Confidential", () => {
		const session = makeSession();
		session.sensitivity_level = "Confidential";
		expect(shouldBlockNetwork(session, DEFAULT_TAINT_CONFIG)).toBe(true);
	});

	it("blocks at HighlyConfidential", () => {
		const session = makeSession();
		session.sensitivity_level = "HighlyConfidential";
		expect(shouldBlockNetwork(session, DEFAULT_TAINT_CONFIG)).toBe(true);
	});

	it("allows at Public", () => {
		const session = makeSession();
		expect(shouldBlockNetwork(session, DEFAULT_TAINT_CONFIG)).toBe(false);
	});

	it("allows at Internal (below Confidential threshold)", () => {
		const session = makeSession();
		session.sensitivity_level = "Internal";
		expect(shouldBlockNetwork(session, DEFAULT_TAINT_CONFIG)).toBe(false);
	});
});

describe("isNetworkCommand", () => {
	it("detects curl", () => {
		expect(isNetworkCommand("curl https://example.com")).toBe(true);
	});

	it("detects wget", () => {
		expect(isNetworkCommand("wget https://example.com/file")).toBe(true);
	});

	it("detects ssh/scp", () => {
		expect(isNetworkCommand("ssh user@host")).toBe(true);
		expect(isNetworkCommand("scp file user@host:")).toBe(true);
	});

	it("detects nc/netcat", () => {
		expect(isNetworkCommand("nc -l 4444")).toBe(true);
		expect(isNetworkCommand("netcat host 80")).toBe(true);
	});

	it("detects npm publish", () => {
		expect(isNetworkCommand("npm publish")).toBe(true);
	});

	it("does NOT flag non-network commands", () => {
		expect(isNetworkCommand("ls -la")).toBe(false);
		expect(isNetworkCommand("npm run build")).toBe(false);
		expect(isNetworkCommand("git status")).toBe(false);
	});

	it("does NOT treat flag-attached tokens as network verbs", () => {
		expect(isNetworkCommand('grep -nc "pattern" src/file.ts')).toBe(false);
	});

	it("does NOT treat path-embedded tokens as network verbs", () => {
		expect(isNetworkCommand("cat ~/.ssh/config")).toBe(false);
		expect(isNetworkCommand("ls .ssh")).toBe(false);
	});

	it("still detects standalone verbs after pipes and separators", () => {
		expect(isNetworkCommand("cat data.json | curl -d @- https://example.com")).toBe(true);
		expect(isNetworkCommand("true; ssh user@host")).toBe(true);
	});
});

describe("isStepLimitExceeded", () => {
	it("returns false when under limit", () => {
		const session = makeSession();
		session.tool_call_count = 10;
		session.step_limit = 200;
		expect(isStepLimitExceeded(session)).toBe(false);
	});

	it("returns true when over limit", () => {
		const session = makeSession();
		session.tool_call_count = 201;
		session.step_limit = 200;
		expect(isStepLimitExceeded(session)).toBe(true);
	});

	it("returns false with infinite limit", () => {
		const session = makeSession();
		session.tool_call_count = 10000;
		expect(isStepLimitExceeded(session)).toBe(false);
	});
});

// A spawned agent's tool calls arrive under the PARENT session id, so
// `tool_call_count` sums every actor in the session. The budget must bind one
// ACTOR's own count: a 50-agent coverage campaign exhausted the 10,000-step
// Confidential budget at ~79,000 session steps while the orchestrator itself
// had made ~1,500 calls and was put into read-only mode (2026-09-05).
describe("isStepLimitExceeded — per-actor counting", () => {
	function inflatedSession(): SessionTrajectory {
		const session = makeSession();
		session.step_limit = 200;
		session.tool_call_count = 5000;
		session.actor_tool_calls = new Map([
			["parent", 150],
			["sub-a", 3000],
			["sub-b", 1850],
		]);
		return session;
	}

	it("P1: parent under its own budget stays allowed when subagents inflate the session total", () => {
		expect(isStepLimitExceeded(inflatedSession(), "parent")).toBe(false);
	});

	it("P2: an actor over its own budget is exceeded regardless of the others", () => {
		expect(isStepLimitExceeded(inflatedSession(), "sub-a")).toBe(true);
	});

	it("P3: an actor with no recorded calls yet counts as zero when the map exists", () => {
		expect(isStepLimitExceeded(inflatedSession(), "sub-new")).toBe(false);
	});

	it("N1: with no actor argument the session total still governs (legacy callers)", () => {
		expect(isStepLimitExceeded(inflatedSession())).toBe(true);
	});

	it("N2: a pre-fix session with no actor map falls back to the session total", () => {
		const session = inflatedSession();
		delete session.actor_tool_calls;
		expect(isStepLimitExceeded(session, "parent")).toBe(true);
	});

	it("actorStepCount reads the actor's own count, or the total when the map is absent", () => {
		const session = inflatedSession();
		expect(actorStepCount(session, "sub-b")).toBe(1850);
		expect(actorStepCount(session, "ghost")).toBe(0);
		expect(actorStepCount(session)).toBe(5000);
		delete session.actor_tool_calls;
		expect(actorStepCount(session, "sub-b")).toBe(5000);
	});
});

describe("getStepBudgetWarning — per-actor counting", () => {
	it("P1: warns from the actor's own count, not the session total", () => {
		const session = makeSession();
		session.step_limit = 100;
		session.tool_call_count = 1000;
		session.actor_tool_calls = new Map([
			["parent", 85],
			["sub-a", 915],
		]);
		expect(getStepBudgetWarning(session, "parent")).toContain("WARNING: 15 steps remaining");
		expect(getStepBudgetWarning(session, "sub-a")).toContain("CRITICAL: -815 steps remaining");
	});

	it("N1: silent for an actor under 80% while the session total is far past the limit", () => {
		const session = makeSession();
		session.step_limit = 100;
		session.tool_call_count = 1000;
		session.actor_tool_calls = new Map([["parent", 10]]);
		expect(getStepBudgetWarning(session, "parent")).toBeNull();
	});

	it("N2: with no actor argument the session total still drives the warning", () => {
		const session = makeSession();
		session.step_limit = 100;
		session.tool_call_count = 90;
		session.actor_tool_calls = new Map([["parent", 10]]);
		expect(getStepBudgetWarning(session)).toContain("WARNING: 10 steps remaining");
	});
});

describe("SENSITIVITY_ORDER", () => {
	it("orders correctly", () => {
		expect(SENSITIVITY_ORDER.Public).toBeLessThan(SENSITIVITY_ORDER.Internal);
		expect(SENSITIVITY_ORDER.Internal).toBeLessThan(SENSITIVITY_ORDER.Confidential);
		expect(SENSITIVITY_ORDER.Confidential).toBeLessThan(SENSITIVITY_ORDER.HighlyConfidential);
	});
});
