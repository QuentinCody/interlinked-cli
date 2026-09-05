// ===========================================
// Rules — Default Config
// ===========================================
// Ships the default `GuardRulesConfig` value with built-in protected-file
// globs, the full quality-check catalog (tsc / biome / mypy / cargo / ...),
// taint tracking, output scanning, structural checks, and project-wide
// sweep defaults.
//
// User rules in `.interlinked/guard-rules.json` and `...local.json` are
// merged on top of this default (see `rules/merge.ts`).

import { DEFAULT_TAINT_CONFIG } from "../taint-tracker.js";
import type { GuardRulesConfig } from "../types.js";
import { DEFAULT_QUALITY_CHECKS } from "./default-config-quality-checks.js";
import {
	DEFAULT_OPF_SIDECAR_SCRIPT,
	DEFAULT_PROTECTED_FILES,
	HIGH_PRECISION_OPF_CALIBRATION_PATH,
	SECONDS_PER_WEEK,
} from "./default-config-resolvers.js";
import { DEFAULT_STRUCTURAL_CHECKS } from "./default-structural.js";

/**
 * Public API — consumed by `rules/loader.ts` via `getDefaultConfig()`
 * and by tests. Do NOT export as a mutable reference — callers should
 * always go through `getDefaultConfig()` which returns a deep clone.
 */
export const DEFAULT_CONFIG: GuardRulesConfig = {
	version: 1,
	enabled: true,
	rules: [],
	protected_files: DEFAULT_PROTECTED_FILES,
	file_reminders: [],
	curl_mcp_detection: {
		enabled: true,
		localhost_ports: [8787, 3000, 4321, 5173, 8080],
		escalate_after: 5,
		message:
			"Agent is curling localhost directly. If an MCP server should be running on this port, it may be disconnected. Consider reconnecting.",
	},
	quality_checks: DEFAULT_QUALITY_CHECKS,
	error_memory: {
		enabled: true,
		max_age_s: SECONDS_PER_WEEK,
		max_records: 5000,
	},
	taint_tracking: DEFAULT_TAINT_CONFIG,
	output_scanning: {
		enabled: true,
		scan_bash_secrets: true,
		scan_web_injection: true,
		scan_file_injection: true,
		max_scan_bytes: 100_000,
	},
	// Extracted to a pure data leaf (default-structural.ts) so browser-bundled
	// surfaces can read the catalog; same object by reference (pinned).
	structural_checks: DEFAULT_STRUCTURAL_CHECKS,
	repo_confinement_allowlist: ["~/.claude"],
	// No linked sibling projects by default — single-root confinement. A
	// multi-repo workspace (e.g. public CLI + private cloud) declares its
	// sibling roots here, relative to the project root.
	linked_projects: [],
	// Path globs that short-circuit the PostToolUse check pipeline entirely.
	// See `SharedConfig.skip_paths` JSDoc in `src/lib/config.ts` and the
	// matcher in `src/lib/path-glob.ts`. Opinionated defaults below cover
	// build artifacts, vendored deps, generated code, lockfiles, and IDE
	// metadata. Per Phase B.2 of `docs/plans/free-cli-adoption/`.
	skip_paths: [
		"dist/**",
		"build/**",
		"out/**",
		"node_modules/**",
		"vendor/**",
		".next/**",
		".nuxt/**",
		".astro/**",
		"target/**",
		".svelte-kit/**",
		"**/generated/**",
		// Brace-alternation `{a,b,c}` is NOT supported by the hook-side
		// inline matcher in `lib/hook-template-chunks/skip-paths.ts` (Phase B.3
		// cuts daemon round-trip). Listing each extension explicitly so the
		// hook-side and daemon-side matchers agree and the path actually
		// short-circuits before opening the harness socket.
		"**/*.generated.ts",
		"**/*.generated.js",
		"**/*.generated.py",
		"**/*.generated.rs",
		"**/*.generated.go",
		"**/*.min.js",
		"**/*.min.css",
		"**/*.bundle.js",
		"**/*.bundle.css",
		"*.lock",
		"**/package-lock.json",
		"**/yarn.lock",
		"**/Cargo.lock",
		"**/uv.lock",
		".git/**",
		".idea/**",
		".vscode/**",
	],
	required_tools: [],
	strict_skips: false,
	skip_allowlist: ["config_disabled", "file_type_mismatch"],
	diff_aware: {
		enabled: false,
		missing_return_types: "baseline",
		complexity: "edit_region",
		no_test_file: "new_files_only",
		undefined_env_vars: "edit_content",
	},
	project_wide_checks: {
		enabled: true,
		edit_interval: 5,
		on_export_change: true,
		tools: ["tsc", "biome"],
		timeout_ms: 30_000,
		severity: "warning",
		max_findings: 20,
	},
	commit_cadence: {
		// Default-on: stderr-only nudges, never block. Stop-hook fires when
		// the agent ends a session with > stop_threshold uncommitted code-file
		// edits; the mid-session backstop is a one-shot for the absurd case
		// of >40 distinct files touched without a commit. Doc/plan files
		// are excluded so transient agent scratch (markdown plans, /docs)
		// doesn't pull the trigger. Token-band escalations only fire at
		// Stop, when the transcript is read once.
		enabled: true,
		stop_threshold: 5,
		mid_session_threshold: 40,
		token_band_low: 200_000,
		token_band_high: 400_000,
		doc_globs: [
			"**/*.md",
			"**/*.mdx",
			"**/*.txt",
			"**/*.rst",
			"docs/**",
			"plans/**",
			"notes/**",
			"**/CLAUDE.md",
			"**/AGENTS.md",
			"**/PLAN*.md",
		],
	},
	verification_stop_checks: {
		// Default-on: stderr-only Stop / SessionEnd reflection nudges, never
		// block. Six independent axes:
		//   - warn_unverified_code: code edits with no tsc/test/lint/build
		//     observed this session (signals captured at PreToolUse).
		//   - warn_verify_not_run: code edits where individual tools ran but
		//     `interlinked verify` (canonical local CI mirror) did not. The
		//     verify suite catches what individual tools miss — docs:check
		//     drift, secrets, SAST findings, dep-audit. A green tsc + npm test
		//     doesn't prove the verify suite is green.
		//   - warn_ui_not_interacted: UI-file edits with no dev-server or
		//     chrome-devtools/playwright MCP call (type-checking is not
		//     feature-checking, per feedback_landing_test_before_push.md).
		//   - warn_stubs_introduced: TODO/FIXME/disabled-test/throw-not-
		//     implemented patterns pushed into Write/Edit content during
		//     the session (scanned at PostToolUse).
		//   - warn_fixture_leaks: untracked src/**/_*.ts-shaped files whose
		//     basename appears in a writeFixture()/setupFixture()/createFixture()
		//     call in a tracked test file — the afterAll cleanup didn't run.
		//   - warn_unresolved_red: a check/test OBSERVED red this session
		//     (tsc/build/lint from observed_checks, plus stayed-red TDD
		//     cycles) that never went green again. Reflection only — the
		//     wording grants the legitimate "meant to leave it red" case.
		// Flip per-kind to false in `.interlinked/guard-rules.local.json` to
		// disable individual checks; flip the master `enabled` to silence
		// all six.
		enabled: true,
		warn_unverified_code: true,
		warn_verify_not_run: true,
		warn_ui_not_interacted: true,
		warn_stubs_introduced: true,
		warn_fixture_leaks: true,
		warn_unresolved_red: true,
		// warn_spec_drift: structural marker/link drift captured at PostToolUse.
		// Inferred prose counts/ranges remain advisory evidence, not Stop nudges.
		warn_spec_drift: true,
		// warn_review_findings: ingested review findings (interlinked
		// findings ingest) with neither a touching edit nor an ack.
		warn_review_findings: true,
		// warn_slow_tests: a test observed running slower than expected this
		// session (measurement integrity, slow-test-stop-check.ts) — a slow
		// test can time out Stryker's mutation dry run and poison
		// kill-measurement for its whole file.
		warn_slow_tests: true,
	},
	// Cross-file spec fact ledger (docs/design/spec-audit-runtime-checks.md
	// §3.2): markdown edits get drift warnings vs the repo-wide fact ledger.
	spec_checks: {
		enabled: true,
	},
	content_scanner: {
		// Off by default — local runtime needs `pip install opf`; users opt in via
		// `.interlinked/guard-rules.local.json` → `"content_scanner": {"enabled": true}`.
		enabled: false,
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
			sidecar_script: DEFAULT_OPF_SIDECAR_SCRIPT,
			// Cold load (first scan includes multi-second model load + JIT warmup).
			startup_timeout_ms: 90_000,
			// Warm scans on CPU: ~200 ms for small inputs, but larger files (10-20
			// KB diffs) plus serialization behind other queued scans can exceed
			// 10s. 30s gives realistic headroom on CPU; GPUs can lower it.
			scan_timeout_ms: 30_000,
			// Free the model after 30 min idle to reclaim RAM; next scan re-spawns.
			idle_shutdown_ms: 30 * 60 * 1000,
			max_restarts: 3,
			// Three sidecars behind a round-robin pool — each Python instance is
			// single-threaded, so N children give N× concurrency for parallel
			// scans from multiple Claude sessions. ~800 MB per instance.
			// Children spawn lazily, so an idle workstation pays zero.
			pool_size: 3,
			// Precision-leaning Viterbi biases shipped under
			// sidecars/calibrations/high_precision.json. Trades recall for
			// fewer false positives on file paths, identifier-shaped strings,
			// and other low-confidence span entries the model loves to flag.
			// To restore stock OPF behavior, override to undefined or to the
			// adjacent default.json (zero biases) in guard-rules.local.json.
			viterbi_calibration_path: HIGH_PRECISION_OPF_CALIBRATION_PATH,
		},
		huggingface: {
			// NOT `openai/privacy-filter` — that model requires `trust_remote_code=True`
			// and is not served by the free HF Inference API. This slot is prepared for
			// `openai/gpt-oss-safeguard-20b` and similar standard-architecture models.
			model: "openai/gpt-oss-safeguard-20b",
			api_key_env: "HF_TOKEN",
			timeout_ms: 4000,
		},
		custom_http: {
			endpoint: "",
			timeout_ms: 4000,
		},
		// 0 = every detected span blocks; OPF local omits score so min_score is
		// mostly meaningful for HF / custom-HTTP backends that do emit scores.
		min_score: 0,
		// Reuses the existing output_scanning cap so operators tune one knob, not two.
		max_scan_bytes: 100_000,
		// Curated FP-suppression list. Each entry kills a known false-positive
		// class observed against the OPF model in practice. Locals can append
		// in `.interlinked/guard-rules.local.json` — appended, never replaced.
		allowlist: [
			// noreply / no-reply addresses are transactional, not contactable PII.
			// `noreply@anthropic.com`, `no-reply@github.com`, etc.
			{
				kind: "prefix",
				pattern: "noreply@",
				label: "private_email",
				reason: "Transactional no-reply addresses are not personal contact info",
			},
			{
				kind: "prefix",
				pattern: "no-reply@",
				label: "private_email",
				reason: "Transactional no-reply addresses are not personal contact info",
			},
			// RFC 2606 reserved test domains.
			{
				kind: "email_domain",
				pattern: "example.com",
				label: "private_email",
				reason: "RFC 2606 reserved test domain",
			},
			{
				kind: "email_domain",
				pattern: "example.net",
				label: "private_email",
				reason: "RFC 2606 reserved test domain",
			},
			{
				kind: "email_domain",
				pattern: "example.org",
				label: "private_email",
				reason: "RFC 2606 reserved test domain",
			},
			// snake_case identifiers misread as person names — `content_scanner`,
			// `user_id`, `private_email` (yes, the model sometimes flags label
			// names from its own training set), etc. Real human names contain
			// spaces or capitals; this catches the FP cleanly.
			{
				kind: "snake_case_identifier",
				label: "private_person",
				reason: "snake_case identifier (config key, function name, etc.) — not a person",
			},
			// UUIDs in `secret` slot — canonical IDs are routinely flagged as
			// secrets by entropy-based detectors. UUIDs are designed to be
			// non-secret stable identifiers; treat as benign.
			{
				kind: "uuid",
				label: "secret",
				reason: "UUIDs are public stable identifiers, not secrets",
			},
		],
	},
	per_edit_coverage: {
		// DEFAULT ON — all four test-quality gates enforce on every repo out of
		// the box: cyclomatic complexity (always-on, separate guard) plus the
		// three flipped here — per-edit coverage, red/green (block_on_test_failure),
		// and CRAP (block_on_crap). A repo opts OUT via
		// `.interlinked/guard-rules.local.json`:
		//   "per_edit_coverage": { "enabled": false }
		//
		// Two enforcement cadences, one policy, chosen automatically by suite cost:
		//   - Fast suite (overlay run fits inside `budget_ms`): the per-edit
		//     overlay enforces IN-BAND — the edit is blocked before the real write
		//     when it adds an uncovered line, drops per-file coverage, leaves the
		//     suite red, or introduces a CRAPpy function.
		//   - Big suite (e.g. THIS repo, interlinked-cli, ~16k tests — the overlay
		//     run exceeds `budget_ms`): the per-edit overlay DEFERS to the
		//     commit-intercept gate, which runs the full suite + coverage + CRAP at
		//     `git commit`. Enforcement still holds — it just lands at commit
		//     cadence instead of per-edit. No repo "must not enable it" anymore;
		//     the budget gate routes big suites to commit time on its own.
		//   - No test tooling at all: the guard fail-opens (loud warning, never a
		//     block) — "can't measure" is treated as allow, not deny.
		//
		// Red/green implication: with debt_mode on (default), an edit that leaves
		// the suite red opens a `red_suite` DEBT instead of blocking — the
		// red→green loop (failing test first, then the fix; or a behavior change
		// whose source + tests move across edits) proceeds file-at-a-time, and
		// only wandering to an unrelated file while red blocks. The old
		// "write code + test together in one `interlinked write --batch`" dance is
		// retired (2026-07). See docs/design/per-edit-coverage-enforcement.md.
		enabled: true,
		mode: "block",
		budget_ms: 25_000,
		// js/ts via vitest+v8, python via pytest+coverage.py. Affected-test
		// selection (coverage-test-selector.ts) scopes each per-edit overlay run to
		// only the tests that transitively import the edited file, so a slow,
		// multi-language suite still fits the per-edit budget and enforces in-band.
		languages: ["js", "ts", "python"],
		// Red-bar (per-edit red/green) enforcement — DEFAULT ON (flipped together
		// with `enabled` / `block_on_crap`). An overlay run that leaves the suite
		// RED produces the red verdict, naming the failing test. Under debt_mode
		// (default) that verdict is DEBT-SHAPED, not a hard stop: the edit lands,
		// a `red_suite` debt opens on the pair, in-pair iteration stays free, and
		// only a wander to an unrelated file while red blocks (commit gate =
		// ground-truth backstop). With debt_mode off the old strict behavior
		// returns (any red-leaving edit refused). A repo opts out entirely via
		// guard-rules.local.json (`"per_edit_coverage": { "block_on_test_failure":
		// false }`), and an indeterminate/unavailable runner still fail-opens
		// (treated like "can't measure").
		block_on_test_failure: true,
		// CRAP (Change Risk Anti-Patterns) per-edit gate — DEFAULT ON (flipped
		// together with `enabled` / `block_on_test_failure`). The 4th per-edit
		// block: a function the edit ADDED or TOUCHED whose CRAP score
		// (cyclomatic² · (1−cov)³ + cyclomatic) reaches `crap_threshold` is refused
		// before the real write — "this function is complex AND under-covered;
		// reduce complexity or add coverage." Computed from the SAME overlay
		// coverage run as the coverage block (no extra suite run) and checked AFTER
		// the uncovered-added-line / drop decision. A repo opts out via
		// guard-rules.local.json (`"per_edit_coverage": { "block_on_crap": false }`).
		block_on_crap: true,
		crap_threshold: 30,
		// Pair-scoped debt lifecycle — DEFAULT ON (2026-06; red twin 2026-07): the
		// uncovered-added-line BLOCK becomes a `coverage` debt and the red-bar
		// BLOCK becomes a `red_suite` debt — the edit is ALLOWED, the debt opens,
		// and you stay free to edit that source or its companion test until it's
		// covered / green again; only a wander to an unrelated file (or commit)
		// blocks. Opt out via `"per_edit_coverage": { "debt_mode": false }` (which
		// restores STRICT uncovered + red blocking). See coverage-debt-gate.ts
		// and docs/design/coverage-debt-tdd.md.
		debt_mode: true,
	},
	// Per-edit mutation gate (spec §4 / §12). DEFAULT OFF — opt IN per repo. The
	// cloud Sandbox runner is not yet wired, so an opted-in repo gets an honest
	// `[mutation:not-measured]` warning rather than a forged clean pass.
	per_edit_mutation: {
		enabled: false,
		mode: "block",
		unavailable_behavior: "allow_unmeasured",
	},
	trajectory_shadow: {
		enabled: true,
	},
};
