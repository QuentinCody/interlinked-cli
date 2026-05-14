import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRules } from "./rules-loader.js";
import { overlayIdPrefix } from "./metacoder/overlay-loader.js";
import {
	DEFAULT_METACODER_CONFIG,
	METACODER_MAX_RULES_DEFAULT,
	METACODER_MAX_PATTERN_LENGTH_DEFAULT,
} from "./metacoder/types.js";

const SESSION = "rules-loader-session-abc12345";

function writeOverlayFile(cwd: string, sessionId: string, overlay: unknown): void {
	const dir = join(cwd, ".interlinked", "sessions", sessionId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "overlay-rules.json"), JSON.stringify(overlay));
}

// All tests skip the distilled-rules layer so per-developer /enforce output
// doesn't leak in. (Matches the vitest project default per CLAUDE.md.)
const ORIGINAL_SKIP_FLAG = process.env.INTERLINKED_SKIP_DISTILLED_RULES;
beforeEach(() => {
	process.env.INTERLINKED_SKIP_DISTILLED_RULES = "1";
});
afterEach(() => {
	if (ORIGINAL_SKIP_FLAG === undefined) {
		delete process.env.INTERLINKED_SKIP_DISTILLED_RULES;
	} else {
		process.env.INTERLINKED_SKIP_DISTILLED_RULES = ORIGINAL_SKIP_FLAG;
	}
});

describe("loadRules — no sessionId (legacy callers)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rules-loader-legacy-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns built-in floor rules", () => {
		const config = loadRules(cwd);
		expect(config.rules.length).toBeGreaterThan(0);
	});

	it("does not pick up overlay files when sessionId is omitted", () => {
		writeOverlayFile(cwd, SESSION, {
			version: 1,
			rules: [
				{
					id: `${overlayIdPrefix(SESSION)}0`,
					enabled: true,
					trigger: "PreToolUse",
					tool_match: ["Edit"],
					action: "block",
					patterns: [{ field: "file_path", regex: "src/legacy/" }],
					reason: "Out of scope.",
					severity: "high",
				},
			],
		});
		const config = loadRules(cwd);
		const overlayIds = config.rules.filter((r) => r.id.startsWith("overlay:"));
		expect(overlayIds).toHaveLength(0);
	});
});

describe("loadRules — metacoder config merge (P4 round 4)", () => {
	// A partial local.metacoder override must layer onto
	// DEFAULT_METACODER_CONFIG, not replace it. Otherwise tuning
	// `timeout_ms` silently disables the metacoder (`enabled: undefined` is
	// falsy) and drops the overlay validator's caps.

	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rules-loader-metacoder-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function writeLocalConfig(metacoderOverride: unknown): void {
		const dir = join(cwd, ".interlinked");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "guard-rules.local.json"),
			JSON.stringify({ metacoder: metacoderOverride }),
		);
	}

	it("preserves enabled:true from defaults when local overrides only timeout_ms", () => {
		writeLocalConfig({ timeout_ms: 5000 });
		const config = loadRules(cwd);
		expect(config.metacoder?.enabled).toBe(true);
		expect(config.metacoder?.timeout_ms).toBe(5000);
	});

	it("preserves default caps when local overrides only timeout_ms", () => {
		writeLocalConfig({ timeout_ms: 5000 });
		const config = loadRules(cwd);
		expect(config.metacoder?.max_rules).toBe(METACODER_MAX_RULES_DEFAULT);
		expect(config.metacoder?.max_pattern_length).toBe(METACODER_MAX_PATTERN_LENGTH_DEFAULT);
	});

	it("honors explicit local enabled:false", () => {
		writeLocalConfig({ enabled: false });
		const config = loadRules(cwd);
		expect(config.metacoder?.enabled).toBe(false);
		// Caps still seeded from defaults so the validator stays bounded
		// even when the metacoder is off — guards future code paths that
		// may reuse the caps without checking `enabled` first.
		expect(config.metacoder?.max_rules).toBe(METACODER_MAX_RULES_DEFAULT);
	});

	it("uses every default field when no local metacoder config exists", () => {
		// No local config file written — rules.metacoder may stay undefined,
		// but the server falls back to DEFAULT_METACODER_CONFIG. Verify the
		// default constants themselves match the expected shape so the
		// fallback is meaningful.
		expect(DEFAULT_METACODER_CONFIG.enabled).toBe(true);
		expect(DEFAULT_METACODER_CONFIG.max_rules).toBe(METACODER_MAX_RULES_DEFAULT);
		expect(DEFAULT_METACODER_CONFIG.max_pattern_length).toBe(METACODER_MAX_PATTERN_LENGTH_DEFAULT);
	});

	it("clamps local timeout_ms to stay below the hook timeout (P2 round 5)", () => {
		// Plan §reviewer-P2 (round 5): a user override of 60000ms must NOT
		// match or exceed the user-prompt hook budget (35000ms). The merge
		// step clamps to USER_PROMPT_HOOK_TIMEOUT_MS - 2000 = 33000ms so
		// the harness always has a buffer to send its clean timeout reply
		// before the hook destroys the socket.
		writeLocalConfig({ timeout_ms: 60_000 });
		const config = loadRules(cwd);
		const HOOK_TIMEOUT = 35_000;
		const MIN_BUFFER = 2_000;
		expect(config.metacoder?.timeout_ms).toBeLessThanOrEqual(HOOK_TIMEOUT - MIN_BUFFER);
	});

	it("preserves a safely-low timeout_ms verbatim", () => {
		writeLocalConfig({ timeout_ms: 8000 });
		const config = loadRules(cwd);
		expect(config.metacoder?.timeout_ms).toBe(8000);
	});

	it("clamps timeout_ms exactly equal to the hook budget", () => {
		writeLocalConfig({ timeout_ms: 35_000 });
		const config = loadRules(cwd);
		expect(config.metacoder?.timeout_ms).toBeLessThan(35_000);
	});
});

describe("loadRules — with sessionId (overlay merge)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rules-loader-overlay-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns floor rules unchanged when no overlay file exists for the session", () => {
		const legacy = loadRules(cwd);
		const merged = loadRules(cwd, SESSION);
		expect(merged.rules).toHaveLength(legacy.rules.length);
	});

	it("appends valid overlay rules after the floor", () => {
		writeOverlayFile(cwd, SESSION, {
			version: 1,
			rules: [
				{
					id: `${overlayIdPrefix(SESSION)}0`,
					enabled: true,
					trigger: "PreToolUse",
					tool_match: ["Edit"],
					action: "block",
					patterns: [{ field: "file_path", regex: "src/legacy/" }],
					reason: "Out of scope.",
					severity: "high",
				},
			],
		});
		const config = loadRules(cwd, SESSION);
		const overlayRules = config.rules.filter((r) => r.id.startsWith("overlay:"));
		expect(overlayRules).toHaveLength(1);
	});

	it("places overlay rules at the end of the merged list (after every floor rule)", () => {
		writeOverlayFile(cwd, SESSION, {
			version: 1,
			rules: [
				{
					id: `${overlayIdPrefix(SESSION)}0`,
					enabled: true,
					trigger: "PreToolUse",
					tool_match: ["Edit"],
					action: "block",
					patterns: [{ field: "file_path", regex: "src/legacy/" }],
					reason: "Out of scope.",
					severity: "high",
				},
			],
		});
		const config = loadRules(cwd, SESSION);
		const lastFloorIndex = config.rules.findIndex((r) => r.id.startsWith("overlay:")) - 1;
		const firstOverlayIndex = config.rules.findIndex((r) => r.id.startsWith("overlay:"));
		expect(firstOverlayIndex).toBeGreaterThan(0);
		expect(config.rules[lastFloorIndex].id.startsWith("overlay:")).toBe(false);
	});

	it("skips the overlay merge when metacoder is disabled, even if overlay-rules.json exists (P1 round 6)", () => {
		// Plan §reviewer-P1 (round 6): toggling metacoder off must
		// immediately stop applying any persisted overlay. Without this
		// gate, a user who flips `enabled: false` keeps being blocked by
		// the last LLM-generated rules until SessionEnd.
		writeOverlayFile(cwd, SESSION, {
			version: 1,
			rules: [
				{
					id: `${overlayIdPrefix(SESSION)}0`,
					enabled: true,
					trigger: "PreToolUse",
					tool_match: ["Edit"],
					action: "block",
					patterns: [{ field: "file_path", regex: "src/legacy/" }],
					reason: "stale overlay rule",
					severity: "high",
				},
			],
		});
		// Write local config disabling the metacoder.
		const dir = join(cwd, ".interlinked");
		writeFileSync(
			join(dir, "guard-rules.local.json"),
			JSON.stringify({ metacoder: { enabled: false } }),
		);
		const config = loadRules(cwd, SESSION);
		const overlayRules = config.rules.filter((r) => r.id.startsWith("overlay:"));
		expect(overlayRules).toHaveLength(0);
	});

	it("drops overlay rules whose ids collide with floor ids (tighten-only invariant)", () => {
		// Pick an actual built-in id so the collision check fires.
		const FLOOR_ID = "builtin-rm-rf-root";
		writeOverlayFile(cwd, SESSION, {
			version: 1,
			rules: [
				{
					id: FLOOR_ID,
					enabled: true,
					trigger: "PreToolUse",
					tool_match: ["*"],
					action: "block",
					patterns: [{ field: "command", regex: "anything" }],
					reason: "should be dropped.",
					severity: "low",
				},
			],
		});
		const config = loadRules(cwd, SESSION);
		// The floor `block_rm_rf` still survives; no overlay version replaces it.
		const matches = config.rules.filter((r) => r.id === FLOOR_ID);
		expect(matches).toHaveLength(1);
		expect(matches[0].reason).not.toContain("should be dropped");
	});
});
