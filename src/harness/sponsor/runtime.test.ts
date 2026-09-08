import { sign as edSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BEACON_FILE, DEFAULT_FEED_URL, FEED_CACHE_FILE, SPONSOR_STATUS_FILE } from "./feed-client.js";
import {
	readSponsorSettingsFromConfig,
	type SponsorRuntimeSettings,
	startSponsorRuntime,
} from "./runtime.js";
import { ROTATION_WINDOW_MS, type SponsorFeed } from "./types.js";

const T0 = Date.parse("2026-06-12T00:00:05Z");

function makeSignedWire(feed: SponsorFeed): { wire: string; pubB64: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const bytes = Buffer.from(JSON.stringify(feed), "utf8");
	return {
		wire: JSON.stringify({
			key_id: "test",
			payload_b64: bytes.toString("base64"),
			sig: edSign(null, bytes, privateKey).toString("base64"),
		}),
		pubB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
	};
}

const FEED: SponsorFeed = {
	version: 1,
	generated_at: "2026-06-12T00:00:00Z",
	valid_until: "2099-01-01T00:00:00Z",
	creatives: [
		{
			id: "alpha",
			campaign: "friends",
			text: "Alpha — a friend project",
			url: "https://alpha.example",
			weight: 1,
		},
	],
};

interface Call {
	url: string;
	body: string | undefined;
}

function makeFetchStub(wire: string, calls: Call[]): typeof fetch {
	return (async (url, init) => {
		const u = String(url);
		calls.push({ url: u, body: init?.body === undefined ? undefined : String(init.body) });
		if (u.endsWith("/v1/feed")) {
			return new Response(wire, { status: 200 });
		}
		return new Response("", { status: 200 });
	});
}

describe("readSponsorSettingsFromConfig", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sponsor-cfg-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns disabled settings when config or sponsor block is missing", () => {
		expect(readSponsorSettingsFromConfig(dir)?.enabled).toBe(false);
		writeFileSync(join(dir, "config.local.json"), JSON.stringify({ sync_mode: "local" }));
		expect(readSponsorSettingsFromConfig(dir)?.enabled).toBe(false);
	});

	it("maps an enabled block, defaulting the feed url and gating telemetry on install_id", () => {
		writeFileSync(
			join(dir, "config.local.json"),
			JSON.stringify({ install_id: "inst-9", sponsor: { enabled: true } }),
		);
		const s = readSponsorSettingsFromConfig(dir);
		expect(s).toEqual({
			enabled: true,
			feedUrl: DEFAULT_FEED_URL,
			telemetry: true,
			installId: "inst-9",
		});
		// No install id ⇒ telemetry forced off (no identity, no beacons).
		writeFileSync(
			join(dir, "config.local.json"),
			JSON.stringify({ sponsor: { enabled: true, feed_url: "https://x.example/v1/feed" } }),
		);
		const s2 = readSponsorSettingsFromConfig(dir);
		expect(s2?.telemetry).toBe(false);
		expect(s2?.feedUrl).toBe("https://x.example/v1/feed");
	});

	it("returns null on malformed config rather than throwing", () => {
		writeFileSync(join(dir, "config.local.json"), "{nope");
		expect(readSponsorSettingsFromConfig(dir)).toBeNull();
	});

	it("N2: returns null when the config's top level is valid JSON but not a keyed object", () => {
		writeFileSync(join(dir, "config.local.json"), "[1,2,3]");
		expect(readSponsorSettingsFromConfig(dir)).toBeNull();
		writeFileSync(join(dir, "config.local.json"), "42");
		expect(readSponsorSettingsFromConfig(dir)).toBeNull();
	});

	it("N3: treats a non-object `sponsor` field the same as a missing one (disabled, no crash)", () => {
		writeFileSync(
			join(dir, "config.local.json"),
			JSON.stringify({ install_id: "inst-9", sponsor: "not-an-object" }),
		);
		const s = readSponsorSettingsFromConfig(dir);
		expect(s).toEqual({
			enabled: false,
			feedUrl: DEFAULT_FEED_URL,
			telemetry: true,
			installId: "inst-9",
		});
	});
});

describe("startSponsorRuntime", () => {
	let dir: string;
	let savedEnv: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sponsor-rt-"));
		savedEnv = process.env.INTERLINKED_SPONSOR_PUBKEY;
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (savedEnv === undefined) delete process.env.INTERLINKED_SPONSOR_PUBKEY;
		else process.env.INTERLINKED_SPONSOR_PUBKEY = savedEnv;
	});

	function settings(overrides: Partial<SponsorRuntimeSettings> = {}): SponsorRuntimeSettings {
		return {
			enabled: true,
			feedUrl: "https://w.example/v1/feed",
			telemetry: true,
			installId: "inst-1",
			...overrides,
		};
	}

	it("writes a disabled status and never fetches when the flag is off", async () => {
		const calls: Call[] = [];
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings({ enabled: false }),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub("{}", calls),
			now: () => T0,
		});
		await rt.tick();
		rt.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=0");
		expect(calls).toHaveLength(0);
	});

	it("fetches, verifies, renders, and counts one impression per window", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const calls: Call[] = [];
		let now = T0;
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, calls),
			now: () => now,
		});
		await rt.tick();
		await rt.tick(); // same window — no second impression
		const status = readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8");
		expect(status).toContain("enabled=1");
		expect(status).toContain("creative=alpha");
		expect(status).toContain("url=https://w.example/v1/c/alpha?i=inst-1");
		const rows = readFileSync(join(dir, BEACON_FILE), "utf8").trim().split("\n");
		expect(rows).toHaveLength(1);
		now = T0 + ROTATION_WINDOW_MS; // next window — one more impression...
		await rt.tick();
		rt.dispose();
		// ...which also crosses the flush interval: both buffered impressions
		// go out in one POST and the buffer truncates.
		const beaconPosts = calls.filter((c) => c.url.endsWith("/v1/beacon"));
		expect(beaconPosts).toHaveLength(1);
		expect(JSON.parse(beaconPosts[0]?.body ?? "{}").beacons).toHaveLength(2);
		expect(readFileSync(join(dir, BEACON_FILE), "utf8")).toBe("");
	});

	it("renders without beaconing when there is no recent activity or telemetry is off", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const callsIdle: Call[] = [];
		const idle = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => false,
			fetchImpl: makeFetchStub(wire, callsIdle),
			now: () => T0,
		});
		await idle.tick();
		idle.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=1");
		expect(() => readFileSync(join(dir, BEACON_FILE), "utf8")).toThrow();

		// telemetry off: direct creative URL, no install id, no beacons.
		const dir2 = mkdtempSync(join(tmpdir(), "sponsor-rt2-"));
		const noTel = startSponsorRuntime({
			interlinkedDir: dir2,
			readSettings: () => settings({ telemetry: false }),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, []),
			now: () => T0,
		});
		await noTel.tick();
		noTel.dispose();
		const st = readFileSync(join(dir2, SPONSOR_STATUS_FILE), "utf8");
		expect(st).toContain("url=https://alpha.example");
		expect(() => readFileSync(join(dir2, BEACON_FILE), "utf8")).toThrow();
		rmSync(dir2, { recursive: true, force: true });
	});

	it("falls back to the verified disk cache when the network fails", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		// Seed the cache via a successful run.
		const okCalls: Call[] = [];
		const seed = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => false,
			fetchImpl: makeFetchStub(wire, okCalls),
			now: () => T0,
		});
		await seed.tick();
		seed.dispose();
		// Fresh runtime, dead network.
		const dead: typeof fetch = (async () => {
			throw new Error("offline");
		});
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => false,
			fetchImpl: dead,
			now: () => T0,
		});
		await rt.tick();
		rt.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("creative=alpha");
	});

	it("does not render and does not throw when the feed fails signature verification and no cache exists", async () => {
		// Signed with a DIFFERENT key than the one advertised via env, so
		// verifyWire fails — exercises the "verified" falsy branch (log +
		// no feed assignment) and, since there's no disk cache either, the
		// tick falls through to the feed===null / !current path.
		const { wire } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = Buffer.from("not-a-real-key").toString("base64");
		const calls: Call[] = [];
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, calls),
			now: () => T0,
		});
		await rt.tick();
		rt.dispose();
		const status = readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8");
		expect(status).toContain("enabled=0");
	});

	it("does not render when the disk cache exists but fails verification (corrupted cache)", async () => {
		process.env.INTERLINKED_SPONSOR_PUBKEY = Buffer.from(
			generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }),
		).toString("base64");
		// A syntactically-valid cached wire signed by a DIFFERENT key than the
		// one configured above, so `loadCachedWire` finds it but `verifyWire`
		// rejects it.
		const { wire: badWire } = makeSignedWire(FEED);
		writeFileSync(join(dir, FEED_CACHE_FILE), badWire);
		const dead: typeof fetch = (async () => {
			throw new Error("offline");
		});
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: dead,
			now: () => T0,
		});
		await rt.tick();
		rt.dispose();
		const status = readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8");
		expect(status).toContain("enabled=0");
	});

	it("evicts the oldest dedup key once the counted-keys bound is exceeded", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const calls: Call[] = [];
		let now = T0;
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, calls),
			now: () => now,
		});
		// MAX_COUNTED_KEYS is 500 — push past it with one new rotation window
		// per tick so every impression is a genuinely new dedup key, forcing
		// the `countedKeys.size > MAX_COUNTED_KEYS` eviction branch to run.
		for (let i = 0; i < 505; i++) {
			now = T0 + i * ROTATION_WINDOW_MS;
			await rt.tick();
		}
		rt.dispose();
		const status = readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8");
		expect(status).toContain("enabled=1");
	}, 20000);

	it("skips the beacon flush when the configured feed URL cannot be parsed (beaconUrlFromFeedUrl → null)", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const calls: Call[] = [];
		let tickCount = 0;
		let now = T0;
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => {
				tickCount += 1;
				// First tick: valid feed URL so a feed loads and caches.
				// Second tick onward: an unparseable feed URL — refreshFeed
				// isn't due yet (within FEED_REFRESH_MS) so the cached feed
				// is still used, but maybeFlush's beaconUrlFromFeedUrl(url)
				// now fails and returns null.
				return settings(tickCount === 1 ? {} : { feedUrl: "   " });
			},
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, calls),
			now: () => now,
		});
		await rt.tick();
		now = T0 + 6 * 60 * 1000; // past the 5-minute flush interval
		await rt.tick();
		rt.dispose();
		const beaconPosts = calls.filter((c) => c.url.endsWith("/v1/beacon"));
		expect(beaconPosts).toHaveLength(0);
	});

	it("uses the default fetch/now implementations when none are injected", async () => {
		const fetchSpy = vi.fn(async () => new Response("", { status: 503 }));
		vi.stubGlobal("fetch", fetchSpy);
		try {
			const rt = startSponsorRuntime({
				interlinkedDir: dir,
				readSettings: () => settings({ enabled: false }),
				hasRecentActivity: () => true,
			});
			await expect(rt.tick()).resolves.toBeUndefined();
			rt.dispose();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("no-ops re-entrantly when a tick is already in flight", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const calls: Call[] = [];
		let resolveFetch: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			resolveFetch = resolve;
		});
		const slowFetch: typeof fetch = (async (url, init) => {
			await gate;
			return makeFetchStub(wire, calls)(url, init);
		});
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: slowFetch,
			now: () => T0,
		});
		const firstTick = rt.tick();
		// Second tick fires while the first is still awaiting the fetch —
		// hits the `if (inFlight) return;` guard and resolves immediately.
		await rt.tick();
		resolveFetch?.();
		await firstTick;
		rt.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=1");
	});

	it("does not rewrite the disabled marker on a second consecutive disabled tick", async () => {
		const calls: Call[] = [];
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings({ enabled: false }),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub("{}", calls),
			now: () => T0,
		});
		await rt.tick();
		await rt.tick(); // wasEnabled already false — skip the rewrite branch
		rt.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=0");
		expect(calls).toHaveLength(0);
	});

	it("swallows an exception thrown mid-tick without disturbing the daemon (outer catch)", async () => {
		const calls: Call[] = [];
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => {
				throw new Error("readSettings blew up");
			},
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub("{}", calls),
			now: () => T0,
		});
		await expect(rt.tick()).resolves.toBeUndefined();
		rt.dispose();
	});

	it("keeps the stale feed when a due refresh fetch fails (feed already non-null, cache skipped)", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const calls: Call[] = [];
		let now = T0;
		let fail = false;
		const flakyFetch: typeof fetch = (async (url, init) => {
			if (fail && String(url).endsWith("/v1/feed")) {
				return new Response("", { status: 503 });
			}
			return makeFetchStub(wire, calls)(url, init);
		});
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: flakyFetch,
			now: () => now,
		});
		await rt.tick(); // feed loads successfully — feed !== null from here on
		fail = true;
		now = T0 + 16 * 60 * 1000; // past FEED_REFRESH_MS — refresh is due again
		await rt.tick(); // fetch fails; feed is already non-null, so cache lookup is skipped
		rt.dispose();
		const status = readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8");
		expect(status).toContain("creative=alpha"); // stale feed still renders
	});

	it("fires a real tick on its own interval timer", async () => {
		vi.useFakeTimers();
		try {
			const calls: Call[] = [];
			const rt = startSponsorRuntime({
				interlinkedDir: dir,
				readSettings: () => settings({ enabled: false }),
				hasRecentActivity: () => true,
				fetchImpl: makeFetchStub("{}", calls),
				now: () => Date.now(),
			});
			await vi.advanceTimersByTimeAsync(60_000);
			rt.dispose();
			expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=0");
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes buffered beacons once the flush interval elapses", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const calls: Call[] = [];
		let now = T0;
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, calls),
			now: () => now,
		});
		await rt.tick(); // impression buffered
		now = T0 + 6 * 60 * 1000; // past the 5-minute flush interval
		await rt.tick();
		rt.dispose();
		const beaconPosts = calls.filter((c) => c.url.endsWith("/v1/beacon"));
		expect(beaconPosts).toHaveLength(1);
		expect(JSON.parse(beaconPosts[0]?.body ?? "{}").beacons.length).toBeGreaterThan(0);
		expect(readFileSync(join(dir, BEACON_FILE), "utf8")).toBe("");
	});
});
