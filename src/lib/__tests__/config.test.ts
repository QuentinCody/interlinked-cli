import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../non-null.js";
import {
	FEATURE_DEFAULTS,
	getActiveServerKey,
	getConfigDir,
	getDataDir,
	getHooksDir,
	getLocalConfigPath,
	getSharedConfigPath,
	hasLegacyConfig,
	initConfig,
	isConfigured,
	isFeatureEnabled,
	migrateLegacyConfig,
	readLocalConfig,
	readSharedConfig,
	resolveConfig,
	updateLocalConfig,
	writeSharedConfig,
} from "../config.js";

// A feature-flag key that is in FEATURE_DEFAULTS with a known default of `true`.
// Picked at module load so a future default flip surfaces here rather than
// hard-coding a literal flag name in every assertion.
const A_TRUE_DEFAULT = nonNull(Object.entries(FEATURE_DEFAULTS).find(([, v]) => v === true)?.[0]);
const A_FALSE_DEFAULT = nonNull(Object.entries(FEATURE_DEFAULTS).find(([, v]) => v === false)?.[0]);

describe("config paths", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("getConfigDir returns <cwd>/.interlinked", () => {
		expect(getConfigDir(tmp)).toBe(join(tmp, ".interlinked"));
	});

	it("getDataDir defaults under .interlinked/ but honors data_dir override", () => {
		// Default — no local config yet.
		expect(getDataDir(tmp)).toBe(join(tmp, ".interlinked"));
	});

	it("getHooksDir lives under .interlinked/hooks", () => {
		expect(getHooksDir(tmp)).toBe(join(tmp, ".interlinked", "hooks"));
	});

	it("config path helpers return absolute paths under cwd", () => {
		expect(getSharedConfigPath(tmp).startsWith(tmp)).toBe(true);
		expect(getLocalConfigPath(tmp).startsWith(tmp)).toBe(true);
	});
});

describe("readSharedConfig / readLocalConfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns null when no config exists", () => {
		expect(readSharedConfig(tmp)).toBeNull();
		expect(readLocalConfig(tmp)).toBeNull();
	});

	it("reads a valid shared config file", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "config.json"),
			JSON.stringify({ version: 1, server_url: "https://example.com" }),
		);
		const read = readSharedConfig(tmp);
		expect(read?.server_url).toBe("https://example.com");
	});

	it("returns null on malformed JSON (tolerant read)", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(join(tmp, ".interlinked", "config.json"), "not-json");
		expect(readSharedConfig(tmp)).toBeNull();
	});
});

describe("isConfigured", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("is false when no config file exists", () => {
		expect(isConfigured(tmp)).toBe(false);
	});

	it("is true once a shared config is written", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "config.json"),
			JSON.stringify({ version: 1, server_url: "https://x" }),
		);
		expect(isConfigured(tmp)).toBe(true);
	});
});

describe("resolveConfig", () => {
	const saved: Record<string, string | undefined> = {};
	const envKeys = [
		"INTERLINKED_SERVER_URL",
		"INTERLINKED_WORKSPACE_ID",
		"INTERLINKED_MCP_PREFIX",
		"INTERLINKED_AGENT_NAME",
		"INTERLINKED_AGENT",
		"INTERLINKED_ACCESS_TOKEN",
		"INTERLINKED_TOKEN",
		"INTERLINKED_SYNC_MODE",
	];
	let tmp: string;

	beforeEach(() => {
		for (const k of envKeys) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns a DEFAULT_SERVER url when nothing is configured", () => {
		const resolved = resolveConfig(tmp);
		expect(resolved.server_url).toBeTruthy();
		expect(resolved.sync_mode).toBe("realtime");
	});

	it("env INTERLINKED_SERVER_URL overrides every other source", () => {
		process.env.INTERLINKED_SERVER_URL = "https://env.example";
		const resolved = resolveConfig(tmp);
		expect(resolved.server_url).toBe("https://env.example");
	});

	it("env INTERLINKED_SYNC_MODE is accepted only for known values", () => {
		process.env.INTERLINKED_SYNC_MODE = "local";
		expect(resolveConfig(tmp).sync_mode).toBe("local");
		process.env.INTERLINKED_SYNC_MODE = "bogus";
		expect(resolveConfig(tmp).sync_mode).toBe("realtime");
	});

	it("env INTERLINKED_ACCESS_TOKEN overrides local.access_token", () => {
		process.env.INTERLINKED_ACCESS_TOKEN = "env-tok";
		expect(resolveConfig(tmp).access_token).toBe("env-tok");
	});
});

describe("updateLocalConfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("merges updates into existing local config", () => {
		updateLocalConfig({ agent_name: "alice" }, tmp);
		updateLocalConfig({ sync_mode: "manual" }, tmp);
		const read = readLocalConfig(tmp);
		expect(read?.agent_name).toBe("alice");
		expect(read?.sync_mode).toBe("manual");
	});

	it("deep-merges the `servers` map rather than replacing it", () => {
		updateLocalConfig({ servers: { production: { server_url: "https://prod" } } }, tmp);
		updateLocalConfig({ servers: { staging: { server_url: "https://staging" } } }, tmp);
		const read = readLocalConfig(tmp);
		expect(read?.servers?.production?.server_url).toBe("https://prod");
		expect(read?.servers?.staging?.server_url).toBe("https://staging");
	});

	it("merges fields into an existing server entry rather than clobbering siblings", () => {
		updateLocalConfig(
			{ servers: { production: { server_url: "https://prod", mcp_prefix: "px_" } } },
			tmp,
		);
		// Second update touches only workspace_id of the same entry.
		updateLocalConfig({ servers: { production: { server_url: "https://prod", workspace_id: "ws-1" } } }, tmp);
		const read = readLocalConfig(tmp);
		expect(read?.servers?.production?.mcp_prefix).toBe("px_");
		expect(read?.servers?.production?.workspace_id).toBe("ws-1");
	});

	it("first write seeds local config from empty (no prior file)", () => {
		expect(readLocalConfig(tmp)).toBeNull();
		updateLocalConfig({ agent_name: "fresh" }, tmp);
		expect(readLocalConfig(tmp)?.agent_name).toBe("fresh");
	});
});

describe("writeSharedConfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("persists a shared config that round-trips through readSharedConfig", () => {
		writeSharedConfig({ version: 1, server_url: "https://written.example" }, tmp);
		expect(readSharedConfig(tmp)?.server_url).toBe("https://written.example");
	});

	it("creates the .interlinked directory if it does not yet exist", () => {
		// Nested cwd that has no .interlinked dir — writeJson must mkdir -p.
		const nested = join(tmp, "deep", "nested");
		writeSharedConfig({ version: 1, server_url: "https://nested.example" }, nested);
		const onDisk: unknown = JSON.parse(
			readFileSync(getSharedConfigPath(nested), "utf-8"),
		);
		expect(onDisk).toHaveProperty("server_url", "https://nested.example");
	});

	it("writes pretty-printed JSON with a trailing newline", () => {
		writeSharedConfig({ version: 1, server_url: "https://x" }, tmp);
		const raw = readFileSync(getSharedConfigPath(tmp), "utf-8");
		expect(raw.endsWith("}\n")).toBe(true);
		expect(raw).toContain('    "server_url"'); // 4-space indent
	});
});

describe("getActiveServerKey", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("defaults to 'production' when no local config exists", () => {
		expect(getActiveServerKey(tmp)).toBe("production");
	});

	it("defaults to 'production' when local config omits active_server", () => {
		updateLocalConfig({ agent_name: "x" }, tmp);
		expect(getActiveServerKey(tmp)).toBe("production");
	});

	it("returns the configured active_server when set", () => {
		updateLocalConfig({ active_server: "staging" }, tmp);
		expect(getActiveServerKey(tmp)).toBe("staging");
	});
});

describe("hasLegacyConfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("is false when no legacy session file exists", () => {
		expect(hasLegacyConfig(tmp)).toBe(false);
	});

	it("is true once .claude/interlinked-session.json exists", () => {
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		writeFileSync(
			join(tmp, ".claude", "interlinked-session.json"),
			JSON.stringify({ server_url: "https://legacy" }),
		);
		expect(hasLegacyConfig(tmp)).toBe(true);
	});
});

describe("isFeatureEnabled", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function writeShared(harness: unknown): void {
		mkdirSync(getConfigDir(tmp), { recursive: true });
		writeFileSync(getSharedConfigPath(tmp), JSON.stringify({ version: 1, server_url: "https://x", harness }));
	}

	it("returns the FEATURE_DEFAULTS value when config is null", () => {
		expect(isFeatureEnabled(A_TRUE_DEFAULT, null)).toBe(true);
		expect(isFeatureEnabled(A_FALSE_DEFAULT, null)).toBe(false);
	});

	it("returns false for an unknown key not in FEATURE_DEFAULTS", () => {
		expect(isFeatureEnabled("harness.totally.unknown.flag", null)).toBe(false);
	});

	it("returns false for a non-harness-prefixed path (skips override walk, no default)", () => {
		// First segment isn't "harness" → override block is skipped and the key
		// isn't in FEATURE_DEFAULTS, so it resolves to false.
		expect(isFeatureEnabled("other.namespace.flag", null)).toBe(false);
	});

	it("skips the override tree for a non-harness path even when harness overrides exist", () => {
		// config.harness is truthy, but the queried path's first segment is not
		// "harness" → the inner override walk is skipped (false arm of the
		// `segments[0] === 'harness'` guard) and we fall to the default (false).
		writeShared({ checks: { ubs_advisory_tier: true } });
		expect(isFeatureEnabled("other.namespace.flag", readSharedConfig(tmp))).toBe(false);
	});

	it("override true wins over a default of false", () => {
		writeShared({ checks: { ubs_advisory_tier: true } });
		// ubs_advisory_tier defaults to false; override flips it on.
		expect(isFeatureEnabled("harness.checks.ubs_advisory_tier", readSharedConfig(tmp))).toBe(true);
	});

	it("override false wins over a default of true", () => {
		writeShared({ evaluator: { wrapper_normalization: false } });
		expect(
			isFeatureEnabled("harness.evaluator.wrapper_normalization", readSharedConfig(tmp)),
		).toBe(false);
	});

	it("falls back to the default when the override tree lacks the leaf segment", () => {
		// harness.evaluator exists but the specific leaf is absent → cursor
		// becomes undefined mid-walk and we fall through to FEATURE_DEFAULTS.
		writeShared({ evaluator: { something_else: true } });
		expect(
			isFeatureEnabled("harness.evaluator.wrapper_normalization", readSharedConfig(tmp)),
		).toBe(true);
	});

	it("falls back to the default when a path segment hits a boolean before the leaf", () => {
		// harness.evaluator is a boolean, but the path goes deeper — cursor is a
		// non-object mid-walk → break → fall through to the default.
		writeShared({ evaluator: true });
		expect(
			isFeatureEnabled("harness.evaluator.wrapper_normalization", readSharedConfig(tmp)),
		).toBe(true);
	});

	it("falls back to the default when the leaf override is an object, not a boolean", () => {
		// Leaf resolves to an object (not boolean) → not returned; default used.
		writeShared({ checks: { ubs_advisory_tier: { nested: true } } });
		expect(
			isFeatureEnabled("harness.checks.ubs_advisory_tier", readSharedConfig(tmp)),
		).toBe(false);
	});

	it("reads the shared config from disk when no config arg is passed", () => {
		// Exercises the default-arg readSharedConfig() path by pointing
		// INTERLINKED_HOME at our tmp .interlinked dir.
		const savedHome = process.env.INTERLINKED_HOME;
		try {
			mkdirSync(join(tmp, ".interlinked"), { recursive: true });
			process.env.INTERLINKED_HOME = join(tmp, ".interlinked");
			writeFileSync(
				getSharedConfigPath(),
				JSON.stringify({
					version: 1,
					server_url: "https://x",
					harness: { checks: { ubs_advisory_tier: true } },
				}),
			);
			expect(isFeatureEnabled("harness.checks.ubs_advisory_tier")).toBe(true);
		} finally {
			if (savedHome === undefined) delete process.env.INTERLINKED_HOME;
			else process.env.INTERLINKED_HOME = savedHome;
		}
	});
});

describe("migrateLegacyConfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function writeLegacy(session: unknown): void {
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		writeFileSync(
			join(tmp, ".claude", "interlinked-session.json"),
			JSON.stringify(session),
		);
	}

	it("returns false and writes nothing when there is no legacy file", () => {
		expect(migrateLegacyConfig(tmp)).toBe(false);
		expect(isConfigured(tmp)).toBe(false);
	});

	it("migrates a minimal legacy session into shared + local config", () => {
		writeLegacy({
			server_url: "https://legacy.example",
			agent_name: "legacy-agent",
			mcp_prefix: "lg_",
			workspace_uuid: "ws-legacy",
			agent_handle: "@legacy",
		});
		expect(migrateLegacyConfig(tmp)).toBe(true);
		expect(readSharedConfig(tmp)?.server_url).toBe("https://legacy.example");
		const local = readLocalConfig(tmp);
		expect(local?.agent_name).toBe("legacy-agent");
		expect(local?.mcp_prefix).toBe("lg_");
		expect(local?.workspace_id).toBe("ws-legacy");
		expect(local?.agent_handle).toBe("@legacy");
	});

	it("falls back to DEFAULT_SERVER and preserves existing local fields when legacy omits them", () => {
		// Seed an existing local config; legacy session has only a (blank) url.
		updateLocalConfig(
			{ agent_name: "kept", mcp_prefix: "kept_", workspace_id: "kept-ws", agent_handle: "@kept" },
			tmp,
		);
		writeLegacy({ server_url: "" });
		expect(migrateLegacyConfig(tmp)).toBe(true);
		// Empty legacy server_url → DEFAULT_SERVER (a localhost url).
		expect(readSharedConfig(tmp)?.server_url).toMatch(/localhost|127\.0\.0\.1/);
		const local = readLocalConfig(tmp);
		// Legacy fields absent → existing local values retained.
		expect(local?.agent_name).toBe("kept");
		expect(local?.mcp_prefix).toBe("kept_");
		expect(local?.workspace_id).toBe("kept-ws");
		expect(local?.agent_handle).toBe("@kept");
	});

	it("migrates a legacy multi-server map into local.servers", () => {
		// Existing local already has one server entry to exercise the merge.
		updateLocalConfig({ servers: { existing: { server_url: "https://existing" } } }, tmp);
		writeLegacy({
			server_url: "https://primary",
			servers: {
				prod: { server_url: "https://prod-legacy", mcp_prefix: "pl_", workspace_uuid: "ws-pl" },
				dev: { server_url: "https://dev-legacy" },
			},
		});
		expect(migrateLegacyConfig(tmp)).toBe(true);
		const local = readLocalConfig(tmp);
		expect(local?.servers?.existing?.server_url).toBe("https://existing");
		expect(local?.servers?.prod?.server_url).toBe("https://prod-legacy");
		expect(local?.servers?.prod?.mcp_prefix).toBe("pl_");
		expect(local?.servers?.prod?.workspace_id).toBe("ws-pl");
		expect(local?.servers?.dev?.server_url).toBe("https://dev-legacy");
	});
});

describe("initConfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("creates a fresh shared config from the provided serverUrl", () => {
		initConfig({ serverUrl: "https://fresh.example" }, tmp);
		const shared = readSharedConfig(tmp);
		expect(shared?.version).toBe(1);
		expect(shared?.server_url).toBe("https://fresh.example");
	});

	it("falls back to DEFAULT_SERVER when no serverUrl and no existing shared config", () => {
		initConfig({}, tmp);
		expect(readSharedConfig(tmp)?.server_url).toMatch(/localhost|127\.0\.0\.1/);
	});

	it("preserves an existing shared server_url when serverUrl option is omitted", () => {
		writeSharedConfig({ version: 1, server_url: "https://preexisting.example" }, tmp);
		initConfig({}, tmp);
		expect(readSharedConfig(tmp)?.server_url).toBe("https://preexisting.example");
	});

	it("does not write a local config when neither agentName nor mcpPrefix is given", () => {
		initConfig({ serverUrl: "https://x" }, tmp);
		expect(readLocalConfig(tmp)).toBeNull();
	});

	it("writes only agent_name when agentName given without mcpPrefix", () => {
		initConfig({ serverUrl: "https://x", agentName: "ann" }, tmp);
		const local = readLocalConfig(tmp);
		expect(local?.agent_name).toBe("ann");
		expect(local?.mcp_prefix).toBeUndefined();
	});

	it("writes only mcp_prefix when mcpPrefix given without agentName", () => {
		initConfig({ serverUrl: "https://x", mcpPrefix: "mp_" }, tmp);
		const local = readLocalConfig(tmp);
		expect(local?.mcp_prefix).toBe("mp_");
		expect(local?.agent_name).toBeUndefined();
	});

	it("merges agent fields into a pre-existing local config", () => {
		updateLocalConfig({ sync_mode: "manual" }, tmp);
		initConfig({ serverUrl: "https://x", agentName: "ann", mcpPrefix: "mp_" }, tmp);
		const local = readLocalConfig(tmp);
		expect(local?.sync_mode).toBe("manual"); // preserved
		expect(local?.agent_name).toBe("ann");
		expect(local?.mcp_prefix).toBe("mp_");
	});

	it("preserves every allow-listed shared field on re-init", () => {
		// Seed a shared config that exercises ALL preservation branches.
		writeSharedConfig(
			{
				version: 1,
				server_url: "https://orig.example",
				default_workspace_key: "wk-key",
				default_project: "proj-x",
				mode: "ci",
				skip_paths: ["dist/**", "vendor/**"],
				pii_patterns: [{ name: "p1", pattern: "\\d{3}", severity: "high" }],
				pii_opt_in: ["email"],
				harness: { checks: { ubs_advisory_tier: true } },
			},
			tmp,
		);
		// Re-init with a NEW server url; everything else must survive.
		initConfig({ serverUrl: "https://new.example" }, tmp);
		const shared = readSharedConfig(tmp);
		expect(shared?.server_url).toBe("https://new.example");
		expect(shared?.default_workspace_key).toBe("wk-key");
		expect(shared?.default_project).toBe("proj-x");
		expect(shared?.mode).toBe("ci");
		expect(shared?.skip_paths).toEqual(["dist/**", "vendor/**"]);
		expect(shared?.pii_patterns).toEqual([{ name: "p1", pattern: "\\d{3}", severity: "high" }]);
		expect(shared?.pii_opt_in).toEqual(["email"]);
		expect(shared?.harness).toEqual({ checks: { ubs_advisory_tier: true } });
	});

	it("omits absent optional shared fields rather than emitting undefined keys", () => {
		// A minimal existing shared config — none of the optional fields set —
		// drives the FALSE arm of every preservation conditional.
		writeSharedConfig({ version: 1, server_url: "https://min.example" }, tmp);
		initConfig({ serverUrl: "https://min2.example" }, tmp);
		const raw = readFileSync(getSharedConfigPath(tmp), "utf-8");
		expect(raw).not.toContain("default_workspace_key");
		expect(raw).not.toContain("default_project");
		expect(raw).not.toContain("skip_paths");
		expect(raw).not.toContain("pii_patterns");
		expect(raw).not.toContain('"mode"');
	});
});

describe("resolveConfig — server entry selection", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const envKeys = [
		"INTERLINKED_SERVER_URL",
		"INTERLINKED_WORKSPACE_ID",
		"INTERLINKED_MCP_PREFIX",
		"INTERLINKED_AGENT_NAME",
		"INTERLINKED_AGENT",
		"INTERLINKED_ACCESS_TOKEN",
		"INTERLINKED_TOKEN",
		"INTERLINKED_SYNC_MODE",
	];
	let tmp: string;

	beforeEach(() => {
		for (const k of envKeys) {
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
		rmSync(tmp, { recursive: true, force: true });
	});

	it("resolves the configured active server entry (url + workspace + prefix paired)", () => {
		updateLocalConfig(
			{
				active_server: "staging",
				servers: {
					staging: { server_url: "https://staging", workspace_id: "ws-stg", mcp_prefix: "stg_" },
				},
			},
			tmp,
		);
		const resolved = resolveConfig(tmp);
		expect(resolved.server_url).toBe("https://staging");
		expect(resolved.workspace_id).toBe("ws-stg");
		expect(resolved.mcp_prefix).toBe("stg_");
	});

	it("when env URL matches a configured server, pulls that entry's workspace + prefix", () => {
		updateLocalConfig(
			{
				servers: {
					production: { server_url: "https://prod", workspace_id: "ws-prod", mcp_prefix: "pr_" },
				},
			},
			tmp,
		);
		process.env.INTERLINKED_SERVER_URL = "https://prod";
		const resolved = resolveConfig(tmp);
		expect(resolved.server_url).toBe("https://prod");
		// env URL matched the server entry → its workspace/prefix flow through.
		expect(resolved.workspace_id).toBe("ws-prod");
		expect(resolved.mcp_prefix).toBe("pr_");
	});

	it("when env URL matches no configured server, uses env URL but no entry workspace", () => {
		updateLocalConfig(
			{
				workspace_id: "top-level-ws",
				servers: {
					production: { server_url: "https://prod", workspace_id: "ws-prod" },
				},
			},
			tmp,
		);
		process.env.INTERLINKED_SERVER_URL = "https://unmatched";
		const resolved = resolveConfig(tmp);
		expect(resolved.server_url).toBe("https://unmatched");
		// No matched entry → falls back to the top-level local workspace_id.
		expect(resolved.workspace_id).toBe("top-level-ws");
	});

	it("uses the shared server_url when no env and no matching server entry", () => {
		writeSharedConfig({ version: 1, server_url: "https://shared-only" }, tmp);
		const resolved = resolveConfig(tmp);
		expect(resolved.server_url).toBe("https://shared-only");
	});

	it("surfaces top-level local agent/token/handle fields", () => {
		updateLocalConfig(
			{
				agent_name: "carol",
				access_token: "tok-local",
				refresh_token: "rtok",
				token_expires_at: "2030-01-01T00:00:00Z",
				oauth_client_id: "cid",
				agent_handle: "@carol",
			},
			tmp,
		);
		const resolved = resolveConfig(tmp);
		expect(resolved.agent_name).toBe("carol");
		expect(resolved.access_token).toBe("tok-local");
		expect(resolved.refresh_token).toBe("rtok");
		expect(resolved.token_expires_at).toBe("2030-01-01T00:00:00Z");
		expect(resolved.oauth_client_id).toBe("cid");
		expect(resolved.agent_handle).toBe("@carol");
	});

	it("env agent + mcp_prefix + workspace overrides win over local", () => {
		updateLocalConfig({ agent_name: "local-agent", mcp_prefix: "local_" }, tmp);
		process.env.INTERLINKED_AGENT = "env-agent";
		process.env.INTERLINKED_MCP_PREFIX = "env_";
		process.env.INTERLINKED_WORKSPACE_ID = "env-ws";
		process.env.INTERLINKED_TOKEN = "env-token-alt";
		const resolved = resolveConfig(tmp);
		expect(resolved.agent_name).toBe("env-agent");
		expect(resolved.mcp_prefix).toBe("env_");
		expect(resolved.workspace_id).toBe("env-ws");
		expect(resolved.access_token).toBe("env-token-alt");
	});

	it("local sync_mode is honored when no env override is present", () => {
		updateLocalConfig({ sync_mode: "local" }, tmp);
		expect(resolveConfig(tmp).sync_mode).toBe("local");
	});

	it("surfaces shared default_workspace_key and default_project", () => {
		writeSharedConfig(
			{
				version: 1,
				server_url: "https://x",
				default_workspace_key: "dwk",
				default_project: "dp",
			},
			tmp,
		);
		const resolved = resolveConfig(tmp);
		expect(resolved.default_workspace_key).toBe("dwk");
		expect(resolved.default_project).toBe("dp");
	});
});

describe("getDataDir — data_dir override from local config (real fs)", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const envKeys = ["INTERLINKED_DATA_DIR", "INTERLINKED_HOME"];
	let tmp: string;

	beforeEach(() => {
		for (const k of envKeys) {
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
		tmp = mkdtempSync(join(tmpdir(), "cfg-test-"));
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reads data_dir from a real config.local.json on disk", () => {
		updateLocalConfig({ data_dir: "/explicit/data/dir" }, tmp);
		expect(getDataDir(tmp)).toBe("/explicit/data/dir");
	});

	it("falls through to default config dir when local config has no data_dir", () => {
		updateLocalConfig({ agent_name: "x" }, tmp);
		expect(getDataDir(tmp)).toBe(join(tmp, ".interlinked"));
	});
});
