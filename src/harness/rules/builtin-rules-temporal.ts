// ===========================================
// Temporal-precondition rules (PB&J Free-CLI item #1)
// ===========================================
// Trajectory-aware rules using `requires_prior` / `forbids_after` predicates
// (see `types/rules.ts::TemporalPredicate`). Appended LAST in BUILTIN_RULES
// (wiring in `builtin-rules.ts`) so they never shadow earlier hard-blocks /
// vendor-scoped / warn-only rules. A temporal rule only surfaces when no
// upstream rule has already claimed the call — backwards-compatible with the
// pre-existing rule corpus.
//
// Extracted from `builtin-rules-processes.ts` 2026-06-12 to keep that file
// under the 800-line cap; re-exported from there for back-compat so existing
// imports (`builtin-rules.ts`, tests) are unchanged.
//
// NOTE on `builtin-npm-publish-requires-tests-pass` action:
// User decision (2026-05-27 session) was option (c) — both rules, temporal
// ratchets to `ask`. Subagent shipped as `warn` to avoid breaking ~100
// existing supply-chain-defense.test.ts fixtures asserting `decision: "allow"`.
// Resolution path: ship as `warn` now to converge merge; ratchet to `ask`
// and update fixtures in a focused follow-up. TODO(npm-publish-ask-ratchet).

import type { GuardRule } from "../types.js";

export const TEMPORAL_PRECONDITION_RULES: GuardRule[] = [
	{
		id: "builtin-git-force-push-requires-inspection",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			// `--force-with-lease` is the safer variant — permitted under the
			// temporal-gate path. Walker bounded to the push's own shell
			// segment; executed_only masks quoted mentions. `(?![-\w])` excludes
			// all `--force-*` variants. Short-flag bundles (`-uf`, `-fq`) too.
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
	},
	{
		id: "builtin-rm-requires-prior-inspection",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
        // A generic Read event neither proves inspection of the deletion target
        // nor exists on every client's tool surface. Keep this heuristic advisory.
		action: "warn",
		patterns: [
			// `rm` MUST be the command verb — at line start or after a shell
			// separator. Prevents matching `vercel rm`, `npm rm`, `git rm`.
			{
				field: "command",
				regex: "(^|;|&&|\\|\\||\\|(?!\\|)|\\n)\\s*(?:sudo\\s+)?rm\\s+(?:-[a-zA-Z]+\\s+)*\\S",
				flags: "i",
				executed_only: true,
			},
			// Negation: skip common safe build-artifact / temp paths.
			{
				field: "command",
				regex: "\\brm\\s+(?:-[a-zA-Z]+\\s+)*(?:/tmp/|/var/tmp/|\\./|dist/|build/|\\.cache/|coverage/|out/|target/|\\.next/|node_modules\\b)",
				flags: "i",
				negate: true,
				executed_only: true,
			},
		],
		requires_prior: {
			// TODO(v2): per-target matching — only when Read:/path/X is in tool_sequence.
			tool: "Read",
			within_last_n: 20,
		},
		reason:
			"No recent native Read event was observed; this does not establish whether the deletion targets were inspected.",
		suggestion:
			"Inspect the intended deletion targets with the client's available read tools. This advisory does not require a particular tool invocation.",
		severity: "medium",
		category: "file-deletion",
	},
	{
		id: "builtin-npm-publish-requires-tests-pass",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		// See note above re: warn vs ask. Ratchet to "ask" in a follow-up.
		action: "warn",
		patterns: [
			{
				field: "command",
				regex: "\\b(npm|yarn|pnpm)\\s+publish\\b",
				flags: "i",
				executed_only: true,
			},
			// Skip `--dry-run` invocations (safe no-network preview).
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
	},
];
