// Behavioral coverage for the Policy Classifier — the LLM-based escalation
// layer for ambiguous PreToolUse cases (shadow mode v1).
//
// Every module boundary that does real I/O is mocked: `node:fs` (config /
// policies / shadow-log reads+writes), `node:child_process` (the `claude` CLI
// subprocess), and `fetch` (the HTTP inference providers). `node:crypto` is
// left real — `hashEvidence` is deterministic over a fixed input. No real
// network, no real subprocess, no real disk writes.
//
// The tests assert real classifications/decisions and walk every branch in
// each export, with particular attention to `classifyAction`'s high
// cyclomatic complexity (every tool-name path + every command-regex path +
// the empty-command and fallback cases).

import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";

// ---------------------------------------------------------------------------
// node:fs mock — resolveApiKey / loadPolicies read; appendShadowLog writes.
// ---------------------------------------------------------------------------
const fsMock = vi.hoisted(() => ({
	existsSync: vi.fn<(p: string) => boolean>(),
	readFileSync: vi.fn<(p: string, enc?: string) => string>(),
	appendFileSync: vi.fn<(p: string, data: string) => void>(),
	mkdirSync: vi.fn<(p: string, opts?: unknown) => void>(),
}));
vi.mock("node:fs", () => fsMock);

// ---------------------------------------------------------------------------
// node:child_process mock — callViaClaudeCode spawns the `claude` CLI.
// The fake child is an EventEmitter with a `stdout`/`stderr` sub-emitter;
// each test drives the close/error lifecycle by hand.
// ---------------------------------------------------------------------------
class FakeChild extends EventEmitter {
	public stdout = new EventEmitter();
	public stderr = new EventEmitter();
}

const spawnMock = vi.hoisted(() => ({
	spawn: vi.fn(),
}));
vi.mock("node:child_process", () => spawnMock);

// Imported AFTER the mocks above are registered (vi.mock is hoisted).
import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import {
	appendShadowLog,
	buildEvidenceEnvelope,
	CLASSIFIER_SYSTEM_PROMPT,
	type ClassifierSessionState,
	callClassifier,
	createClassifierSessionState,
	hashEvidence,
	resolveApiKey,
	type ShadowLogEntry,
} from "./policy-classifier.js";
import type {
	ClassifierConfig,
	EscalationRequest,
	HarnessEvent,
	PolicyClassification,
	PolicyEvidence,
	SessionTrajectory,
} from "./types.js";

// ===========================================
// fetch stubbing
// ===========================================

type FetchImpl = (url: string, init?: RequestInit) => Response | Promise<Response>;
let fetchSpy: MockInstance;

function stubFetch(impl: FetchImpl): void {
	fetchSpy = vi.fn(((input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		return Promise.resolve(impl(url, init));
	}) as typeof fetch) as unknown as MockInstance;
	vi.stubGlobal("fetch", fetchSpy);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// ===========================================
// Fixtures
// ===========================================

/** Minimal classifier config; spread overrides on top. */
function makeConfig(overrides: Partial<ClassifierConfig> = {}): ClassifierConfig {
	return {
		enabled: true,
		mode: "shadow",
		provider: "openai_compatible",
		endpoint: "https://api.example.test/v1/chat/completions",
		api_key_env: "TEST_CLASSIFIER_KEY",
		model: "llama-3.1-8b",
		timeout_ms: 3000,
		max_input_tokens: 800,
		confidence_threshold: 0.8,
		max_calls_per_session: 50,
		...overrides,
	};
}

/** Minimal session trajectory — only the fields buildEvidenceEnvelope reads. */
function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "sess-1",
		agent_name: "agent-a",
		started_at: "2026-06-06T00:00:00Z",
		tool_call_count: 5,
		error_count: 1,
		files_read: new Set<string>(),
		files_written: new Set<string>(["a.ts", "b.ts"]),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: ["Read:x.ts", "Edit:y.ts"],
		sensitivity_level: "Internal",
		taint_sources: [],
		step_limit: 100,
		consecutive_pattern: null,
		suggested_permissions: new Set<string>(),
		acknowledged_checks: new Set<string>(),
		fired_reminders: new Set<string>(),
		soft_blocks: new Set<string>(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: 0,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set<string>(),
		bloat_warned: new Set<string>(),
		assertion_counts: new Map(),
		...overrides,
	};
}

function makeEscalation(overrides: Partial<EscalationRequest> = {}): EscalationRequest {
	return {
		trigger: "external_url",
		summary: "curl to external host",
		tool_name: "Bash",
		tool_input_redacted: {},
		sensitivity_level: "Internal",
		step_number: 5,
		recent_tool_sequence: [],
		...overrides,
	};
}

function makeEvidence(overrides: Partial<PolicyEvidence> = {}): PolicyEvidence {
	return {
		tool: "Bash",
		action_class: "curl_external",
		target_summary: "curl to external URL (non-localhost)",
		trigger: "external_url",
		trigger_reason: "curl to external host",
		session_sensitivity: "Internal",
		step_number: 5,
		taint_source_count: 0,
		taint_source_levels: [],
		recent_actions: [],
		agent_role: "worker",
		files_written_count: 2,
		errors_this_session: 1,
		injection_detected_in_session: false,
		policies: [],
		...overrides,
	};
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	fsMock.existsSync.mockReset();
	fsMock.readFileSync.mockReset();
	fsMock.appendFileSync.mockReset();
	fsMock.mkdirSync.mockReset();
	spawnMock.spawn.mockReset();
	// Default: no policies.json on disk → the default-policy path is exercised
	// unless a test overrides existsSync. Tests that need a policies.json (or a
	// present .interlinked dir) re-mock existsSync after this default.
	fsMock.existsSync.mockReturnValue(false);
	// Default: no env keys leak in from the host.
	delete process.env.TEST_CLASSIFIER_KEY;
	delete process.env.test_classifier_key;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	// Restore env to pristine snapshot.
	for (const k of Object.keys(process.env)) {
		if (!(k in ORIGINAL_ENV)) delete process.env[k];
	}
	Object.assign(process.env, ORIGINAL_ENV);
});

// ===========================================
// resolveApiKey
// ===========================================

describe("resolveApiKey", () => {
	it("returns undefined for an empty env var name (short-circuit)", () => {
		expect(resolveApiKey("")).toBeUndefined();
		// Empty name must never reach the fs fallback.
		expect(fsMock.readFileSync).not.toHaveBeenCalled();
	});

	it("returns the value from process.env when present", () => {
		process.env.TEST_CLASSIFIER_KEY = "env-secret";
		expect(resolveApiKey("TEST_CLASSIFIER_KEY")).toBe("env-secret");
		// Env hit short-circuits before touching config.local.json.
		expect(fsMock.readFileSync).not.toHaveBeenCalled();
	});

	it("falls back to config.local.json under the exact key", () => {
		fsMock.readFileSync.mockReturnValue(JSON.stringify({ TEST_CLASSIFIER_KEY: "file-secret" }));
		expect(resolveApiKey("TEST_CLASSIFIER_KEY")).toBe("file-secret");
		expect(fsMock.readFileSync).toHaveBeenCalledTimes(1);
	});

	it("falls back to the lowercased key in config.local.json", () => {
		fsMock.readFileSync.mockReturnValue(JSON.stringify({ test_classifier_key: "lower-secret" }));
		expect(resolveApiKey("TEST_CLASSIFIER_KEY")).toBe("lower-secret");
	});

	it("returns undefined when the key is absent in config (|| undefined branch)", () => {
		fsMock.readFileSync.mockReturnValue(JSON.stringify({ unrelated: "x" }));
		expect(resolveApiKey("TEST_CLASSIFIER_KEY")).toBeUndefined();
	});

	it("returns undefined when config.local.json cannot be read (catch)", () => {
		fsMock.readFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(resolveApiKey("TEST_CLASSIFIER_KEY")).toBeUndefined();
	});

	it("returns undefined when config.local.json is invalid JSON (catch)", () => {
		fsMock.readFileSync.mockReturnValue("{not json");
		expect(resolveApiKey("TEST_CLASSIFIER_KEY")).toBeUndefined();
	});

	// test-contract: public-api — the fallback path is documented in the file
	// header ("2. .interlinked/config.local.json") as part of resolveApiKey's
	// contract; every case above mocks readFileSync's RETURN value only, so a
	// wrong path segment or dropped encoding argument passes every one of them
	// silently (readFileSync ignores its own arguments once mocked).
	it("reads config.local.json from <cwd>/.interlinked with utf-8 encoding (exact call args)", () => {
		fsMock.readFileSync.mockReturnValue(JSON.stringify({ TEST_CLASSIFIER_KEY: "file-secret" }));
		resolveApiKey("TEST_CLASSIFIER_KEY");
		expect(fsMock.readFileSync).toHaveBeenCalledWith(
			join(process.cwd(), ".interlinked", "config.local.json"),
			"utf-8",
		);
	});
});

// ===========================================
// createClassifierSessionState
// ===========================================

describe("createClassifierSessionState", () => {
	it("initializes both counters to zero", () => {
		expect(createClassifierSessionState()).toEqual({
			calls_this_session: 0,
			consecutive_failures: 0,
		});
	});
});

// ===========================================
// CLASSIFIER_SYSTEM_PROMPT
// ===========================================

describe("CLASSIFIER_SYSTEM_PROMPT", () => {
	it("is the fixed JSON-only security classifier prompt", () => {
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("security policy classifier");
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"compliant"');
		expect(CLASSIFIER_SYSTEM_PROMPT).toContain("insufficient evidence");
	});
});

// ===========================================
// buildEvidenceEnvelope + classifyAction + buildTargetSummary
// (classifyAction/buildTargetSummary are private — exercised through the
//  public envelope builder via action_class / target_summary)
// ===========================================

/** Convenience: run the envelope builder for a single tool/input and return it. */
function envFor(
	toolName: string,
	toolInput: JsonObject,
	opts: {
		session?: Partial<SessionTrajectory>;
		escalation?: Partial<EscalationRequest>;
		intent?: { goal?: string; file_patterns?: string[] };
		event?: Partial<HarnessEvent>;
	} = {},
): PolicyEvidence {
	const event: HarnessEvent = {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: toolName,
		tool_input: toolInput,
		timestamp: "2026-06-06T00:00:00Z",
		...opts.event,
	};
	// existsSync defaults to false in beforeEach (→ default-policy path); a test
	// that needs policies.json overrides existsSync before calling envFor.
	return buildEvidenceEnvelope(
		event,
		makeSession(opts.session),
		makeEscalation(opts.escalation),
		opts.intent,
	);
}

describe("classifyAction (via buildEvidenceEnvelope.action_class)", () => {
	it.each([
		["Write", "file_write"],
		["WriteFile", "file_write"],
		["write_file", "file_write"],
		["create", "file_write"],
		["Edit", "file_edit"],
		["EditFile", "file_edit"],
		["edit_file", "file_edit"],
		["str_replace", "file_edit"],
		["Read", "file_read"],
		["ReadFile", "file_read"],
		["read_file", "file_read"],
		["view", "file_read"],
		["Glob", "file_search"],
		["Grep", "file_search"],
	])("classifies tool %s as %s", (tool, expected) => {
		expect(envFor(tool, {}).action_class).toBe(expected);
	});

	it("returns 'unknown' for an unrecognized tool with no command", () => {
		expect(envFor("MysteryTool", {}).action_class).toBe("unknown");
	});

	it.each([
		["curl https://example.com/data", "curl_external"],
		["wget https://example.com/x", "curl_external"],
		["curl http://localhost:8080/x", "curl_localhost"],
		["wget http://127.0.0.1:3000", "curl_localhost"],
		["ssh user@host", "network_ssh"],
		["scp f host:/x", "network_ssh"],
		["sftp host", "network_ssh"],
		["rsync -a a b", "network_ssh"],
		["nc -l 9000", "network_raw"],
		["ncat host 80", "network_raw"],
		["netcat host 80", "network_raw"],
		["socat - TCP:host:80", "network_raw"],
		["telnet host 23", "network_raw"],
		["npm publish", "npm_publish"],
		["git push origin main", "git_network"],
		["git pull", "git_network"],
		["git fetch --all", "git_network"],
		["git clone https://x/y", "git_network"],
		["git commit -m x", "git_local"],
		["git add .", "git_local"],
		["git stash", "git_local"],
		["git reset --hard", "git_local"],
		["git checkout main", "git_local"],
		["git rebase main", "git_local"],
		["git merge feature", "git_local"],
		["npm test", "npm_test"],
		["npm run build", "npm_test"],
		["npx vitest run", "npm_test"],
		["npx jest", "npm_test"],
		["npx mocha", "npm_test"],
		["npm install lodash", "npm_install"],
		["npm ci", "npm_install"],
		["yarn add x", "npm_install"],
		["pnpm install", "npm_install"],
		["tsc --noEmit", "lint_typecheck"],
		["biome check .", "lint_typecheck"],
		["eslint src", "lint_typecheck"],
		["prettier -w .", "lint_typecheck"],
		["make build", "build"],
		["cargo build", "build"],
		["go build ./...", "build"],
		["gcc main.c", "build"],
		["rm file.txt", "file_delete"],
		["chmod 755 x", "file_permissions"],
		["chown me x", "file_permissions"],
		["cat file", "file_read_cmd"],
		["head -n 5 file", "file_read_cmd"],
		["tail -f log", "file_read_cmd"],
		["less file", "file_read_cmd"],
		["more file", "file_read_cmd"],
		["wc -l file", "file_read_cmd"],
		["mkdir dir", "file_manage"],
		["touch x", "file_manage"],
		["cp a b", "file_manage"],
		["mv a b", "file_manage"],
		["ls -la", "file_list"],
		["find . -name x", "file_list"],
		["fd pattern", "file_list"],
		["echo hello && some_unknown_binary", "bash_other"],
	])("classifies command %j as %s", (cmd, expected) => {
		expect(envFor("Bash", { command: cmd }).action_class).toBe(expected);
	});

	// test-contract: boundary — the `\s+` in each of these 7 regexes only differs
	// from a single `\s` when a command has TWO OR MORE whitespace characters
	// between the matched words; every single-space fixture above is silently
	// blind to that boundary. Real commands legitimately carry extra whitespace
	// (copy-pasted, generated, or hand-aligned), so this is a real input class,
	// not a synthetic one.
	it.each([
		["npm  publish", "npm_publish"],
		["git  push origin", "git_network"],
		["git  commit -m x", "git_local"],
		["npm  test", "npm_test"],
		["npx  vitest run", "npm_test"],
		["npm  install", "npm_install"],
		["go  build ./...", "build"],
	])("classifies double-spaced command %j as %s (\\s+ vs \\s boundary)", (cmd, expected) => {
		expect(envFor("Bash", { command: cmd }).action_class).toBe(expected);
	});

	it("treats a non-string command via String() coercion (numeric stays falsy-safe)", () => {
		// command is a number → String(123) = "123" → no regex matches → bash_other
		expect(envFor("Bash", { command: 123 }).action_class).toBe("bash_other");
	});

	it("returns 'unknown' when the Bash command is an empty string", () => {
		expect(envFor("Bash", { command: "" }).action_class).toBe("unknown");
	});

	it("classifies 'g++' followed by whitespace as bash_other (trailing-\\b regex quirk)", () => {
		// The build regex ends `g\+\+\b`; `+` is a non-word char, so the trailing
		// `\b` cannot match when the next char is also non-word (a space). This
		// pins the real (quirky) source behavior: `g++ main.cpp` → bash_other.
		expect(envFor("Bash", { command: "g++ main.cpp" }).action_class).toBe("bash_other");
	});
});

describe("buildTargetSummary (via buildEvidenceEnvelope.target_summary)", () => {
	it("uses file_path when present", () => {
		expect(envFor("Write", { file_path: "src/x.ts" }).target_summary).toBe("file: src/x.ts");
	});

	it("falls back to the `path` key when file_path is absent", () => {
		expect(envFor("Read", { path: "src/y.ts" }).target_summary).toBe("file: src/y.ts");
	});

	it("returns the tool name when there is no file and no command", () => {
		expect(envFor("MysteryTool", {}).target_summary).toBe("MysteryTool");
	});

	it("redacts a curl-to-localhost target", () => {
		expect(envFor("Bash", { command: "curl http://localhost:8080/x" }).target_summary).toBe(
			"curl to localhost",
		);
	});

	it("redacts a curl-to-external target without revealing the URL", () => {
		const summary = envFor("Bash", { command: "curl https://evil.example.com/x" }).target_summary;
		expect(summary).toBe("curl to external URL (non-localhost)");
		expect(summary).not.toContain("evil.example.com");
	});

	it("falls back to the action class for a non-curl command", () => {
		expect(envFor("Bash", { command: "git push origin main" }).target_summary).toBe("git_network");
	});
});

describe("buildEvidenceEnvelope (aggregation + optional fields)", () => {
	it("aggregates session context without leaking raw content", () => {
		const ev = envFor(
			"Bash",
			{ command: "curl https://x.test/y" },
			{
				session: {
					sensitivity_level: "Confidential",
					tool_call_count: 9,
					error_count: 2,
					files_written: new Set(["a", "b", "c"]),
					tool_sequence: Array.from({ length: 15 }, (_, i) => `Edit:f${i}.ts`),
					taint_sources: [
						{ level: "Internal", file: "s.ts", at_step: 1, provenance: "local_read" },
						{ level: "Confidential", file: "t.ts", at_step: 2, provenance: "document_content" },
					],
				},
				event: { agent_role: "lead" },
			},
		);
		expect(ev.session_sensitivity).toBe("Confidential");
		expect(ev.step_number).toBe(9);
		expect(ev.errors_this_session).toBe(2);
		expect(ev.files_written_count).toBe(3);
		expect(ev.taint_source_count).toBe(2);
		expect(ev.taint_source_levels).toEqual(["Internal", "Confidential"]);
		// recent_actions is the LAST 10 of tool_sequence.
		expect(ev.recent_actions).toHaveLength(10);
		expect(ev.recent_actions[0]).toBe("Edit:f5.ts");
		expect(ev.agent_role).toBe("lead");
	});

	it("defaults agent_role to 'unknown' when the event omits it", () => {
		expect(envFor("Read", { file_path: "x.ts" }).agent_role).toBe("unknown");
	});

	it("defaults tool/tool_input to empties when the event omits them", () => {
		fsMock.existsSync.mockReturnValue(false);
		const event = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			timestamp: "2026-06-06T00:00:00Z",
		} as HarnessEvent;
		const ev = buildEvidenceEnvelope(event, makeSession(), makeEscalation());
		expect(ev.tool).toBe("");
		// No tool name, no command → classifyAction returns "unknown".
		expect(ev.action_class).toBe("unknown");
	});

	it("passes through intent goal + file patterns when provided", () => {
		const ev = envFor(
			"Edit",
			{ file_path: "x.ts" },
			{ intent: { goal: "refactor auth", file_patterns: ["src/auth/**"] } },
		);
		expect(ev.intent_goal).toBe("refactor auth");
		expect(ev.intent_file_patterns).toEqual(["src/auth/**"]);
	});

	it("omits intent fields when no intent state is given (exactOptional)", () => {
		const ev = envFor("Edit", { file_path: "x.ts" });
		expect(ev.intent_goal).toBeUndefined();
		expect(ev.intent_file_patterns).toBeUndefined();
	});

	it("reports no injection when injection_detected_steps is empty", () => {
		const ev = envFor("Bash", { command: "rm x" }, { session: { injection_detected_steps: [] } });
		expect(ev.injection_detected_in_session).toBe(false);
		expect(ev.steps_since_injection).toBeUndefined();
	});

	it("treats a session with an empty injection_detected_steps as no-injection", () => {
		fsMock.existsSync.mockReturnValue(false);
		// `injection_detected_steps` is a required field on SessionTrajectory,
		// always normalized to [] (never missing) by both fresh-session
		// creation and snapshot restore (readNumberArray) — the realistic
		// "no injection recorded" state is an empty array, not an absent key.
		const session = makeSession({ injection_detected_steps: [] });
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Bash",
			tool_input: { command: "rm x" },
			timestamp: "2026-06-06T00:00:00Z",
		};
		const ev = buildEvidenceEnvelope(event, session, makeEscalation());
		expect(ev.injection_detected_in_session).toBe(false);
		expect(ev.steps_since_injection).toBeUndefined();
	});

	it("computes steps_since_injection from the latest injection step", () => {
		const ev = envFor(
			"Bash",
			{ command: "rm x" },
			{ session: { tool_call_count: 12, injection_detected_steps: [3, 7] } },
		);
		expect(ev.injection_detected_in_session).toBe(true);
		// 12 - 7 (last injection) = 5
		expect(ev.steps_since_injection).toBe(5);
	});
});

// ===========================================
// loadPolicies + getDefaultPolicies (via buildEvidenceEnvelope.policies)
// ===========================================

describe("loadPolicies / getDefaultPolicies (via envelope.policies)", () => {
	it("returns default policies matching the trigger when no policies.json exists", () => {
		fsMock.existsSync.mockReturnValue(false);
		const ev = envFor("Bash", { command: "curl https://x" }, { escalation: { trigger: "external_url" } });
		const ids = ev.policies.map((p) => p.id);
		expect(ids).toContain("no_exfil_after_taint");
		// step_budget / post_injection defaults do NOT apply to external_url.
		expect(ids).not.toContain("step_budget_justification");
		expect(ids).not.toContain("post_injection_compliance");
	});

	it("returns the post-injection default policy for the post_injection_action trigger", () => {
		fsMock.existsSync.mockReturnValue(false);
		const ev = envFor("Bash", { command: "rm x" }, { escalation: { trigger: "post_injection_action" } });
		expect(ev.policies.map((p) => p.id)).toEqual(["post_injection_compliance"]);
	});

	it("returns the step-budget default policy for the high_step_budget trigger", () => {
		fsMock.existsSync.mockReturnValue(false);
		const ev = envFor("Read", { file_path: "x" }, { escalation: { trigger: "high_step_budget" } });
		expect(ev.policies.map((p) => p.id)).toEqual(["step_budget_justification"]);
	});

	it("returns no default policies for an unmatched trigger", () => {
		fsMock.existsSync.mockReturnValue(false);
		const ev = envFor("Read", { file_path: "x" }, { escalation: { trigger: "nonexistent_trigger" } });
		expect(ev.policies).toEqual([]);
	});

	it("loads + filters policies.json: trigger match and wildcard '*' both included", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockReturnValue(
			JSON.stringify({
				policies: [
					{ id: "p_match", name: "m", description: "d", applies_to_triggers: ["external_url"] },
					{ id: "p_wild", name: "w", description: "d", applies_to_triggers: ["*"] },
					{ id: "p_other", name: "o", description: "d", applies_to_triggers: ["unrelated"] },
				],
			}),
		);
		const ev = envFor("Bash", { command: "curl https://x" }, { escalation: { trigger: "external_url" } });
		const ids = ev.policies.map((p) => p.id);
		expect(ids).toContain("p_match");
		expect(ids).toContain("p_wild");
		expect(ids).not.toContain("p_other");
	});

	it("falls back to defaults when policies.json lacks a policies array", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockReturnValue(JSON.stringify({ notPolicies: 1 }));
		const ev = envFor("Bash", { command: "curl https://x" }, { escalation: { trigger: "external_url" } });
		expect(ev.policies.map((p) => p.id)).toContain("no_exfil_after_taint");
	});

	it("falls back to defaults when policies.json is unreadable (catch)", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockImplementation(() => {
			throw new Error("EACCES");
		});
		const ev = envFor("Bash", { command: "curl https://x" }, { escalation: { trigger: "external_url" } });
		expect(ev.policies.map((p) => p.id)).toContain("no_exfil_after_taint");
	});

	it("falls back to defaults when policies.json is invalid JSON (catch)", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockReturnValue("{bad json");
		const ev = envFor("Bash", { command: "curl https://x" }, { escalation: { trigger: "external_url" } });
		expect(ev.policies.map((p) => p.id)).toContain("no_exfil_after_taint");
	});

	// `loadPolicies` now validates each policy entry (id/name/description as
	// strings, applies_to_triggers as a string array) instead of trusting an
	// `as PolicyRule[]` cast. A malformed entry falls the WHOLE file back to
	// defaults — same all-or-nothing philosophy the file already applies to a
	// missing `policies` array or invalid JSON, and safer than silently
	// mixing a partially-garbled custom entry into the evidence sent to the
	// LLM classifier.
	it("N1: a policy entry with a non-array applies_to_triggers falls back to defaults", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockReturnValue(
			JSON.stringify({
				policies: [{ id: "p_bad", name: "n", description: "d", applies_to_triggers: "external_url" }],
			}),
		);
		const ev = envFor("Bash", { command: "curl https://x" }, { escalation: { trigger: "external_url" } });
		const ids = ev.policies.map((p) => p.id);
		expect(ids).not.toContain("p_bad");
		expect(ids).toContain("no_exfil_after_taint");
	});

	it("N2: a policy entry missing a required string field falls back to defaults", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockReturnValue(
			JSON.stringify({
				policies: [{ id: "p_bad", applies_to_triggers: ["external_url"] }],
			}),
		);
		const ev = envFor("Bash", { command: "curl https://x" }, { escalation: { trigger: "external_url" } });
		const ids = ev.policies.map((p) => p.id);
		expect(ids).not.toContain("p_bad");
		expect(ids).toContain("no_exfil_after_taint");
	});

	it("P1: a policy entry with a valid applies_to_roles array passes through unchanged", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.readFileSync.mockReturnValue(
			JSON.stringify({
				policies: [
					{
						id: "p_roles",
						name: "n",
						description: "d",
						applies_to_triggers: ["external_url"],
						applies_to_roles: ["worker", "subagent"],
					},
				],
			}),
		);
		const ev = envFor("Bash", { command: "curl https://x" }, { escalation: { trigger: "external_url" } });
		const found = ev.policies.find((p) => p.id === "p_roles");
		expect(found?.applies_to_roles).toEqual(["worker", "subagent"]);
	});
});

// ===========================================
// callClassifier — routing + truncation
// ===========================================

describe("callClassifier", () => {
	it("increments calls_this_session on every call", async () => {
		const state = createClassifierSessionState();
		// No API key configured for a non-claude_code provider → fail-open allow.
		await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(state.calls_this_session).toBe(1);
		await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(state.calls_this_session).toBe(2);
	});

	it("returns 'No API key configured' for an HTTP provider with no key", async () => {
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(result).toEqual({
			label: "allow",
			confidence: 0,
			reasoning: "No API key configured",
		});
		// Never reaches the network when the key is missing.
		expect(fetchSpy).toBeUndefined();
	});

	it("routes to the claude_code subprocess path when provider is claude_code", async () => {
		const child = new FakeChild();
		spawnMock.spawn.mockReturnValue(child);
		const state = createClassifierSessionState();
		const promise = callClassifier(
			makeEvidence(),
			makeConfig({ provider: "claude_code" }),
			state,
		);
		// Drive the subprocess to a successful close.
		child.stdout.emit(
			"data",
			Buffer.from(JSON.stringify({ structured_output: { compliant: true, confidence: 0.9, reasoning: "ok" } })),
		);
		child.emit("close", 0);
		const result = await promise;
		expect(result.label).toBe("allow");
		expect(spawnMock.spawn).toHaveBeenCalledOnce();
		// claude_code path never touches the API-key resolution / fetch.
		expect(fetchSpy).toBeUndefined();
	});

	it("truncates oversized evidence before sending (max_input_tokens * 4 chars)", async () => {
		stubFetch(() =>
			jsonResponse({
				choices: [{ message: { content: '{"compliant":true,"confidence":0.5,"reasoning":"ok"}' } }],
			}),
		);
		process.env.TEST_CLASSIFIER_KEY = "k";
		const state = createClassifierSessionState();
		// max_input_tokens=1 → maxChars=4. The serialized evidence is far longer,
		// so the body sent to the model must be exactly 4 chars.
		const bigEvidence = makeEvidence({ trigger_reason: "x".repeat(5000) });
		await callClassifier(bigEvidence, makeConfig({ provider: "groq", max_input_tokens: 1 }), state);
		const init = nonNull(fetchSpy.mock.calls[0])[1] as RequestInit;
		const sentBody = JSON.parse(init.body as string);
		const userMsg = (sentBody.messages as Array<{ role: string; content: string }>).find(
			(m) => m.role === "user",
		);
		expect(userMsg?.content).toHaveLength(4);
	});

	it("uses the default 800-token budget when max_input_tokens is 0 (|| fallback)", async () => {
		stubFetch(() =>
			jsonResponse({
				choices: [{ message: { content: '{"compliant":true,"confidence":0.5,"reasoning":"ok"}' } }],
			}),
		);
		process.env.TEST_CLASSIFIER_KEY = "k";
		const state = createClassifierSessionState();
		// 0 is falsy → defaults to 800 → 3200 chars. Small evidence is untruncated.
		await callClassifier(makeEvidence(), makeConfig({ provider: "groq", max_input_tokens: 0 }), state);
		const init = nonNull(fetchSpy.mock.calls[0])[1] as RequestInit;
		const sentBody = JSON.parse(init.body as string);
		const userMsg = (sentBody.messages as Array<{ role: string; content: string }>).find(
			(m) => m.role === "user",
		);
		// Untruncated: equals the full serialized evidence.
		expect(userMsg?.content).toBe(JSON.stringify(makeEvidence()));
	});
});

// ===========================================
// callViaClaudeCode + parseClaudeCodeOutput (through callClassifier)
// ===========================================

describe("callViaClaudeCode", () => {
	async function runClaudeCode(
		opts: {
			config?: Partial<ClassifierConfig>;
			drive: (child: FakeChild, state: ClassifierSessionState) => void;
		},
	): Promise<{ result: PolicyClassification; state: ClassifierSessionState; child: FakeChild }> {
		const child = new FakeChild();
		spawnMock.spawn.mockReturnValue(child);
		const state = createClassifierSessionState();
		const promise = callClassifier(
			makeEvidence(),
			makeConfig({ provider: "claude_code", ...opts.config }),
			state,
		);
		opts.drive(child, state);
		const result = await promise;
		return { result, state, child };
	}

	it("parses structured_output (compliant:true → allow) and resets failures", async () => {
		const { result, state } = await runClaudeCode({
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(
						JSON.stringify({
							structured_output: { compliant: true, confidence: 0.91, reasoning: "fine", policy_id: null },
						}),
					),
				);
				child.emit("close", 0);
			},
		});
		expect(result).toEqual({
			label: "allow",
			confidence: 0.91,
			reasoning: "fine",
			policy_id: undefined,
		});
		expect(state.consecutive_failures).toBe(0);
	});

	it("maps structured_output compliant:false to deny with policy_id", async () => {
		const { result } = await runClaudeCode({
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(
						JSON.stringify({
							structured_output: { compliant: false, confidence: 0.7, reasoning: "violation", policy_id: "no_exfil_after_taint" },
						}),
					),
				);
				child.emit("close", 0);
			},
		});
		expect(result.label).toBe("deny");
		expect(result.policy_id).toBe("no_exfil_after_taint");
		expect(result.confidence).toBe(0.7);
	});

	it("clamps an out-of-range structured_output confidence into [0,1]", async () => {
		const { result } = await runClaudeCode({
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(JSON.stringify({ structured_output: { compliant: true, confidence: 5, reasoning: "x" } })),
				);
				child.emit("close", 0);
			},
		});
		expect(result.confidence).toBe(1);
	});

	it("defaults reasoning when structured_output omits it", async () => {
		const { result } = await runClaudeCode({
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(JSON.stringify({ structured_output: { compliant: true } })),
				);
				child.emit("close", 0);
			},
		});
		expect(result.reasoning).toBe("No reasoning provided");
		expect(result.confidence).toBe(0);
	});

	it("falls back to the markdown-fenced `result` field when structured_output is absent", async () => {
		const { result } = await runClaudeCode({
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(
						JSON.stringify({
							result: '```json\n{"compliant":false,"confidence":0.6,"reasoning":"nope"}\n```',
						}),
					),
				);
				child.emit("close", 0);
			},
		});
		expect(result.label).toBe("deny");
		expect(result.reasoning).toBe("nope");
	});

	it("recovers via the catch → parseClassificationJson path when output is not wrapper JSON", async () => {
		const { result } = await runClaudeCode({
			drive: (child) => {
				// A markdown-fenced payload is NOT valid top-level JSON, so
				// `JSON.parse(output)` throws and parseClaudeCodeOutput's catch
				// re-parses the whole string via parseClassificationJson (which
				// strips the fence).
				child.stdout.emit(
					"data",
					Buffer.from('```json\n{"compliant":true,"confidence":0.4,"reasoning":"raw"}\n```'),
				);
				child.emit("close", 0);
			},
		});
		expect(result).toMatchObject({ label: "allow", confidence: 0.4, reasoning: "raw" });
	});

	it("handles structured_output that is a non-object (typeof guard) by falling through", async () => {
		const { result } = await runClaudeCode({
			drive: (child) => {
				// structured_output present but a string → typeof !== "object" →
				// falls through to the `result` field (here a plain payload).
				child.stdout.emit(
					"data",
					Buffer.from(
						JSON.stringify({
							structured_output: "not-an-object",
							result: '{"compliant":false,"confidence":0.5,"reasoning":"fell-through"}',
						}),
					),
				);
				child.emit("close", 0);
			},
		});
		expect(result).toMatchObject({ label: "deny", reasoning: "fell-through" });
	});

	// `isJsonObject` explicitly rejects arrays (typeof "object" but not a keyed
	// record — see json-types.ts). Before that guard, the old `as JsonObject`
	// cast let a JSON *array* through as if it were the structured_output
	// payload: every field read `undefined`, and the function returned a
	// fabricated "No reasoning provided" verdict instead of falling through
	// to the `result` field like every other non-object shape already does.
	it("N1: structured_output that is an ARRAY now falls through instead of yielding a fake verdict", async () => {
		const { result } = await runClaudeCode({
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(
						JSON.stringify({
							structured_output: [1, 2, 3],
							result: '{"compliant":false,"confidence":0.5,"reasoning":"fell-through-array"}',
						}),
					),
				);
				child.emit("close", 0);
			},
		});
		expect(result).toMatchObject({ label: "deny", reasoning: "fell-through-array" });
	});

	it("P1: a policy_id that is a number (not a string) is dropped rather than passed through untyped", async () => {
		const { result } = await runClaudeCode({
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(
						JSON.stringify({
							structured_output: { compliant: false, confidence: 0.5, reasoning: "x", policy_id: 42 },
						}),
					),
				);
				child.emit("close", 0);
			},
		});
		expect(result.policy_id).toBeUndefined();
	});

	it("returns parse-fail when the wrapper has neither structured_output nor result (|| '' branch)", async () => {
		const { result } = await runClaudeCode({
			drive: (child) => {
				// Valid wrapper JSON, but no structured_output and no result →
				// String(undefined || "") = "" → parseClassificationJson("") fails.
				child.stdout.emit("data", Buffer.from(JSON.stringify({ unrelated: 1 })));
				child.emit("close", 0);
			},
		});
		expect(result).toEqual({
			label: "allow",
			confidence: 0,
			reasoning: "Failed to parse classifier JSON",
		});
	});

	it("fails open with the exit code and increments failures on non-zero close", async () => {
		const { result, state } = await runClaudeCode({
			drive: (child) => {
				child.emit("close", 2);
			},
		});
		expect(result).toEqual({ label: "allow", confidence: 0, reasoning: "Claude Code exit code 2" });
		expect(state.consecutive_failures).toBe(1);
	});

	it("fails open and increments failures when the subprocess errors", async () => {
		const { result, state } = await runClaudeCode({
			drive: (child) => {
				child.emit("error", new Error("spawn ENOENT"));
			},
		});
		expect(result).toEqual({
			label: "allow",
			confidence: 0,
			reasoning: "Claude Code spawn failed: spawn ENOENT",
		});
		expect(state.consecutive_failures).toBe(1);
	});

	it("passes the configured model + system prompt + json schema to spawn", async () => {
		await runClaudeCode({
			config: { model: "sonnet" },
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(JSON.stringify({ structured_output: { compliant: true, confidence: 1, reasoning: "ok" } })),
				);
				child.emit("close", 0);
			},
		});
		const [cmd, args] = nonNull(spawnMock.spawn.mock.calls[0]);
		expect(cmd).toBe("claude");
		expect(args).toContain("sonnet");
		expect(args).toContain(CLASSIFIER_SYSTEM_PROMPT);
		expect(args).toContain("--no-session-persistence");
	});

	it("defaults the model to 'haiku' when config.model is empty", async () => {
		await runClaudeCode({
			config: { model: "" },
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(JSON.stringify({ structured_output: { compliant: true, confidence: 1, reasoning: "ok" } })),
				);
				child.emit("close", 0);
			},
		});
		const [, args] = nonNull(spawnMock.spawn.mock.calls[0]);
		expect(args).toContain("haiku");
	});

	it("defaults the timeout to 15000ms when config.timeout_ms is 0", async () => {
		await runClaudeCode({
			config: { timeout_ms: 0 },
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(JSON.stringify({ structured_output: { compliant: true, confidence: 1, reasoning: "ok" } })),
				);
				child.emit("close", 0);
			},
		});
		const opts = nonNull(spawnMock.spawn.mock.calls[0])[2] as { timeout: number };
		expect(opts.timeout).toBe(15000);
	});

	// test-contract: public-api — the exact argv handed to the `claude` CLI
	// subprocess IS the classifier's real wire contract (there is no other API
	// surface to assert it through); a `toContain`-only check lets any single
	// flag/value go blank without failing, which is exactly what the survivor
	// mutants on this call site (every flag, the stdio array, and the whole
	// embedded JSON-schema string) exploited.
	it("passes the exact CLI argv, stdio, and json-schema — not just individually-contained flags", async () => {
		await runClaudeCode({
			config: { model: "sonnet" },
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(JSON.stringify({ structured_output: { compliant: true, confidence: 1, reasoning: "ok" } })),
				);
				child.emit("close", 0);
			},
		});
		const expectedJsonSchema = JSON.stringify({
			type: "object",
			properties: {
				compliant: { type: "boolean" },
				confidence: { type: "number", minimum: 0, maximum: 1 },
				reasoning: { type: "string" },
				policy_id: { type: ["string", "null"] },
			},
			required: ["compliant", "confidence", "reasoning"],
		});
		const [cmd, args, opts] = nonNull(spawnMock.spawn.mock.calls[0]);
		expect(cmd).toBe("claude");
		expect(args).toEqual([
			"-p",
			"--model",
			"sonnet",
			"--no-session-persistence",
			"--disallowed-tools",
			"Bash,Edit,Write,Read,Glob,Grep,Agent,WebFetch,WebSearch",
			"--effort",
			"low",
			"--output-format",
			"json",
			"--system-prompt",
			CLASSIFIER_SYSTEM_PROMPT,
			"--json-schema",
			expectedJsonSchema,
			JSON.stringify(makeEvidence()),
		]);
		expect(opts).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
	});

	// test-contract: bug — without the trim, JSON.parse throws on a leading BOM,
	// falls into parseClaudeCodeOutput's catch, and parseClassificationJson then
	// reads compliant/reasoning off the TOP-LEVEL wrapper instead of
	// structured_output — silently returning a fabricated "No reasoning
	// provided" allow instead of the real verdict. A `claude -p` subprocess can
	// legitimately emit a BOM (locale/shell dependent), so this is a real input,
	// verified against a real Node JSON.parse (BOM is not tolerated JSON
	// whitespace; String.prototype.trim() does strip it).
	it("trims stdout before parsing — a BOM-prefixed payload still resolves the nested verdict", async () => {
		const { result } = await runClaudeCode({
			drive: (child) => {
				child.stdout.emit(
					"data",
					Buffer.from(
						"\uFEFF" +
							JSON.stringify({
								structured_output: {
									compliant: false,
									confidence: 0.9,
									reasoning: "blocked",
									policy_id: "p1",
								},
							}),
					),
				);
				child.emit("close", 0);
			},
		});
		expect(result).toEqual({ label: "deny", confidence: 0.9, reasoning: "blocked", policy_id: "p1" });
	});
});

// ===========================================
// callViaHttp — OpenAI-compatible + Anthropic + error paths
// ===========================================

describe("callViaHttp (OpenAI-compatible providers)", () => {
	beforeEach(() => {
		process.env.TEST_CLASSIFIER_KEY = "k-openai";
	});

	it("posts to config.endpoint with a Bearer header and parses the verdict", async () => {
		stubFetch((url) => {
			expect(url).toBe("https://api.example.test/v1/chat/completions");
			return jsonResponse({
				choices: [{ message: { content: '{"compliant":false,"confidence":0.82,"reasoning":"blocked","policy_id":"p1"}' } }],
			});
		});
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(result).toEqual({
			label: "deny",
			confidence: 0.82,
			reasoning: "blocked",
			policy_id: "p1",
		});
		const init = nonNull(fetchSpy.mock.calls[0])[1] as RequestInit;
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k-openai");
		expect(state.consecutive_failures).toBe(0);
	});

	it("uses max_tokens (not reasoning params) for a non-reasoning model", async () => {
		stubFetch(() =>
			jsonResponse({ choices: [{ message: { content: '{"compliant":true,"confidence":0.5,"reasoning":"ok"}' } }] }),
		);
		const state = createClassifierSessionState();
		await callClassifier(makeEvidence(), makeConfig({ provider: "groq", model: "llama-3.1-8b" }), state);
		const body = JSON.parse((nonNull(fetchSpy.mock.calls[0])[1] as RequestInit).body as string);
		expect(body.max_tokens).toBe(150);
		expect(body.max_completion_tokens).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("uses reasoning params for a gpt-oss model", async () => {
		stubFetch(() =>
			jsonResponse({ choices: [{ message: { content: '{"compliant":true,"confidence":0.5,"reasoning":"ok"}' } }] }),
		);
		const state = createClassifierSessionState();
		await callClassifier(makeEvidence(), makeConfig({ provider: "groq", model: "gpt-oss-120b" }), state);
		const body = JSON.parse((nonNull(fetchSpy.mock.calls[0])[1] as RequestInit).body as string);
		expect(body.max_completion_tokens).toBe(1024);
		expect(body.reasoning_effort).toBe("low");
		expect(body.max_tokens).toBeUndefined();
	});

	it("uses reasoning params when the model name contains 'reasoning'", async () => {
		stubFetch(() =>
			jsonResponse({ choices: [{ message: { content: '{"compliant":true,"confidence":0.5,"reasoning":"ok"}' } }] }),
		);
		const state = createClassifierSessionState();
		await callClassifier(makeEvidence(), makeConfig({ provider: "groq", model: "my-reasoning-model" }), state);
		const body = JSON.parse((nonNull(fetchSpy.mock.calls[0])[1] as RequestInit).body as string);
		expect(body.max_completion_tokens).toBe(1024);
	});

	it("fails open and increments failures on a non-ok HTTP status", async () => {
		stubFetch(() => jsonResponse({ error: "rate limited" }, 429));
		const state = createClassifierSessionState();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(result).toEqual({
			label: "allow",
			confidence: 0,
			reasoning: "Classifier HTTP error: 429",
		});
		expect(state.consecutive_failures).toBe(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("fail-open: Classifier HTTP error: 429"));
	});

	it("fails open with the Error message when fetch rejects (Error branch)", async () => {
		stubFetch(() => Promise.reject(new Error("network down")));
		const state = createClassifierSessionState();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(result.reasoning).toBe("Classifier call failed: network down");
		expect(state.consecutive_failures).toBe(1);
	});

	it("fails open with String(err) when fetch rejects with a non-Error (else branch)", async () => {
		stubFetch(() => Promise.reject("string failure"));
		const state = createClassifierSessionState();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(result.reasoning).toBe("Classifier call failed: string failure");
	});

	it("aborts the request and fails open when the timeout fires (abort-callback + AbortController)", async () => {
		vi.useFakeTimers();
		try {
			// A fetch that honors the AbortSignal: it only settles when aborted,
			// so the request is still in flight when the timeout's
			// `() => controller.abort()` callback runs. Advancing fake timers
			// past timeout_ms fires that callback → signal aborts → reject.
			fetchSpy = vi.fn(((_input: string | URL | Request, init?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return;
					signal.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted.", "AbortError"));
					});
				});
			}) as typeof fetch) as unknown as MockInstance;
			vi.stubGlobal("fetch", fetchSpy);
			vi.spyOn(console, "warn").mockImplementation(() => {});

			const state = createClassifierSessionState();
			const promise = callClassifier(makeEvidence(), makeConfig({ provider: "groq", timeout_ms: 50 }), state);
			// Fire the setTimeout(() => controller.abort(), 50) callback.
			await vi.advanceTimersByTimeAsync(60);
			const result = await promise;
			expect(result.label).toBe("allow");
			expect(result.confidence).toBe(0);
			expect(result.reasoning).toContain("Classifier call failed:");
			expect(state.consecutive_failures).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses the default 3000ms timeout when config.timeout_ms is 0 (|| 3000 branch)", async () => {
		// A 0 timeout is falsy → the `|| 3000` fallback is taken. fetch resolves
		// immediately so the timer never actually fires; we only need the
		// fallback expression evaluated. setTimeout is spied to assert the arg.
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		stubFetch(() =>
			jsonResponse({ choices: [{ message: { content: '{"compliant":true,"confidence":0.5,"reasoning":"ok"}' } }] }),
		);
		const state = createClassifierSessionState();
		await callClassifier(makeEvidence(), makeConfig({ provider: "groq", timeout_ms: 0 }), state);
		// The abort timer was scheduled with the 3000ms default.
		const scheduledDelays = setTimeoutSpy.mock.calls.map((c) => c[1]);
		expect(scheduledDelays).toContain(3000);
	});

	// test-contract: public-api — the request wire-format for the
	// OpenAI-compatible provider path is the classifier's actual contract with
	// the inference endpoint; per-field toContain-style checks let any single
	// value (Content-Type, the role strings, the message objects) go blank
	// without failing.
	it("posts the exact method + headers + body — not just individually-contained fields", async () => {
		stubFetch(() =>
			jsonResponse({ choices: [{ message: { content: '{"compliant":true,"confidence":0.5,"reasoning":"ok"}' } }] }),
		);
		const state = createClassifierSessionState();
		const evidence = makeEvidence();
		await callClassifier(evidence, makeConfig({ provider: "groq", model: "llama-3.1-8b" }), state);
		const [, init] = nonNull(fetchSpy.mock.calls[0]) as [string, RequestInit];
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer k-openai",
		});
		expect(JSON.parse(init.body as string)).toEqual({
			model: "llama-3.1-8b",
			messages: [
				{ role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
				{ role: "user", content: JSON.stringify(evidence) },
			],
			max_tokens: 150,
			temperature: 0,
		});
	});

	// test-contract: invariant — every call schedules an abort timer via
	// setTimeout; the `finally` block is the ONLY place that clears it, so a
	// dropped clearTimeout means every classifier call leaks a timer that
	// outlives the call by up to timeout_ms.
	it("clears the abort timer in `finally` after a successful call", async () => {
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
		stubFetch(() =>
			jsonResponse({ choices: [{ message: { content: '{"compliant":true,"confidence":0.5,"reasoning":"ok"}' } }] }),
		);
		const state = createClassifierSessionState();
		await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(clearTimeoutSpy).toHaveBeenCalled();
	});
});

describe("callViaHttp (Anthropic provider)", () => {
	beforeEach(() => {
		process.env.TEST_CLASSIFIER_KEY = "k-anthropic";
	});

	it("posts to the Anthropic endpoint with x-api-key + version headers", async () => {
		stubFetch((url) => {
			expect(url).toBe("https://api.anthropic.com/v1/messages");
			return jsonResponse({
				content: [{ type: "text", text: '{"compliant":true,"confidence":0.77,"reasoning":"fine"}' }],
			});
		});
		const state = createClassifierSessionState();
		const result = await callClassifier(
			makeEvidence(),
			makeConfig({ provider: "anthropic", model: "vendor-model-v6" }),
			state,
		);
		expect(result).toMatchObject({ label: "allow", confidence: 0.77, reasoning: "fine" });
		const init = nonNull(fetchSpy.mock.calls[0])[1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("k-anthropic");
		expect(headers["anthropic-version"]).toBe("2023-06-01");
		const body = JSON.parse(init.body as string);
		expect(body.system).toBe(CLASSIFIER_SYSTEM_PROMPT);
		expect(body.max_tokens).toBe(150);
	});

	it("parses an Anthropic deny verdict", async () => {
		stubFetch(() =>
			jsonResponse({ content: [{ type: "text", text: '{"compliant":false,"confidence":0.9,"reasoning":"bad"}' }] }),
		);
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "anthropic" }), state);
		expect(result.label).toBe("deny");
	});

	it("returns the 'No content' fallback when the Anthropic content array is empty", async () => {
		stubFetch(() => jsonResponse({ content: [] }));
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "anthropic" }), state);
		expect(result).toEqual({ label: "allow", confidence: 0, reasoning: "No content in response" });
	});

	it("returns the 'No content' fallback when content is missing entirely", async () => {
		stubFetch(() => jsonResponse({}));
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "anthropic" }), state);
		expect(result.reasoning).toBe("No content in response");
	});

	it("returns the Anthropic parse-failure fallback when content[0] is malformed", async () => {
		// content[0] is null → accessing `.text` throws → catch path.
		stubFetch(() => jsonResponse({ content: [null] }));
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "anthropic" }), state);
		expect(result.reasoning).toBe("Failed to parse Anthropic response");
	});

	it("defaults to empty text (then parse-fail) when content[0].text is absent (|| '' branch)", async () => {
		// content[0] present but no `text` → String(undefined || "") = "" →
		// parseClassificationJson("") fails with the classifier-JSON fallback.
		stubFetch(() => jsonResponse({ content: [{ type: "text" }] }));
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "anthropic" }), state);
		expect(result.reasoning).toBe("Failed to parse classifier JSON");
	});

	// test-contract: public-api — same rationale as the OpenAI-compatible
	// sibling test above, for the Anthropic wire format (x-api-key/version
	// headers, the single-message `messages` array, and its "user" role).
	it("posts the exact method + headers + body — not just individually-contained fields", async () => {
		stubFetch(() =>
			jsonResponse({ content: [{ type: "text", text: '{"compliant":true,"confidence":0.6,"reasoning":"fine"}' }] }),
		);
		const state = createClassifierSessionState();
		const evidence = makeEvidence();
		await callClassifier(evidence, makeConfig({ provider: "anthropic", model: "vendor-model-v6" }), state);
		const [, init] = nonNull(fetchSpy.mock.calls[0]) as [string, RequestInit];
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"Content-Type": "application/json",
			"x-api-key": "k-anthropic",
			"anthropic-version": "2023-06-01",
		});
		expect(JSON.parse(init.body as string)).toEqual({
			model: "vendor-model-v6",
			system: CLASSIFIER_SYSTEM_PROMPT,
			messages: [{ role: "user", content: JSON.stringify(evidence) }],
			max_tokens: 150,
			temperature: 0,
		});
	});
});

// ===========================================
// parseOpenAIResponse fallbacks (through callViaHttp)
// ===========================================

describe("parseOpenAIResponse fallbacks", () => {
	beforeEach(() => {
		process.env.TEST_CLASSIFIER_KEY = "k";
	});

	it("returns 'No choices' when the choices array is empty", async () => {
		stubFetch(() => jsonResponse({ choices: [] }));
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(result).toEqual({ label: "allow", confidence: 0, reasoning: "No choices in response" });
	});

	it("returns 'No choices' when choices is missing entirely", async () => {
		stubFetch(() => jsonResponse({}));
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(result.reasoning).toBe("No choices in response");
	});

	it("returns the OpenAI parse-failure fallback when choices[0] is malformed", async () => {
		// choices[0] is null → accessing `.message` throws → catch path.
		stubFetch(() => jsonResponse({ choices: [null] }));
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(result.reasoning).toBe("Failed to parse OpenAI response");
	});

	it("returns 'Failed to parse classifier JSON' when message content is not JSON", async () => {
		stubFetch(() => jsonResponse({ choices: [{ message: { content: "not json at all" } }] }));
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		expect(result.reasoning).toBe("Failed to parse classifier JSON");
	});

	it("defaults to empty content (then parse-fail) when message.content is absent", async () => {
		stubFetch(() => jsonResponse({ choices: [{ message: {} }] }));
		const state = createClassifierSessionState();
		const result = await callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
		// String(undefined||"") = "" → JSON.parse("") throws → parse-fail fallback.
		expect(result.reasoning).toBe("Failed to parse classifier JSON");
	});
});

// ===========================================
// parseClassificationJson (through callViaHttp content)
// ===========================================

describe("parseClassificationJson", () => {
	beforeEach(() => {
		process.env.TEST_CLASSIFIER_KEY = "k";
	});

	/** Helper: feed `content` through the OpenAI parse path and return the verdict. */
	async function parseContent(content: string): Promise<PolicyClassification> {
		stubFetch(() => jsonResponse({ choices: [{ message: { content } }] }));
		const state = createClassifierSessionState();
		return callClassifier(makeEvidence(), makeConfig({ provider: "groq" }), state);
	}

	it("parses a plain JSON object (no fences)", async () => {
		const r = await parseContent('{"compliant":true,"confidence":0.5,"reasoning":"ok"}');
		expect(r).toMatchObject({ label: "allow", confidence: 0.5, reasoning: "ok" });
	});

	it("strips a ```json fence before parsing", async () => {
		const r = await parseContent('```json\n{"compliant":false,"confidence":0.6,"reasoning":"x"}\n```');
		expect(r.label).toBe("deny");
	});

	it("strips a bare ``` fence (no language tag) before parsing", async () => {
		const r = await parseContent('```\n{"compliant":true,"confidence":0.3,"reasoning":"y"}\n```');
		expect(r).toMatchObject({ label: "allow", confidence: 0.3 });
	});

	it("maps a missing `compliant` field to allow (only false → deny)", async () => {
		const r = await parseContent('{"confidence":0.4,"reasoning":"no compliant key"}');
		expect(r.label).toBe("allow");
	});

	it("maps compliant:true explicitly to allow", async () => {
		const r = await parseContent('{"compliant":true,"confidence":0.4,"reasoning":"ok"}');
		expect(r.label).toBe("allow");
	});

	it("clamps confidence above 1 down to 1", async () => {
		const r = await parseContent('{"compliant":true,"confidence":9,"reasoning":"ok"}');
		expect(r.confidence).toBe(1);
	});

	it("clamps a negative confidence up to 0", async () => {
		const r = await parseContent('{"compliant":true,"confidence":-3,"reasoning":"ok"}');
		expect(r.confidence).toBe(0);
	});

	it("coerces a non-numeric confidence to 0 (Number() || 0)", async () => {
		const r = await parseContent('{"compliant":true,"confidence":"high","reasoning":"ok"}');
		expect(r.confidence).toBe(0);
	});

	it("defaults reasoning when absent", async () => {
		const r = await parseContent('{"compliant":true,"confidence":0.5}');
		expect(r.reasoning).toBe("No reasoning provided");
	});

	it("passes policy_id through and normalizes empty policy_id to undefined", async () => {
		const withId = await parseContent('{"compliant":false,"confidence":0.5,"reasoning":"x","policy_id":"p9"}');
		expect(withId.policy_id).toBe("p9");
		const emptyId = await parseContent('{"compliant":false,"confidence":0.5,"reasoning":"x","policy_id":""}');
		expect(emptyId.policy_id).toBeUndefined();
	});

	it("returns the parse-fail fallback for malformed JSON inside a fence", async () => {
		const r = await parseContent("```json\n{not valid}\n```");
		expect(r.reasoning).toBe("Failed to parse classifier JSON");
	});

	// `isJsonObject` rejects arrays/primitives/null even when they parse as
	// valid JSON — a bare JSON array is not a classification payload. Before
	// the guard, `JSON.parse(cleaned) as JsonObject` let this through and
	// every field read `undefined`, silently returning a "No reasoning
	// provided" verdict instead of an honest parse failure.
	it("N1: a top-level JSON array is treated as a parse failure, not a blank-fields verdict", async () => {
		const r = await parseContent("[1,2,3]");
		expect(r).toEqual({ label: "allow", confidence: 0, reasoning: "Failed to parse classifier JSON" });
	});

	it("N2: a top-level JSON null is treated as a parse failure", async () => {
		const r = await parseContent("null");
		expect(r).toEqual({ label: "allow", confidence: 0, reasoning: "Failed to parse classifier JSON" });
	});

	it("P1: a well-formed object still parses normally alongside the new array/null guard", async () => {
		const r = await parseContent('{"compliant":true,"confidence":0.8,"reasoning":"still works"}');
		expect(r).toMatchObject({ label: "allow", confidence: 0.8, reasoning: "still works" });
	});
});

// ===========================================
// appendShadowLog
// ===========================================

describe("appendShadowLog", () => {
	function makeEntry(): ShadowLogEntry {
		return {
			ts: "2026-06-06T00:00:00Z",
			session_id: "s1",
			agent_name: "a1",
			trigger: "external_url",
			tool_name: "Bash",
			action_class: "curl_external",
			local_decision: "allow",
			classification: { label: "deny", confidence: 0.8, reasoning: "x" },
			would_have_changed: true,
			latency_ms: 12,
			evidence_hash: "sha256:abc",
		};
	}

	it("appends a JSON line, creating the .interlinked dir when missing", () => {
		fsMock.existsSync.mockReturnValue(false);
		appendShadowLog(makeEntry());
		expect(fsMock.mkdirSync).toHaveBeenCalledWith(expect.stringContaining(".interlinked"), {
			recursive: true,
		});
		expect(fsMock.appendFileSync).toHaveBeenCalledOnce();
		const [path, data] = nonNull(fsMock.appendFileSync.mock.calls[0]);
		expect(path).toContain("policy-shadow.jsonl");
		expect(data.endsWith("\n")).toBe(true);
		expect(JSON.parse(data.trim()).session_id).toBe("s1");
	});

	it("does not create the dir when it already exists", () => {
		fsMock.existsSync.mockReturnValue(true);
		appendShadowLog(makeEntry());
		expect(fsMock.mkdirSync).not.toHaveBeenCalled();
		expect(fsMock.appendFileSync).toHaveBeenCalledOnce();
	});

	it("honors an explicit cwd override for the log path", () => {
		fsMock.existsSync.mockReturnValue(true);
		appendShadowLog(makeEntry(), "/custom/root");
		const [path] = nonNull(fsMock.appendFileSync.mock.calls[0]);
		expect(path).toContain("/custom/root");
		expect(path).toContain(".interlinked");
	});

	it("swallows write errors (catch → void)", () => {
		fsMock.existsSync.mockReturnValue(true);
		fsMock.appendFileSync.mockImplementation(() => {
			throw new Error("EROFS");
		});
		expect(() => appendShadowLog(makeEntry())).not.toThrow();
	});
});

// ===========================================
// hashEvidence (real node:crypto — deterministic)
// ===========================================

describe("hashEvidence", () => {
	it("produces a stable sha256:<16-hex> digest for the same evidence", () => {
		const ev = makeEvidence();
		const h1 = hashEvidence(ev);
		const h2 = hashEvidence(ev);
		expect(h1).toBe(h2);
		expect(h1).toMatch(/^sha256:[0-9a-f]{16}$/);
	});

	it("produces different digests for different evidence", () => {
		const a = hashEvidence(makeEvidence({ trigger: "external_url" }));
		const b = hashEvidence(makeEvidence({ trigger: "high_step_budget" }));
		expect(a).not.toBe(b);
	});
});
