import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { GuardRulesConfig } from "../types.js";
import type { GuardRulesOverrides } from "./config-overrides.js";
import { DEFAULT_CONFIG } from "./default-config.js";
import { mergeLocalOverrides, mergeTeamRules } from "./merge.js";

function mkBaseConfig() {
	return structuredClone(DEFAULT_CONFIG);
}

describe("mergeTeamRules — mutation kills (w52)", () => {
	it("does NOT wipe project_specific when team config omits it (kills 193de00d4ba258bb)", () => {
		const config = mkBaseConfig();
		config.project_specific = { protected_paths: ["keep/"], protected_reason: "kept" };
		mergeTeamRules(config, {});
		expect(config.project_specific).toEqual({
			protected_paths: ["keep/"],
			protected_reason: "kept",
		});
	});

	it("does NOT wipe policy_classifier when team config omits it (kills 16da46afce780efe)", () => {
		const config = mkBaseConfig();
		const classifier: NonNullable<GuardRulesConfig["policy_classifier"]> = {
			enabled: true,
			mode: "shadow",
			provider: "groq",
			endpoint: "https://example.com",
			api_key_env: "K",
			model: "m",
			timeout_ms: 100,
			max_input_tokens: 800, confidence_threshold: 0.8, max_calls_per_session: 50,
		};
		config.policy_classifier = classifier;
		mergeTeamRules(config, {});
		expect(config.policy_classifier).toBe(classifier);
	});

	it("does NOT wipe auto_coordination when team config omits it (kills 7ad9510e286b0c54)", () => {
		const config = mkBaseConfig();
		const ac: NonNullable<GuardRulesConfig["auto_coordination"]> = {
			enabled: true,
			check_interval: 5,
			min_interval_ms: 1,
			max_interval_ms: 2,
			timeout_ms: 10,
			skip_tools: [],
			urgent_importance: "high", max_misses_before_disable: 5,
		};
		config.auto_coordination = ac;
		mergeTeamRules(config, {});
		expect(config.auto_coordination).toBe(ac);
	});

	it("team config applies file_types to an existing quality check (kills 66206e5b8581b9c6)", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, {
			quality_checks: {
				typescript: {
					file_types: [".foo"],
				},
			},
		});
		expect(config.quality_checks.typescript?.file_types).toEqual([".foo"]);
	});

	it("team config applies description to an existing quality check (kills 6bf542bee5b6b61f)", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, {
			quality_checks: {
				typescript: {
					description: "custom desc",
				},
			},
		});
		expect(config.quality_checks.typescript?.description).toBe("custom desc");
	});

	it("skips a truthy non-object quality-check override, e.g. a function (kills f8d47c0f1bbeb6c1)", () => {
		// typeof a function is "function", not "object", so the real code's
		// `typeof teamCheck !== "object"` guard must skip it even though the
		// function is truthy and even carries an own `enabled` property.
		const config = mkBaseConfig();
		const before = config.quality_checks.typescript?.enabled;
		const fakeCheck = Object.assign(function fakeCheck() {}, { enabled: !before });
		mergeTeamRules(config, {
			quality_checks: {
				typescript: fakeCheck,
			},
		});
		expect(config.quality_checks.typescript?.enabled).toBe(before);
	});
});

describe("mergeLocalOverrides — mutation kills (w52)", () => {
	it("does NOT wipe disabled_rules when local config omits it (kills afa3419ac6ace3a8)", () => {
		const config = mkBaseConfig();
		config.disabled_rules = ["keep-this-rule"];
		mergeLocalOverrides(config, {});
		expect(config.disabled_rules).toEqual(["keep-this-rule"]);
	});

	it("does NOT wipe extra_exceptions when local config omits it (kills 7009d7a1822ffadc)", () => {
		const config = mkBaseConfig();
		config.extra_exceptions = { "some-rule": ["allow this"] };
		mergeLocalOverrides(config, {});
		expect(config.extra_exceptions).toEqual({ "some-rule": ["allow this"] });
	});

	const optionalOverrides = {
		trajectory_shadow: { enabled: false },
		scratchpad_guard: { code_write_mode: "warn" },
		spec_checks: { enabled: false },
		baseline_autofold: { enabled: false },
		edit_contract: { stale_read: "off" },
		scratchpad_archive: { enabled: false },
		verification_stop_checks: { enabled: false },
		mutation_directed_strict_profile: { enabled: true },
	} satisfies GuardRulesOverrides;

	for (const [key, override] of Object.entries(optionalOverrides)) {
		it(`creates a missing ${key} section with the explicit local settings`, () => {
			const config = mkBaseConfig();
			Reflect.deleteProperty(config, key);
			mergeLocalOverrides(config, { [key]: override });
			expect(Reflect.get(config, key)).toMatchObject(override);
		});
	}

	it("mergeOptionalSection leaves the section untouched for an explicit null override (kills a4159ab9b4c5a747)", () => {
		// !override -> false would make the function proceed even though override
		// is falsy (null), assigning config.trajectory_shadow = null instead of
		// leaving it undefined.
		const config = mkBaseConfig();
		Reflect.deleteProperty(config, "trajectory_shadow");
		const local: GuardRulesOverrides = {};
		Reflect.set(local, "trajectory_shadow", null);
		mergeLocalOverrides(config, local);
		expect(config.trajectory_shadow).toBeUndefined();
	});

	it("does not create an empty content_scanner.allowlist from an empty override array (kills 76e8358041f86893 / 4f466d1d93858db6)", () => {
		const config = mkBaseConfig();
		delete nonNull(config.content_scanner).allowlist;
		mergeLocalOverrides(config, {
			content_scanner: {
				allowlist: [],
			},
		});
		expect(config.content_scanner?.allowlist).toBeUndefined();
	});

	it("does not create an empty content_scanner.disabled_labels from an empty override array (kills f3eb03f2734994ef / 1e92a1f6210c7b6d)", () => {
		const config = mkBaseConfig();
		delete nonNull(config.content_scanner).disabled_labels;
		mergeLocalOverrides(config, {
			content_scanner: {
				disabled_labels: [],
			},
		});
		expect(config.content_scanner?.disabled_labels).toBeUndefined();
	});
});
