// ===========================================
// Sponsor slots — daemon runtime loop
// ===========================================
// Spec: docs/design/sponsor-slots.md. Owns the periodic work: refresh the
// signed feed, rotate the creative for the current window, write
// `sponsor.status` for the bash statusline, count rotation-impressions
// (one per creative per window, only while the daemon has seen real hook
// activity), and flush buffered beacons. Everything is best-effort and
// exception-proof — sponsor code must never disturb the daemon. Runs on
// its own interval, never on the hook path.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import {
	appendBeacon,
	beaconUrlFromFeedUrl,
	buildClickUrl,
	clearSponsorStatus,
	DEFAULT_FEED_URL,
	fetchFeedWire,
	flushBeacons,
	loadCachedWire,
	saveCachedWire,
	selectCreative,
	verifyWire,
	windowNumber,
	writeSponsorStatus,
} from "./feed-client.js";
import type { SponsorFeed } from "./types.js";

/** Live-readable settings (re-read every tick so toggles apply hot). */
export interface SponsorRuntimeSettings {
	enabled: boolean;
	feedUrl: string;
	telemetry: boolean;
	installId: string;
}

export interface SponsorRuntimeOptions {
	interlinkedDir: string;
	/** Read current settings (null = sponsor not configured). */
	readSettings: () => SponsorRuntimeSettings | null;
	/** Did the daemon process a hook event recently? Gates impressions. */
	hasRecentActivity: () => boolean;
	fetchImpl?: typeof fetch;
	log?: (msg: string) => void;
	/** Injectable clock for tests. */
	now?: () => number;
}

export interface SponsorRuntime {
	/** One unit of periodic work. Public so tests drive it directly. */
	tick(): Promise<void>;
	dispose(): void;
}

/**
 * Read sponsor settings straight from `<interlinkedDir>/config.local.json`.
 * The daemon-side mirror of the CLI's config schema (`SponsorConfig` in
 * src/lib/config.ts) — read directly so the harness keeps zero import
 * coupling to the CLI config layer. Telemetry requires an install_id: no
 * identity, no beacons (render still works). Null only on a malformed file.
 */
export function readSponsorSettingsFromConfig(
	interlinkedDir: string,
): SponsorRuntimeSettings | null {
	let raw: string;
	try {
		raw = readFileSync(join(interlinkedDir, "config.local.json"), "utf8");
	} catch {
		return { enabled: false, feedUrl: DEFAULT_FEED_URL, telemetry: false, installId: "" };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isJsonObject(parsed)) return null;
		const installId = typeof parsed.install_id === "string" ? parsed.install_id : "";
		const sponsor = isJsonObject(parsed.sponsor) ? parsed.sponsor : undefined;
		return {
			enabled: sponsor?.enabled === true,
			feedUrl:
				typeof sponsor?.feed_url === "string" && sponsor.feed_url.length > 0
					? sponsor.feed_url
					: DEFAULT_FEED_URL,
			telemetry: sponsor?.telemetry !== false && installId.length > 0,
			installId,
		};
	} catch {
		return null;
	}
}

const TICK_INTERVAL_MS = 60_000;
const FEED_REFRESH_MS = 15 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/** Dedup-memory bound for (creative, window) impression keys. */
const MAX_COUNTED_KEYS = 500;

export function startSponsorRuntime(opts: SponsorRuntimeOptions): SponsorRuntime {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const now = opts.now ?? (() => Date.now());
	const log = opts.log ?? ((): void => undefined);

	let feed: SponsorFeed | null = null;
	let feedFetchedAt = 0;
	let lastFlushAt = now();
	let wasEnabled: boolean | null = null;
	let inFlight = false;
	const countedKeys = new Set<string>();

	async function refreshFeed(feedUrl: string): Promise<void> {
		const due = feed === null || now() - feedFetchedAt >= FEED_REFRESH_MS;
		if (!due) return;
		// Mark the attempt time even on failure so an unreachable Worker is
		// retried once per refresh interval, not once per tick.
		feedFetchedAt = now();
		const wire = await fetchFeedWire(feedUrl, fetchImpl);
		if (wire) {
			const verified = verifyWire(wire);
			if (verified) {
				feed = verified;
				saveCachedWire(opts.interlinkedDir, wire);
				log(`[sponsor] feed refreshed: ${verified.creatives.length} creative(s)`);
				return;
			}
			log("[sponsor] fetched feed failed verification — ignoring");
		}
		if (feed === null) {
			// Cold start with no network: the disk cache is still
			// signature-checked, so local tampering cannot inject content.
			const cached = loadCachedWire(opts.interlinkedDir);
			if (cached) {
				feed = verifyWire(cached);
				if (feed) log("[sponsor] using verified cached feed");
			}
		}
	}

	function recordImpression(
		settings: SponsorRuntimeSettings,
		creativeId: string,
		campaign: string,
	): void {
		const win = windowNumber(now());
		const key = `${creativeId}:${win}`;
		if (countedKeys.has(key)) return;
		if (!opts.hasRecentActivity()) return;
		countedKeys.add(key);
		if (countedKeys.size > MAX_COUNTED_KEYS) {
			const first = countedKeys.values().next().value;
			if (first !== undefined) countedKeys.delete(first);
		}
		appendBeacon(opts.interlinkedDir, {
			kind: "impression",
			creative: creativeId,
			campaign,
			window: win,
			install_id: settings.installId,
			ts: new Date(now()).toISOString(),
		});
	}

	async function maybeFlush(settings: SponsorRuntimeSettings): Promise<void> {
		if (now() - lastFlushAt < FLUSH_INTERVAL_MS) return;
		lastFlushAt = now();
		const url = beaconUrlFromFeedUrl(settings.feedUrl);
		if (!url) return;
		await flushBeacons(opts.interlinkedDir, url, fetchImpl);
	}

	async function tick(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			const settings = opts.readSettings();
			if (!settings?.enabled) {
				// Write the disabled marker once per state change, not every tick.
				if (wasEnabled !== false) {
					clearSponsorStatus(opts.interlinkedDir);
					wasEnabled = false;
				}
				return;
			}
			wasEnabled = true;
			await refreshFeed(settings.feedUrl);
			const current = feed === null ? null : selectCreative(feed, now());
			if (!current) {
				clearSponsorStatus(opts.interlinkedDir);
				return;
			}
			// telemetry on: click routes through the Worker (countable, carries
			// the anonymous install id). telemetry off: direct link, no routing.
			const clickUrl = settings.telemetry
				? (buildClickUrl(settings.feedUrl, current.id, settings.installId) ?? current.url)
				: current.url;
			writeSponsorStatus(opts.interlinkedDir, {
				enabled: true,
				creative: current,
				clickUrl,
			});
			if (settings.telemetry) {
				recordImpression(settings, current.id, current.campaign);
				await maybeFlush(settings);
			}
		} catch (e) {
			// Prime directive: sponsor work never disturbs the daemon.
			void e;
		} finally {
			inFlight = false;
		}
	}

	// No auto-tick here: the caller fires the first tick (and tests drive
	// ticks directly — an in-flight constructor tick would hold the
	// re-entrancy guard and make explicit ticks silently no-op).
	const timer = setInterval(() => {
		void tick();
	}, TICK_INTERVAL_MS);
	timer.unref();

	return {
		tick,
		dispose(): void {
			clearInterval(timer);
		},
	};
}
