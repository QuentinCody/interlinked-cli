// ===========================================
// Sponsor slots — feed fetch/verify, rotation, status + beacons
// ===========================================
// Spec: docs/design/sponsor-slots.md. This module is the ONLY place sponsor
// bytes cross the network, and the only writer of the files the bash
// statusline reads. Fail closed everywhere: unsigned/tampered/expired feed
// means no render. Never throws to callers — the daemon must not be
// crashable from sponsor code.

import { createPublicKey, verify as edVerify } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import {
	activeCreatives,
	feedIsLive,
	parseFeedPayload,
	ROTATION_WINDOW_MS,
	type SponsorBeacon,
	type SponsorCreative,
	type SponsorFeed,
	type SponsorWire,
	stripControlChars,
} from "./types.js";

/** Default feed endpoint (the deployed sponsor Worker, path-routed on the
 *  interlinked domain) — override per-project via `sponsor.feed_url`. */
export const DEFAULT_FEED_URL = "https://interlinked.quentincody.dev/v1/feed";

export const FEED_CACHE_FILE = "sponsor-feed.json";
export const SPONSOR_STATUS_FILE = "sponsor.status";
export const BEACON_FILE = "sponsor-beacons.jsonl";

/** Beacon buffer hard cap — stop appending rather than grow unboundedly. */
const BEACON_FILE_MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_WIRE_BYTES = 256 * 1024;

/**
 * Trusted feed-signing public keys (base64 SPKI DER, Ed25519), keyed by the
 * wire's `key_id`. Rotation = add the new key here, keep the old one until
 * its feeds expire. `INTERLINKED_SPONSOR_PUBKEY` overrides for dev/tests.
 */
const EMBEDDED_SPONSOR_PUBKEYS: Record<string, string> = {
	"sponsor-2026a": "MCowBQYDK2VwAyEAecJdYpEnYgCYMPskPlurFmE72BlHCVAWM90teom+oRI=",
};

interface VerifyOptions {
	/** Explicit base64 SPKI key (tests / key rotation drills). */
	pubkeyB64?: string;
}

/**
 * Parse + signature-check a wire envelope and return the validated feed.
 * Any failure — shape, unknown key, bad base64, bad signature, invalid
 * payload — returns null.
 */
export function verifyWire(wireJson: string, opts: VerifyOptions = {}): SponsorFeed | null {
	let wire: SponsorWire;
	try {
		const parsed: unknown = JSON.parse(wireJson);
		// Fail-closed: anything that isn't a keyed JSON object (array, string,
		// number, null) is rejected here, same as a missing/wrong-typed field —
		// no render, never a guess.
		if (!isJsonObject(parsed)) return null;
		const { key_id, payload_b64, sig } = parsed;
		if (
			typeof key_id !== "string" ||
			typeof payload_b64 !== "string" ||
			typeof sig !== "string"
		) {
			return null;
		}
		wire = { key_id, payload_b64, sig };
	} catch {
		return null;
	}
	const keyB64 =
		opts.pubkeyB64 ??
		process.env.INTERLINKED_SPONSOR_PUBKEY ??
		EMBEDDED_SPONSOR_PUBKEYS[wire.key_id];
	if (!keyB64) return null;
	try {
		const key = createPublicKey({
			key: Buffer.from(keyB64, "base64"),
			format: "der",
			type: "spki",
		});
		const payload = Buffer.from(wire.payload_b64, "base64");
		const sig = Buffer.from(wire.sig, "base64");
		if (!edVerify(null, payload, key, sig)) return null;
		return parseFeedPayload(payload.toString("utf8"));
	} catch {
		return null;
	}
}

/** GET the wire JSON. Null on timeout, non-2xx, oversize, or any error. */
export async function fetchFeedWire(
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
	timer.unref?.();
	try {
		const res = await fetchImpl(url, { signal: ctl.signal });
		if (!res.ok) return null;
		const text = await res.text();
		if (text.length > MAX_WIRE_BYTES) return null;
		return text;
	} catch {
		return null;
	} finally {
		// Keep the abort timer armed through the BODY read, not just the headers:
		// clearing it right after fetch() (the old bug) let a server that returned
		// headers and then stalled the body hang res.text() forever — wedging
		// `sponsor enable --spinner` and the daemon's in-flight tick, so later
		// refreshes were skipped (finding 2026-06). `finally` clears on every exit
		// path (success, early return, abort throw), so the timer never leaks.
		clearTimeout(timer);
	}
}

/** Cached wire round-trip. The cache stores the WIRE, not the payload, so a
 *  locally tampered cache still fails signature verification on load. */
export function loadCachedWire(interlinkedDir: string): string | null {
	try {
		return readFileSync(join(interlinkedDir, FEED_CACHE_FILE), "utf8");
	} catch {
		return null;
	}
}

export function saveCachedWire(interlinkedDir: string, wire: string): void {
	atomicWrite(join(interlinkedDir, FEED_CACHE_FILE), wire);
}

/** FNV-1a 32-bit — tiny, dependency-free, stable across platforms. */
export function fnv1a32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export function windowNumber(nowMs: number): number {
	return Math.floor(nowMs / ROTATION_WINDOW_MS);
}

/**
 * Deterministic weighted pick for the current rotation window. Every install
 * computes the same answer for the same window (sponsors get legible slices
 * of the day; impressions aggregate cleanly). Null when the feed is expired
 * or has no active creatives.
 */
export function selectCreative(feed: SponsorFeed, nowMs: number): SponsorCreative | null {
	if (!feedIsLive(feed, nowMs)) return null;
	const candidates = activeCreatives(feed, nowMs);
	if (candidates.length === 0) return null;
	const total = candidates.reduce((sum, c) => sum + c.weight, 0);
	let slot = fnv1a32(String(windowNumber(nowMs))) % total;
	for (const c of candidates) {
		slot -= c.weight;
		if (slot < 0) return c;
	}
	return candidates[candidates.length - 1] ?? null;
}

/** Click-through routed via the Worker so clicks are countable server-side:
 *  `<feed origin>/v1/c/<creative-id>[?i=<install>]`. Null if the feed URL
 *  is unparseable (caller falls back to the creative's direct URL). */
export function buildClickUrl(
	feedUrl: string,
	creativeId: string,
	installId?: string,
): string | null {
	try {
		const u = new URL(feedUrl);
		const suffix = installId ? `?i=${encodeURIComponent(installId)}` : "";
		return `${u.origin}/v1/c/${creativeId}${suffix}`;
	} catch {
		return null;
	}
}

export function beaconUrlFromFeedUrl(feedUrl: string): string | null {
	try {
		return `${new URL(feedUrl).origin}/v1/beacon`;
	} catch {
		return null;
	}
}

interface SponsorStatusArgs {
	enabled: boolean;
	creative?: SponsorCreative;
	clickUrl?: string;
}

/**
 * Write the kv file the bash statusline renders (same pattern as
 * `classifier.status`). Text/url are re-stripped here as defense in depth —
 * this is the last write before terminal bytes.
 */
export function writeSponsorStatus(interlinkedDir: string, args: SponsorStatusArgs): void {
	const lines: string[] = [`enabled=${args.enabled ? "1" : "0"}`];
	if (args.enabled && args.creative) {
		const c = args.creative;
		const click = args.clickUrl ?? c.url;
		lines.push(
			`creative=${c.id}`,
			`campaign=${c.campaign}`,
			`text=${stripControlChars(c.text)}`,
			`url=${stripControlChars(click)}`,
		);
	}
	lines.push(`written_at=${new Date().toISOString()}`);
	atomicWrite(join(interlinkedDir, SPONSOR_STATUS_FILE), `${lines.join("\n")}\n`);
}

export function clearSponsorStatus(interlinkedDir: string): void {
	writeSponsorStatus(interlinkedDir, { enabled: false });
}

/** Append one beacon row. Best-effort; stops appending at the size cap. */
export function appendBeacon(interlinkedDir: string, beacon: SponsorBeacon): void {
	try {
		const path = join(interlinkedDir, BEACON_FILE);
		if (existsSync(path) && statSync(path).size > BEACON_FILE_MAX_BYTES) return;
		writeFileSync(path, `${JSON.stringify(beacon)}\n`, { flag: "a" });
	} catch (e) {
		void e;
	}
}

/**
 * Validate one buffered beacon row. Returns null for anything that isn't a
 * well-shaped `SponsorBeacon` — a row that parses as JSON but carries the
 * wrong field types (or an unknown `kind`) is dropped, same as a row that
 * fails `JSON.parse` outright, rather than forwarded to the Worker verbatim.
 */
function parseSponsorBeacon(value: unknown): SponsorBeacon | null {
	if (!isJsonObject(value)) return null;
	const { kind, creative, campaign, window, install_id, ts } = value;
	if (kind !== "impression" && kind !== "click") return null;
	if (typeof creative !== "string") return null;
	if (typeof campaign !== "string") return null;
	if (typeof window !== "number" || !Number.isFinite(window)) return null;
	if (typeof install_id !== "string") return null;
	if (typeof ts !== "string") return null;
	return { kind, creative, campaign, window, install_id, ts };
}

/**
 * POST all buffered beacons as one batch; truncate the buffer on success.
 * Returns false (and keeps the buffer) on any failure — beacons are
 * fire-and-forget telemetry, never load-bearing.
 */
export async function flushBeacons(
	interlinkedDir: string,
	beaconUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const path = join(interlinkedDir, BEACON_FILE);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return true; // nothing buffered
	}
	const beacons: SponsorBeacon[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const beacon = parseSponsorBeacon(JSON.parse(line));
			if (beacon) beacons.push(beacon);
			// else: parsed but wrong-shaped — drop it rather than wedge the
			// buffer forever (same treatment as a JSON syntax error below).
		} catch (e) {
			// Unparseable row: drop it rather than wedge the buffer forever.
			void e;
		}
	}
	if (beacons.length === 0) return true;
	try {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
		timer.unref?.();
		const res = await fetchImpl(beaconUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ beacons }),
			signal: ctl.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return false;
		writeFileSync(path, "");
		return true;
	} catch {
		return false;
	}
}

function atomicWrite(path: string, content: string): void {
	try {
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, content);
		renameSync(tmp, path);
	} catch (e) {
		void e;
	}
}
