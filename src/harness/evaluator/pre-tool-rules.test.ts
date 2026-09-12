// Covers the `bash-code-file-write-bypass` block in evaluateDestructiveRules.
// `pre-tool-rules.ts` is a low-coverage module whose remediation message
// previously pointed agents at the now-removed MultiEdit tool; this test pins
// the message to the real primitive (`interlinked write --batch`) and is
// filename-corresponding so the per-edit overlay selects it (finding 2026-06:
// the block was full-suite-covered via supply-chain-defense.test.ts but the
// scoped overlay under-selected, so editing the message tripped the
// uncovered-added-line gate).

import { makeSession as makeSessionFixture } from "../__tests__/fixtures/evaluator.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../rules-loader.js";
import type { GuardRule, GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { evaluateDestructiveRules } from "./pre-tool-rules.js";

function withCustomRule(rule: GuardRule): GuardRulesConfig {
	const base = getDefaultConfig();
	return { ...base, rules: [rule, ...base.rules] };
}

function baseRule(overrides: Partial<GuardRule>): GuardRule {
	return {
		id: "custom-test-rule",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		action: "warn",
		patterns: [],
		reason: "custom test rule",
		severity: "low",
		...overrides,
	};
}

function bashEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "pre-tool-rules-test",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-06-15T00:00:00Z",
	};
}

describe("evaluateDestructiveRules — bash-code-file-write-bypass", () => {
	it("handles a tool event with no argument object without inventing a destructive command", () => {
		const event: HarnessEvent = { ...bashEvent(""), tool_input: undefined };
		expect(evaluateDestructiveRules(event, getDefaultConfig(), undefined, [])).toBeNull();
	});
	it("blocks a shell redirect to a code file and recommends the real atomic primitive", () => {
		const decision = evaluateDestructiveRules(
			bashEvent("echo x > src/foo.ts"),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("bash-code-file-write-bypass");
		// The remediation must name an AVAILABLE primitive, never the removed
		// MultiEdit tool (finding 2026-06; MultiEdit is gone from Claude Code).
		expect(decision?.reason).toContain("Write or Edit tool");
	});

	// Rewritten 2026-08-05. The old message answered a coordinated multi-site
	// edit with `interlinked write --batch <manifest.json>` — a FILE path. That
	// is what taught agents to stage manifests in the session scratchpad: ~40
	// recorded multi-edit invocations, every one via a scratchpad manifest, for
	// a capability stdin already had. Two obligations on this message now:
	it("points at ordinary sequential edits, since transient debt defers the intermediate", () => {
		const decision = evaluateDestructiveRules(
			bashEvent("echo x > src/foo.ts"),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.reason).toContain("transient debt");
	});

	it("never steers toward staging a manifest FILE — stdin only", () => {
		const reason =
			evaluateDestructiveRules(bashEvent("echo x > src/foo.ts"), getDefaultConfig(), undefined, [])
				?.reason ?? "";
		expect(reason).toContain("--stdin");
		expect(reason).not.toContain("<manifest.json>");
	});

	it("does not block a redirect to a non-code file", () => {
		const decision = evaluateDestructiveRules(
			bashEvent("echo x > notes.txt"),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.rule_id).not.toBe("bash-code-file-write-bypass");
	});
});

describe("evaluateDestructiveRules — out-of-repo scratch/ steer (warn-only, 2026-07-07)", () => {
	function bashEventWithCwd(command: string): HarnessEvent {
		return { ...bashEvent(command), cwd: "/Users/dev/project" };
	}

	it("warns (never blocks) on a code-file write outside the repo, steering to scratch/", () => {
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd("echo x > /tmp/probe.mts"),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(decision?.rule_id).not.toBe("bash-code-file-write-bypass");
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(true);
		expect(warnings.join("\n")).toContain("scratch/");
	});

	it("does NOT emit the steer for an in-repo code write (the block path owns it)", () => {
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd("echo x > src/foo.ts"),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(decision?.rule_id).toBe("bash-code-file-write-bypass");
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(false);
	});

	it("does NOT emit the steer for non-code out-of-repo writes", () => {
		const warnings: string[] = [];
		evaluateDestructiveRules(
			bashEventWithCwd("echo x > /tmp/notes.txt"),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(false);
	});
});

describe("evaluateDestructiveRules — scratchpad code-write block (2026-07-09)", () => {
	// The fixture session id must appear as a path segment for the
	// session-scratchpad triad to match (see sessionScratchpadAllows).
	const SCRATCHPAD = "/tmp/claude-501/-Users-dev-project/pre-tool-rules-test/scratchpad";

	function bashEventWithCwd(command: string): HarnessEvent {
		return { ...bashEvent(command), cwd: "/Users/dev/project" };
	}

	it("blocks a redirect into THIS session's scratchpad with the scratch/ redirect", () => {
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd(`echo x > ${SCRATCHPAD}/probe.ts`),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-scratchpad-code-write");
		expect(decision?.reason).toContain("scratch/");
	});

	it("blocks the $VAR form once the assignment resolves to the scratchpad", () => {
		const decision = evaluateDestructiveRules(
			bashEventWithCwd(`SCRATCH=${SCRATCHPAD} && cat > $SCRATCH/draft.ts <<'EOF'\nx\nEOF`),
			getDefaultConfig(),
			undefined,
			[],
		);
		expect(decision?.rule_id).toBe("builtin-scratchpad-code-write");
	});

	it("keeps the warn-only steer for a DIFFERENT session's scratchpad", () => {
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd("echo x > /tmp/claude-501/-Users-dev-project/other-session/scratchpad/probe.ts"),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(decision?.rule_id).not.toBe("builtin-scratchpad-code-write");
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(true);
	});

	it("keeps the warn-only steer for non-scratchpad out-of-repo code writes", () => {
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEventWithCwd("echo x > /tmp/probe.mts"),
			getDefaultConfig(),
			undefined,
			warnings,
		);
		expect(decision?.rule_id).not.toBe("builtin-scratchpad-code-write");
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(true);
	});

	it("honors the INTERLINKED_DISABLE_SCRATCH_GUARD escape hatch (warn instead)", () => {
		process.env.INTERLINKED_DISABLE_SCRATCH_GUARD = "1";
		try {
			const warnings: string[] = [];
			const decision = evaluateDestructiveRules(
				bashEventWithCwd(`echo x > ${SCRATCHPAD}/probe.ts`),
				getDefaultConfig(),
				undefined,
				warnings,
			);
			expect(decision?.rule_id).not.toBe("builtin-scratchpad-code-write");
			expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(true);
		} finally {
			delete process.env.INTERLINKED_DISABLE_SCRATCH_GUARD;
		}
	});
});

describe("evaluateDestructiveRules — rewrite action", () => {
	it("rewrites the command and returns allow with updated_input when the rewrite changes it", () => {
		const rule = baseRule({
			id: "custom-rewrite",
			action: "rewrite",
			patterns: [{ field: "command", regex: "foo" }],
			rewrite: { field: "command", match: "foo", replace: "bar" },
		});
		const decision = evaluateDestructiveRules(
			bashEvent("run foo now"),
			withCustomRule(rule),
			undefined,
			[],
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.rule_id).toBe("custom-rewrite");
		expect(decision?.updated_input).toEqual({ command: "run bar now" });
	});

	it("falls through to the generic warning when the rewrite produces no change", () => {
		const rule = baseRule({
			id: "custom-rewrite-noop",
			action: "rewrite",
			patterns: [{ field: "command", regex: "foo" }],
			rewrite: { field: "command", match: "zzz-nomatch", replace: "bar" },
		});
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEvent("run foo now"),
			withCustomRule(rule),
			undefined,
			warnings,
		);
		expect(decision).toBeNull();
		expect(warnings).toContain("[interlinked] Warning: custom test rule");
	});

	it("falls through to the generic warning when action is rewrite but rule.rewrite is missing", () => {
		const rule = baseRule({
			id: "custom-rewrite-no-spec",
			action: "rewrite",
			patterns: [{ field: "command", regex: "foo" }],
		});
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEvent("run foo now"),
			withCustomRule(rule),
			undefined,
			warnings,
		);
		expect(decision).toBeNull();
		expect(warnings).toContain("[interlinked] Warning: custom test rule");
	});
});

describe("evaluateDestructiveRules — soft_block action", () => {
	function softBlockRule(): GuardRule {
		return baseRule({
			id: "custom-soft-block",
			action: "soft_block",
			patterns: [{ field: "command", regex: "danger-op" }],
		});
	}

	function emptySession(): SessionTrajectory {
		return ({ ...makeSessionFixture(),
			session_id: "soft-block-session",
			tool_sequence: [],
			commands_run: [],
			files_read: new Set(),
			files_written: new Set(),
			verification_observed: new Set(),
			soft_blocks: new Set<string>(),
		} satisfies SessionTrajectory);
	}

	it("blocks on the first attempt and records the soft-block key on the session", () => {
		const session = emptySession();
		const decision = evaluateDestructiveRules(
			bashEvent("danger-op now"),
			withCustomRule(softBlockRule()),
			session,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("custom-soft-block");
		expect(session.soft_blocks.has("custom-soft-block::danger-op now")).toBe(true);
	});

	it("allows retry (warn instead of block) once the same key is already soft-blocked", () => {
		const session = emptySession();
		session.soft_blocks.add("custom-soft-block::danger-op now");
		const warnings: string[] = [];
		const decision = evaluateDestructiveRules(
			bashEvent("danger-op now"),
			withCustomRule(softBlockRule()),
			session,
			warnings,
		);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("Warning (retry allowed)"))).toBe(true);
		expect(warnings).toContain("[interlinked] Warning: custom test rule");
	});
});

describe("evaluateDestructiveRules — applies_to_roles gating", () => {
	it("skips a rule scoped to a role the event does not carry", () => {
		const rule = baseRule({
			id: "custom-role-scoped",
			action: "block",
			patterns: [{ field: "command", regex: "role-only-op" }],
			applies_to_roles: ["lead"],
		});
		const event = ({  ...bashEvent("role-only-op"), agent_role: "worker" } satisfies HarnessEvent);
		const decision = evaluateDestructiveRules(event, withCustomRule(rule), undefined, []);
		expect(decision?.rule_id).not.toBe("custom-role-scoped");
	});
});

describe("evaluateDestructiveRules — scratchpad_guard.code_write_mode 'off'", () => {
	it("emits no scratch warning at all when the mode is off", () => {
		const base = getDefaultConfig();
		const rules: GuardRulesConfig = { ...base, scratchpad_guard: { code_write_mode: "off" } };
		const warnings: string[] = [];
		const event = ({  ...bashEvent("echo x > /tmp/probe.mts"), cwd: "/Users/dev/project" } satisfies HarnessEvent);
		const decision = evaluateDestructiveRules(event, rules, undefined, warnings);
		expect(decision).toBeNull();
		expect(warnings.some((w) => w.includes("[interlinked:scratch]"))).toBe(false);
	});
});

describe("evaluateDestructiveRules — compound command block/rewrite (anchored per-subcommand match)", () => {
	it("blocks on a subcommand whose anchored pattern only matches once isolated", () => {
		const rule = baseRule({
			id: "custom-anchored-block",
			action: "block",
			patterns: [{ field: "command", regex: "^rm -rf" }],
		});
		const decision = evaluateDestructiveRules(
			bashEvent("echo hi && rm -rf /tmp/x"),
			withCustomRule(rule),
			undefined,
			[],
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("custom-anchored-block");
	});

	it("rewrites a subcommand and returns allow with the joined updated command", () => {
		const rule = baseRule({
			id: "custom-anchored-rewrite",
			action: "rewrite",
			patterns: [{ field: "command", regex: "^foo" }],
			rewrite: { field: "command", match: "^foo", replace: "bar" },
		});
		const decision = evaluateDestructiveRules(
			bashEvent("echo hi && foo test"),
			withCustomRule(rule),
			undefined,
			[],
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.updated_input).toEqual({ command: "echo hi && bar test" });
	});
});

describe("evaluateDestructiveRules — missing tool_name", () => {
	it("does not crash and evaluates cleanly when tool_name is absent", () => {
		const event = ({  ...bashEvent("echo hi"), tool_name: undefined } satisfies HarnessEvent);
		const decision = evaluateDestructiveRules(event, getDefaultConfig(), undefined, []);
		expect(decision).toBeNull();
	});
});

describe("evaluateDestructiveRules — builtin-patch-applier (exec-time, gap 5)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pre-tool-rules-applier-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("blocks a Bash command that executes a pre-existing hand-rolled patch-applier script", () => {
		const script = join(root, "apply.mjs");
		writeFileSync(script, "import fs from 'node:fs';\nfs.writeFileSync('src/harness/x.ts', body);\n");
		const event = ({
			...bashEvent(`node ${script}`),
			cwd: root,
		} satisfies HarnessEvent);
		const decision = evaluateDestructiveRules(event, getDefaultConfig(), undefined, []);
		expect(decision?.decision).toBe("block");
		expect(decision?.rule_id).toBe("builtin-patch-applier");
		// The reason must name the actual offending script and write call, not
		// just a generic "blocked" — that's the observable a reviewer reads.
		expect(decision?.reason).toContain("apply.mjs");
		expect(decision?.reason).toContain("writeFileSync");
	});

	it("does not block executing an ordinary script with no repo-source write", () => {
		const script = join(root, "check.mjs");
		writeFileSync(script, "console.log('just checking');\n");
		const event = ({
			...bashEvent(`node ${script}`),
			cwd: root,
		} satisfies HarnessEvent);
		const decision = evaluateDestructiveRules(event, getDefaultConfig(), undefined, []);
		expect(decision?.rule_id).not.toBe("builtin-patch-applier");
	});
});
