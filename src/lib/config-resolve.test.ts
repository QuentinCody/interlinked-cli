import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resolveActiveServerEntry,
	resolveConfigEnvOverrides,
	resolveSyncMode,
} from "./config-resolve.js";
import type { LocalConfig } from "./config.js";

const ENV_KEYS = [
	"INTERLINKED_SERVER_URL",
	"INTERLINKED_WORKSPACE_ID",
	"INTERLINKED_MCP_PREFIX",
	"INTERLINKED_AGENT_NAME",
	"INTERLINKED_AGENT",
	"INTERLINKED_ACCESS_TOKEN",
	"INTERLINKED_TOKEN",
	"INTERLINKED_SYNC_MODE",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("resolveConfigEnvOverrides — positive (must fire)", () => {
	it("P1: reads and trims every override var", () => {
		process.env.INTERLINKED_SERVER_URL = " http://x ";
		process.env.INTERLINKED_WORKSPACE_ID = " ws ";
		process.env.INTERLINKED_MCP_PREFIX = " pfx ";
		process.env.INTERLINKED_AGENT_NAME = " agent ";
		process.env.INTERLINKED_ACCESS_TOKEN = " tok ";
		process.env.INTERLINKED_SYNC_MODE = " Local ";

		expect(resolveConfigEnvOverrides()).toEqual({
			envServerUrl: "http://x",
			envWorkspaceId: "ws",
			envMcpPrefix: "pfx",
			envAgentName: "agent",
			envAccessToken: "tok",
			envSyncMode: "local",
		});
	});

	it("P2: falls back to legacy INTERLINKED_AGENT and INTERLINKED_TOKEN names", () => {
		process.env.INTERLINKED_AGENT = "legacy-agent";
		process.env.INTERLINKED_TOKEN = "legacy-tok";

		const result = resolveConfigEnvOverrides();
		expect(result.envAgentName).toBe("legacy-agent");
		expect(result.envAccessToken).toBe("legacy-tok");
	});

	it("P3: prefers the primary var name over the legacy one when both are set", () => {
		process.env.INTERLINKED_AGENT_NAME = "primary-agent";
		process.env.INTERLINKED_AGENT = "legacy-agent";
		process.env.INTERLINKED_ACCESS_TOKEN = "primary-tok";
		process.env.INTERLINKED_TOKEN = "legacy-tok";

		const result = resolveConfigEnvOverrides();
		expect(result.envAgentName).toBe("primary-agent");
		expect(result.envAccessToken).toBe("primary-tok");
	});
});

describe("resolveConfigEnvOverrides — negative (must not fire)", () => {
	it("N1: returns undefined for every field when no env vars are set", () => {
		expect(resolveConfigEnvOverrides()).toEqual({
			envServerUrl: undefined,
			envWorkspaceId: undefined,
			envMcpPrefix: undefined,
			envAgentName: undefined,
			envAccessToken: undefined,
			envSyncMode: undefined,
		});
	});
});

describe("resolveActiveServerEntry — positive (must fire)", () => {
	it("P1: returns the configured active_server entry when no env URL override", () => {
		const local: LocalConfig = {
			active_server: "staging",
			servers: {
				staging: { server_url: "http://staging" },
				production: { server_url: "http://prod" },
			},
		};
		expect(resolveActiveServerEntry(local, undefined)).toEqual({
			server_url: "http://staging",
		});
	});

	it("P2: defaults active_server to 'production' when unset", () => {
		const local: LocalConfig = {
			servers: { production: { server_url: "http://prod" } },
		};
		expect(resolveActiveServerEntry(local, undefined)).toEqual({
			server_url: "http://prod",
		});
	});

	it("P3: matches by server_url when an env URL override is present", () => {
		const local: LocalConfig = {
			active_server: "production",
			servers: {
				production: { server_url: "http://prod" },
				matched: { server_url: "http://env-match", workspace_id: "w1" },
			},
		};
		expect(resolveActiveServerEntry(local, "http://env-match")).toEqual({
			server_url: "http://env-match",
			workspace_id: "w1",
		});
	});
});

describe("resolveActiveServerEntry — negative (must not fire)", () => {
	it("N1: returns undefined when local config is null", () => {
		expect(resolveActiveServerEntry(null, undefined)).toBeUndefined();
	});

	it("N2: returns undefined when env URL override matches no configured server", () => {
		const local: LocalConfig = {
			servers: { production: { server_url: "http://prod" } },
		};
		expect(resolveActiveServerEntry(local, "http://unmatched")).toBeUndefined();
	});
});

describe("resolveSyncMode — positive (must fire)", () => {
	it("P1: uses a valid env override over the local config value", () => {
		const local: LocalConfig = { sync_mode: "realtime" };
		expect(resolveSyncMode(local, "manual")).toBe("manual");
	});

	it("P2: falls back to local sync_mode when no env override is present", () => {
		const local: LocalConfig = { sync_mode: "manual" };
		expect(resolveSyncMode(local, undefined)).toBe("manual");
	});

	it("P3: defaults to 'realtime' when neither env nor local set a mode", () => {
		expect(resolveSyncMode(null, undefined)).toBe("realtime");
	});
});

describe("resolveSyncMode — negative (must not fire)", () => {
	it("N1: ignores an invalid env override string and falls back to local", () => {
		const local: LocalConfig = { sync_mode: "local" };
		expect(resolveSyncMode(local, "bogus")).toBe("local");
	});
});
