// ===========================================
// Simplification — versioned capability catalog contract
// ===========================================
// A stdlib/native replacement is never justified by an API name alone. This
// artifact pins the runtime/platform version and the evidence used to compare
// semantics. It is a Cloud-review input contract; the local CLI ships no
// universal equivalence claims.

import { createHash } from "node:crypto";
import { isJsonObject, type JsonObject } from "./json-types.js";
import { canonicalSimplificationAgentCiJson } from "./simplification-agent-ci-request.js";
import { isPinnedExactVersion } from "./simplification-version.js";

/** Public wire-version constant for Interlinked MCP Server implementations. */
const SIMPLIFICATION_CAPABILITY_CATALOG_VERSION =
	"simplification-capability-catalog/v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REMEDIES = ["stdlib", "native"] as const;
const SUPPORT = ["available", "partial", "unavailable"] as const;
const EQUIVALENCE = ["unverified", "contract-checked", "fixture-validated"] as const;

type SimplificationCapabilityRemedy = (typeof REMEDIES)[number];
type SimplificationCapabilitySupport = (typeof SUPPORT)[number];
type SimplificationCapabilityEquivalence = (typeof EQUIVALENCE)[number];

interface SimplificationCapabilityEntry {
	id: string;
	remedy: SimplificationCapabilityRemedy;
	capability: string;
	target: {
		name: string;
		version: string;
	};
	support: SimplificationCapabilitySupport;
	equivalence: SimplificationCapabilityEquivalence;
	contract_sha256: string;
	fixture_sha256: string | null;
	provenance: {
		source: string;
		source_sha256: string;
		checked_at: string;
	};
	limitations: string[];
}

export interface SimplificationCapabilityCatalog {
	schema_version: typeof SIMPLIFICATION_CAPABILITY_CATALOG_VERSION;
	catalog_id: string;
	entries: SimplificationCapabilityEntry[];
}

type SimplificationCapabilityCatalogParseResult =
	| { ok: true; catalog: Readonly<SimplificationCapabilityCatalog> }
	| { ok: false; reason: string };

function exactKeys(value: object, expected: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function sha256(value: unknown): value is string {
	return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const millis = Date.parse(value);
	return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function member<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
	return typeof value === "string" && values.some((candidate) => candidate === value);
}

function canonicalStrings(value: unknown): value is string[] {
	if (!Array.isArray(value) || !value.every(nonempty)) return false;
	if (new Set(value).size !== value.length) return false;
	return value.every((entry, index) => index === 0 || entry >= (value[index - 1] ?? ""));
}

function parseTarget(value: unknown): SimplificationCapabilityEntry["target"] | null {
	if (!isJsonObject(value) || !exactKeys(value, ["name", "version"])) return null;
	if (!nonempty(value.name) || !nonempty(value.version)) return null;
	if (!isPinnedExactVersion(value.version)) return null;
	return { name: value.name, version: value.version };
}

function parseProvenance(
	value: unknown,
): SimplificationCapabilityEntry["provenance"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["source", "source_sha256", "checked_at"],
	)) return null;
	if (!nonempty(value.source) || !sha256(value.source_sha256) || !isoTimestamp(value.checked_at)) {
		return null;
	}
	return {
		source: value.source,
		source_sha256: value.source_sha256,
		checked_at: value.checked_at,
	};
}

type SimplificationCapabilityEntryScalars = {
	id: string;
	remedy: SimplificationCapabilityRemedy;
	capability: string;
	support: SimplificationCapabilitySupport;
	equivalence: SimplificationCapabilityEquivalence;
	contract_sha256: string;
	fixture_sha256: string | null;
	limitations: string[];
};

function hasValidEntryScalars(
	value: JsonObject,
	target: SimplificationCapabilityEntry["target"] | null,
): value is SimplificationCapabilityEntryScalars {
	if (
		!target || !nonempty(value.id) || !member(value.remedy, REMEDIES)
		|| !nonempty(value.capability)
	) {
		return false;
	}
	if (!member(value.support, SUPPORT) || !member(value.equivalence, EQUIVALENCE)) {
		return false;
	}
	if (!sha256(value.contract_sha256) || !canonicalStrings(value.limitations)) return false;
	if (value.fixture_sha256 !== null && !sha256(value.fixture_sha256)) return false;
	return true;
}

function hasConsistentEntryEquivalence(
	value: Pick<SimplificationCapabilityEntryScalars, "equivalence" | "support" | "fixture_sha256">,
	provenance: SimplificationCapabilityEntry["provenance"] | null,
): provenance is SimplificationCapabilityEntry["provenance"] {
	if (!provenance) return false;
	if (value.equivalence === "fixture-validated" && value.fixture_sha256 === null) return false;
	if (value.support !== "available" && value.equivalence === "fixture-validated") return false;
	return true;
}

function parseEntry(value: unknown): SimplificationCapabilityEntry | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		[
			"id",
			"remedy",
			"capability",
			"target",
			"support",
			"equivalence",
			"contract_sha256",
			"fixture_sha256",
			"provenance",
			"limitations",
		],
	)) return null;
	const target = parseTarget(value.target);
	const provenance = parseProvenance(value.provenance);
	if (!target) return null;
	if (!hasValidEntryScalars(value, target) || !hasConsistentEntryEquivalence(value, provenance)) {
		return null;
	}
	return {
		id: value.id,
		remedy: value.remedy,
		capability: value.capability,
		target,
		support: value.support,
		equivalence: value.equivalence,
		contract_sha256: value.contract_sha256,
		fixture_sha256: value.fixture_sha256,
		provenance,
		limitations: [...value.limitations],
	};
}

function freezeRecursively<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const memberValue of Object.values(value)) freezeRecursively(memberValue);
	}
	return value;
}

export function parseSimplificationCapabilityCatalog(
	input: unknown,
): SimplificationCapabilityCatalogParseResult {
	if (!isJsonObject(input) || !exactKeys(input, ["schema_version", "catalog_id", "entries"])) {
		return { ok: false, reason: "capability catalog has an unknown or missing field" };
	}
	if (
		input.schema_version !== SIMPLIFICATION_CAPABILITY_CATALOG_VERSION
		|| !nonempty(input.catalog_id)
		|| !Array.isArray(input.entries)
	) {
		return { ok: false, reason: "capability catalog version, id, or entries are invalid" };
	}
	const entries: SimplificationCapabilityEntry[] = [];
	for (const raw of input.entries) {
		const entry = parseEntry(raw);
		if (!entry) return { ok: false, reason: "capability catalog contains an invalid entry" };
		entries.push(entry);
	}
	const ids = entries.map((entry) => entry.id);
	if (
		new Set(ids).size !== ids.length
		|| !ids.every((id, index) => index === 0 || id >= (ids[index - 1] ?? ""))
	) {
		return { ok: false, reason: "capability entries must have unique, canonical ids" };
	}
	return {
		ok: true,
		catalog: freezeRecursively({
			schema_version: SIMPLIFICATION_CAPABILITY_CATALOG_VERSION,
			catalog_id: input.catalog_id,
			entries,
		}),
	};
}

export function simplificationCapabilityCatalogSha256(
	catalog: Readonly<SimplificationCapabilityCatalog>,
): string {
	return createHash("sha256")
		.update(canonicalSimplificationAgentCiJson(catalog), "utf8")
		.digest("hex");
}

/** Exact version matching is deliberate: callers must resolve ranges before review. */
export function findSimplificationCapabilities(
	catalog: Readonly<SimplificationCapabilityCatalog>,
	target: { name: string; version: string },
	remedy?: SimplificationCapabilityRemedy,
): SimplificationCapabilityEntry[] {
	return catalog.entries.filter((entry) =>
		entry.target.name === target.name
		&& entry.target.version === target.version
		&& (remedy === undefined || entry.remedy === remedy));
}
