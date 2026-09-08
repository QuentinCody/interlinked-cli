import { wireAbsentOptional, parseWire, wireObject, wireOptional, wireUnknown } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_REGISTRY } from "./check-registry/index.js";
import { DEFAULT_AUTO_COORDINATION_CONFIG } from "./auto-coordinate.js";
import { BUILTIN_RULES } from "./rules/builtin-rules.js";
import { getDefaultConfig } from "./rules-loader.js";
import { writeStatuslineArtifacts } from "./statusline-snapshot.js";
import type { GuardRule, GuardRulesConfig, QualityCheckConfig } from "./types.js";

function emptyConfig(): GuardRulesConfig {
	const cfg = getDefaultConfig();
	cfg.rules = [];
	cfg.disabled_rules = [];
	return cfg;
}

/** Count of registry detectors the snapshot folds into `inline_checks_enabled`. */
const REGISTRY_AGENT_SAFETY = CHECK_REGISTRY.filter((c) => c.pipeline === "agent_safety").length;

function ruleFixture(over: Partial<GuardRule> & { id: string }): GuardRule {
	return {
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["*"],
		action: "block",
		patterns: [],
		reason: "because",
		severity: "high",
		category: "process",
		...over,
	};
}

function toolCheck(over: Partial<QualityCheckConfig> = {}): QualityCheckConfig {
	return {
		enabled: true,
		command: "tsc --noEmit",
		file_types: [".ts"],
		timeout_ms: 5000,
		severity: "error",
		...over,
	};
}

function classifierToggle(enabled: boolean): NonNullable<GuardRulesConfig["policy_classifier"]> {
	return {
		enabled,
		mode: "shadow",
		provider: "openai_compatible",
		endpoint: "https://api.example.test/v1/chat/completions",
		api_key_env: "TEST_CLASSIFIER_KEY",
		model: "test-model",
		timeout_ms: 3000,
		max_input_tokens: 800,
		confidence_threshold: 0.8,
		max_calls_per_session: 50,
	};
}

function scannerToggle(enabled: boolean): NonNullable<GuardRulesConfig["content_scanner"]> {
	return { ...nonNull(getDefaultConfig().content_scanner), enabled };
}

function autoCoordToggle(enabled: boolean): NonNullable<GuardRulesConfig["auto_coordination"]> {
	return { ...DEFAULT_AUTO_COORDINATION_CONFIG, enabled };
}

function inlineCheck(over: Partial<QualityCheckConfig> = {}): QualityCheckConfig {
	return {
		enabled: true,
		file_types: [".ts"],
		timeout_ms: 5000,
		severity: "warning",
		...over,
	};
}

describe("writeStatuslineArtifacts", () => {
	let cwd: string;
	let interlinkedDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-snapshot-"));
		interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("writes a snapshot with default mode values when no config files exist", () => {
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 12345,
		});

		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^harness_mode=quality$/m);
		expect(text).toMatch(/^enforcement_mode=balanced$/m);
		expect(text).toMatch(/^sync_mode=realtime$/m);
		expect(text).toMatch(/^rules_total=0$/m);
		expect(text).toMatch(/^server_bridge=local_only$/m);
		expect(text).toMatch(/^index_status=missing$/m);
	});

	function writeConfiguredSnapshot(): string {
		writeFileSync(join(interlinkedDir, "config.json"), JSON.stringify({ mode: "ci" }));
		writeFileSync(
			join(interlinkedDir, "check-policy.json"),
			JSON.stringify({ mode: "strict" }),
		);
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({
				sync_mode: "local",
				active_server: "production",
				servers: { production: { workspace_id: "team-acme" } },
			}),
		);
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 2,
			indexStatus: "ready",
			indexFiles: 12450,
			serverBridgeConnected: true,
			daemonPid: 12345,
		});
		return readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
	}

	it("reads harness_mode from config.json", () => {
		expect(writeConfiguredSnapshot()).toMatch(/^harness_mode=ci$/m);
	});

	it("reads enforcement_mode from check-policy.json", () => {
		expect(writeConfiguredSnapshot()).toMatch(/^enforcement_mode=strict$/m);
	});

	it("reads sync_mode and active_server from config.local.json", () => {
		const text = writeConfiguredSnapshot();
		expect(text).toMatch(/^sync_mode=local$/m);
		expect(text).toMatch(/^active_server=production$/m);
	});

	it("resolves workspace_id through the active server entry", () => {
		expect(writeConfiguredSnapshot()).toMatch(/^workspace_id=team-acme$/m);
	});

	it("propagates index status and file count", () => {
		const text = writeConfiguredSnapshot();
		expect(text).toMatch(/^index_status=ready$/m);
		expect(text).toMatch(/^index_files=12450$/m);
	});

	it("reflects connected server bridge", () => {
		expect(writeConfiguredSnapshot()).toMatch(/^server_bridge=connected$/m);
	});

	it("reflects current reservations count", () => {
		expect(writeConfiguredSnapshot()).toMatch(/^reservations_count=2$/m);
	});

	it("emits the daemon PID for accuracy", () => {
		// Identifies which harness process wrote the snapshot. Surfaced in
		// the bash status line so a screenshot tells you whether you're
		// looking at the daemon you just restarted, not a zombie writer.
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 98765,
			specFactsTotal: 214,
			reviewFindingsOpen: 3,
		});
		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^daemon_pid=98765$/m);
		expect(text).toMatch(/^spec_facts_total=214$/m);
		expect(text).toMatch(/^review_findings_open=3$/m);
	});

	it("emits spec_facts_total=-1 when the ledger is not built (bash → spec off)", () => {
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^spec_facts_total=-1$/m);
		expect(text).toMatch(/^review_findings_open=0$/m);
	});

	it("emits split tool/inline check counts plus a back-compat sum", () => {
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: getDefaultConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 12345,
		});
		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		const tools = Number(text.match(/^tool_checks_enabled=(\d+)$/m)?.[1]);
		const inline = Number(text.match(/^inline_checks_enabled=(\d+)$/m)?.[1]);
		const total = Number(text.match(/^checks_enabled=(\d+)$/m)?.[1]);
		expect(tools).toBeGreaterThan(0);
		expect(inline).toBeGreaterThan(tools);
		expect(total).toBe(tools + inline);
	});

	it("inline count tracks CHECK_REGISTRY size when config inline checks are off", async () => {
		const { CHECK_REGISTRY } = await import("./check-registry/index.js");
		const registryAgentSafety = CHECK_REGISTRY.filter(
			(c) => c.pipeline === "agent_safety",
		).length;
		const cfg = emptyConfig();
		for (const v of Object.values(cfg.quality_checks)) {
			if (v) v.enabled = false;
		}
		cfg.structural_checks.enabled = false;
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: cfg,
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 12345,
		});
		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(new RegExp("^inline_checks_enabled=" + registryAgentSafety + "$", "m"));
		expect(text).toMatch(/^tool_checks_enabled=0$/m);
	});

	it("loaded-checks.md splits tool runners from inline detectors", () => {
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: getDefaultConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 12345,
		});
		const md = readFileSync(join(interlinkedDir, "loaded-checks.md"), "utf-8");
		expect(md).toContain("Tool runners enabled:");
		expect(md).toContain("Inline detectors loaded:");
		expect(md).toContain("## Tool runners");
		expect(md).toContain("## Inline detectors");
	});

	it("writes loaded-rules.md sorted by category then id", () => {
		const rules = emptyConfig();
		rules.rules = [
			{
				id: "process_b",
				enabled: true,
				trigger: "PreToolUse",
				tool_match: ["*"],
				action: "block",
				patterns: [],
				reason: "B",
				severity: "high",
				category: "process",
			},
			{
				id: "process_a",
				enabled: true,
				trigger: "PreToolUse",
				tool_match: ["*"],
				action: "block",
				patterns: [],
				reason: "A",
				severity: "high",
				category: "process",
			},
			{
				id: "filesystem_x",
				enabled: true,
				trigger: "PreToolUse",
				tool_match: ["*"],
				action: "warn",
				patterns: [],
				reason: "X",
				severity: "medium",
				category: "filesystem",
			},
		];
		rules.disabled_rules = ["block_force_push"];

		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules,
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 12345,
		});

		const md = readFileSync(join(interlinkedDir, "loaded-rules.md"), "utf-8");
		expect(md).toContain("Total active rules: **3**");
		expect(md).toContain("## Filesystem (1)");
		expect(md).toContain("## Process (2)");
		const aIdx = md.indexOf("`process_a`");
		const bIdx = md.indexOf("`process_b`");
		expect(aIdx).toBeGreaterThan(0);
		expect(bIdx).toBeGreaterThan(aIdx);
		expect(md).toContain("## Disabled rules (1)");
		expect(md).toContain("~~`block_force_push`~~");
	});
});

// ===========================================
// Snapshot key/value contract
// ===========================================
// The bash status-line script does pure formatting: every number it renders is
// parsed out of these key=value rows. A dropped row or a wrong value is a
// silently wrong status line, so the rows are asserted by key, order and value
// rather than by "contains something plausible".

describe("statusline snapshot rows", () => {
	let cwd: string;
	let interlinkedDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-rows-"));
		interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function write(
		rules: GuardRulesConfig,
		over: Partial<Parameters<typeof writeStatuslineArtifacts>[0]> = {},
	): string {
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules,
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 4242,
			...over,
		});
		return readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
	}

	function valueOf(text: string, key: string): string | undefined {
		for (const line of text.split("\n")) {
			const eq = line.indexOf("=");
			if (eq > 0 && line.slice(0, eq) === key) return line.slice(eq + 1);
		}
		return undefined;
	}

	it("emits exactly the 31 documented keys, in order, terminated by a newline", () => {
		const text = write(emptyConfig());
		const keys = text.replace(/\n$/, "").split("\n").map((l) => l.slice(0, l.indexOf("=")));
		expect(keys).toEqual([
			"harness_mode",
			"enforcement_mode",
			"sync_mode",
			"active_server",
			"workspace_id",
			"rules_total",
			"rules_disabled",
			"rules_custom",
			"tool_checks_enabled",
			"inline_checks_enabled",
			"checks_enabled",
			// Guard activity since daemon start — what the harness DID, as
			// opposed to how big it is (2026-08-10).
			"guard_blocked",
			"guard_warned",
			"guard_asked",
			"guard_last_block_rule",
			"reservations_count",
			"index_status",
			"index_files",
			"classifier_enabled",
			"scanner_enabled",
			"auto_coordination",
			"server_bridge",
			"daemon_pid",
			"spec_facts_total",
			"review_findings_open",
			// Work-done counters + caps. Appended AFTER the existing keys on
			// purpose: a consumer that reads by position keeps working, and the
			// statusline reads by name anyway.
			"lifetime_blocked",
			"lifetime_caught",
			"lifetime_evaluated",
			"cap_cyclomatic",
			"cap_crap",
			"cap_function_tokens",
			"generated_at",
		]);
		expect(text.endsWith("\n")).toBe(true);
	});

	it("stamps generated_at with a real ISO-8601 instant", () => {
		const before = Date.now();
		const stamp = valueOf(write(emptyConfig()), "generated_at");
		expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Date.parse(stamp ?? "")).toBeGreaterThanOrEqual(before - 1000);
	});

	it("counts custom rules as those with no built-in id, and disabled as the list length", () => {
		const builtinId = (nonNull(BUILTIN_RULES[0])).id;
		const cfg = emptyConfig();
		cfg.rules = [
			ruleFixture({ id: builtinId }),
			ruleFixture({ id: "team_custom_one" }),
			ruleFixture({ id: "team_custom_two" }),
		];
		cfg.disabled_rules = ["one_off", "another_off"];
		const text = write(cfg);
		expect(valueOf(text, "rules_total")).toBe("3");
		expect(valueOf(text, "rules_custom")).toBe("2");
		expect(valueOf(text, "rules_disabled")).toBe("2");
	});

	it("reports zero disabled rules when the config omits the list entirely", () => {
		const cfg = emptyConfig();
		cfg.rules = [ruleFixture({ id: "team_custom_one" })];
		delete cfg.disabled_rules;
		const text = write(cfg);
		expect(valueOf(text, "rules_disabled")).toBe("0");
		expect(valueOf(text, "rules_custom")).toBe("1");
	});

	it("renders every toggle in its enabled wording", () => {
		const cfg = emptyConfig();
		cfg.policy_classifier = classifierToggle(true);
		cfg.content_scanner = scannerToggle(true);
		cfg.auto_coordination = autoCoordToggle(true);
		const text = write(cfg);
		expect(valueOf(text, "classifier_enabled")).toBe("enabled");
		expect(valueOf(text, "scanner_enabled")).toBe("enabled");
		expect(valueOf(text, "auto_coordination")).toBe("on");
	});

	it("renders every toggle in its disabled wording", () => {
		const cfg = emptyConfig();
		cfg.policy_classifier = classifierToggle(false);
		cfg.content_scanner = scannerToggle(false);
		cfg.auto_coordination = autoCoordToggle(false);
		const text = write(cfg);
		expect(valueOf(text, "classifier_enabled")).toBe("disabled");
		expect(valueOf(text, "scanner_enabled")).toBe("disabled");
		expect(valueOf(text, "auto_coordination")).toBe("off");
	});

	it("defaults absent sections to off/off/ON — auto-coordination opts OUT, not in", () => {
		// The asymmetry is deliberate: classifier and scanner are opt-in, but
		// auto-coordination is on unless a config explicitly sets `enabled: false`.
		const cfg = emptyConfig();
		delete cfg.policy_classifier;
		delete cfg.content_scanner;
		delete cfg.auto_coordination;
		const text = write(cfg);
		expect(valueOf(text, "classifier_enabled")).toBe("disabled");
		expect(valueOf(text, "scanner_enabled")).toBe("disabled");
		expect(valueOf(text, "auto_coordination")).toBe("on");
	});

	it("ignores a non-string mode and falls back to the documented default", () => {
		writeFileSync(join(interlinkedDir, "config.json"), JSON.stringify({ mode: 123 }));
		writeFileSync(join(interlinkedDir, "check-policy.json"), JSON.stringify({ mode: [] }));
		writeFileSync(join(interlinkedDir, "config.local.json"), JSON.stringify({ sync_mode: 7 }));
		const text = write(emptyConfig());
		expect(valueOf(text, "harness_mode")).toBe("quality");
		expect(valueOf(text, "enforcement_mode")).toBe("balanced");
		expect(valueOf(text, "sync_mode")).toBe("realtime");
	});

	it("treats an empty-string setting as unset rather than as an empty mode", () => {
		writeFileSync(join(interlinkedDir, "config.json"), JSON.stringify({ mode: "" }));
		writeFileSync(join(interlinkedDir, "check-policy.json"), JSON.stringify({ mode: "" }));
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({ sync_mode: "", active_server: "", workspace_id: "" }),
		);
		const text = write(emptyConfig());
		expect(valueOf(text, "harness_mode")).toBe("quality");
		expect(valueOf(text, "enforcement_mode")).toBe("balanced");
		expect(valueOf(text, "sync_mode")).toBe("realtime");
		expect(valueOf(text, "active_server")).toBe("");
		expect(valueOf(text, "workspace_id")).toBe("");
	});

	it("leaves active_server and workspace_id empty when nothing is configured", () => {
		const text = write(emptyConfig());
		expect(valueOf(text, "active_server")).toBe("");
		expect(valueOf(text, "workspace_id")).toBe("");
	});

	it("falls back to the top-level workspace_id when the active server has no entry", () => {
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({ active_server: "prod", workspace_id: "ws-fallback" }),
		);
		const text = write(emptyConfig());
		expect(valueOf(text, "active_server")).toBe("prod");
		expect(valueOf(text, "workspace_id")).toBe("ws-fallback");
	});

	it("falls back when a servers map exists but has no entry for the active server", () => {
		writeFileSync(
			join(interlinkedDir, "config.local.json"),
			JSON.stringify({
				active_server: "prod",
				workspace_id: "ws-fallback",
				servers: { staging: { workspace_id: "ws-staging" } },
			}),
		);
		expect(valueOf(write(emptyConfig()), "workspace_id")).toBe("ws-fallback");
	});

	it("still writes the snapshot when the config omits structural_checks", () => {
		const cfg = emptyConfig();
		cfg.quality_checks = {};
		delete (parseWire(cfg, wireObject({ "structural_checks": wireAbsentOptional(wireOptional(wireUnknown)) }), "test JSON value")).structural_checks;
		const text = write(cfg);
		expect(valueOf(text, "inline_checks_enabled")).toBe(String(REGISTRY_AGENT_SAFETY));
		expect(valueOf(text, "checks_enabled")).toBe(String(REGISTRY_AGENT_SAFETY));
	});

	it("still writes the snapshot when the config omits content_scanner", () => {
		const cfg = emptyConfig();
		delete cfg.content_scanner;
		expect(valueOf(write(cfg), "scanner_enabled")).toBe("disabled");
	});

	it("splits tool runners from inline detectors and adds structural_checks as one unit", () => {
		const cfg = emptyConfig();
		cfg.quality_checks = {
			a_tool: toolCheck(),
			b_inline: inlineCheck(),
			c_inline: inlineCheck({ file_types: [] }),
			d_off_tool: toolCheck({ enabled: false }),
			e_off_inline: inlineCheck({ enabled: false }),
		};
		cfg.structural_checks.enabled = true;
		const on = write(cfg);
		expect(valueOf(on, "tool_checks_enabled")).toBe("1");
		expect(valueOf(on, "inline_checks_enabled")).toBe(String(REGISTRY_AGENT_SAFETY + 3));
		expect(valueOf(on, "checks_enabled")).toBe(String(REGISTRY_AGENT_SAFETY + 4));

		cfg.structural_checks.enabled = false;
		const off = write(cfg);
		expect(valueOf(off, "tool_checks_enabled")).toBe("1");
		expect(valueOf(off, "inline_checks_enabled")).toBe(String(REGISTRY_AGENT_SAFETY + 2));
		expect(valueOf(off, "checks_enabled")).toBe(String(REGISTRY_AGENT_SAFETY + 3));
	});

	it("propagates the caller-supplied counters verbatim", () => {
		const text = write(emptyConfig(), {
			reservationsCount: 7,
			indexStatus: "stale",
			indexFiles: 913,
			serverBridgeConnected: true,
			daemonPid: 31337,
			specFactsTotal: 0,
			reviewFindingsOpen: 12,
		});
		expect(valueOf(text, "reservations_count")).toBe("7");
		expect(valueOf(text, "index_status")).toBe("stale");
		expect(valueOf(text, "index_files")).toBe("913");
		expect(valueOf(text, "server_bridge")).toBe("connected");
		expect(valueOf(text, "daemon_pid")).toBe("31337");
		// 0 is a real measurement ("ledger built, nothing in it") and must not
		// collapse into the -1 "no ledger" sentinel.
		expect(valueOf(text, "spec_facts_total")).toBe("0");
		expect(valueOf(text, "review_findings_open")).toBe("12");
	});

	it("renders live guardTally counters and last-block rule verbatim (P1: nonzero counts)", () => {
		const text = write(emptyConfig(), {
			guardTally: { blocked: 3, warned: 7, asked: 2, lastBlockRule: "block_force_push" },
		});
		expect(valueOf(text, "guard_blocked")).toBe("3");
		expect(valueOf(text, "guard_warned")).toBe("7");
		expect(valueOf(text, "guard_asked")).toBe("2");
		expect(valueOf(text, "guard_last_block_rule")).toBe("block_force_push");
	});

	it("defaults every guard-tally field when guardTally is omitted entirely (N1)", () => {
		const text = write(emptyConfig());
		expect(valueOf(text, "guard_blocked")).toBe("0");
		expect(valueOf(text, "guard_warned")).toBe("0");
		expect(valueOf(text, "guard_asked")).toBe("0");
		expect(valueOf(text, "guard_last_block_rule")).toBe("");
	});

	it("writes all three artifacts on one call", () => {
		write(emptyConfig());
		expect(existsSync(join(interlinkedDir, "statusline.snapshot"))).toBe(true);
		expect(existsSync(join(interlinkedDir, "loaded-rules.md"))).toBe(true);
		expect(existsSync(join(interlinkedDir, "loaded-checks.md"))).toBe(true);
		// atomicWrite renames its temp file into place — no `.tmp` residue.
		expect(existsSync(join(interlinkedDir, "statusline.snapshot.tmp"))).toBe(false);
	});
});

// ===========================================
// loaded-rules.md — the "N rules" click target
// ===========================================
// This file is what a user lands on from the status line, so its prose is the
// product's voice: the pointer to the reference docs and to the two config
// files is the only instruction they get. Assert the document, not fragments.

const RULES_MD_NOTICE =
	"_Auto-generated by the harness on rule load. Do not edit — see " +
	"`docs/generated/guard-rules.md` for the full reference, or edit " +
	"`.interlinked/guard-rules.json` / `.interlinked/guard-rules.local.json` " +
	"to change what's loaded here._";

describe("loaded-rules.md", () => {
	let cwd: string;
	let interlinkedDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-rules-md-"));
		interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function renderRules(rules: GuardRule[], disabled?: string[]): string[] {
		const cfg = emptyConfig();
		cfg.rules = rules;
		if (disabled === undefined) delete cfg.disabled_rules;
		else cfg.disabled_rules = disabled;
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: cfg,
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		return readFileSync(join(interlinkedDir, "loaded-rules.md"), "utf-8").split("\n");
	}

	/** Ids listed under one `## Heading (n)` section, in document order. */
	function idsUnder(lines: string[], heading: string): string[] {
		const start = lines.indexOf(heading);
		expect(start).toBeGreaterThanOrEqual(0);
		const out: string[] = [];
		for (let i = start + 1; i < lines.length; i++) {
			const line = nonNull(lines[i]);
			if (line.startsWith("## ")) break;
			const m = /^- `([^`]+)`/.exec(line);
			if (m?.[1]) out.push(m[1]);
		}
		return out;
	}

	it("renders the whole document verbatim: title, notice, totals, sections", () => {
		const builtinId = (nonNull(BUILTIN_RULES[0])).id;
		const lines = renderRules(
			[
				ruleFixture({
					id: builtinId,
					category: "process",
					action: "block",
					severity: "high",
					reason: "Builtin reason",
				}),
				ruleFixture({
					id: "zz_custom",
					category: "content_quality",
					action: "warn",
					severity: "medium",
					reason: "Custom reason",
				}),
			],
			["z_disabled", "a_disabled"],
		);
		expect(lines).toEqual([
			"# Interlinked harness — loaded rules",
			"",
			RULES_MD_NOTICE,
			"",
			"Total active rules: **2**",
			"",
			"## Content Quality (1)",
			"",
			"- `zz_custom` — warn — medium — custom — Custom reason",
			"",
			"## Process (1)",
			"",
			`- \`${builtinId}\` — block — high — built-in — Builtin reason`,
			"",
			"## Disabled rules (2)",
			"",
			"- ~~`a_disabled`~~ — disabled in `guard-rules.local.json`",
			"- ~~`z_disabled`~~ — disabled in `guard-rules.local.json`",
			"",
		]);
	});

	it("omits the disabled section entirely when nothing is disabled", () => {
		const withEmptyList = renderRules([ruleFixture({ id: "only_rule" })], []);
		expect(withEmptyList.some((l) => l.startsWith("## Disabled rules"))).toBe(false);
		const withNoList = renderRules([ruleFixture({ id: "only_rule" })]);
		expect(withNoList.some((l) => l.startsWith("## Disabled rules"))).toBe(false);
	});

	it("keeps ascending ids ascending — the list is sorted, not merely reordered", () => {
		// A fixture already in the right order: a comparator that reverses (or
		// stops comparing) is invisible against a reverse-ordered input.
		const lines = renderRules([
			ruleFixture({ id: "process_a", reason: "A" }),
			ruleFixture({ id: "process_b", reason: "B" }),
		]);
		expect(idsUnder(lines, "## Process (2)")).toEqual(["process_a", "process_b"]);
	});

	it("sorts by id within a category even when categories interleave in config order", () => {
		const lines = renderRules([
			ruleFixture({ id: "zeta_b", category: "zeta", reason: "ZB" }),
			ruleFixture({ id: "alpha_x", category: "alpha", reason: "AX" }),
			ruleFixture({ id: "zeta_a", category: "zeta", reason: "ZA" }),
		]);
		expect(idsUnder(lines, "## Zeta (2)")).toEqual(["zeta_a", "zeta_b"]);
		expect(idsUnder(lines, "## Alpha (1)")).toEqual(["alpha_x"]);
		// Categories themselves come out alphabetically, not in config order.
		const headings = lines.filter((l) => l.startsWith("## "));
		expect(headings).toEqual(["## Alpha (1)", "## Zeta (2)"]);
	});

	it("sorts a 3-member category correctly when a foreign category splits it", () => {
		const lines = renderRules([
			ruleFixture({ id: "aa_one", category: "gamma", reason: "one" }),
			ruleFixture({ id: "ff_six", category: "alpha", reason: "six" }),
			ruleFixture({ id: "gg_seven", category: "gamma", reason: "seven" }),
			ruleFixture({ id: "cc_three", category: "gamma", reason: "three" }),
		]);
		expect(idsUnder(lines, "## Gamma (3)")).toEqual(["aa_one", "cc_three", "gg_seven"]);
	});

	it("keeps two rules that share an id in config order", () => {
		const lines = renderRules([
			ruleFixture({ id: "dup_rule", reason: "First reason" }),
			ruleFixture({ id: "dup_rule", reason: "Second reason" }),
		]);
		const bullets = lines.filter((l) => l.startsWith("- `dup_rule`"));
		expect(bullets).toEqual([
			"- `dup_rule` — block — high — custom — First reason",
			"- `dup_rule` — block — high — custom — Second reason",
		]);
	});

	it("humanizes category slugs on both separators", () => {
		const lines = renderRules([
			ruleFixture({ id: "r_one", category: "content_quality" }),
			ruleFixture({ id: "r_two", category: "supply-chain" }),
		]);
		const headings = lines.filter((l) => l.startsWith("## "));
		expect(headings).toEqual(["## Content Quality (1)", "## Supply Chain (1)"]);
	});

	it("survives a category slug with an empty segment", () => {
		// `_leading`.split(/[_-]/) yields an empty first part; capitalizing it
		// would dereference index 0 of an empty string.
		const lines = renderRules([ruleFixture({ id: "r_one", category: "_leading" })]);
		expect(existsSync(join(interlinkedDir, "loaded-rules.md"))).toBe(true);
		expect(lines).toContain("##  Leading (1)");
	});

	it("labels rules with no category as uncategorized", () => {
		const rule = ruleFixture({ id: "r_one" });
		delete rule.category;
		const lines = renderRules([rule]);
		expect(lines).toContain("## Uncategorized (1)");
	});

	it("sorts disabled ids ascending regardless of config order", () => {
		const lines = renderRules([], ["m_mid", "z_last", "a_first"]);
		expect(lines).toEqual([
			"# Interlinked harness — loaded rules",
			"",
			RULES_MD_NOTICE,
			"",
			"Total active rules: **0**",
			"",
			"## Disabled rules (3)",
			"",
			"- ~~`a_first`~~ — disabled in `guard-rules.local.json`",
			"- ~~`m_mid`~~ — disabled in `guard-rules.local.json`",
			"- ~~`z_last`~~ — disabled in `guard-rules.local.json`",
			"",
		]);
	});

	it("deduplicates repeated disabled ids — the count is of distinct ids", () => {
		const lines = renderRules([], ["dupe", "dupe", "other"]);
		expect(lines).toContain("## Disabled rules (2)");
		expect(lines.filter((l) => l.includes("~~`dupe`~~"))).toHaveLength(1);
	});
});

// ===========================================
// loaded-checks.md — the "N checks" click target
// ===========================================

const CHECKS_MD_NOTICE =
	"_Auto-generated by the harness on rule load. Do not edit — see " +
	"`.interlinked/check-policy.json` for the active mode (balanced/strict/lenient) " +
	"or `.interlinked/guard-rules.local.json` to flip individual checks on/off._";

const TOOL_SECTION_NOTICE =
	"_Subprocess wrappers (tsc, biome, gitleaks, …). Each spawns an " +
	"external command per matching edit._";

const CONFIG_INLINE_NOTICE =
	"_In-process checks toggleable through `quality_checks` in " +
	"`guard-rules.local.json`. Each is a built-in detector dispatched " +
	"in-process — no subprocess spawn._";

const REGISTRY_NOTICE =
	"_Built-in `agent_safety` detectors from `src/harness/check-registry/`. " +
	"Always loaded; gated per-edit by `content_keywords` and the active " +
	"check-policy mode. Authored by the harness team — not user-toggleable " +
	"from config._";

const DISABLED_NOTICE =
	"_Re-enable in `.interlinked/guard-rules.local.json` under " +
	"`quality_checks.<name>.enabled = true`._";

const STRUCTURAL_BULLET =
	"- `structural_checks` — error — bundle — Cross-file dependency " +
	"checks: export surface, import resolution, dependency cycles, " +
	"blast radius. Counts as one toggle, runs ~25 sub-checks.";

describe("loaded-checks.md", () => {
	let cwd: string;
	let interlinkedDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-checks-md-"));
		interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function renderChecks(
		quality: Record<string, QualityCheckConfig>,
		structuralEnabled: boolean,
	): string[] {
		const cfg = emptyConfig();
		cfg.quality_checks = quality;
		cfg.structural_checks.enabled = structuralEnabled;
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: cfg,
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		return readFileSync(join(interlinkedDir, "loaded-checks.md"), "utf-8").split("\n");
	}

	/** Insertion order is deliberately neither sorted nor reverse-sorted, so a
	 *  comparator that gives up (or inverts) is visible in every section. */
	function ninePartConfig(): Record<string, QualityCheckConfig> {
		return {
			t_c: toolCheck({ command: "cmd-c", file_types: [], severity: "error" }),
			i_c: inlineCheck({ file_types: [], severity: "warning" }),
			d_c: inlineCheck({ enabled: false, severity: "error", description: "Gamma disabled" }),
			t_a: toolCheck({ command: "cmd-a", severity: "error", description: "Alpha tool" }),
			i_a: inlineCheck({
				file_types: [".py", ".pyi"],
				severity: "warning",
				description: "Alpha inline",
			}),
			d_a: inlineCheck({ enabled: false, severity: "error", description: "Alpha disabled" }),
			t_b: toolCheck({ command: "cmd-b", file_types: [".ts", ".tsx"], severity: "warning" }),
			i_b: inlineCheck({ file_types: [".ts", ".tsx"], severity: "error" }),
			d_b: inlineCheck({ enabled: false, severity: "warning" }),
		};
	}

	const registrySorted = CHECK_REGISTRY.filter((c) => c.pipeline === "agent_safety")
		.slice()
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	it("renders header, tool and config-inline sections verbatim", () => {
		const lines = renderChecks(ninePartConfig(), true);
		const regHeading = `## Inline detectors — registry (${REGISTRY_AGENT_SAFETY})`;
		const regIdx = lines.indexOf(regHeading);
		expect(regIdx).toBeGreaterThan(0);
		expect(lines.slice(0, regIdx)).toEqual([
			"# Interlinked harness — loaded checks",
			"",
			CHECKS_MD_NOTICE,
			"",
			"Tool runners enabled: **3**",
			`Inline detectors loaded: **${REGISTRY_AGENT_SAFETY + 4}**`,
			"",
			"## Tool runners — enabled (3)",
			"",
			TOOL_SECTION_NOTICE,
			"",
			"- `t_a` — error — `cmd-a` — Alpha tool",
			"- `t_b` — warning — `cmd-b` — Runs on edits to .ts, .tsx.",
			"- `t_c` — error — `cmd-c` — Runs on edits to all files.",
			"",
			"## Inline detectors — config-driven (4)",
			"",
			CONFIG_INLINE_NOTICE,
			"",
			STRUCTURAL_BULLET,
			"- `i_a` — warning — Alpha inline",
			"- `i_b` — error — Runs on edits to .ts, .tsx.",
			"- `i_c` — warning — Runs on edits to all files.",
			"",
		]);
	});

	it("renders the registry section sorted by id, one exact bullet per detector", () => {
		const lines = renderChecks(ninePartConfig(), true);
		const regHeading = `## Inline detectors — registry (${REGISTRY_AGENT_SAFETY})`;
		const regIdx = lines.indexOf(regHeading);
		expect(lines.slice(regIdx, regIdx + 4)).toEqual([regHeading, "", REGISTRY_NOTICE, ""]);
		const bullets = lines.slice(regIdx + 4, regIdx + 4 + REGISTRY_AGENT_SAFETY);
		expect(bullets).toEqual(
			registrySorted.map(
				(c) => `- \`${c.id}\` — ${c.severity} — ${c.phase} — tier ${c.tier} — ${c.description}`,
			),
		);
		expect(lines[regIdx + 4 + REGISTRY_AGENT_SAFETY]).toBe("");
	});

	it("renders the disabled section verbatim, trimming the trailing gap when a check has no description", () => {
		const lines = renderChecks(ninePartConfig(), true);
		const disIdx = lines.indexOf("## Quality checks — disabled (3)");
		expect(disIdx).toBeGreaterThan(0);
		expect(lines.slice(disIdx)).toEqual([
			"## Quality checks — disabled (3)",
			"",
			DISABLED_NOTICE,
			"",
			"- ~~`d_a`~~ — error — Alpha disabled",
			"- ~~`d_b`~~ — warning",
			"- ~~`d_c`~~ — error — Gamma disabled",
			"",
		]);
	});

	it("omits the tool-runner section when no tool runner is enabled", () => {
		const lines = renderChecks({ i_only: inlineCheck() }, false);
		expect(lines.some((l) => l.startsWith("## Tool runners"))).toBe(false);
		expect(lines).toContain("Tool runners enabled: **0**");
	});

	it("omits the config-inline section when structural is off and no inline check is enabled", () => {
		const lines = renderChecks({ t_only: toolCheck() }, false);
		const regIdx = lines.indexOf(`## Inline detectors — registry (${REGISTRY_AGENT_SAFETY})`);
		expect(regIdx).toBeGreaterThan(0);
		// Nothing at all between the tool section and the registry section: an
		// omitted section contributes zero lines, not a placeholder.
		expect(lines.slice(0, regIdx)).toEqual([
			"# Interlinked harness — loaded checks",
			"",
			CHECKS_MD_NOTICE,
			"",
			"Tool runners enabled: **1**",
			`Inline detectors loaded: **${REGISTRY_AGENT_SAFETY}**`,
			"",
			"## Tool runners — enabled (1)",
			"",
			TOOL_SECTION_NOTICE,
			"",
			"- `t_only` — error — `tsc --noEmit` — Runs on edits to .ts.",
			"",
		]);
	});

	it("still renders the config-inline section for structural_checks alone", () => {
		const lines = renderChecks({ t_only: toolCheck() }, true);
		expect(lines).toContain("## Inline detectors — config-driven (1)");
		expect(lines).toContain(STRUCTURAL_BULLET);
		expect(lines).toContain(`Inline detectors loaded: **${REGISTRY_AGENT_SAFETY + 1}**`);
	});

	it("drops the structural bullet — and one from the count — when structural is off", () => {
		const lines = renderChecks({ i_one: inlineCheck(), i_two: inlineCheck() }, false);
		expect(lines).toContain("## Inline detectors — config-driven (2)");
		expect(lines).not.toContain(STRUCTURAL_BULLET);
		expect(lines).toContain(`Inline detectors loaded: **${REGISTRY_AGENT_SAFETY + 2}**`);
	});

	it("omits the disabled section when every configured check is enabled", () => {
		const lines = renderChecks({ t_only: toolCheck(), i_only: inlineCheck() }, true);
		expect(lines.some((l) => l.startsWith("## Quality checks — disabled"))).toBe(false);
	});

	it("still writes loaded-checks.md when the config omits structural_checks", () => {
		const cfg = emptyConfig();
		cfg.quality_checks = { t_only: toolCheck() };
		delete (parseWire(cfg, wireObject({ "structural_checks": wireAbsentOptional(wireOptional(wireUnknown)) }), "test JSON value")).structural_checks;
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: cfg,
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		const lines = readFileSync(join(interlinkedDir, "loaded-checks.md"), "utf-8").split("\n");
		expect(lines).toContain("## Tool runners — enabled (1)");
		expect(lines.some((l) => l.startsWith("## Inline detectors — config-driven"))).toBe(false);
	});

	it("keeps a tool runner out of the inline section and vice versa", () => {
		const lines = renderChecks(
			{ solo_tool: toolCheck({ command: "cmd-x" }), solo_inline: inlineCheck() },
			false,
		);
		const toolIdx = lines.indexOf("## Tool runners — enabled (1)");
		const inlineIdx = lines.indexOf("## Inline detectors — config-driven (1)");
		expect(toolIdx).toBeGreaterThanOrEqual(0);
		expect(inlineIdx).toBeGreaterThan(toolIdx);
		expect(lines.slice(toolIdx, inlineIdx)).toContain(
			"- `solo_tool` — error — `cmd-x` — Runs on edits to .ts.",
		);
		expect(lines.slice(inlineIdx)).toContain("- `solo_inline` — warning — Runs on edits to .ts.");
		expect(lines.slice(toolIdx, inlineIdx).some((l) => l.includes("solo_inline"))).toBe(false);
	});
});

// ===========================================
// Which registry entries count as "loaded inline detectors"
// ===========================================
// Only the `agent_safety` pipeline runs on every PostToolUse; `suggestion`
// checks do not, so counting them would overstate what the status line claims
// is enforced. The live registry currently holds agent_safety entries only,
// which makes the filter invisible against the real one — these tests supply a
// mixed registry so the exclusion is actually observed.

// ===========================================
// Failure-swallowing branches (L85, L93, L101, L509)
// ===========================================
// Each of the three artifact writes is independently best-effort: an I/O
// failure on one must not prevent the others, and must never throw out of
// writeStatuslineArtifacts. Also covers readJsonSafely's malformed-JSON
// catch (L509).

describe("writeStatuslineArtifacts — failure swallowing", () => {
	let cwd: string;

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("swallows the write failure for all three artifacts when interlinkedDir does not exist", () => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-missing-dir-"));
		const interlinkedDir = join(cwd, ".interlinked"); // deliberately never created
		expect(() =>
			writeStatuslineArtifacts({
				cwd,
				interlinkedDir,
				rules: emptyConfig(),
				reservationsCount: 0,
				indexStatus: "missing",
				indexFiles: 0,
				serverBridgeConnected: false,
				daemonPid: 1,
			}),
		).not.toThrow();
		expect(existsSync(join(interlinkedDir, "statusline.snapshot"))).toBe(false);
		expect(existsSync(join(interlinkedDir, "loaded-rules.md"))).toBe(false);
		expect(existsSync(join(interlinkedDir, "loaded-checks.md"))).toBe(false);
	});

	it("degrades to documented defaults when config.json holds malformed JSON", () => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-malformed-"));
		const interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(join(interlinkedDir, "config.json"), "{ not valid json");
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^harness_mode=quality$/m);
	});
});

// ===========================================
// byCategoryThenId — missing-category fallback (L485, L486)
// ===========================================
// A single rule never invokes the comparator (Array.prototype.sort skips
// comparisons for a 1-element array), so the existing "labels rules with no
// category as uncategorized" case never actually exercises the `a.category
// || "uncategorized"` / `b.category || "uncategorized"` fallbacks. This needs
// at least two category-less rules compared against each other (hitting both
// sides in one comparator call) and against a categorized rule (hitting one
// side).

describe("loaded-rules.md — sorts rules missing `category` against each other and against categorized rules", () => {
	let cwd: string;
	let interlinkedDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-nocat-"));
		interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("buckets two category-less rules together, sorted by id, alongside a categorized one", () => {
		const noCatZ = ruleFixture({ id: "z_one" });
		delete noCatZ.category;
		const noCatA = ruleFixture({ id: "a_two" });
		delete noCatA.category;
		const cfg = emptyConfig();
		cfg.rules = [noCatZ, noCatA, ruleFixture({ id: "m_three", category: "process" })];

		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: cfg,
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		const lines = readFileSync(join(interlinkedDir, "loaded-rules.md"), "utf-8").split("\n");
		const headings = lines.filter((l) => l.startsWith("## ")).filter((l) => !l.includes("Disabled"));
		expect(headings).toEqual(["## Process (1)", "## Uncategorized (2)"]);
		const uncatIdx = lines.indexOf("## Uncategorized (2)");
		const uncatBullets = lines
			.slice(uncatIdx + 1)
			.filter((l) => l.startsWith("- `"));
		expect(uncatBullets).toEqual([
			"- `a_two` — block — high — custom — because",
			"- `z_one` — block — high — custom — because",
		]);
	});
});

describe("registry pipeline filtering", () => {
	let cwd: string;
	let interlinkedDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-registry-"));
		interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		vi.doUnmock("./check-registry/index.js");
		vi.resetModules();
	});

	async function renderWith(registry: unknown[]): Promise<{ snapshot: string; checks: string[] }> {
		vi.resetModules();
		vi.doMock("./check-registry/index.js", () => ({ CHECK_REGISTRY: registry }));
		const mod = await import("./statusline-snapshot.js");
		const cfg = emptyConfig();
		cfg.quality_checks = {};
		cfg.structural_checks.enabled = false;
		mod.writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: cfg,
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		return {
			snapshot: readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8"),
			checks: readFileSync(join(interlinkedDir, "loaded-checks.md"), "utf-8").split("\n"),
		};
	}

	const MIXED_REGISTRY = [
		{
			id: "zz_safety",
			pipeline: "agent_safety",
			severity: "error",
			phase: "post",
			tier: 1,
			description: "Zed detector",
		},
		{
			id: "aa_safety",
			pipeline: "agent_safety",
			severity: "warning",
			phase: "pre_warn",
			tier: 2,
			description: "Aye detector",
		},
		{
			id: "mm_suggestion",
			pipeline: "suggestion",
			severity: "warning",
			phase: "post",
			tier: 3,
			description: "Ranked advice, not run every edit",
		},
	];

	it("counts only agent_safety entries toward inline_checks_enabled", async () => {
		const { snapshot } = await renderWith(MIXED_REGISTRY);
		expect(snapshot).toMatch(/^inline_checks_enabled=2$/m);
		expect(snapshot).toMatch(/^checks_enabled=2$/m);
		expect(snapshot).toMatch(/^tool_checks_enabled=0$/m);
	});

	it("lists only agent_safety entries in the registry section, sorted by id", async () => {
		const { checks } = await renderWith(MIXED_REGISTRY);
		const idx = checks.indexOf("## Inline detectors — registry (2)");
		expect(idx).toBeGreaterThan(0);
		expect(checks.slice(idx)).toEqual([
			"## Inline detectors — registry (2)",
			"",
			REGISTRY_NOTICE,
			"",
			"- `aa_safety` — warning — pre_warn — tier 2 — Aye detector",
			"- `zz_safety` — error — post — tier 1 — Zed detector",
			"",
		]);
		expect(checks.join("\n")).not.toContain("mm_suggestion");
	});

	it("omits the registry section entirely when no detector is loaded", async () => {
		const { snapshot, checks } = await renderWith([]);
		// With no tool runners, no config inline checks, no structural bundle and
		// no registry, the document is the header and nothing else.
		expect(checks).toEqual([
			"# Interlinked harness — loaded checks",
			"",
			CHECKS_MD_NOTICE,
			"",
			"Tool runners enabled: **0**",
			"Inline detectors loaded: **0**",
			"",
		]);
		expect(snapshot).toMatch(/^inline_checks_enabled=0$/m);
	});

	it("omits the registry section when the registry holds only non-agent_safety entries", async () => {
		const { snapshot, checks } = await renderWith([MIXED_REGISTRY[2]]);
		expect(checks).toEqual([
			"# Interlinked harness — loaded checks",
			"",
			CHECKS_MD_NOTICE,
			"",
			"Tool runners enabled: **0**",
			"Inline detectors loaded: **0**",
			"",
		]);
		expect(snapshot).toMatch(/^inline_checks_enabled=0$/m);
	});
});

// ===========================================
// safeWork / safeCaps — catch branches (L110-111, L121-122)
// ===========================================
// Both counters are best-effort: a lifetime-ledger or metric-caps failure must
// still let the snapshot write with zeroed-out fields, never throw.

describe("writeStatuslineArtifacts — ledger and caps failure swallowing", () => {
	let cwd: string;
	let interlinkedDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-ledger-fail-"));
		interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		vi.doUnmock("./enforcement-ledger.js");
		vi.doUnmock("./metric-caps.js");
		vi.resetModules();
	});

	it("falls back to zeroed lifetime counters when updateEnforcementLedger throws", async () => {
		vi.resetModules();
		vi.doMock("./enforcement-ledger.js", () => ({
			updateEnforcementLedger: () => {
				throw new Error("ledger read failed");
			},
		}));
		const mod = await import("./statusline-snapshot.js");
		mod.writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^lifetime_blocked=0$/m);
		expect(text).toMatch(/^lifetime_caught=0$/m);
		expect(text).toMatch(/^lifetime_evaluated=0$/m);
	});

	it("falls back to zeroed metric caps when maxCyclomaticFor/crapThresholdFor throw", async () => {
		vi.resetModules();
		vi.doMock("./metric-caps.js", () => ({
			maxCyclomaticFor: () => {
				throw new Error("caps read failed");
			},
			crapThresholdFor: () => {
				throw new Error("caps read failed");
			},
		}));
		const mod = await import("./statusline-snapshot.js");
		mod.writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^cap_cyclomatic=0$/m);
		expect(text).toMatch(/^cap_crap=0$/m);
	});
});

// ===========================================
// safeCaps — root derivation from interlinkedDir (L126 regex)
// ===========================================
// `safeCaps` strips the TRAILING `/.interlinked` segment off `interlinkedDir`
// to find the project root metric-caps.json lives under. These tests write a
// real override at the expected root and read it back through the emitted
// `cap_cyclomatic`/`cap_crap` rows — the only way to observe the private
// regex's behavior, since it isn't exported.

describe("safeCaps — resolves metric-caps.json from interlinkedDir's own root", () => {
	let cwd: string;
	let interlinkedDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "statusline-caps-"));
		interlinkedDir = join(cwd, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function writeCapsOverride(dir: string, maxCyclomatic: number, crapThreshold: number): void {
		writeFileSync(
			join(dir, "metric-caps.json"),
			JSON.stringify({ max_cyclomatic: maxCyclomatic, crap_threshold: crapThreshold }),
		);
	}

	it("P1: reads the override from the SAME .interlinked dir the caller passed (single occurrence, no trailing slash)", () => {
		writeCapsOverride(interlinkedDir, 77, 66);
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^cap_cyclomatic=77$/m);
		expect(text).toMatch(/^cap_crap=66$/m);
	});

	it("P2: still finds the override when interlinkedDir carries an explicit trailing slash", () => {
		writeCapsOverride(interlinkedDir, 78, 67);
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir: `${interlinkedDir}/`,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^cap_cyclomatic=78$/m);
		expect(text).toMatch(/^cap_crap=67$/m);
	});

	it("P3: strips only the TRAILING .interlinked segment — an earlier .interlinked in the path is left alone", () => {
		// A decoy ".interlinked" directory sits between cwd and the REAL one:
		// cwd/.interlinked/nested/.interlinked. Only an end-anchored match
		// resolves root = cwd/.interlinked/nested (the correct answer); an
		// unanchored or first-match regex would instead strip the DECOY
		// occurrence and produce a broken, nonexistent root.
		const decoyRoot = join(cwd, ".interlinked", "nested");
		const realInterlinkedDir = join(decoyRoot, ".interlinked");
		mkdirSync(realInterlinkedDir, { recursive: true });
		writeCapsOverride(realInterlinkedDir, 79, 68);
		writeStatuslineArtifacts({
			cwd: decoyRoot,
			interlinkedDir: realInterlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		const text = readFileSync(join(realInterlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^cap_cyclomatic=79$/m);
		expect(text).toMatch(/^cap_crap=68$/m);
	});

	it("N1: falls back to the documented defaults when no metric-caps.json exists at the root", () => {
		writeStatuslineArtifacts({
			cwd,
			interlinkedDir,
			rules: emptyConfig(),
			reservationsCount: 0,
			indexStatus: "missing",
			indexFiles: 0,
			serverBridgeConnected: false,
			daemonPid: 1,
		});
		const text = readFileSync(join(interlinkedDir, "statusline.snapshot"), "utf-8");
		expect(text).toMatch(/^cap_cyclomatic=25$/m);
		expect(text).toMatch(/^cap_crap=30$/m);
		expect(text).toMatch(/^cap_function_tokens=500$/m);
	});
});
