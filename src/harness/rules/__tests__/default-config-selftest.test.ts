// Table-driven self-test for DEFAULT_CONFIG (src/harness/rules/default-config.ts).
//
// DEFAULT_CONFIG is one big data literal, not a function — mutation testing
// flips its booleans, blanks its strings, and empties its arrays/objects.
// `default-config.test.ts` checks SHAPE ("is this field the right type").
// This file pins VALUE: every literal that is deterministic across machines
// gets an exact-value assertion, and every glob / allowlist entry gets a
// real matching-path firing test through the actual matcher it feeds
// (`matchesGlob`, `compileAllowlist` + `applyAllowlist`) — not a
// string-equality stand-in for behavior.
//
// Two fields are excluded from value-pinning on purpose: `sidecar_script`
// and `viterbi_calibration_path` under `content_scanner.local` resolve
// filesystem paths that vary by deployment layout (see
// `default-config-resolvers.ts`) — their mutants belong to that file, not
// this one.

import { describe, expect, it } from "vitest";
import { matchesGlob } from "../../../lib/path-glob.js";
import { nonNull } from "../../../lib/non-null.js";
import { applyAllowlist, compileAllowlist } from "../../content-scanner/allowlist.js";
import type { ScanFinding } from "../../content-scanner/types.js";
import { DEFAULT_CONFIG } from "../default-config.js";

function finding(label: string, text: string): ScanFinding {
	return { label, start: 0, end: text.length, text, source: "test" };
}

// ---------------------------------------------------------------------------
// Top-level scalars + empty/singleton arrays
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG — top-level literals", () => {
	it.each([
		["version", DEFAULT_CONFIG.version, 1],
		["enabled", DEFAULT_CONFIG.enabled, true],
		["strict_skips", DEFAULT_CONFIG.strict_skips, false],
	] as const)("%s pins to its declared value", (_name, actual, expected) => {
		expect(actual).toBe(expected);
	});

	it.each([
		["rules", DEFAULT_CONFIG.rules, []],
		["file_reminders", DEFAULT_CONFIG.file_reminders, []],
		["linked_projects", DEFAULT_CONFIG.linked_projects, []],
		["required_tools", DEFAULT_CONFIG.required_tools, []],
		["repo_confinement_allowlist", DEFAULT_CONFIG.repo_confinement_allowlist, ["~/.claude"]],
		["skip_allowlist", DEFAULT_CONFIG.skip_allowlist, ["config_disabled", "file_type_mismatch"]],
	] as const)("array %s equals its exact contents", (_name, actual, expected) => {
		expect(actual).toEqual(expected);
	});
});

describe("DEFAULT_CONFIG — curl_mcp_detection", () => {
	const c = DEFAULT_CONFIG.curl_mcp_detection;

	it("pins enabled + escalate_after + port list + message verbatim", () => {
		expect(c.enabled).toBe(true);
		expect(c.escalate_after).toBe(5);
		expect(c.localhost_ports).toEqual([8787, 3000, 4321, 5173, 8080]);
		expect(c.message).toBe(
			"Agent is curling localhost directly. If an MCP server should be running on this port, it may be disconnected. Consider reconnecting.",
		);
	});
});

describe("DEFAULT_CONFIG — error_memory", () => {
	it("enabled + max_records pinned", () => {
		expect(DEFAULT_CONFIG.error_memory.enabled).toBe(true);
		expect(DEFAULT_CONFIG.error_memory.max_records).toBe(5000);
	});
});

describe("DEFAULT_CONFIG — output_scanning", () => {
	it("every scan toggle + byte cap pinned as one object", () => {
		expect(DEFAULT_CONFIG.output_scanning).toEqual({
			enabled: true,
			scan_bash_secrets: true,
			scan_web_injection: true,
			scan_file_injection: true,
			max_scan_bytes: 100_000,
		});
	});
});

// ---------------------------------------------------------------------------
// structural_checks — 30 leaf fields, table-driven (largest boolean surface
// in the file: the module's ~53 open BooleanLiteral survivors live mostly
// here).
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG — structural_checks (every detector flag pinned)", () => {
	const sc = DEFAULT_CONFIG.structural_checks;

	it.each([
		["enabled", sc.enabled, false],
		["export_surface", sc.export_surface, true],
		["import_resolution", sc.import_resolution, true],
		["duplicate_symbols", sc.duplicate_symbols, true],
		["co_dependency_staleness", sc.co_dependency_staleness, true],
		["import_cycles", sc.import_cycles, true],
		["interface_change_impact", sc.interface_change_impact, true],
		["test_proximity", sc.test_proximity, true],
		["smart_tsc", sc.smart_tsc, true],
		["blast_radius", sc.blast_radius, true],
		["stale_read_warning", sc.stale_read_warning, true],
		["sibling_awareness", sc.sibling_awareness, true],
		["staleness_window_s", sc.staleness_window_s, 300],
		["blast_radius_threshold", sc.blast_radius_threshold, 5],
		["recently_failed", sc.recently_failed, true],
		["completion_tracking", sc.completion_tracking, true],
		["route_context", sc.route_context, true],
		["redundant_reread", sc.redundant_reread, true],
		["dead_imports", sc.dead_imports, true],
		["completion_reminder_threshold", sc.completion_reminder_threshold, 10],
		["dead_exports", sc.dead_exports, true],
		["hallucinated_imports", sc.hallucinated_imports, true],
		["cross_package_imports", sc.cross_package_imports, true],
		["undefined_env_vars", sc.undefined_env_vars, true],
		["layer_violations", sc.layer_violations, false],
		["impact_analysis", sc.impact_analysis, true],
		["impact_high_threshold", sc.impact_high_threshold, 4],
		["test_first", sc.test_first, true],
		["test_first_mode", sc.test_first_mode, "enforce"],
		["cross_file_switch_discriminant", sc.cross_file_switch_discriminant, true],
		["single_implementation_interface", sc.single_implementation_interface, true],
	] as const)("structural_checks.%s pins to its declared value", (_name, actual, expected) => {
		expect(actual).toBe(expected);
	});

	it("test_first_mode is a member of the declared enum", () => {
		expect(["nudge", "warn", "enforce"]).toContain(sc.test_first_mode);
	});
});

// ---------------------------------------------------------------------------
// skip_paths — full-array pin (kills the whole-array→[] mutant) PLUS real
// matching-path firing per glob through the actual matcher the hook-side
// PostToolUse pipeline uses.
// ---------------------------------------------------------------------------

const EXPECTED_SKIP_PATHS = [
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
];

describe("DEFAULT_CONFIG — skip_paths", () => {
	it("equals the exact 28-entry glob list", () => {
		expect(DEFAULT_CONFIG.skip_paths).toEqual(EXPECTED_SKIP_PATHS);
	});

	it("has no duplicate globs", () => {
		const globs = nonNull(DEFAULT_CONFIG.skip_paths);
		expect(new Set(globs).size).toBe(globs.length);
	});

	// Each row: [index into skip_paths, a real path that SHOULD match, a real
	// path that should NOT match]. Reading via index (not a re-typed literal)
	// means a StringLiteral mutant on that entry breaks the "should match"
	// assertion for real, not by coincidence.
	it.each([
		[0, "dist/index.js", "src/dist.js"],
		[1, "build/main.js", "src/build.js"],
		[2, "out/bundle.js", "src/out.js"],
		[3, "node_modules/lodash/index.js", "src/node_modules.js"],
		[4, "vendor/pkg/file.go", "src/vendor.go"],
		[5, ".next/cache/x.json", "src/next.json"],
		[6, ".nuxt/dist/x.js", "src/nuxt.js"],
		[7, ".astro/types.d.ts", "src/astro.ts"],
		[8, "target/debug/main", "src/target.rs"],
		[9, ".svelte-kit/output/x.js", "src/svelte-kit.js"],
		[10, "src/generated/foo.ts", "src/foo.ts"],
		[11, "src/foo.generated.ts", "src/foo.ts"],
		[12, "src/foo.generated.js", "src/foo.js"],
		[13, "src/foo.generated.py", "src/foo.py"],
		[14, "src/foo.generated.rs", "src/foo.rs"],
		[15, "src/foo.generated.go", "src/foo.go"],
		[16, "src/foo.min.js", "src/foo.js"],
		[17, "src/foo.min.css", "src/foo.css"],
		[18, "src/foo.bundle.js", "src/foo.js"],
		[19, "src/foo.bundle.css", "src/foo.css"],
		[20, "Pipfile.lock", "src/Pipfile.lock"],
		[21, "sub/dir/package-lock.json", "sub/dir/package.json"],
		[22, "a/yarn.lock", "a/yarn.json"],
		[23, "sub/Cargo.lock", "sub/Cargo.toml"],
		[24, "sub/uv.lock", "sub/uv.toml"],
		[25, ".git/HEAD", "src/git/HEAD"],
		[26, ".idea/workspace.xml", "src/idea/workspace.xml"],
		[27, ".vscode/settings.json", "src/vscode/settings.json"],
	])("skip_paths[%i] matches %j but not %j", (index, matchSample, nonMatchSample) => {
		const glob = nonNull(DEFAULT_CONFIG.skip_paths)[index];
		expect(matchesGlob(matchSample, nonNull(glob))).toBe(true);
		expect(matchesGlob(nonMatchSample, nonNull(glob))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// diff_aware / project_wide_checks / commit_cadence
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG — diff_aware", () => {
	it("pins the whole object, including every mode enum", () => {
		expect(DEFAULT_CONFIG.diff_aware).toEqual({
			enabled: false,
			missing_return_types: "baseline",
			complexity: "edit_region",
			no_test_file: "new_files_only",
			undefined_env_vars: "edit_content",
		});
	});

	it("every mode value is a member of its declared enum", () => {
		const da = nonNull(DEFAULT_CONFIG.diff_aware);
		expect(["baseline", "off"]).toContain(da.missing_return_types);
		expect(["edit_region", "off"]).toContain(da.complexity);
		expect(["new_files_only", "off"]).toContain(da.no_test_file);
		expect(["edit_content", "off"]).toContain(da.undefined_env_vars);
	});
});

describe("DEFAULT_CONFIG — project_wide_checks", () => {
	it("pins enabled/edit_interval/on_export_change/timeout/severity/max_findings", () => {
		const p = nonNull(DEFAULT_CONFIG.project_wide_checks);
		expect(p.enabled).toBe(true);
		expect(p.edit_interval).toBe(5);
		expect(p.on_export_change).toBe(true);
		expect(p.timeout_ms).toBe(30_000);
		expect(p.severity).toBe("warning");
		expect(p.max_findings).toBe(20);
		expect(["error", "warning"]).toContain(p.severity);
	});

	it("tools list equals exactly [tsc, biome]", () => {
		expect(DEFAULT_CONFIG.project_wide_checks?.tools).toEqual(["tsc", "biome"]);
	});
});

describe("DEFAULT_CONFIG — commit_cadence", () => {
	const EXPECTED_DOC_GLOBS = [
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
	];

	it("pins thresholds + token bands + the full doc_globs array", () => {
		const cc = nonNull(DEFAULT_CONFIG.commit_cadence);
		expect(cc.enabled).toBe(true);
		expect(cc.stop_threshold).toBe(5);
		expect(cc.mid_session_threshold).toBe(40);
		expect(cc.token_band_low).toBe(200_000);
		expect(cc.token_band_high).toBe(400_000);
		expect(cc.doc_globs).toEqual(EXPECTED_DOC_GLOBS);
	});

	it("has no duplicate doc_globs", () => {
		const globs = nonNull(DEFAULT_CONFIG.commit_cadence?.doc_globs);
		expect(new Set(globs).size).toBe(globs.length);
	});

	// Samples chosen to match exactly ONE glob each so a StringLiteral mutant
	// on any single entry is caught, not masked by a sibling glob.
	it.each([
		[4, "docs/architecture", "readme.md"],
		[5, "plans/roadmap", "notes.txt"],
		[6, "notes/scratch", "docs/x"],
	])("doc_globs[%i] fires on a real path with no overlapping sibling glob", (index, sample) => {
		const globs = nonNull(DEFAULT_CONFIG.commit_cadence?.doc_globs);
		expect(matchesGlob(sample, nonNull(globs[index]))).toBe(true);
	});

	it("doc_globs[0] (**/*.md) fires on README.md", () => {
		const globs = nonNull(DEFAULT_CONFIG.commit_cadence?.doc_globs);
		expect(matchesGlob("README.md", nonNull(globs[0]))).toBe(true);
		expect(matchesGlob("README.txt", nonNull(globs[0]))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// verification_stop_checks / spec_checks / trajectory_shadow
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG — verification_stop_checks", () => {
	it("pins the whole object — all ten axes on by default", () => {
		expect(DEFAULT_CONFIG.verification_stop_checks).toEqual({
			enabled: true,
			warn_unverified_code: true,
			session_tsc_history: false,
			warn_verify_not_run: true,
			warn_ui_not_interacted: true,
			warn_stubs_introduced: true,
			warn_fixture_leaks: true,
			warn_unresolved_red: true,
			warn_spec_drift: true,
			warn_review_findings: true,
			warn_slow_tests: true,
		});
	});
});

describe("DEFAULT_CONFIG — spec_checks / trajectory_shadow", () => {
	it("both are on-by-default single-flag objects", () => {
		expect(DEFAULT_CONFIG.spec_checks).toEqual({ enabled: true });
		expect(DEFAULT_CONFIG.trajectory_shadow).toEqual({ enabled: true });
	});
});

// ---------------------------------------------------------------------------
// content_scanner — nested config + real allowlist-firing behavior
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG — content_scanner top-level + scan_points", () => {
	it("enabled false, runtime local — off by default until opt-in", () => {
		expect(DEFAULT_CONFIG.content_scanner?.enabled).toBe(false);
		expect(DEFAULT_CONFIG.content_scanner?.runtime).toBe("local");
		expect(["local", "huggingface", "custom_http"]).toContain(
			DEFAULT_CONFIG.content_scanner?.runtime,
		);
	});

	it("scan_points pins every hook toggle as one object", () => {
		expect(DEFAULT_CONFIG.content_scanner?.scan_points).toEqual({
			write_edit: true,
			bash_command: true,
			external_egress: true,
			read_grep_taint: true,
			user_prompt: true,
		});
	});

	it("min_score and the shared max_scan_bytes cap pin exactly", () => {
		expect(DEFAULT_CONFIG.content_scanner?.min_score).toBe(0);
		expect(DEFAULT_CONFIG.content_scanner?.max_scan_bytes).toBe(100_000);
	});
});

describe("DEFAULT_CONFIG — content_scanner.local (sidecar knobs)", () => {
	it("pins every deterministic field; idle_shutdown_ms proves 30*60*1000, not a slipped operator", () => {
		const local = nonNull(DEFAULT_CONFIG.content_scanner?.local);
		expect(local.python_bin).toBe("python3");
		expect(local.startup_timeout_ms).toBe(90_000);
		expect(local.scan_timeout_ms).toBe(30_000);
		// 30 * 60 * 1000 — pinning the product catches both "30*60/1000" (1.8)
		// and "30/60*1000" (500) arithmetic-operator mutants.
		expect(local.idle_shutdown_ms).toBe(1_800_000);
		expect(local.max_restarts).toBe(3);
		expect(local.pool_size).toBe(3);
		// sidecar_script / viterbi_calibration_path are deployment-resolved
		// paths (default-config-resolvers.ts) — asserted present, not equal to
		// a hardcoded value.
		expect(typeof local.sidecar_script).toBe("string");
		expect(local.sidecar_script.length).toBeGreaterThan(0);
	});
});

describe("DEFAULT_CONFIG — content_scanner.huggingface / custom_http", () => {
	it("huggingface slot points at the safeguard model with the right token env", () => {
		expect(DEFAULT_CONFIG.content_scanner?.huggingface).toEqual({
			model: "openai/gpt-oss-safeguard-20b",
			api_key_env: "HF_TOKEN",
			timeout_ms: 4000,
		});
	});

	it("custom_http slot ships with an empty endpoint until configured", () => {
		expect(DEFAULT_CONFIG.content_scanner?.custom_http).toEqual({
			endpoint: "",
			timeout_ms: 4000,
		});
	});
});

describe("DEFAULT_CONFIG — content_scanner.allowlist (curated FP suppressions)", () => {
	const EXPECTED_ALLOWLIST = [
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
		{
			kind: "snake_case_identifier",
			label: "private_person",
			reason: "snake_case identifier (config key, function name, etc.) — not a person",
		},
		{
			kind: "uuid",
			label: "secret",
			reason: "UUIDs are public stable identifiers, not secrets",
		},
	];

	it("equals the exact 7-entry curated list", () => {
		expect(DEFAULT_CONFIG.content_scanner?.allowlist).toEqual(EXPECTED_ALLOWLIST);
	});

	it("every entry's kind is a member of the AllowlistEntry union", () => {
		const kinds = ["exact", "prefix", "suffix", "contains", "email_domain", "snake_case_identifier", "uuid"];
		for (const entry of nonNull(DEFAULT_CONFIG.content_scanner?.allowlist)) {
			expect(kinds).toContain(entry.kind);
		}
	});

	it("no two entries share the same (kind, pattern) pair", () => {
		const entries = nonNull(DEFAULT_CONFIG.content_scanner?.allowlist);
		const keys = entries.map((e) => `${e.kind}:${"pattern" in e ? e.pattern : ""}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	// Real firing: compile the shipped allowlist and prove each entry actually
	// suppresses the finding shape it was written for, and does NOT suppress a
	// clearly different one.
	it("compiled allowlist suppresses noreply@ and no-reply@ private_email findings", () => {
		const compiled = compileAllowlist(DEFAULT_CONFIG.content_scanner?.allowlist);
		const result = applyAllowlist(
			[
				finding("private_email", "noreply@anthropic.com"),
				finding("private_email", "no-reply@github.com"),
				finding("private_email", "quentin@realmail.com"),
			],
			compiled,
		);
		expect(result.kept.map((f) => f.text)).toEqual(["quentin@realmail.com"]);
		expect(result.suppressed.map((s) => s.finding.text)).toEqual(
			expect.arrayContaining(["noreply@anthropic.com", "no-reply@github.com"]),
		);
	});

	it("compiled allowlist suppresses the three RFC 2606 test domains, not a real domain", () => {
		const compiled = compileAllowlist(DEFAULT_CONFIG.content_scanner?.allowlist);
		const result = applyAllowlist(
			[
				finding("private_email", "user@example.com"),
				finding("private_email", "user@example.net"),
				finding("private_email", "user@example.org"),
				finding("private_email", "user@evilexample.com"),
			],
			compiled,
		);
		// "example.com" is suffix-anchored on "@" — "evilexample.com" must NOT
		// be caught by the same entry (RFC 2606 domain-boundary guard).
		expect(result.kept.map((f) => f.text)).toEqual(["user@evilexample.com"]);
		expect(result.suppressed).toHaveLength(3);
	});

	it("compiled allowlist suppresses snake_case identifiers labeled private_person only", () => {
		const compiled = compileAllowlist(DEFAULT_CONFIG.content_scanner?.allowlist);
		const result = applyAllowlist(
			[
				finding("private_person", "content_scanner"),
				finding("private_person", "Quentin Cody"),
			],
			compiled,
		);
		expect(result.kept.map((f) => f.text)).toEqual(["Quentin Cody"]);
		expect(result.suppressed.map((s) => s.finding.text)).toEqual(["content_scanner"]);
	});

	it("compiled allowlist suppresses UUIDs labeled secret only", () => {
		const compiled = compileAllowlist(DEFAULT_CONFIG.content_scanner?.allowlist);
		const result = applyAllowlist(
			[
				finding("secret", "550e8400-e29b-41d4-a716-446655440000"),
				finding("secret", "sk-live-not-a-uuid-at-all"),
			],
			compiled,
		);
		expect(result.kept.map((f) => f.text)).toEqual(["sk-live-not-a-uuid-at-all"]);
		expect(result.suppressed.map((s) => s.finding.text)).toEqual([
			"550e8400-e29b-41d4-a716-446655440000",
		]);
	});
});

// ---------------------------------------------------------------------------
// per_edit_coverage / per_edit_mutation
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG — per_edit_coverage", () => {
	it("pins every gate flag + threshold", () => {
		const pec = nonNull(DEFAULT_CONFIG.per_edit_coverage);
		expect(pec.enabled).toBe(true);
		expect(pec.mode).toBe("block");
		expect(pec.budget_ms).toBe(25_000);
		expect(pec.block_on_test_failure).toBe(true);
		expect(pec.block_on_crap).toBe(true);
		expect(pec.crap_threshold).toBe(30);
		expect(pec.debt_mode).toBe(true);
		expect(["block", "warn"]).toContain(pec.mode);
	});

	it("languages equals exactly [js, ts, python]", () => {
		expect(DEFAULT_CONFIG.per_edit_coverage?.languages).toEqual(["js", "ts", "python"]);
	});
});

describe("DEFAULT_CONFIG — per_edit_mutation", () => {
	it("ships OFF by default with the honest-not-measured fallback", () => {
		expect(DEFAULT_CONFIG.per_edit_mutation).toEqual({
			enabled: false,
			mode: "block",
			unavailable_behavior: "allow_unmeasured",
		});
	});

	it("mode and unavailable_behavior are enum members", () => {
		const pem = nonNull(DEFAULT_CONFIG.per_edit_mutation);
		expect(["block", "warn", "off"]).toContain(pem.mode);
		expect(["allow_unmeasured", "block"]).toContain(pem.unavailable_behavior);
	});
});
