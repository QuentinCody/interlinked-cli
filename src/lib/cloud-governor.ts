import type { HarnessEvent } from "../harness/types.js";

export interface CloudGovernorConfig {
	enabled: boolean;
	url: string;
	bearer_token: string;
	timeout_ms?: number;
}

export interface CloudVerdict {
	decision: "allow" | "block";
	reason?: string;
	warnings?: string[];
	rule_id?: string;
}

const DEFAULT_TIMEOUT_MS = 2000;

// Forwards a hook event to the cloud governor (the Worker in cloud/). Fail-open
// on any error or timeout — cloud is advisory in v0, not authoritative. Returns
// null when the governor is disabled, misconfigured, unreachable, or returned
// an unparseable response.
export async function evaluateRemote(
	event: HarnessEvent,
	config: CloudGovernorConfig,
): Promise<CloudVerdict | null> {
	if (!config.enabled) return null;
	if (!config.url || !config.bearer_token) return null;

	const controller = new AbortController();
	const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(config.url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${config.bearer_token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(event),
			signal: controller.signal,
		});
		if (!response.ok) return null;
		const verdict: unknown = await response.json();
		return parseVerdict(verdict);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// Mirror of CloudVerdict but with every field typed `unknown` — the value comes
// from `response.json()` so nothing about its shape is trusted; the parser
// narrows each field before promoting it into the typed CloudVerdict.
interface RawVerdict {
	decision?: unknown;
	reason?: unknown;
	warnings?: unknown;
	rule_id?: unknown;
}

function parseVerdict(value: unknown): CloudVerdict | null {
	if (!value || typeof value !== "object") return null;
	const v = value as RawVerdict;
	if (v.decision !== "allow" && v.decision !== "block") return null;
	const result: CloudVerdict = { decision: v.decision };
	if (typeof v.reason === "string") result.reason = v.reason;
	if (Array.isArray(v.warnings) && v.warnings.every((w) => typeof w === "string")) {
		result.warnings = v.warnings;
	}
	if (typeof v.rule_id === "string") result.rule_id = v.rule_id;
	return result;
}
