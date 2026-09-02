// ===========================================
// Sponsor slots — feed schema, validation, sanitization
// ===========================================
// Spec: docs/design/sponsor-slots.md. The daemon is the trust boundary:
// everything here assumes feed bytes are REMOTE and hostile until they
// pass signature verification (feed-client.ts) and the sanitizers below.
// Nothing un-sanitized may ever be written where the bash statusline (or
// any terminal surface) will read it.

/** One sponsored creative. All fields pre-validated + sanitized. */
export interface SponsorCreative {
	/** Stable id, `[a-z0-9-]{1,64}` — used for click routing + beacon keys. */
	id: string;
	/** Campaign grouping key (billing aggregation seam). Same charset as id. */
	campaign: string;
	/** Display text. Control bytes stripped; 1..MAX_TEXT_LEN chars. */
	text: string;
	/** Click-through target. https only. */
	url: string;
	/** Rotation weight (future bid seam). Integer 1..100. */
	weight: number;
	/** Optional flight window (ISO 8601). */
	starts_at?: string;
	ends_at?: string;
}

/** Verified, validated feed payload. */
export interface SponsorFeed {
	version: 1;
	generated_at: string;
	/** Hard expiry — the kill switch. Expired feed means no render. */
	valid_until: string;
	creatives: SponsorCreative[];
}

/** Wire envelope: signature over the exact base64-decoded payload bytes. */
export interface SponsorWire {
	key_id: string;
	payload_b64: string;
	sig: string;
}

/** Telemetry beacon row (appended to sponsor-beacons.jsonl, POSTed in batches). */
export interface SponsorBeacon {
	kind: "impression" | "click";
	creative: string;
	campaign: string;
	/** Rotation window number (floor(epochMs / ROTATION_WINDOW_MS)). */
	window: number;
	install_id: string;
	ts: string;
}

export const MAX_CREATIVES = 20;
export const MAX_TEXT_LEN = 80;
/** Rotation window: every install shows the same creative per UTC window. */
export const ROTATION_WINDOW_MS = 10 * 60 * 1000;

const ID_RE = /^[a-z0-9-]{1,64}$/;
// C0 (0x00-0x1f) + DEL (0x7f) + C1 (0x80-0x9f) — the terminal-escape ranges.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Strip C0 + DEL + C1 control bytes — and ONLY those — so remote text can
 * never smuggle ANSI/OSC escape sequences into a terminal surface. Emoji,
 * pipes, general unicode and URLs pass through untouched.
 */
export function stripControlChars(s: string): string {
	return s.replace(CONTROL_RE, "");
}

/**
 * Validate + sanitize one raw creative. Returns null when the creative is
 * unusable (caller skips it; per-creative failures never reject the feed).
 */
/** Unvalidated creative shape — every field unknown until checked. */
interface RawCreative {
	id?: unknown;
	campaign?: unknown;
	text?: unknown;
	url?: unknown;
	weight?: unknown;
	starts_at?: unknown;
	ends_at?: unknown;
}

export function sanitizeCreative(raw: unknown): SponsorCreative | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as RawCreative;
	const id = validateCreativeId(o);
	if (id === null) return null;
	const text = validateCreativeText(o);
	if (text === null) return null;
	const url = validateCreativeUrl(o);
	if (url === null) return null;
	const campaign = resolveCreativeCampaign(o);
	const weight = resolveCreativeWeight(o);
	const out: SponsorCreative = { id, campaign, text, url, weight };
	applyOptionalCreativeDates(o, out);
	return out;
}

/** `id` field: required, `[a-z0-9-]{1,64}`. */
function validateCreativeId(o: RawCreative): string | null {
	if (typeof o.id !== "string" || !ID_RE.test(o.id)) return null;
	return o.id;
}

/** `campaign` field: same charset as id, defaults to "default". */
function resolveCreativeCampaign(o: RawCreative): string {
	return typeof o.campaign === "string" && ID_RE.test(o.campaign) ? o.campaign : "default";
}

/** `text` field: required string, control-stripped, trimmed, length-capped, non-empty. */
function validateCreativeText(o: RawCreative): string | null {
	if (typeof o.text !== "string") return null;
	const text = stripControlChars(o.text).trim().slice(0, MAX_TEXT_LEN);
	return text.length === 0 ? null : text;
}

/** `url` field: required string, control-stripped, trimmed, https-only. */
function validateCreativeUrl(o: RawCreative): string | null {
	if (typeof o.url !== "string") return null;
	const url = stripControlChars(o.url).trim();
	return isHttpsUrl(url) ? url : null;
}

/** `weight` field: optional integer 1..100, defaults to 1. */
function resolveCreativeWeight(o: RawCreative): number {
	if (typeof o.weight === "number" && Number.isFinite(o.weight)) {
		return Math.min(100, Math.max(1, Math.floor(o.weight)));
	}
	return 1;
}

/** `starts_at` / `ends_at`: optional ISO dates, set on `out` only when valid. */
function applyOptionalCreativeDates(o: RawCreative, out: SponsorCreative): void {
	if (typeof o.starts_at === "string" && isIsoDate(o.starts_at)) out.starts_at = o.starts_at;
	if (typeof o.ends_at === "string" && isIsoDate(o.ends_at)) out.ends_at = o.ends_at;
}

/**
 * Parse + validate a decoded feed payload. Feed-level problems (shape,
 * version, expiry fields, creative cap) reject the whole feed; individual
 * bad creatives are skipped.
 */
export function parseFeedPayload(payloadJson: string): SponsorFeed | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const o = parsed as {
		version?: unknown;
		generated_at?: unknown;
		valid_until?: unknown;
		creatives?: unknown;
	};
	if (o.version !== 1) return null;
	if (typeof o.generated_at !== "string" || !isIsoDate(o.generated_at)) return null;
	if (typeof o.valid_until !== "string" || !isIsoDate(o.valid_until)) return null;
	if (!Array.isArray(o.creatives) || o.creatives.length > MAX_CREATIVES) return null;
	const creatives: SponsorCreative[] = [];
	for (const raw of o.creatives) {
		const c = sanitizeCreative(raw);
		if (c) creatives.push(c);
	}
	return {
		version: 1,
		generated_at: o.generated_at,
		valid_until: o.valid_until,
		creatives,
	};
}

/** Is the feed currently within its validity window? */
export function feedIsLive(feed: SponsorFeed, nowMs: number): boolean {
	const until = Date.parse(feed.valid_until);
	return Number.isFinite(until) && nowMs < until;
}

/** Creatives whose optional flight window contains `nowMs`. */
export function activeCreatives(feed: SponsorFeed, nowMs: number): SponsorCreative[] {
	return feed.creatives.filter((c) => {
		// Guard the parsed bounds with Number.isFinite (as feedIsLive does): a
		// malformed `starts_at`/`ends_at` makes Date.parse return NaN, and a raw
		// `nowMs < NaN` / `nowMs >= NaN` is always false — which would render the
		// creative on a broken schedule (fail OPEN). Treat an unparseable bound as
		// out-of-window and suppress the creative (fail closed). Found by the
		// harness's own `nan_coercion_guard` check (finding 2026-06).
		if (c.starts_at) {
			const startsAt = Date.parse(c.starts_at);
			if (!Number.isFinite(startsAt) || nowMs < startsAt) return false;
		}
		if (c.ends_at) {
			const endsAt = Date.parse(c.ends_at);
			if (!Number.isFinite(endsAt) || nowMs >= endsAt) return false;
		}
		return true;
	});
}

function isHttpsUrl(s: string): boolean {
	try {
		return new URL(s).protocol === "https:";
	} catch {
		return false;
	}
}

function isIsoDate(s: string): boolean {
	return Number.isFinite(Date.parse(s));
}
