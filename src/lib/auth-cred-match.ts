// ===========================================
// Claude Code credential-store matching helpers
// ===========================================
// Extracted from auth.ts (readClaudeCodeToken) for cyclomatic-complexity
// decomposition and to stay under the per-file line cap. Pure helpers, no
// side effects beyond reading the plain-object entries passed in.

import { isJsonObject, type JsonObject } from "./json-types.js";

interface CredEntry extends JsonObject {
	accessToken: string;
}

function isCredEntry(value: unknown): value is CredEntry {
	return (
		isJsonObject(value) && typeof value.accessToken === "string"
	);
}

function isCredEntryExpired(value: CredEntry): boolean {
	const expiresAt = resolveCredExpiry(value);
	if (!expiresAt) {
		return false;
	}
	return expiresAt.getTime() <= Date.now();
}

function resolveCredExpiry(value: CredEntry): Date | null {
	const candidates: unknown[] = [
		value.token_expires_at,
		value.tokenExpiresAt,
		value.expires_at,
		value.expiresAt,
		value.expiry,
		value.exp,
	];
	for (const candidate of candidates) {
		const parsed = parseExpiryValue(candidate);
		if (parsed) {
			return parsed;
		}
	}
	return null;
}

function parseExpiryValue(value: unknown): Date | null {
	if (value == null) {
		return null;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		const millis = value > 1_000_000_000_000 ? value : value * 1000;
		const date = new Date(millis);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) {
			return null;
		}
		const asNumber = Number(trimmed);
		if (Number.isFinite(asNumber)) {
			return parseExpiryValue(asNumber);
		}
		const date = new Date(trimmed);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	return null;
}

/**
 * Strategy 1: Match by mcp_prefix against key prefix.
 */
export function matchCredByPrefix(oauthEntries: object, mcpPrefix?: string): string | null {
	if (!mcpPrefix) return null;
	for (const [key, value] of Object.entries(oauthEntries)) {
		if (key.startsWith(mcpPrefix) && isCredEntry(value) && !isCredEntryExpired(value)) {
			return value.accessToken;
		}
	}
	return null;
}

/**
 * Strategy 2: Match by serverName containing "Interlinked" or "interlinked".
 */
export function matchCredByServerName(oauthEntries: object): string | null {
	for (const [_key, value] of Object.entries(oauthEntries)) {
		if (
			isCredEntry(value) &&
			typeof value.serverName === "string" && /interlinked/i.test(value.serverName) &&
			!isCredEntryExpired(value)
		) {
			return value.accessToken;
		}
	}
	return null;
}
