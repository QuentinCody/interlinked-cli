// ===========================================
// Public-credential contexts — key-shaped values that are public by design
// ===========================================
// Some providers ship a client identifier in the shape of a secret: Google
// API keys (`AIza…`) embedded in public web pages are the common case. When
// Bash output carries such a value INSIDE one of the contexts below, the
// session is raised to Internal (the escalation tier) instead of Confidential
// (the network hard block). See evaluator/secret-output-origin.ts.
//
// This list is CODE, not config, on purpose: `guard-rules.local.json` is
// writable by the agent being gated, so a config list would let that agent
// loosen its own gate. Add an entry only with a public source that documents
// the value as non-secret, plus a positive and a negative test in
// public-credential-contexts.test.ts. Add nothing for a signature that no
// rule in signatures-patterns-secrets.ts matches (there is no Stripe
// publishable-key signature, so `pk_live_` / `pk_test_` have no entry).

import { SECRETS_RULES } from "./signatures-patterns-secrets.js";

export interface PublicCredentialContext {
	/** Stable id, reported in warnings and taint-source detail. */
	id: string;
	/** The secret signature (`SECRETS_RULES[].id`) this context can excuse. */
	signature_id: string;
	/** A match of the signature counts as public only when it lies wholly
	 *  inside a match of this pattern. Must carry the `g` flag. */
	context: RegExp;
	rationale: string;
	/** Public documentation that the value is not a secret. */
	source_url: string;
}

const GCP_KEY = String.raw`AIza[0-9A-Za-z_-]{35}`;

export const PUBLIC_CREDENTIAL_CONTEXTS: readonly PublicCredentialContext[] = [
	{
		id: "youtube-innertube-api-key",
		signature_id: "sig-secret-gcp-api",
		context: new RegExp(
			String.raw`["']?(?:INNERTUBE_API_KEY|innertubeApiKey)["']?\s*:\s*["']${GCP_KEY}["']`,
			"g",
		),
		rationale:
			"YouTube serves its web-client InnerTube key in the ytcfg block of every public page to " +
			"anonymous visitors; it identifies the client application, not a user, and unlocks no private data.",
		source_url:
			"https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_base.py",
	},
	{
		id: "firebase-web-config-api-key",
		signature_id: "sig-secret-gcp-api",
		context: new RegExp(
			String.raw`(?:firebaseConfig\s*[:=]\s*|initializeApp\s*\(\s*)\{[^{}]{0,2000}?["']?apiKey["']?\s*:\s*["']${GCP_KEY}["']`,
			"g",
		),
		rationale:
			"Firebase web apps ship apiKey in client code by design; Google documents that Firebase API " +
			"keys only identify the project and that access is controlled by Security Rules and App Check.",
		source_url: "https://firebase.google.com/docs/projects/api-keys",
	},
];

export type Span = readonly [start: number, end: number];

function contextSpans(text: string, signatureId: string): { ids: string[]; spans: Span[] } {
	const ids: string[] = [];
	const spans: Span[] = [];
	for (const entry of PUBLIC_CREDENTIAL_CONTEXTS) {
		if (entry.signature_id !== signatureId) continue;
		for (const m of text.matchAll(entry.context)) {
			spans.push([m.index, m.index + m[0].length]);
			if (!ids.includes(entry.id)) ids.push(entry.id);
		}
	}
	return { ids, spans };
}

/** Every occurrence of the signature's patterns in `text`, as spans (null for
 *  an unknown signature id). Also used by committed-test-fixture.ts. */
export function signatureSpans(text: string, signatureId: string): Span[] | null {
	const rule = SECRETS_RULES.find((r) => r.id === signatureId);
	if (!rule) return null;
	const spans: Span[] = [];
	for (const pattern of rule.patterns) {
		const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		for (const m of text.matchAll(global)) spans.push([m.index, m.index + m[0].length]);
	}
	return spans;
}

/**
 * The context ids that cover EVERY occurrence of EVERY listed signature in
 * `text`, or null when any occurrence sits outside a registered context (or a
 * signature has no context entry at all). Null is the fail-safe answer: the
 * caller then treats the hit as a real secret.
 */
export function publicContextsCovering(text: string, signatureIds: readonly string[]): string[] | null {
	if (signatureIds.length === 0) return null;
	const used: string[] = [];
	for (const signatureId of signatureIds) {
		const hits = signatureSpans(text, signatureId);
		const { ids, spans } = contextSpans(text, signatureId);
		if (!hits || hits.length === 0 || spans.length === 0) return null;
		const inside = hits.every(([s, e]) => spans.some(([cs, ce]) => cs <= s && e <= ce));
		if (!inside) return null;
		for (const id of ids) if (!used.includes(id)) used.push(id);
	}
	return used;
}
