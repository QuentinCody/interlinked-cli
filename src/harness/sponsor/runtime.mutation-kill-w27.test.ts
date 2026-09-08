// Mutation-kill wave 27 — targets manifest-listed survivors in runtime.ts.
// Companion to runtime.test.ts; kept separate so this wave's intent (pin
// exact literals / boundaries / log text the broad companion tests don't
// assert on) stays legible on its own.
import assert from "node:assert/strict";
import { type KeyObject, sign as edSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isJsonObject } from "../../lib/json-types.js";
import { BEACON_FILE, DEFAULT_FEED_URL, FEED_CACHE_FILE, SPONSOR_STATUS_FILE } from "./feed-client.js";
import {
	readSponsorSettingsFromConfig,
	type SponsorRuntimeSettings,
	startSponsorRuntime,
} from "./runtime.js";
import { ROTATION_WINDOW_MS, type SponsorFeed } from "./types.js";

function beaconCount(body: string | undefined): number {
	assert(typeof body === "string");
	const payload: unknown = JSON.parse(body);
	assert(isJsonObject(payload) && Array.isArray(payload.beacons));
	return payload.beacons.length;
}

const T0 = Date.parse("2026-06-12T00:00:05Z");
const FEED_REFRESH_MS = 15 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

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

function signFeedWithKey(feed: SponsorFeed, privateKey: KeyObject): string {
	const bytes = Buffer.from(JSON.stringify(feed), "utf8");
	return JSON.stringify({
		key_id: "test",
		payload_b64: bytes.toString("base64"),
		sig: edSign(null, bytes, privateKey).toString("base64"),
	});
}

const FEED: SponsorFeed = {
	version: 1,
	generated_at: "2026-06-12T00:00:00Z",
	valid_until: "2099-01-01T00:00:00Z",
	creatives: [
		{ id: "alpha", campaign: "friends", text: "Alpha — a friend project", url: "https://alpha.example", weight: 1 },
	],
};

const FEED_BETA: SponsorFeed = {
	version: 1,
	generated_at: "2026-06-12T00:00:00Z",
	valid_until: "2099-01-01T00:00:00Z",
	creatives: [{ id: "beta", campaign: "friends", text: "Beta", url: "https://beta.example", weight: 1 }],
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

describe("readSponsorSettingsFromConfig — mutation kill w27", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sponsor-cfg-w27-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: invariant — pins every literal in the catch-block
	// default object (enabled/telemetry/installId), not just `.enabled`.
	it("returns the exact disabled-defaults object when config.local.json cannot be read", () => {
		expect(readSponsorSettingsFromConfig(dir)).toEqual({
			enabled: false,
			feedUrl: DEFAULT_FEED_URL,
			telemetry: false,
			installId: "",
		});
	});

	// test-contract: invariant — pins the `feed_url.length > 0` guard so an
	// empty string can't slip through as a "valid" feed URL.
	it("falls back to DEFAULT_FEED_URL when sponsor.feed_url is an empty string", () => {
		writeFileSync(
			join(dir, "config.local.json"),
			JSON.stringify({ install_id: "z", sponsor: { enabled: true, feed_url: "" } }),
		);
		expect(readSponsorSettingsFromConfig(dir)?.feedUrl).toBe(DEFAULT_FEED_URL);
	});

	// test-contract: invariant — pins that an explicit `telemetry: false`
	// stays false even with a valid install id present.
	it("keeps telemetry false when sponsor.telemetry is explicitly false with an install id present", () => {
		writeFileSync(
			join(dir, "config.local.json"),
			JSON.stringify({ install_id: "abc", sponsor: { enabled: true, telemetry: false } }),
		);
		expect(readSponsorSettingsFromConfig(dir)?.telemetry).toBe(false);
	});

	// test-contract: invariant — pins the "" default for installId when
	// install_id is absent from an otherwise well-formed config.
	it("defaults installId to empty string when install_id is missing", () => {
		writeFileSync(join(dir, "config.local.json"), JSON.stringify({ sponsor: { enabled: true } }));
		expect(readSponsorSettingsFromConfig(dir)?.installId).toBe("");
	});
});

describe("startSponsorRuntime — mutation kill w27", () => {
	let dir: string;
	let savedEnv: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sponsor-rt-w27-"));
		savedEnv = process.env.INTERLINKED_SPONSOR_PUBKEY;
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (savedEnv === undefined) delete process.env.INTERLINKED_SPONSOR_PUBKEY;
		else process.env.INTERLINKED_SPONSOR_PUBKEY = savedEnv;
		vi.restoreAllMocks();
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

	// test-contract: invariant — pins that the default `now` arrow really
	// calls Date.now() and uses its real numeric return, not a no-op that
	// returns undefined (an undefined clock would make every later interval
	// arithmetic NaN, which the boundary tests below would also fail on).
	it("uses Date.now as the default clock when the `now` option is omitted", () => {
		const before = Date.now();
		const dateSpy = vi.spyOn(Date, "now");
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings({ enabled: false }),
			hasRecentActivity: () => true,
		});
		const after = Date.now();
		expect(dateSpy).toHaveBeenCalled();
		const observed = dateSpy.mock.results[0]?.value;
		expect(typeof observed).toBe("number");
		expect(observed).toBeGreaterThanOrEqual(before);
		expect(observed).toBeLessThanOrEqual(after);
		rt.dispose();
	});

	// test-contract: invariant — pins that `feed === null` alone forces a
	// refresh, independent of the elapsed-time clause (kills the `||`→`&&`
	// mutant and both `feed === null` truthiness flips at that site).
	it("treats the very first refresh as due even when the injected clock returns a tiny number", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const calls: Call[] = [];
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, calls),
			now: () => 100,
		});
		await rt.tick();
		rt.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("creative=alpha");
	});

	// test-contract: invariant — pins the early `if (!due) return;` guard
	// once the feed is already loaded (kills the "always due" and "!due
	// forced false" mutants).
	it("does not re-fetch the feed on a second tick at the same instant", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const calls: Call[] = [];
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, calls),
			now: () => T0,
		});
		await rt.tick();
		await rt.tick();
		rt.dispose();
		expect(calls.filter((c) => c.url.endsWith("/v1/feed"))).toHaveLength(1);
	});

	// test-contract: invariant — pins the elapsed-time clause of `due` on
	// its own, once the feed is already non-null.
	it("refetches the feed once the refresh interval has fully elapsed", async () => {
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
		now = T0 + 60 * 60 * 1000; // 1h — well past FEED_REFRESH_MS
		await rt.tick();
		rt.dispose();
		expect(calls.filter((c) => c.url.endsWith("/v1/feed"))).toHaveLength(2);
	});

	// test-contract: boundary — pins `>=` at the exact refresh boundary
	// (kills the `>` flip, which would treat the boundary as not-yet-due).
	it("refetches exactly at the refresh-interval boundary", async () => {
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
		now = T0 + FEED_REFRESH_MS;
		await rt.tick();
		rt.dispose();
		expect(calls.filter((c) => c.url.endsWith("/v1/feed"))).toHaveLength(2);
	});

	// test-contract: invariant — pins the real 15-minute refresh interval
	// (kills the `-`→`+` op and both `15*60*1000` arithmetic-constant
	// mutants, all of which would make a refetch fire far too early).
	it("does not refetch shortly after loading, well inside the refresh interval", async () => {
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
		now = T0 + 1000; // 1s later
		await rt.tick();
		rt.dispose();
		expect(calls.filter((c) => c.url.endsWith("/v1/feed"))).toHaveLength(1);
	});

	// test-contract: invariant — pins the exact log message on a
	// bad-signature live fetch, alongside the resulting disabled render state.
	it("logs the exact failed-verification message on a badly-signed live feed", async () => {
		const { wire } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = Buffer.from("not-a-real-key").toString("base64");
		const log = vi.fn();
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, []),
			now: () => T0,
			log,
		});
		await rt.tick();
		rt.dispose();
		expect(log).toHaveBeenCalledWith("[sponsor] fetched feed failed verification — ignoring");
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=0");
	});

	// test-contract: invariant — pins that the cache-fallback branch is
	// unreachable once the in-memory feed is already loaded: a later failed
	// refresh must keep the fresh feed, not fall back to a divergent cache.
	it("keeps the fresh live feed instead of a divergent disk cache when a later refresh attempt fails", async () => {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		process.env.INTERLINKED_SPONSOR_PUBKEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
		const wireAlpha = signFeedWithKey(FEED, privateKey);
		const wireBeta = signFeedWithKey(FEED_BETA, privateKey);
		let now = T0;
		let feedOk = true;
		const fetchImpl: typeof fetch = (async (url: unknown) => {
			const u = String(url);
			if (u.endsWith("/v1/feed")) {
				return feedOk
					? (new Response(wireAlpha, { status: 200 }))
					: (new Response("", { status: 503 }));
			}
			return new Response("", { status: 200 });
		});
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl,
			now: () => now,
		});
		await rt.tick(); // feed = alpha; cache saved with alpha's wire
		writeFileSync(join(dir, FEED_CACHE_FILE), wireBeta); // simulate a stale/divergent cache
		feedOk = false;
		now = T0 + 20 * 60 * 1000; // past the refresh interval — a real refetch attempt fires and fails
		await rt.tick();
		rt.dispose();
		const status = readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8");
		expect(status).toContain("creative=alpha");
		expect(status).not.toContain("creative=beta");
	});

	// test-contract: invariant — pins the exact log message on a
	// successful live refresh, including the creative count, alongside the
	// resulting render.
	it("logs the exact refreshed-feed message with the correct creative count", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const log = vi.fn();
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, []),
			now: () => T0,
			log,
		});
		await rt.tick();
		rt.dispose();
		expect(log).toHaveBeenCalledWith("[sponsor] feed refreshed: 1 creative(s)");
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("creative=alpha");
	});

	// test-contract: invariant — pins that "using verified cached feed" is
	// logged only when the disk cache actually verifies, in both directions.
	it("logs 'using verified cached feed' only when the disk cache actually verifies", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const dead: typeof fetch = (async () => {
			throw new Error("offline");
		});

		// (a) good cache: seed it via one successful run, then run again with
		// a dead network — original code loads and verifies the cache and logs.
		const seed = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => false,
			fetchImpl: makeFetchStub(wire, []),
			now: () => T0,
		});
		await seed.tick();
		seed.dispose();
		const logGood = vi.fn();
		const rtGood = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings(),
			hasRecentActivity: () => false,
			fetchImpl: dead,
			now: () => T0,
			log: logGood,
		});
		await rtGood.tick();
		rtGood.dispose();
		expect(logGood).toHaveBeenCalledWith("[sponsor] using verified cached feed");
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("creative=alpha");

		// (b) corrupted cache signed by an unrelated key: verification fails,
		// so the log must NOT fire.
		const dirBad = mkdtempSync(join(tmpdir(), "sponsor-rt-w27-bad-"));
		const { wire: badWire } = makeSignedWire(FEED);
		writeFileSync(join(dirBad, FEED_CACHE_FILE), badWire);
		const logBad = vi.fn();
		const rtBad = startSponsorRuntime({
			interlinkedDir: dirBad,
			readSettings: () => settings(),
			hasRecentActivity: () => true,
			fetchImpl: dead,
			now: () => T0,
			log: logBad,
		});
		await rtBad.tick();
		rtBad.dispose();
		expect(logBad).not.toHaveBeenCalledWith("[sponsor] using verified cached feed");
		rmSync(dirBad, { recursive: true, force: true });
	});

	// test-contract: invariant — the only externally observable effect of
	// the countedKeys eviction is that a previously-seen (creative,window) key
	// becomes "new" again once evicted, re-firing a beacon for that window.
	it(
		"evicts the oldest dedup key past the 500-key bound, letting that window's impression re-fire later",
		async () => {
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
			await rt.tick(); // window 0 counted — size 1
			for (let i = 1; i <= 500; i++) {
				now = T0 + i * ROTATION_WINDOW_MS;
				await rt.tick(); // 500 more distinct windows — size crosses 501, must evict window 0's key
			}
			now = T0; // back to window 0
			await rt.tick(); // if window 0's key was evicted, this re-counts as new
			rt.dispose();
			const flushed = calls
				.filter((c) => c.url.endsWith("/v1/beacon"))
				.reduce((sum, c) => sum + beaconCount(c.body), 0);
			let remaining = 0;
			try {
				remaining = readFileSync(join(dir, BEACON_FILE), "utf8").trim().split("\n").filter(Boolean).length;
			} catch {
				remaining = 0;
			}
			expect(flushed + remaining).toBe(502); // 501 distinct windows + 1 re-triggered window 0
		},
		20000,
	);

	// test-contract: boundary — pins the `>` (not `>=`) boundary: at
	// exactly 500 counted keys, eviction must NOT have happened yet.
	it(
		"does not yet evict at exactly 500 counted keys",
		async () => {
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
			for (let i = 0; i < 500; i++) {
				now = T0 + i * ROTATION_WINDOW_MS;
				await rt.tick(); // 500 distinct windows — size reaches exactly 500
			}
			now = T0; // back to window 0 — should still be a dedup skip (not yet evicted)
			await rt.tick();
			rt.dispose();
			const flushed = calls
				.filter((c) => c.url.endsWith("/v1/beacon"))
				.reduce((sum, c) => sum + beaconCount(c.body), 0);
			let remaining = 0;
			try {
				remaining = readFileSync(join(dir, BEACON_FILE), "utf8").trim().split("\n").filter(Boolean).length;
			} catch {
				remaining = 0;
			}
			expect(flushed + remaining).toBe(500); // no re-trigger — window 0's key is still present
		},
		20000,
	);

	// test-contract: boundary — pins the exact flush-interval boundary.
	it("flushes exactly at the flush-interval boundary", async () => {
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
		await rt.tick(); // impression buffered, lastFlushAt = T0
		now = T0 + FLUSH_INTERVAL_MS;
		await rt.tick();
		rt.dispose();
		expect(calls.filter((c) => c.url.endsWith("/v1/beacon"))).toHaveLength(1);
	});

	// test-contract: invariant — pins the real 5-minute flush interval
	// (kills both `5*60*1000` arithmetic-constant mutants, which would make a
	// flush fire almost immediately).
	it("does not flush shortly after buffering an impression, well inside the flush interval", async () => {
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
		now = T0 + 1000; // 1s later
		await rt.tick();
		rt.dispose();
		expect(calls.filter((c) => c.url.endsWith("/v1/beacon"))).toHaveLength(0);
	});

	// test-contract: invariant — pins that a null `readSettings()` result
	// is handled via optional chaining, not a crash (kills the
	// `settings?.enabled` → `settings.enabled` mutant).
	it("treats a null settings result as disabled without throwing", async () => {
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => null,
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub("{}", []),
			now: () => T0,
		});
		await rt.tick();
		rt.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=0");
	});

	// test-contract: invariant — deleting the status file between two
	// consecutive disabled ticks makes the "only write once per state change"
	// guard externally observable: if the guard is broken, the file comes
	// back; if it holds, it stays deleted.
	it("does not rewrite the disabled-status file on a second consecutive disabled tick", async () => {
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings({ enabled: false }),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub("{}", []),
			now: () => T0,
		});
		await rt.tick();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=0");
		rmSync(join(dir, SPONSOR_STATUS_FILE));
		await rt.tick(); // wasEnabled already false — should skip the rewrite
		rt.dispose();
		expect(() => readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toThrow();
	});

	// test-contract: invariant — pins that `wasEnabled` is correctly set
	// to true on an enabled tick, so the very next disabled tick detects the
	// transition and clears the status (kills the `true`→`false` flip that
	// would leave a stale "enabled=1" marker on disk).
	it("clears the enabled status on the very next tick after settings flip from enabled to disabled", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		let enabled = true;
		const rt = startSponsorRuntime({
			interlinkedDir: dir,
			readSettings: () => settings({ enabled }),
			hasRecentActivity: () => true,
			fetchImpl: makeFetchStub(wire, []),
			now: () => T0,
		});
		await rt.tick();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=1");
		enabled = false;
		await rt.tick();
		rt.dispose();
		expect(readFileSync(join(dir, SPONSOR_STATUS_FILE), "utf8")).toContain("enabled=0");
	});

	// test-contract: invariant — pins that dispose() actually clears the
	// interval, so no further ticks fire afterward.
	it("dispose() clears the interval so no further ticks fire", async () => {
		vi.useFakeTimers();
		try {
			let tickCount = 0;
			const rt = startSponsorRuntime({
				interlinkedDir: dir,
				readSettings: () => {
					tickCount += 1;
					return settings({ enabled: false });
				},
				hasRecentActivity: () => true,
				fetchImpl: makeFetchStub("{}", []),
				now: () => Date.now(),
			});
			await vi.advanceTimersByTimeAsync(60_000); // one interval tick fires
			const countAfterOneInterval = tickCount;
			rt.dispose();
			await vi.advanceTimersByTimeAsync(180_000); // three more intervals' worth of time
			expect(tickCount).toBe(countAfterOneInterval);
		} finally {
			vi.useRealTimers();
		}
	});
});
