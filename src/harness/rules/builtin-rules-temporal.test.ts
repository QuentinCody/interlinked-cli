// Temporal-precondition rules — registry shape + the force-push pattern
// hardening that landed during the destructive_command_guard adoption
// (segment-bounded walker, executed_only masking, bundled short flags).
// The temporal GATING (requires_prior / forbids_after) is exercised through
// the evaluator in temporal-rules.test.ts; here we pin the raw patterns.

import { describe, expect, it } from "vitest";
import { extractScannableText } from "../evaluator/spans.js";
import type { GuardRule } from "../types.js";
import { TEMPORAL_PRECONDITION_RULES } from "./builtin-rules-temporal.js";

const forcePush = TEMPORAL_PRECONDITION_RULES.find(
	(r) => r.id === "builtin-git-force-push-requires-inspection",
);

/** Mirror the evaluator's executed_only projection so these unit tests match
 *  live behavior (quoted/heredoc-data mentions are masked before matching). */
function ruleMatches(command: string): boolean {
	if (!forcePush) throw new Error("force-push rule missing");
	const positives = forcePush.patterns.filter((p) => !p.negate);
	const negatives = forcePush.patterns.filter((p) => p.negate);
	const project = (p: { executed_only?: boolean }) =>
		p.executed_only ? extractScannableText(command) : command;
	const anyPositive = positives.some((p) =>
		new RegExp(p.regex, p.flags || "i").test(project(p)),
	);
	if (!anyPositive) return false;
	return !negatives.some((p) => new RegExp(p.regex, p.flags || "i").test(project(p)));
}

describe("TEMPORAL_PRECONDITION_RULES — registry shape", () => {
	it("exports the three temporal rules", () => {
		const ids = TEMPORAL_PRECONDITION_RULES.map((r) => r.id);
		expect(ids).toContain("builtin-git-force-push-requires-inspection");
		expect(ids).toContain("builtin-rm-requires-prior-inspection");
		expect(ids).toContain("builtin-npm-publish-requires-tests-pass");
	});

	it("every rule declares a temporal predicate", () => {
		for (const r of TEMPORAL_PRECONDITION_RULES) {
			expect(r.requires_prior || r.forbids_after).toBeTruthy();
		}
	});
});

describe("force-push pattern — fires on real force pushes", () => {
	it("matches --force", () => {
		expect(ruleMatches("git push --force origin main")).toBe(true);
	});
	it("matches a bare -f", () => {
		expect(ruleMatches("git push -f origin main")).toBe(true);
	});
	it("matches bundled short flags (-uf, -fq, -vf)", () => {
		expect(ruleMatches("git push -uf origin main")).toBe(true);
		expect(ruleMatches("git push -fq origin main")).toBe(true);
		expect(ruleMatches("git push -vf")).toBe(true);
	});
	it("matches --force after other flags/args", () => {
		expect(ruleMatches("git push origin main --force")).toBe(true);
		expect(ruleMatches("git push --set-upstream origin feat --force")).toBe(true);
	});
});

describe("force-push pattern — does not fire on safe variants", () => {
	it("ignores --force-with-lease", () => {
		expect(ruleMatches("git push --force-with-lease origin main")).toBe(false);
	});
	it("ignores --force-with-lease --force-if-includes", () => {
		expect(ruleMatches("git push --force-with-lease --force-if-includes")).toBe(false);
	});
	it("ignores a plain push", () => {
		expect(ruleMatches("git push origin main")).toBe(false);
	});
});

describe("force-push pattern — boundary + data discipline", () => {
	it("does not span a shell separator (echo --force after &&)", () => {
		expect(ruleMatches("git push origin main && echo --force")).toBe(false);
	});
	it("does not fire on a quoted mention (executed_only masking)", () => {
		expect(ruleMatches('echo "git push --force"')).toBe(false);
		expect(ruleMatches("git commit -m 'mention git push --force in the message'")).toBe(false);
	});
	it("still fires inside an inline-exec payload (bash -c)", () => {
		expect(ruleMatches("bash -c 'git push --force origin main'")).toBe(true);
	});
});

// The describe blocks above only pin the force-push rule's own patterns;
// `enabled`/`trigger`/`tool_match`/`action`/`severity`/`category`/`reason`/
// `suggestion`/`requires_prior` were previously unchecked on ANY of the three
// rules, and the rm / npm-publish rules' `patterns` (including their regex
// strings) had no coverage at all — `"exports the three temporal rules"`
// only checks id membership, and `"every rule declares a temporal
// predicate"` only checks requires_prior/forbids_after truthiness (which a
// `requires_prior: {}` mutant still satisfies, since `{}` is truthy).

function byTemporalId(id: string): GuardRule {
	const r = TEMPORAL_PRECONDITION_RULES.find((rule) => rule.id === id);
	if (!r) throw new Error(`rule ${id} missing`);
	return r;
}

describe("TEMPORAL_PRECONDITION_RULES — full field pin (every literal, all three rules)", () => {
	it("pins every field of the force-push rule verbatim", () => {
		expect(byTemporalId("builtin-git-force-push-requires-inspection")).toEqual({
			id: "builtin-git-force-push-requires-inspection",
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["Bash", "Shell", "run_command"],
			action: "ask",
			patterns: [
				{
					field: "command",
					regex: "\\bgit\\s+push\\b[^;&|<>()\\n]*?--force(?![-\\w])",
					executed_only: true,
				},
				{
					field: "command",
					regex: "\\bgit\\s+push\\b[^;&|<>()\\n]*?\\s-[a-zA-Z]*f[a-zA-Z]*\\b",
					executed_only: true,
				},
			],
			requires_prior: {
				bash_match: "git\\s+(log|diff|status)\\b",
				within_last_n: 10,
			},
			reason:
				"git push --force without a prior `git log` / `git diff` / `git status` in the last 10 commands is risky — run one of those first to confirm what's being pushed.",
			suggestion:
				"Run `git log origin/<branch>..HEAD` or `git diff origin/<branch>` before force-pushing to see what is about to be overwritten on the remote.",
			severity: "high",
			category: "git-operations",
		});
	});

	it("pins every field of the rm rule verbatim", () => {
		expect(byTemporalId("builtin-rm-requires-prior-inspection")).toEqual({
			id: "builtin-rm-requires-prior-inspection",
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["Bash", "Shell", "run_command"],
			action: "warn",
			patterns: [
				{
					field: "command",
					regex: "(^|;|&&|\\|\\||\\|(?!\\|)|\\n)\\s*(?:sudo\\s+)?rm\\s+(?:-[a-zA-Z]+\\s+)*\\S",
					flags: "i",
					executed_only: true,
				},
				{
					field: "command",
					regex:
						"\\brm\\s+(?:-[a-zA-Z]+\\s+)*(?:/tmp/|/var/tmp/|\\./|dist/|build/|\\.cache/|coverage/|out/|target/|\\.next/|node_modules\\b)",
					flags: "i",
					negate: true,
					executed_only: true,
				},
			],
			requires_prior: {
				tool: "Read",
				within_last_n: 20,
			},
			reason:
				"No recent native Read event was observed; this does not establish whether the deletion targets were inspected.",
			suggestion:
				"Inspect the intended deletion targets with the client's available read tools. This advisory does not require a particular tool invocation.",
			severity: "medium",
			category: "file-deletion",
		});
	});

	it("pins every field of the npm-publish rule verbatim", () => {
		expect(byTemporalId("builtin-npm-publish-requires-tests-pass")).toEqual({
			id: "builtin-npm-publish-requires-tests-pass",
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["Bash", "Shell", "run_command"],
			action: "warn",
			patterns: [
				{
					field: "command",
					regex: "\\b(npm|yarn|pnpm)\\s+publish\\b",
					flags: "i",
					executed_only: true,
				},
				{ field: "command", regex: "--dry-run\\b", negate: true },
			],
			requires_prior: {
				verification_kind: "test",
				within_last_n: 50,
			},
			reason:
				"Publishing without running the test suite in this session is risky — run tests first.",
			suggestion:
				"Run `npm test` (or your project's test command) before `npm publish`. Any test run in the session unlocks publish.",
			severity: "high",
			category: "supply-chain",
		});
	});
});

/** Generalized version of `ruleMatches` above, parametrized by rule — proves
 *  the rm / npm-publish patterns actually fire correctly (not just that their
 *  config strings are pinned): same executed_only projection as the real
 *  evaluator. */
function matches(rule: GuardRule | undefined, command: string): boolean {
	if (!rule) throw new Error("rule missing");
	const positives = rule.patterns.filter((p) => !p.negate);
	const negatives = rule.patterns.filter((p) => p.negate);
	const project = (p: { executed_only?: boolean }) =>
		p.executed_only ? extractScannableText(command) : command;
	const anyPositive = positives.some((p) => new RegExp(p.regex, p.flags || "i").test(project(p)));
	if (!anyPositive) return false;
	return !negatives.some((p) => new RegExp(p.regex, p.flags || "i").test(project(p)));
}

const rmRule = TEMPORAL_PRECONDITION_RULES.find(
	(r) => r.id === "builtin-rm-requires-prior-inspection",
);
const publishRule = TEMPORAL_PRECONDITION_RULES.find(
	(r) => r.id === "builtin-npm-publish-requires-tests-pass",
);

describe("rm pattern — fires on real deletions, not on other *rm* verbs", () => {
	it("matches a plain rm of a real path", () => {
		expect(matches(rmRule, "rm important-data.txt")).toBe(true);
	});
	it("matches sudo rm with flags on a real (non-safe-listed) path", () => {
		expect(matches(rmRule, "sudo rm -rf important-secrets/")).toBe(true);
	});
	it("does not match git rm / npm rm / vercel rm (verb-boundary correctness)", () => {
		expect(matches(rmRule, "git rm tracked-file.ts")).toBe(false);
		expect(matches(rmRule, "npm rm left-pad")).toBe(false);
		expect(matches(rmRule, "vercel rm my-deployment")).toBe(false);
	});
});

describe("rm pattern — negation skips safe build/temp paths", () => {
	it("does not fire on dist/, build/, node_modules, or /tmp/ deletions", () => {
		expect(matches(rmRule, "rm -rf dist/")).toBe(false);
		expect(matches(rmRule, "rm -rf build/")).toBe(false);
		expect(matches(rmRule, "rm -rf node_modules")).toBe(false);
		expect(matches(rmRule, "rm /tmp/scratch.txt")).toBe(false);
	});
	it("still fires on a real path that merely starts similarly (no over-broad negation)", () => {
		expect(matches(rmRule, "rm -rf distribution-report.csv")).toBe(true);
	});
});

describe("rm pattern — executed_only masking", () => {
	it("does not fire on a quoted mention", () => {
		expect(matches(rmRule, 'echo "rm important-data.txt"')).toBe(false);
	});
});

describe("npm-publish pattern — fires on npm/yarn/pnpm publish, case-insensitively", () => {
	it("matches npm publish, yarn publish, pnpm publish", () => {
		expect(matches(publishRule, "npm publish")).toBe(true);
		expect(matches(publishRule, "yarn publish")).toBe(true);
		expect(matches(publishRule, "pnpm publish")).toBe(true);
	});
	it("matches case-insensitively", () => {
		expect(matches(publishRule, "NPM PUBLISH")).toBe(true);
	});
	it("does not fire on an unrelated command that merely contains the word publish", () => {
		expect(matches(publishRule, "echo publish notes")).toBe(false);
	});
});

describe("npm-publish pattern — --dry-run negation", () => {
	it("does not fire on a --dry-run invocation", () => {
		expect(matches(publishRule, "npm publish --dry-run")).toBe(false);
	});
});

describe("npm-publish pattern — executed_only masking", () => {
	it("does not fire on a quoted mention", () => {
		expect(matches(publishRule, 'echo "npm publish"')).toBe(false);
	});
});
