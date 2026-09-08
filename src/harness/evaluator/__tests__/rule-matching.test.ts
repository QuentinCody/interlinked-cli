import { describe, expect, it } from "vitest";
import type { GuardRule, HarnessEvent, SessionTrajectory } from "../../types.js";
import {
	extractResolvedTargets,
	formatAskReason,
	formatAskReasonWithTargets,
	formatAskSystemMessage,
	formatReason,
	getCachedRegex,
	getField,
	matchesRule,
	shouldEvaluateRule,
} from "../rule-matching.js";

function makeRule(overrides: Partial<GuardRule> = {}): GuardRule {
	return {
		id: "test-rule",
		category: "test",
		severity: "medium",
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		patterns: [{ field: "command", regex: "rm\\s+-rf" }],
		action: "block",
		reason: "do not delete everything",
		enabled: true,
		...overrides,
	};
}

/** Minimal-but-complete SessionTrajectory fixture, following the convention
 *  established in `active-when.test.ts`. Only the fields the temporal
 *  predicate evaluator + matchesRule's session-gating actually read
 *  (`tool_sequence`) are exercised by these tests; the rest are present
 *  so the object satisfies the full interface. */
function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: "2026-07-31T00:00:00.000Z",
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
		last_coordination_ts: 0,
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

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		timestamp: "2026-07-31T00:00:00.000Z",
		...overrides,
	};
}

describe("shouldEvaluateRule", () => {
	it("respects enabled flag", () => {
		expect(shouldEvaluateRule(makeRule({ enabled: false }), "PreToolUse", "Bash")).toBe(false);
	});

	it("matches the configured trigger or 'both'", () => {
		expect(shouldEvaluateRule(makeRule({ trigger: "PreToolUse" }), "PreToolUse", "Bash")).toBe(
			true,
		);
		expect(shouldEvaluateRule(makeRule({ trigger: "PostToolUse" }), "PreToolUse", "Bash")).toBe(
			false,
		);
		expect(shouldEvaluateRule(makeRule({ trigger: "both" }), "PostToolUse", "Bash")).toBe(true);
	});

	it("handles wildcard tool_match and case-insensitive tool names", () => {
		expect(shouldEvaluateRule(makeRule({ tool_match: ["*"] }), "PreToolUse", "AnyTool")).toBe(
			true,
		);
		expect(shouldEvaluateRule(makeRule({ tool_match: ["bash"] }), "PreToolUse", "Bash")).toBe(
			true,
		);
		expect(shouldEvaluateRule(makeRule({ tool_match: ["Write"] }), "PreToolUse", "Bash")).toBe(
			false,
		);
	});

	it("matches when ANY entry in a multi-tool tool_match matches (OR, not AND)", () => {
		// A tool_match list is an OR over its entries. With only one entry
		// ever exercised elsewhere, `.some(...)` and `.every(...)` are
		// indistinguishable; a list where exactly one of two entries matches
		// tells them apart.
		expect(
			shouldEvaluateRule(makeRule({ tool_match: ["Write", "Bash"] }), "PreToolUse", "Bash"),
		).toBe(true);
		expect(
			shouldEvaluateRule(makeRule({ tool_match: ["Write", "Edit"] }), "PreToolUse", "Bash"),
		).toBe(false);
	});
});

describe("getCachedRegex", () => {
	it("returns the same RegExp object for identical pattern+flags", () => {
		const a = getCachedRegex("foo", "i");
		const b = getCachedRegex("foo", "i");
		expect(a).toBe(b);
	});

	it("differentiates by flags", () => {
		const a = getCachedRegex("foo", "i");
		const b = getCachedRegex("foo", "g");
		expect(a).not.toBe(b);
	});
});

describe("matchesRule", () => {
	it("returns true when any positive pattern matches", () => {
		const rule = makeRule();
		expect(
			matchesRule({
				command: "rm -rf /",
				toolInput: { command: "rm -rf /" },
				rule,
			}),
		).toBe(true);
	});

	it("returns false when no positive pattern matches", () => {
		const rule = makeRule();
		expect(
			matchesRule({
				command: "ls -la",
				toolInput: { command: "ls -la" },
				rule,
			}),
		).toBe(false);
	});

	it("skips rules when a negated pattern matches (exception)", () => {
		const rule = makeRule({
			patterns: [
				{ field: "command", regex: "rm\\s+-rf" },
				{ field: "command", regex: "node_modules", negate: true },
			],
		});
		expect(
			matchesRule({
				command: "rm -rf node_modules",
				toolInput: { command: "rm -rf node_modules" },
				rule,
			}),
		).toBe(false);
	});

	it("applies extra_exceptions substring allowlist from local config", () => {
		const rule = makeRule({ id: "destructive-delete" });
		expect(
			matchesRule({
				command: "rm -rf /tmp/cache",
				toolInput: { command: "rm -rf /tmp/cache" },
				rule,
				extraExceptions: { "destructive-delete": ["/tmp/cache"] },
			}),
		).toBe(false);
	});

	// --- file_extensions allowlist ---
	// A rule that opts into a file-extension allowlist should only fire when the
	// tool's file_path/path matches one of the listed extensions. Documentation
	// files (.md/.html) describing the same pattern are not violations.

	it("file_extensions: rule fires when path matches the allowlist", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["py", "ts", "rb"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "src/migrate.py", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
	});

	it("file_extensions: rule skipped when path is documentation (.md)", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["py", "ts", "rb"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "docs/dangerous-things.md", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: rule skipped when path is HTML marketing", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "chmod\\s+777", flags: "i" }],
			file_extensions: ["py", "rb", "sh"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "landing/public/index.html", content: "chmod 777 example" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: tolerates leading dots and case in the allowlist", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: [".PY", "Ts"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "src/migrate.py", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
	});

	it("file_extensions: tolerates surrounding whitespace in the allowlist entry", () => {
		// normalizeExt trims before lowercasing; an entry padded with spaces
		// (e.g. authored via a form field or YAML block scalar) must still
		// resolve to the same extension as its trimmed form.
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: [" py "],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "src/migrate.py", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
	});

	it("file_extensions: empty / undefined allowlist preserves existing fire-on-all behavior", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			// no file_extensions
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "docs/dangerous.md", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
	});

	it("file_extensions: rule rejects path-less Bash payload when scope is set", () => {
		const rule = makeRule({
			tool_match: ["Bash"],
			patterns: [{ field: "command", regex: "rm\\s+-rf" }],
			file_extensions: ["py"],
		});
		expect(
			matchesRule({
				command: "rm -rf /tmp/x",
				toolInput: { command: "rm -rf /tmp/x" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: also reads `path` field as a fallback to `file_path`", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["py"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { path: "src/migrate.py", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
	});

	it("file_extensions: an explicitly empty allowlist ([]) still preserves fire-on-all", () => {
		// Distinct from the "undefined" case above: `!allowlist` is false here
		// (the array exists), only `allowlist.length === 0` fires the
		// short-circuit. A mutant that removes the short-circuit falls through
		// to `.map()` on an empty array, which can never `.includes()` a real
		// extension — so an explicit [] must be tested separately from undefined.
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: [],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "src/migrate.py", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
	});

	it("file_extensions: a dotfile with no directory has no extension (dot at position 0)", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["env"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: ".env", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: a filename with no dot at all has no extension", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["txt"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "Makefile", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: a bare filename (no directory separator) still resolves its extension", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["txt"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "requirements.txt", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
	});

	it("file_extensions: a single leading separator (dot immediately after) still has no extension", () => {
		// Boundary case for the `slash >= 0` check: slash === 0 exactly.
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["env"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "/.env", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: extension is resolved from the segment after the LAST separator only", () => {
		// A directory component containing its own dot ("src.backup") must not
		// leak into the extension computation once the real filename
		// ("README", no dot) is sliced off.
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["backup/readme"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "src.backup/README", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: slices the filename starting exactly one character after the separator", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["env"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "x/.env", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: resolves the extension using the LAST separator when '/' and '\\\\' both occur", () => {
		// filePath contains a "/" before a later "\" — the rightmost separator
		// overall must win, otherwise the trailing ".env" segment (a dotfile,
		// no real extension) gets merged with the preceding directory text.
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["env"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "a/dir\\.env", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(false);
	});

	// --- tool_externality gate ---

	it("tool_externality: fires only when the classified tier is in the allowlist", () => {
		const rule = makeRule({
			tool_match: ["*"],
			patterns: [{ field: "command", regex: ".*" }],
			tool_externality: ["external_action"],
		});
		expect(
			matchesRule({
				command: "curl https://example.com",
				toolInput: { command: "curl https://example.com" },
				rule,
				toolName: "Bash",
			}),
		).toBe(true);
		expect(
			matchesRule({
				command: "ls -la",
				toolInput: { command: "ls -la" },
				rule,
				toolName: "Bash",
			}),
		).toBe(false);
	});

	it("tool_externality: undefined allowlist preserves fire-on-all", () => {
		const rule = makeRule({
			tool_match: ["*"],
			patterns: [{ field: "command", regex: ".*" }],
		});
		expect(
			matchesRule({
				command: "ls -la",
				toolInput: { command: "ls -la" },
				rule,
				toolName: "Bash",
			}),
		).toBe(true);
	});

	it("tool_externality: an explicitly empty allowlist ([]) also preserves fire-on-all", () => {
		// Distinct from `undefined` above: `!allowlist` is false here (the
		// array exists), only `allowlist.length === 0` fires the short-circuit.
		const rule = makeRule({
			tool_match: ["*"],
			patterns: [{ field: "command", regex: ".*" }],
			tool_externality: [],
		});
		expect(
			matchesRule({
				command: "ls -la",
				toolInput: { command: "ls -la" },
				rule,
				toolName: "Bash",
			}),
		).toBe(true);
	});

	it("tool_externality: classifies via the `??` fallback when the context carries no toolName", () => {
		// ctx.toolName is optional; omitting it entirely (rather than passing
		// "") must still resolve to a real tier via classifyToolExternality's
		// own falsy-toolName handling ("local_write"), not crash or silently
		// allow.
		const rule = makeRule({
			tool_match: ["*"],
			patterns: [{ field: "command", regex: ".*" }],
			tool_externality: ["local_write"],
		});
		expect(
			matchesRule({
				command: "ls -la",
				toolInput: { command: "ls -la" },
				rule,
			}),
		).toBe(true);
		const ruleExternalOnly = makeRule({
			tool_match: ["*"],
			patterns: [{ field: "command", regex: ".*" }],
			tool_externality: ["external_action"],
		});
		expect(
			matchesRule({
				command: "ls -la",
				toolInput: { command: "ls -la" },
				rule: ruleExternalOnly,
			}),
		).toBe(false);
	});

	// --- projectForPattern: executed_only / strip_wrappers opt-in projections ---

	it("executed_only: masks quoted (non-executed) spans before matching", () => {
		const rule = makeRule({
			patterns: [{ field: "command", regex: "rm\\s+-rf", executed_only: true }],
		});
		const command = "git commit -m 'rm -rf /'";
		expect(matchesRule({ command, toolInput: { command }, rule })).toBe(false);
	});

	it("executed_only: off by default — the same quoted text still matches", () => {
		const rule = makeRule({
			patterns: [{ field: "command", regex: "rm\\s+-rf" }],
		});
		const command = "git commit -m 'rm -rf /'";
		expect(matchesRule({ command, toolInput: { command }, rule })).toBe(true);
	});

	it("strip_wrappers: strips a sudo prefix so an anchored pattern still matches", () => {
		const rule = makeRule({
			patterns: [{ field: "command", regex: "^rm\\s+-rf", strip_wrappers: true }],
		});
		const command = "sudo rm -rf /";
		expect(matchesRule({ command, toolInput: { command }, rule })).toBe(true);
	});

	it("strip_wrappers: off by default — the anchored pattern does not see past the sudo prefix", () => {
		const rule = makeRule({
			patterns: [{ field: "command", regex: "^rm\\s+-rf" }],
		});
		const command = "sudo rm -rf /";
		expect(matchesRule({ command, toolInput: { command }, rule })).toBe(false);
	});

	// --- evaluatePatterns: vacuous match, empty-value skipping, default flags ---

	it("vacuously matches when a rule has ONLY negated patterns and none of them fire", () => {
		// Zero positive patterns is a vacuous pass (OR over an empty set).
		// A rule authored as pure exceptions still needs a positive baseline
		// of "always applies unless excepted".
		const rule = makeRule({
			patterns: [{ field: "command", regex: "foo-not-present", negate: true }],
		});
		expect(
			matchesRule({ command: "unrelated text", toolInput: { command: "unrelated text" }, rule }),
		).toBe(true);
	});

	it("skips an empty-valued positive pattern instead of matching against ''", () => {
		const rule = makeRule({
			patterns: [{ field: "nonexistent_field", regex: ".*" }],
		});
		expect(matchesRule({ command: "", toolInput: {}, rule })).toBe(false);
	});

	it("skips an empty-valued negated pattern instead of falsely treating '' as an exception", () => {
		const rule = makeRule({
			patterns: [
				{ field: "command", regex: "positive-match-here" },
				{ field: "missing_field", regex: ".*", negate: true },
			],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { command: "positive-match-here" },
				rule,
			}),
		).toBe(true);
	});

	it("negated pattern reads the field's OWN value, not the fallback, when both are present", () => {
		const rule = makeRule({
			patterns: [
				{ field: "command", regex: "rm\\s+-rf" },
				{ field: "note", regex: "node_modules", negate: true },
			],
		});
		expect(
			matchesRule({
				command: "irrelevant-fallback-should-not-be-consulted",
				toolInput: { command: "rm -rf everything", note: "node_modules cache" },
				rule,
			}),
		).toBe(false);
	});

	it("negated pattern does NOT fire when its regex genuinely does not match", () => {
		const rule = makeRule({
			patterns: [
				{ field: "command", regex: "rm\\s+-rf" },
				{ field: "command", regex: "node_modules", negate: true },
			],
		});
		expect(
			matchesRule({
				command: "rm -rf /var/cache",
				toolInput: { command: "rm -rf /var/cache" },
				rule,
			}),
		).toBe(true);
	});

	it("positive patterns default to case-insensitive matching when flags is omitted", () => {
		const rule = makeRule({
			patterns: [{ field: "command", regex: "ABORT" }],
		});
		expect(
			matchesRule({
				command: "please abort now",
				toolInput: { command: "please abort now" },
				rule,
			}),
		).toBe(true);
	});

	it("negated patterns default to case-insensitive matching when flags is omitted", () => {
		const rule = makeRule({
			patterns: [
				{ field: "command", regex: "rm\\s+-rf" },
				{ field: "note", regex: "SAFE", negate: true },
			],
		});
		expect(
			matchesRule({
				command: "rm -rf /",
				toolInput: { command: "rm -rf /", note: "this is safe to remove" },
				rule,
			}),
		).toBe(false);
	});

	// --- extra_exceptions: fallback resolution + match semantics ---

	it("extra_exceptions reads toolInput.command over the fallback command string", () => {
		const rule = makeRule({ id: "destructive-delete" });
		expect(
			matchesRule({
				command: "irrelevant-fallback-text",
				toolInput: { command: "rm -rf /tmp/cache" },
				rule,
				extraExceptions: { "destructive-delete": ["/tmp/cache"] },
			}),
		).toBe(false);
	});

	it("extra_exceptions falls back to the raw command string when toolInput has no command field", () => {
		const rule = makeRule({
			id: "destructive-delete",
			patterns: [{ field: "note", regex: "danger" }],
		});
		expect(
			matchesRule({
				command: "rm -rf /tmp/cache",
				toolInput: { note: "danger zone" },
				rule,
				extraExceptions: { "destructive-delete": ["/tmp/cache"] },
			}),
		).toBe(false);
	});

	it("extra_exceptions does not fire when none of the exception substrings are present", () => {
		const rule = makeRule({ id: "destructive-delete" });
		expect(
			matchesRule({
				command: "rm -rf /tmp/cache",
				toolInput: { command: "rm -rf /tmp/cache" },
				rule,
				extraExceptions: { "destructive-delete": ["/some/other/path"] },
			}),
		).toBe(true);
	});

	// --- Temporal predicates: requires_prior / forbids_after ---

	it("temporal predicates fall through to not-fire when no session is provided", () => {
		const rule = makeRule({ requires_prior: { tool: "Read" } });
		expect(
			matchesRule({
				command: "rm -rf /",
				toolInput: { command: "rm -rf /" },
				rule,
			}),
		).toBe(false);
	});

	it("requires_prior: stays dormant when the precondition IS met", () => {
		const session = makeSession({ tool_sequence: ["Read:src/index.ts"] });
		const rule = makeRule({ requires_prior: { tool: "Read" } });
		expect(
			matchesRule({
				command: "rm -rf /",
				toolInput: { command: "rm -rf /" },
				rule,
				session,
			}),
		).toBe(false);
	});

	it("requires_prior: fires when the precondition is MISSING", () => {
		const session = makeSession({ tool_sequence: [] });
		const rule = makeRule({ requires_prior: { tool: "Read" } });
		expect(
			matchesRule({
				command: "rm -rf /",
				toolInput: { command: "rm -rf /" },
				rule,
				session,
			}),
		).toBe(true);
	});

	it("forbids_after: fires when the forbidden prior state IS present", () => {
		const session = makeSession({ tool_sequence: ["Bash:ls -la"] });
		const rule = makeRule({ forbids_after: { tool: "Bash" } });
		expect(
			matchesRule({
				command: "rm -rf /",
				toolInput: { command: "rm -rf /" },
				rule,
				session,
			}),
		).toBe(true);
	});

	it("forbids_after: stays dormant when the forbidden prior state is ABSENT", () => {
		const session = makeSession({ tool_sequence: [] });
		const rule = makeRule({ forbids_after: { tool: "Bash" } });
		expect(
			matchesRule({
				command: "rm -rf /",
				toolInput: { command: "rm -rf /" },
				rule,
				session,
			}),
		).toBe(false);
	});

	it("forbids_after ALONE (no requires_prior) also falls through to not-fire when no session is provided", () => {
		// The session-gate reads `(rule.requires_prior || rule.forbids_after) && !session`.
		// Every OTHER no-session case above uses a rule with `requires_prior` set, so a
		// mutant narrowing that OR down to `rule.requires_prior` alone still passes them —
		// it only misbehaves for a forbids_after-ONLY rule, which is exactly this case.
		// Proven via scratch/audit-rulematching-forbidsguard-probe.mts: that mutant
		// flips this exact call from `false` to `true` while leaving every pre-existing
		// assertion in this file unchanged.
		const rule = makeRule({ forbids_after: { tool: "Bash" } });
		expect(
			matchesRule({
				command: "rm -rf /",
				toolInput: { command: "rm -rf /" },
				rule,
			}),
		).toBe(false);
	});
});

describe("getField", () => {
	it("returns shallow field when path has no dot", () => {
		expect(getField({ a: 1 }, "a")).toBe(1);
	});

	it("traverses dot paths", () => {
		expect(getField({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
	});

	it("returns undefined on dead-end traversal", () => {
		expect(getField({ a: 1 }, "a.b")).toBeUndefined();
		expect(getField({ a: [1, 2] }, "a.b")).toBeUndefined();
	});

	it("returns undefined on dead-end traversal through a null intermediate value", () => {
		expect(getField({ a: null }, "a.b")).toBeUndefined();
	});

	it("stops descending at a non-object value even when the final key would resolve on it", () => {
		// If the dead-end guard didn't stop descent, `current` would remain the
		// primitive `1` and `current["toString"]` would resolve to
		// `Number.prototype.toString` (a function, not undefined) instead of
		// correctly reporting a dead end.
		expect(getField({ a: 1 }, "a.toString")).toBeUndefined();
	});

	it("stops descending at an array intermediate even when the next key is a real array property", () => {
		// Isolates the array-specific disjunct from the primitive/null ones
		// above: `[1, 2, 3]` is not null and `typeof [] === "object"`, so only
		// the explicit `Array.isArray` guard blocks descent here. Without it,
		// `current` would become the array, then `.length` (a number), then
		// `.toString` on that number would resolve to a function instead of
		// undefined.
		expect(getField({ a: [1, 2, 3] }, "a.length.toString")).toBeUndefined();
	});
});

describe("formatReason", () => {
	it("prefixes with BLOCKED and appends suggestion if present", () => {
		const rule = makeRule({ reason: "nope", suggestion: "try this" });
		expect(formatReason(rule)).toBe("BLOCKED: nope\n\nSuggestion: try this");
	});

	it("omits suggestion block when undefined", () => {
		const rule = makeRule({ reason: "nope" });
		expect(formatReason(rule)).toBe("BLOCKED: nope");
	});
});

describe("formatAskReason", () => {
	it("builds the exact confirmation message and appends the suggestion when present", () => {
		const rule = makeRule({ reason: "deletes prod data", suggestion: "use --dry-run first" });
		expect(formatAskReason(rule)).toBe(
			"POTENTIALLY DESTRUCTIVE: deletes prod data\n\n" +
				"This action requires user confirmation before proceeding. " +
				"If the user approves, the operation will run; if not, choose a non-destructive alternative.\n\n" +
				"Suggestion: use --dry-run first",
		);
	});

	it("omits the suggestion block entirely when the rule has none", () => {
		const rule = makeRule({ reason: "deletes prod data" });
		expect(formatAskReason(rule)).toBe(
			"POTENTIALLY DESTRUCTIVE: deletes prod data\n\n" +
				"This action requires user confirmation before proceeding. " +
				"If the user approves, the operation will run; if not, choose a non-destructive alternative.",
		);
	});
});

describe("formatAskSystemMessage", () => {
	it("builds the exact multi-line operator message and appends Safer when a suggestion is present", () => {
		const rule = makeRule({
			id: "destructive-delete",
			reason: "deletes prod data",
			suggestion: "use --dry-run first",
			severity: "critical",
		});
		const event = makeEvent({ tool_name: "Bash" });
		expect(formatAskSystemMessage(rule, event)).toBe(
			[
				"⚠️  Interlinked detected a potentially destructive operation.",
				"   Tool:     Bash",
				"   Rule:     destructive-delete (critical)",
				"   Why:      deletes prod data",
				"   Safer:    use --dry-run first",
				"",
				"Approve only if you intended this action. Deny to make the agent pick a non-destructive path.",
			].join("\n"),
		);
	});

	it("omits the Safer line when the rule has no suggestion", () => {
		const rule = makeRule({ id: "destructive-delete", reason: "deletes prod data", severity: "high" });
		const event = makeEvent({ tool_name: "Bash" });
		expect(formatAskSystemMessage(rule, event)).toBe(
			[
				"⚠️  Interlinked detected a potentially destructive operation.",
				"   Tool:     Bash",
				"   Rule:     destructive-delete (high)",
				"   Why:      deletes prod data",
				"",
				"Approve only if you intended this action. Deny to make the agent pick a non-destructive path.",
			].join("\n"),
		);
	});

	it("falls back to 'unknown' when the event carries no tool_name", () => {
		const rule = makeRule({ id: "destructive-delete", reason: "deletes prod data", severity: "high" });
		const event = makeEvent();
		expect(formatAskSystemMessage(rule, event)).toContain("   Tool:     unknown");
	});
});

describe("formatAskReasonWithTargets", () => {
	it("returns the reason unchanged when targets is undefined", () => {
		expect(formatAskReasonWithTargets("base reason", undefined)).toBe("base reason");
	});

	it("returns the reason unchanged when targets is an empty array", () => {
		expect(formatAskReasonWithTargets("base reason", [])).toBe("base reason");
	});

	it("appends a bulleted Targets list, one bullet per target, in order", () => {
		expect(
			formatAskReasonWithTargets("base reason", [
				{ kind: "file", value: "/tmp/x" },
				{ kind: "url", value: "https://example.com" },
			]),
		).toBe("base reason\n\nTargets:\n  • file: /tmp/x\n  • url: https://example.com");
	});
});

describe("extractResolvedTargets — Bash: rm targets", () => {
	it("extracts the file arguments following a bare `rm`", () => {
		expect(
			extractResolvedTargets("Bash", { command: "rm -rf /tmp/cache /tmp/other" }, makeRule()),
		).toEqual([
			{ kind: "file", value: "/tmp/cache" },
			{ kind: "file", value: "/tmp/other" },
		]);
	});

	it("skips a sudo wrapper prefix before locating `rm`", () => {
		expect(extractResolvedTargets("Bash", { command: "sudo rm -rf /tmp/x" }, makeRule())).toEqual([
			{ kind: "file", value: "/tmp/x" },
		]);
	});

	it("resolves `rm` by basename when invoked via an absolute path", () => {
		expect(extractResolvedTargets("Bash", { command: "/bin/rm -rf /tmp/y" }, makeRule())).toEqual([
			{ kind: "file", value: "/tmp/y" },
		]);
	});

	it("skips a whitespace-only quoted argument rather than emitting a blank target", () => {
		expect(
			extractResolvedTargets("Bash", { command: 'rm -rf "   " /tmp/real' }, makeRule()),
		).toEqual([{ kind: "file", value: "/tmp/real" }]);
	});

	it("caps rm targets at MAX_RESOLVED_TARGETS (5), keeping the first five", () => {
		expect(
			extractResolvedTargets("Bash", { command: "rm -rf /a /b /c /d /e /f" }, makeRule()),
		).toEqual([
			{ kind: "file", value: "/a" },
			{ kind: "file", value: "/b" },
			{ kind: "file", value: "/c" },
			{ kind: "file", value: "/d" },
			{ kind: "file", value: "/e" },
		]);
	});

	it("truncates an overlong target value to 200 chars with a trailing ellipsis", () => {
		const longPath = `/tmp/${"x".repeat(250)}`;
		const targets = extractResolvedTargets("Bash", { command: `rm -rf ${longPath}` }, makeRule());
		expect(targets).toHaveLength(1);
		const value = targets[0]?.value ?? "";
		expect(value).toHaveLength(200);
		expect(value.endsWith("…")).toBe(true);
		expect(value.slice(0, 199)).toBe(longPath.slice(0, 199));
	});

	it("does NOT truncate a value at exactly the 200-char boundary", () => {
		const exactPath = `/tmp/${"y".repeat(195)}`; // "/tmp/" (5) + 195 = 200 exactly
		expect(exactPath).toHaveLength(200);
		const targets = extractResolvedTargets("Bash", { command: `rm -rf ${exactPath}` }, makeRule());
		expect(targets).toEqual([{ kind: "file", value: exactPath }]);
	});

	it("truncates a value one character past the 200-char boundary", () => {
		const overPath = `/tmp/${"y".repeat(196)}`; // 201 chars total
		expect(overPath).toHaveLength(201);
		const targets = extractResolvedTargets("Bash", { command: `rm -rf ${overPath}` }, makeRule());
		expect(targets[0]?.value).toHaveLength(200);
		expect(targets[0]?.value.endsWith("…")).toBe(true);
	});

	it("does not extract anything from a command with no `rm`/curl/git-push trigger", () => {
		expect(extractResolvedTargets("Bash", { command: "ls -la" }, makeRule())).toEqual([]);
	});

	it("returns no targets when the Bash toolInput carries no command field at all", () => {
		expect(extractResolvedTargets("Bash", {}, makeRule())).toEqual([]);
	});

	it("returns no targets when toolInput.command is present but not a string", () => {
		expect(extractResolvedTargets("Bash", { command: 42 }, makeRule())).toEqual([]);
	});

	it("triggers on `rm` preceded only by plain whitespace (not just start/`;`/`&&`/`||`)", () => {
		// A regex mutant narrowing the whitespace-before-rm alternative would
		// miss this — the only preceding boundary here is a plain space.
		expect(
			extractResolvedTargets("Bash", { command: "echo hi rm -rf /tmp/x" }, makeRule()),
		).toEqual([{ kind: "file", value: "/tmp/x" }]);
	});

	it("closes a quoted argument and resumes normal whitespace-splitting for subsequent tokens", () => {
		// If the tokenizer's quote-close handling is broken (quote state never
		// clears), everything after the first quoted arg gets absorbed into
		// one run-on token instead of splitting on the following spaces.
		expect(
			extractResolvedTargets("Bash", { command: 'rm -rf "quoted" /tmp/a /tmp/b' }, makeRule()),
		).toEqual([
			{ kind: "file", value: "quoted" },
			{ kind: "file", value: "/tmp/a" },
			{ kind: "file", value: "/tmp/b" },
		]);
	});

	it("treats a single-quoted argument the same as a double-quoted one", () => {
		expect(
			extractResolvedTargets("Bash", { command: "rm -rf 'single quoted' /tmp/x" }, makeRule()),
		).toEqual([
			{ kind: "file", value: "single quoted" },
			{ kind: "file", value: "/tmp/x" },
		]);
	});

	it("splits on tabs and newlines, not just spaces", () => {
		expect(
			extractResolvedTargets("Bash", { command: "rm -rf\t/tmp/tab-sep" }, makeRule()),
		).toEqual([{ kind: "file", value: "/tmp/tab-sep" }]);
		expect(
			extractResolvedTargets("Bash", { command: "rm -rf\n/tmp/newline-sep" }, makeRule()),
		).toEqual([{ kind: "file", value: "/tmp/newline-sep" }]);
	});

	it("once the cap is reached, a later extractor (URL) contributes no further targets", () => {
		// pushTarget's own entry-guard must stop a DIFFERENT extractor's call
		// once a PRIOR extractor already filled the accumulator to the cap —
		// exercised only when two extractors share one `acc` within the same
		// extractBashTargets call.
		expect(
			extractResolvedTargets(
				"Bash",
				{ command: "rm -rf /a /b /c /d /e && curl https://example.com/x" },
				makeRule(),
			),
		).toEqual([
			{ kind: "file", value: "/a" },
			{ kind: "file", value: "/b" },
			{ kind: "file", value: "/c" },
			{ kind: "file", value: "/d" },
			{ kind: "file", value: "/e" },
		]);
	});

	it("does not trigger on a quoted 'rm' that isn't a real unquoted command word", () => {
		// The trigger regex runs on the RAW (quote-including) text, where the
		// quote characters break every boundary alternative around "rm" — a
		// mutant that forces the gate to always fire would still find a bare
		// "rm" token once the tokenizer strips the quotes off, so this only
		// distinguishes a broken gate, not a broken tokenizer.
		expect(extractResolvedTargets("Bash", { command: 'echo "rm" -rf /tmp/x' }, makeRule())).toEqual(
			[],
		);
	});
});

describe("extractResolvedTargets — Bash: URL targets", () => {
	it("extracts a URL following curl", () => {
		expect(
			extractResolvedTargets("Bash", { command: "curl https://example.com/a" }, makeRule()),
		).toEqual([{ kind: "url", value: "https://example.com/a" }]);
	});

	it("extracts a URL following wget", () => {
		expect(
			extractResolvedTargets("Bash", { command: "wget http://foo.test/path" }, makeRule()),
		).toEqual([{ kind: "url", value: "http://foo.test/path" }]);
	});

	it("extracts multiple URLs from the same command, in order", () => {
		expect(
			extractResolvedTargets(
				"Bash",
				{ command: "curl https://example.com/a https://example.com/b" },
				makeRule(),
			),
		).toEqual([
			{ kind: "url", value: "https://example.com/a" },
			{ kind: "url", value: "https://example.com/b" },
		]);
	});

	it("does not extract a URL-shaped substring when neither curl nor wget is present", () => {
		expect(
			extractResolvedTargets(
				"Bash",
				{ command: "echo https://example.com/should-not-trigger" },
				makeRule(),
			),
		).toEqual([]);
	});
});

describe("extractResolvedTargets — Bash: git push branch", () => {
	it("extracts the branch (second positional after push)", () => {
		expect(
			extractResolvedTargets("Bash", { command: "git push origin feature/foo" }, makeRule()),
		).toEqual([{ kind: "branch", value: "feature/foo" }]);
	});

	it("skips flags between push and the positionals", () => {
		expect(
			extractResolvedTargets("Bash", { command: "git push --force origin main" }, makeRule()),
		).toEqual([{ kind: "branch", value: "main" }]);
	});

	it("does not extract a branch when there are fewer than two positionals", () => {
		expect(extractResolvedTargets("Bash", { command: "git push" }, makeRule())).toEqual([]);
	});

	it("does not extract (and does not crash) when there is exactly ONE positional after push", () => {
		// `if (positionals.length >= 2)` guards `nonNull(positionals[1])` just below it.
		// The zero-positional case above ("git push") stays a no-op even if that
		// threshold regresses to `>= 1` (0 is still not >= 1) — only a bare
		// single-remote push (`git push origin`, entirely ordinary: it pushes the
		// current branch to its tracked remote) lands on the boundary. Proven via
		// scratch/audit-rulematching-branchcount-probe.mts: loosening the guard to
		// `>= 1` throws `nonNull: expected a value but received null/undefined` on
		// this exact input while every other case in this describe block still
		// passes unchanged.
		expect(extractResolvedTargets("Bash", { command: "git push origin" }, makeRule())).toEqual([]);
	});

	it("resolves `git` by basename when invoked via an absolute path", () => {
		expect(
			extractResolvedTargets("Bash", { command: "/usr/bin/git push origin main" }, makeRule()),
		).toEqual([{ kind: "branch", value: "main" }]);
	});

	it("finds nothing when the `git`/`push` trigger substring is inside a quoted argument, not real tokens", () => {
		// The outer trigger regex matches on raw text (quotes don't count for
		// it), but the token-level git/push scan must fail to find a
		// discrete "git" token here — the whole phrase is one quoted token.
		expect(
			extractResolvedTargets("Bash", { command: 'echo "not really git push"' }, makeRule()),
		).toEqual([]);
	});

	it("does not mistake a decoy 'push' token for the real one when it precedes the actual git token", () => {
		expect(
			extractResolvedTargets("Bash", { command: "sudo push git push origin main" }, makeRule()),
		).toEqual([{ kind: "branch", value: "main" }]);
	});

	it("finds nothing when git IS present but no `push` token follows it", () => {
		expect(
			extractResolvedTargets(
				"Bash",
				{ command: 'git commit -m "git push later"' },
				makeRule(),
			),
		).toEqual([]);
	});

	it("does not emit a phantom empty positional for consecutive whitespace between push and its args", () => {
		expect(
			extractResolvedTargets("Bash", { command: "git push  origin main" }, makeRule()),
		).toEqual([{ kind: "branch", value: "main" }]);
	});

	it("triggers the git-push gate across multiple spaces between `git` and `push`", () => {
		// The trigger regex requires one-or-more whitespace between the two
		// words; a mutant narrowing that to "exactly one" would reject this.
		expect(
			extractResolvedTargets("Bash", { command: "git  push origin main" }, makeRule()),
		).toEqual([{ kind: "branch", value: "main" }]);
	});

	it("does not scan for a branch when git and push are not adjacent (gate must gate)", () => {
		// "git" and "push" both appear as tokens here, non-adjacently, so the
		// token-level scan WOULD find a (bogus) branch if ever invoked — the
		// outer `\bgit\s+push\b` gate must be what prevents that.
		expect(
			extractResolvedTargets(
				"Bash",
				{ command: "git status; do the push origin main later" },
				makeRule(),
			),
		).toEqual([]);
	});

	it("scans past an earlier, non-adjacent `git` token to find the `push` that actually follows a LATER one", () => {
		// The token-level "git" search (like the decoy-`push` case above)
		// finds the FIRST "git" token, which need not be the one immediately
		// followed by "push" — the gate only requires SOME "git"+"push" pair
		// adjacent in the raw text, not that it be the first "git". The
		// internal "push" search must then advance past every token between
		// that first "git" and the real "push" several tokens later.
		expect(
			extractResolvedTargets(
				"Bash",
				{ command: "git status && git push origin release-branch" },
				makeRule(),
			),
		).toEqual([{ kind: "branch", value: "release-branch" }]);
	});

	it("does not trigger on a quoted 'git' that isn't a real unquoted command word", () => {
		// Mirrors the quoted-'rm' case: the raw-text gate is blocked by the
		// quote character sitting directly between "git" and the required
		// whitespace, even though "push" and its args are real bare tokens.
		expect(
			extractResolvedTargets("Bash", { command: 'echo "git" push origin main' }, makeRule()),
		).toEqual([]);
	});
});

describe("extractResolvedTargets — write-like tools", () => {
	it.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])(
		"extracts file_path for %s",
		(toolName) => {
			expect(extractResolvedTargets(toolName, { file_path: "/src/foo.ts" }, makeRule())).toEqual([
				{ kind: "file", value: "/src/foo.ts" },
			]);
		},
	);

	it("matches tool names case-insensitively", () => {
		expect(extractResolvedTargets("write", { file_path: "/src/lower.ts" }, makeRule())).toEqual([
			{ kind: "file", value: "/src/lower.ts" },
		]);
	});

	it("returns no targets when file_path is absent", () => {
		expect(extractResolvedTargets("Write", {}, makeRule())).toEqual([]);
	});

	it("returns no targets for a tool that is neither Bash, write-like, WebFetch, nor mcp__*", () => {
		expect(extractResolvedTargets("Read", { file_path: "/src/foo.ts" }, makeRule())).toEqual([]);
	});

	it("returns no targets when toolName is an empty string (the `||` fallback path)", () => {
		expect(extractResolvedTargets("", { file_path: "/src/foo.ts" }, makeRule())).toEqual([]);
	});

	it("returns no targets when file_path is present but not a string", () => {
		expect(extractResolvedTargets("Write", { file_path: 12345 }, makeRule())).toEqual([]);
	});
});

describe("extractResolvedTargets — WebFetch", () => {
	it("extracts the url field", () => {
		expect(extractResolvedTargets("WebFetch", { url: "https://x.test" }, makeRule())).toEqual([
			{ kind: "url", value: "https://x.test" },
		]);
	});

	it("returns no targets when url is absent", () => {
		expect(extractResolvedTargets("WebFetch", {}, makeRule())).toEqual([]);
	});

	it("returns no targets when url is present but not a string", () => {
		expect(extractResolvedTargets("WebFetch", { url: 12345 }, makeRule())).toEqual([]);
	});
});

describe("extractResolvedTargets — mcp__ tools", () => {
	it("classifies url / branch / table / recipient(to) / file(path) suffixes up to the cap", () => {
		expect(
			extractResolvedTargets(
				"mcp__github__create_pull_request",
				{
					url: "https://github.com/x",
					target_branch: "main",
					table: "users",
					to: "someone@example.com",
					repo_path: "/repo",
				},
				makeRule(),
			),
		).toEqual([
			{ kind: "url", value: "https://github.com/x" },
			{ kind: "branch", value: "main" },
			{ kind: "table", value: "users" },
			{ kind: "recipient", value: "someone@example.com" },
			{ kind: "file", value: "/repo" },
		]);
	});

	it("classifies the recipient kind via both the `to` and `_recipient` suffixes", () => {
		expect(
			extractResolvedTargets(
				"mcp__slack__send_message",
				{ recipient: "a@example.com", notify_to: "b@example.com" },
				makeRule(),
			),
		).toEqual([
			{ kind: "recipient", value: "a@example.com" },
			{ kind: "recipient", value: "b@example.com" },
		]);
	});

	it("falls back to `package` for _id / _name / bare id / bare name keys", () => {
		expect(
			extractResolvedTargets(
				"mcp__registry__publish_package",
				{
					package_id: "abc123",
					owner_name: "quentincody",
					id: "bare-id-value",
					name: "bare-name-value",
				},
				makeRule(),
			),
		).toEqual([
			{ kind: "package", value: "abc123" },
			{ kind: "package", value: "quentincody" },
			{ kind: "package", value: "bare-id-value" },
			{ kind: "package", value: "bare-name-value" },
		]);
	});

	it("skips unclassifiable keys and non-string values", () => {
		expect(
			extractResolvedTargets(
				"mcp__registry__publish_package",
				{ random_field: "unclassified", count: 5 },
				makeRule(),
			),
		).toEqual([]);
	});

	it("skips a non-string value even when its key WOULD classify (e.g. a numeric target_url)", () => {
		// Distinct from the case above: "random_field"/"count" never classify
		// to a kind at all, so a broken type-guard there is unobservable
		// through this key. "target_url" DOES classify (suffix "url"), so a
		// disabled type-guard would forward the raw number straight into
		// pushTarget, which calls `.trim()` on it.
		expect(
			extractResolvedTargets("mcp__webhook__register", { target_url: 12345 }, makeRule()),
		).toEqual([]);
	});

	it("caps mcp targets at MAX_RESOLVED_TARGETS (5), dropping later classifiable fields", () => {
		const targets = extractResolvedTargets(
			"mcp__github__create_pull_request",
			{
				url: "https://github.com/x",
				target_branch: "main",
				table: "users",
				to: "someone@example.com",
				repo_path: "/repo",
				package_id: "abc123",
				owner_name: "quentincody",
			},
			makeRule(),
		);
		expect(targets).toHaveLength(5);
		expect(targets.some((t) => t.kind === "package")).toBe(false);
	});
});
