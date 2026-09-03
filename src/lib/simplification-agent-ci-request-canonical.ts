// ===========================================
// Simplification Agent CI request — canonical identities
// ===========================================
// Content addressing for the request artifact: a stable JSON encoding, the two
// derived identities (idempotency key, result-cache key), and the deep freeze
// applied once a parse has branded a request.

import { createHash } from "node:crypto";
import { isJsonObject, type JsonObject } from "./json-types.js";
import type {
	SimplificationAgentCiHandoffBindingResult,
	SimplificationAgentCiRequestV1,
	ValidSimplificationAgentCiRequest,
} from "./simplification-agent-ci-request-schema.js";
import { parseSimplificationHandoff } from "./simplification-schema.js";

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function compareCodeUnits(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

function canonicalJsonValue(value: unknown, location: string): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`${location} contains a non-finite number`);
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry, index) => canonicalJsonValue(entry, `${location}[${index}]`)).join(",")}]`;
	}
	if (!isJsonObject(value)) throw new TypeError(`${location} is not JSON-compatible`);
	const keys = Object.keys(value).sort();
	const members = keys.map((key) => {
		const member = value[key];
		if (member === undefined) throw new TypeError(`${location}.${key} is undefined`);
		return `${JSON.stringify(key)}:${canonicalJsonValue(member, `${location}.${key}`)}`;
	});
	return `{${members.join(",")}}`;
}

/** Stable JSON used only for content identities; object keys sort recursively. */
export function canonicalSimplificationAgentCiJson(value: unknown): string {
	return canonicalJsonValue(value, "request");
}

/**
 * Validate and content-address the local CLI's existing deep-handoff shape.
 * This is an adapter only: the shared schema insists the artifact remains
 * explicitly `not_submitted`.
 */
export function bindSimplificationAgentCiHandoff(
	input: unknown,
): SimplificationAgentCiHandoffBindingResult {
	const handoff = parseSimplificationHandoff(input);
	if (!handoff) return { ok: false, reason: "invalid local simplification deep handoff" };
	return {
		ok: true,
		handoff,
		handoff_sha256: sha256(canonicalSimplificationAgentCiJson(handoff)),
	};
}

function requestHashMaterial(request: SimplificationAgentCiRequestV1): JsonObject {
	return {
		schema_version: request.schema_version,
		kind: request.kind,
		lens_version: request.lens_version,
		repository: request.repository,
		scope: request.scope,
		requested_remedies: request.requested_remedies,
		evidence: request.evidence,
		orchestration: request.orchestration,
		validation: request.validation,
		record: request.record,
		no_cache: request.no_cache,
		submission: request.submission,
	};
}

/** Hash of the exact portable submission intent, excluding its self-derived key. */
export function canonicalSimplificationAgentCiRequestHash(
	request: SimplificationAgentCiRequestV1,
): string {
	return sha256(canonicalSimplificationAgentCiJson(requestHashMaterial(request)));
}

/**
 * Result cache identity. Operational switches (`record`, `no_cache`) and the
 * not-submitted marker cannot alter findings, so they are deliberately absent.
 */
export function canonicalSimplificationAgentCiCacheKey(
	request: ValidSimplificationAgentCiRequest,
): string {
	const material: JsonObject = {
		schema_version: request.schema_version,
		lens_version: request.lens_version,
		repository: request.repository,
		scope: request.scope,
		requested_remedies: request.requested_remedies,
		evidence: request.evidence,
		orchestration: request.orchestration,
		validation: request.validation,
	};
	return sha256(canonicalSimplificationAgentCiJson(material));
}

export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const member of Object.values(value)) deepFreeze(member);
	}
	return value;
}
