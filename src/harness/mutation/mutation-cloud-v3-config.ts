// =========================================================
// Mutation cloud v3 — explicit local opt-in configuration
// =========================================================

import { resolve } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { readConfinedFileText } from "./mutation-cloud-v3-local-read.js";
import type { MutationCloudV3RuntimeConfig } from "./mutation-cloud-v3-runtime.js";
import {
	keyRegistryFailure,
	registryRoleConflictFailure,
	type V3KeyRegistry,
} from "./protocol-v3/canonical.js";
import { PROTOCOL_V3_CONTRACT_DIGEST } from "./protocol-v3/contract-identity.js";

export const MUTATION_CLOUD_V3_LOCAL_CONFIG = ".interlinked/mutation-cloud-v3.local.json";
export const MAX_MUTATION_CLOUD_V3_CONFIG_BYTES = 64 * 1024;

const CONFIG_KEYS = [
	"version",
	"enabled",
	"background_enabled",
	"base_url",
	"token",
	"project_ref",
	"repository",
	"claimant_id",
	"owner",
	"timeout_ms",
	"lease_ms",
	"contract_digest",
	"key_registry",
	"server_authority",
	"evaluator_policy_version",
	"site_count_threshold",
] as const;

const MAX_RUNTIME_OWNER_LENGTH = 128;
const SAFE_RUNTIME_OWNER_CHARS = /^[A-Za-z0-9._:-]+$/;

interface MutationCloudV3LocalConfig extends MutationCloudV3RuntimeConfig {
	/** Separate, default-off authorization for daemon-owned processing. Manual
	 * cloud commands need only the enclosing enabled:true runtime opt-in. */
	backgroundEnabled: boolean;
}

type MutationCloudV3ConfigOutcome =
	| { ok: true; config: MutationCloudV3LocalConfig }
	| { ok: false; reason: string };

function unknownConfigKey(value: Record<string, unknown>): string | null {
	const allowed = new Set<string>(CONFIG_KEYS);
	const unknown = Object.keys(value).find((key) => !allowed.has(key));
	return unknown === undefined ? null : `mutation cloud config carries unknown key "${unknown}"`;
}

function nonEmpty(value: unknown, field: string): string | null {
	return typeof value === "string" && value.length > 0 ? null : `mutation cloud config ${field} is required`;
}

function positiveInteger(value: unknown, field: string): string | null {
	return Number.isSafeInteger(value) && Number(value) > 0
		? null
		: `mutation cloud config ${field} must be a positive safe integer`;
}

function runtimeOwnerFailure(value: unknown): string | null {
	return typeof value === "string" && value.length <= MAX_RUNTIME_OWNER_LENGTH && SAFE_RUNTIME_OWNER_CHARS.test(value)
		? null
		: "mutation cloud config owner must be a 1-128 character identifier using letters, digits, dot, underscore, colon, or hyphen";
}

function leaseMarginFailure(timeoutMs: unknown, leaseMs: unknown): string | null {
	if (typeof timeoutMs !== "number" || typeof leaseMs !== "number") return null;
	return leaseMs >= timeoutMs * 3
		? null
		: "mutation cloud config lease_ms must be at least 3 × timeout_ms for claim/report/evaluation fencing";
}

type BackgroundSetting =
	| { ok: true; enabled: boolean }
	| { ok: false; reason: string };

function backgroundSetting(value: unknown): BackgroundSetting {
	if (value === undefined) return { ok: true, enabled: false };
	return typeof value === "boolean"
		? { ok: true, enabled: value }
		: { ok: false, reason: "mutation cloud config background_enabled must be a boolean when present" };
}

function checkedString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`internal mutation cloud config parser lost checked ${field}`);
	}
	return value;
}

function checkedPositiveInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || Number(value) <= 0) {
		throw new Error(`internal mutation cloud config parser lost checked ${field}`);
	}
	return Number(value);
}

function safeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return "mutation cloud config base_url is required";
	try {
		const parsed = new URL(value);
		const localHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
		return parsed.protocol === "https:" || localHttp
			? null
			: "mutation cloud config base_url must use HTTPS (HTTP is allowed only for loopback testing)";
	} catch {
		return "mutation cloud config base_url must be an absolute URL";
	}
}

function authorityFailure(value: unknown, projectRef: unknown): string | null {
	if (!isJsonObject(value)) return "mutation cloud config server_authority must be an object";
	const keys = Object.keys(value).sort();
	if (keys.join(",") !== "project,tenant") {
		return "mutation cloud config server_authority must contain exactly tenant and project";
	}
	const tenant = nonEmpty(value.tenant, "server_authority.tenant");
	if (tenant !== null) return tenant;
	const project = nonEmpty(value.project, "server_authority.project");
	if (project !== null) return project;
	return value.project === projectRef
		? null
		: "mutation cloud config server_authority.project must equal project_ref";
}

/** Strictly parse the ignored, machine-local cloud runtime config. Manual
 * commands require enabled:true; daemon processing additionally requires the
 * separately parsed, default-off background_enabled:true. */
export function parseMutationCloudV3Config(value: unknown, root: string): MutationCloudV3ConfigOutcome {
	if (!isJsonObject(value)) return { ok: false, reason: "mutation cloud config must be a JSON object" };
	const unknown = unknownConfigKey(value);
	if (unknown !== null) return { ok: false, reason: unknown };
	if (value.version !== 1) return { ok: false, reason: "mutation cloud config version must be 1" };
	if (value.enabled !== true) {
		return { ok: false, reason: "mutation cloud v3 is not opted in (set enabled to true in the local config)" };
	}
	const background = backgroundSetting(value.background_enabled);
	if (!background.ok) return background;
	for (const [field, candidate] of [
		["token", value.token],
		["project_ref", value.project_ref],
		["repository", value.repository],
		["claimant_id", value.claimant_id],
		["evaluator_policy_version", value.evaluator_policy_version],
		["contract_digest", value.contract_digest],
	] as const) {
		const failure = nonEmpty(candidate, field);
		if (failure !== null) return { ok: false, reason: failure };
	}
	const ownerFailure = runtimeOwnerFailure(value.owner);
	if (ownerFailure !== null) return { ok: false, reason: ownerFailure };
	const leaseMargin = leaseMarginFailure(value.timeout_ms, value.lease_ms);
	if (leaseMargin !== null) return { ok: false, reason: leaseMargin };
	const baseUrl = safeBaseUrl(value.base_url);
	if (baseUrl !== null) return { ok: false, reason: baseUrl };
	if (typeof value.contract_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.contract_digest)) {
		return { ok: false, reason: "mutation cloud config contract_digest must be lowercase sha-256 hex" };
	}
	if (value.contract_digest !== PROTOCOL_V3_CONTRACT_DIGEST) {
		return {
			ok: false,
			reason: `mutation cloud config contract_digest does not match this CLI build (${PROTOCOL_V3_CONTRACT_DIGEST})`,
		};
	}
	for (const [field, candidate] of [
		["timeout_ms", value.timeout_ms],
		["lease_ms", value.lease_ms],
		["site_count_threshold", value.site_count_threshold],
	] as const) {
		const failure = positiveInteger(candidate, field);
		if (failure !== null) return { ok: false, reason: failure };
	}
	const authority = authorityFailure(value.server_authority, value.project_ref);
	if (authority !== null) return { ok: false, reason: authority };
	const registry = keyRegistryFailure(value.key_registry);
	if (registry !== null) return { ok: false, reason: `mutation cloud config ${registry}` };
	// SAFETY: keyRegistryFailure constructed every record and validated key
	// purpose/window/public-key fields; this only names that proven shape.
	const keyRegistry = value.key_registry as V3KeyRegistry;
	const roleConflict = registryRoleConflictFailure(keyRegistry);
	if (roleConflict !== null) return { ok: false, reason: `mutation cloud config ${roleConflict}` };

	if (!isJsonObject(value.server_authority)) {
		throw new Error("internal mutation cloud config parser lost checked server_authority");
	}
	const serverAuthority = {
		tenant: checkedString(value.server_authority.tenant, "server_authority.tenant"),
		project: checkedString(value.server_authority.project, "server_authority.project"),
	};
	const common = {
		baseUrl: checkedString(value.base_url, "base_url"),
		token: checkedString(value.token, "token"),
		projectRef: checkedString(value.project_ref, "project_ref"),
		timeoutMs: checkedPositiveInteger(value.timeout_ms, "timeout_ms"),
	};
	return {
		ok: true,
		config: {
			backgroundEnabled: background.enabled,
			submission: {
				...common,
				repository: checkedString(value.repository, "repository"),
				contractDigest: checkedString(value.contract_digest, "contract_digest"),
				keyRegistry,
				serverAuthority,
			},
			client: { ...common, claimantId: checkedString(value.claimant_id, "claimant_id") },
			evaluator: {
				keyRegistry,
				serverAuthority,
				evaluatorPolicyVersion: checkedString(value.evaluator_policy_version, "evaluator_policy_version"),
				siteCountThreshold: checkedPositiveInteger(value.site_count_threshold, "site_count_threshold"),
				cwd: root,
			},
			owner: checkedString(value.owner, "owner"),
			leaseMs: checkedPositiveInteger(value.lease_ms, "lease_ms"),
		},
	};
}

export function loadMutationCloudV3Config(root: string, path = MUTATION_CLOUD_V3_LOCAL_CONFIG): MutationCloudV3LocalConfig {
	const absolute = resolve(root, path);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readConfinedFileText({
			root,
			path,
			maxBytes: MAX_MUTATION_CLOUD_V3_CONFIG_BYTES,
			label: "mutation cloud config",
		}));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`could not read mutation cloud config ${absolute}: ${detail}`, { cause: error });
	}
	const outcome = parseMutationCloudV3Config(parsed, root);
	if (!outcome.ok) throw new Error(`${absolute}: ${outcome.reason}`);
	return outcome.config;
}
