import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../non-null.js";
import {
	FEATURE_DEFAULTS,
	getLocalConfigPath,
	initConfig,
	isFeatureEnabled,
	migrateLegacyConfig,
	readLocalConfig,
	resolveConfig,
	updateLocalConfig,
	writeSharedConfig,
	type FeatureNode,
} from "../config.js";

const ENV_KEYS = [
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
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	tmp = mkdtempSync(join(tmpdir(), "cfg-mut-"));
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	rmSync(tmp, { recursive: true, force: true });
});

function writeLegacy(session: unknown): void {
	mkdirSync(join(tmp, ".claude"), { recursive: true });
	writeFileSync(join(tmp, ".claude", "interlinked-session.json"), JSON.stringify(session));
}

// Basis: config.ts:89-90 ("boolean leaves enable features, while string leaves
// carry metadata") and config.ts:291-292 (override is read only when the path
// has a boolean leaf).
describe("isFeatureEnabled — non-boolean leaves", () => {
	it("ignores a string metadata leaf and falls back to the flag default", () => {
		const flag = nonNull(Object.entries(FEATURE_DEFAULTS).find(([, v]) => v === true)?.[0]);
		const segments = flag.split(".").slice(1);
		const leaf = nonNull(segments.pop());
		const branch: FeatureNode = { [leaf]: "false" };
		let tree: FeatureNode = branch;
		for (const seg of segments.reverse()) tree = { [seg]: tree };
		const result = isFeatureEnabled(flag, { version: 1, server_url: "https://x", harness: tree });
		expect(result).toBe(true);
	});
});

// Basis: config.ts:334-337 — the active server entry is used so server_url,
// workspace_id and mcp_prefix are always paired.
describe("resolveConfig — active server entry wins over other sources", () => {
	it("prefers the active server entry url over the shared server_url", () => {
		writeSharedConfig({ version: 1, server_url: "https://shared" }, tmp);
		updateLocalConfig(
			{ active_server: "prod", servers: { prod: { server_url: "https://entry" } } },
			tmp,
		);
		expect(resolveConfig(tmp).server_url).toBe("https://entry");
	});

	it("prefers the active server entry workspace_id over the top-level local workspace_id", () => {
		updateLocalConfig(
			{
				workspace_id: "ws-local",
				active_server: "prod",
				servers: { prod: { server_url: "https://entry", workspace_id: "ws-entry" } },
			},
			tmp,
		);
		expect(resolveConfig(tmp).workspace_id).toBe("ws-entry");
	});

	it("prefers the active server entry mcp_prefix over the top-level local mcp_prefix", () => {
		updateLocalConfig(
			{
				mcp_prefix: "local_",
				active_server: "prod",
				servers: { prod: { server_url: "https://entry", mcp_prefix: "entry_" } },
			},
			tmp,
		);
		expect(resolveConfig(tmp).mcp_prefix).toBe("entry_");
	});
});

// Basis: config.ts:398-400 (legacy file is migrated into the new format) and
// config.ts:412 (merge into existing local config, preserve other fields).
describe("migrateLegacyConfig — legacy values and existing fields", () => {
	it("imports the legacy agent_name over a pre-existing local agent_name", () => {
		updateLocalConfig({ agent_name: "old-agent" }, tmp);
		writeLegacy({ server_url: "https://primary", agent_name: "legacy-agent" });
		expect(migrateLegacyConfig(tmp)).toBe(true);
		expect(readLocalConfig(tmp)?.agent_name).toBe("legacy-agent");
	});

	it("imports the legacy workspace_uuid over a pre-existing local workspace_id", () => {
		updateLocalConfig({ workspace_id: "ws-old" }, tmp);
		writeLegacy({ server_url: "https://primary", workspace_uuid: "ws-legacy" });
		expect(migrateLegacyConfig(tmp)).toBe(true);
		expect(readLocalConfig(tmp)?.workspace_id).toBe("ws-legacy");
	});

	it("keeps unrelated fields of an existing server entry when a legacy server of the same name is merged", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			getLocalConfigPath(tmp),
			JSON.stringify({ servers: { prod: { server_url: "https://old", label: "keep-me" } } }),
		);
		writeLegacy({
			server_url: "https://primary",
			servers: { prod: { server_url: "https://prod-legacy" } },
		});
		expect(migrateLegacyConfig(tmp)).toBe(true);
		const prod = readLocalConfig(tmp)?.servers?.prod as Record<string, unknown> | undefined;
		expect(prod?.server_url).toBe("https://prod-legacy");
		expect(prod?.label).toBe("keep-me");
	});
});

// Basis: config.ts:440-457 — re-init preserves every deliberate setting; only
// the options the caller passes change.
describe("initConfig — partial agent options", () => {
	it("does not erase an existing local mcp_prefix when only agentName is given", () => {
		updateLocalConfig({ mcp_prefix: "keep_" }, tmp);
		initConfig({ agentName: "new-agent" }, tmp);
		const local = readLocalConfig(tmp);
		expect(local?.agent_name).toBe("new-agent");
		expect(local?.mcp_prefix).toBe("keep_");
	});
});
