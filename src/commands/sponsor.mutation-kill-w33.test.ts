import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import { sign as edSign, generateKeyPairSync } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FEED_URL, SPONSOR_STATUS_FILE } from "../harness/sponsor/feed-client.js";
import type { SponsorFeed } from "../harness/sponsor/types.js";
import { addSponsorSpinnerVerb } from "../lib/sponsor-spinner.js";

// Hoisted mutable state so the node:os mock factory (which runs hoisted,
// before any local const declarations) can read a per-test fake homedir.
const osState = vi.hoisted(() => ({ fakeHome: "" }));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => osState.fakeHome };
});

// Wrap the real implementation so most tests exercise real fs behavior;
// one test below overrides the return value for exactly one call.
vi.mock("../lib/sponsor-spinner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/sponsor-spinner.js")>();
	return { ...actual, addSponsorSpinnerVerb: vi.fn(actual.addSponsorSpinnerVerb) };
});

import { sponsorDisableAction, sponsorEnableAction, sponsorStatusAction } from "./sponsor.js";

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

describe("sponsor command — mutation-kill wave 33", () => {
	let cwd: string;
	let settingsPath: string;
	let savedEnv: string | undefined;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "sponsor-w33-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		settingsPath = join(cwd, "claude-settings.json");
		savedEnv = process.env.INTERLINKED_SPONSOR_PUBKEY;
		osState.fakeHome = mkdtempSync(join(tmpdir(), "sponsor-w33-home-"));
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(osState.fakeHome, { recursive: true, force: true });
		if (savedEnv === undefined) delete process.env.INTERLINKED_SPONSOR_PUBKEY;
		else process.env.INTERLINKED_SPONSOR_PUBKEY = savedEnv;
		vi.restoreAllMocks();
	});

	function localConfig(): Record<string, unknown> {
		return parseWire(JSON.parse(
			readFileSync(join(cwd, ".interlinked", "config.local.json"), "utf8"),
		), wireRecord(wireUnknown), "test JSON value");
	}

	function printedLog(): string {
		return vi
			.mocked(console.log)
			.mock.calls.map((c) => String(c[0]))
			.join("\n");
	}

	function printedErr(): string {
		return vi
			.mocked(console.error)
			.mock.calls.map((c) => String(c[0]))
			.join("\n");
	}

	// test-contract: mutation-kill — resolveDeps default claudeSettingsPath must
	// join(homedir(), ".claude", "settings.json"); mutants ffce61632eb14327 /
	// d6d52fc4e224a8b3 blank out ".claude" / "settings.json" respectively.
	it("enable --spinner with no claudeSettingsPath override writes to <home>/.claude/settings.json", async () => {
		mkdirSync(join(osState.fakeHome, ".claude"), { recursive: true });
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl: typeof fetch = async () => new Response(wire);
		await sponsorEnableAction({ spinner: true }, { cwd, fetchImpl });
		const expectedPath = join(osState.fakeHome, ".claude", "settings.json");
		expect(existsSync(expectedPath)).toBe(true);
		expect(readFileSync(expectedPath, "utf8")).toContain("Alpha");
	});

	// test-contract: mutation-kill — the early-refusal error text must be the
	// exact message; mutant 04f9f2ce80794dd1 blanks it to "".
	it("enable outside an interlinked project prints the exact refusal message", async () => {
		const bare = mkdtempSync(join(tmpdir(), "sponsor-w33-bare-"));
		await sponsorEnableAction({}, { cwd: bare, claudeSettingsPath: settingsPath });
		expect(printedErr()).toContain(
			"No .interlinked/ here — run `interlinked enable` first, then opt in.",
		);
		rmSync(bare, { recursive: true, force: true });
	});

	// test-contract: mutation-kill — resolveSpinnerVerb must be called with
	// `sponsor.feed_url ?? DEFAULT_FEED_URL`; mutant b8c2990296b5bf7a swaps
	// `??` for `&&`, which passes `undefined` through instead of the default.
	it("enable --spinner with no --feed-url fetches the DEFAULT_FEED_URL", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		let seenUrl: string | undefined;
		const fetchImpl: typeof fetch = async (url) => {
			seenUrl = String(url);
			return new Response(wire);
		};
		await sponsorEnableAction({ spinner: true }, { cwd, claudeSettingsPath: settingsPath, fetchImpl });
		expect(seenUrl).toBe(DEFAULT_FEED_URL);
	});

	// test-contract: mutation-kill — `res.ok && res.written` must gate the
	// success branch; mutant a71682158bf252bb swaps `&&` for `||`, which would
	// treat ok:true/written:"" as success instead of falling through to the
	// "skipped" error branch.
	it("enable --spinner falls to the skipped branch when the write reports ok but no written verb", async () => {
		vi.mocked(addSponsorSpinnerVerb).mockReturnValueOnce({ ok: true, written: "" });
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl: typeof fetch = async () => new Response(wire);
		await sponsorEnableAction({ spinner: true }, { cwd, claudeSettingsPath: settingsPath, fetchImpl });
		expect(printedErr()).toContain("Spinner surface skipped: unknown");
		const sponsor = parseWire(localConfig().sponsor, wireObject({ "spinner": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value");
		expect(sponsor.spinner).not.toBe(true);
	});

	// test-contract: mutation-kill — a fresh spinner install must UNION with
	// any prior `spinner_verbs_written` (mutant e10af4ed4e8902d5 swaps the
	// `??` fallback for `&&`, discarding a non-empty prior array) and must
	// set `sponsor.spinner = true` on success (mutant aebf769167cc9034 flips
	// that literal to false).
	it("enable --spinner merges with prior spinner_verbs_written and sets spinner:true", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		const before = localConfig();
		writeFileSync(
			join(cwd, ".interlinked", "config.local.json"),
			JSON.stringify({
				...before,
				sponsor: { ...(parseWire(before.sponsor, wireRecord(wireUnknown), "sponsor config")), spinner_verbs_written: ["Old verb"] },
			}),
		);
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl: typeof fetch = async () => new Response(wire);
		await sponsorEnableAction({ spinner: true }, { cwd, claudeSettingsPath: settingsPath, fetchImpl });
		const sponsor = parseWire(localConfig().sponsor, wireObject({ "spinner": wireAbsentOptional(wireOptional(wireBoolean)), "spinner_verbs_written": wireAbsentOptional(wireOptional(wireArray(wireString))) }), "test JSON value");
		expect(sponsor.spinner).toBe(true);
		expect(sponsor.spinner_verbs_written).toEqual(
			expect.arrayContaining(["Old verb", "Sponsored by Alpha — a friend project"]),
		);
		expect(sponsor.spinner_verbs_written).toHaveLength(2);
	});

	// test-contract: mutation-kill — `if (opts.spinner)` must gate the whole
	// spinner branch; mutant ceab4d4b8ddde8d3 replaces the condition with
	// `true`, which would fetch the feed even when --spinner was not passed.
	it("enable without --spinner never calls fetchImpl", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response(""));
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath, fetchImpl });
		expect(fetchImpl).not.toHaveBeenCalled();
		const sponsor = parseWire(localConfig().sponsor, wireObject({ "spinner": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value");
		expect(sponsor.spinner).toBeUndefined();
	});

	// test-contract: mutation-kill — the successful --spinner console output
	// carries several exact strings and a truncated (not full) install id;
	// mutants 7080582e3e7b72d1 / ae7943c020ccb0c5 / f92f23e6ab46e9fb /
	// 883d074e07e7b094 / dd9167b039e42233 blank those strings, and
	// ee0627ea3870e0cf replaces `installId.slice(0, 8)` with the full id.
	it("enable --spinner (non-json) prints the full expected message set with a truncated install id", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl: typeof fetch = async () => new Response(wire);
		await sponsorEnableAction({ spinner: true }, { cwd, claudeSettingsPath: settingsPath, fetchImpl });
		const installId = parseWire(localConfig().install_id, wireString, "test JSON value");
		const printed = printedLog();
		expect(printed).toContain('Spinner verb installed: "Sponsored by Alpha — a friend project"');
		expect(printed).toContain("Claude Code reads spinnerVerbs at boot — restart to see it.");
		expect(printed).toContain("Sponsor slot enabled (statusline row 3).");
		expect(printed).toContain("anonymous impressions/clicks");
		expect(printed).toContain("Restart the daemon to start rendering: interlinked harness restart");
		expect(printed).toContain(`install ${installId.slice(0, 8)}…`);
		expect(printed).not.toContain(`install ${installId}…`);
	});

	// test-contract: mutation-kill — a fresh disable (no prior sponsor config,
	// so `written` must fall back to `[]` and the `written.length > 0` guard
	// must be strictly false) must NOT call removeSponsorSpinnerVerbs at all.
	// mutants e159daad42518d37 (fallback becomes a non-empty array),
	// b6c63509e42dad3b (condition forced `true`), and 951d2d63221fb622
	// (`> 0` weakened to `>= 0`) each independently force that call, which
	// would surface as a "not removed" error against this corrupted file.
	it("disable on a fresh project never touches settings.json (even if it's corrupted)", async () => {
		writeFileSync(settingsPath, "{ not valid json");
		await sponsorDisableAction({}, { cwd, claudeSettingsPath: settingsPath });
		expect(printedErr()).not.toContain("Spinner verbs not removed");
	});

	// test-contract: mutation-kill — a real disable (prior verb present, real
	// settings.json) must report NO error (mutant 5da24a51121ec340 forces
	// `!res.ok` to `true`, always printing the "not removed" line even on
	// success), must set `spinner:false` (mutant dba002f1a429997a flips the
	// literal to true), and must print the exact human-readable disable
	// message on the non-json path (mutants 86e5cba61c7c0c81 forces the json
	// branch, 7f5cd87a87ab0787 blanks the message).
	it("disable after a real spinner install succeeds silently, clears spinner, and prints the disable message", async () => {
		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl: typeof fetch = async () => new Response(wire);
		await sponsorEnableAction({ spinner: true }, { cwd, claudeSettingsPath: settingsPath, fetchImpl });
		vi.mocked(console.error).mockClear();
		vi.mocked(console.log).mockClear();
		await sponsorDisableAction({}, { cwd, claudeSettingsPath: settingsPath });
		expect(printedErr()).not.toContain("Spinner verbs not removed");
		const sponsor = parseWire(localConfig().sponsor, wireObject({ "spinner": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value");
		expect(sponsor.spinner).toBe(false);
		expect(printedLog()).toContain(
			"Sponsor slot disabled — row clears on the next statusline refresh.",
		);
	});

	// test-contract: mutation-kill — `spinner: sponsor.spinner === true` must
	// reflect the real flag both ways; mutants 933da06fa8eb2624 (forces
	// `true`), bfac0c81d675678a (forces `false`), f3c55d8044d4992b (flips the
	// inner literal), and 258accf3c1e44f66 (`===` weakened to `!==`) each
	// break one direction of this equality.
	it("status --json reports spinner:false when disabled and spinner:true when enabled", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		vi.mocked(console.log).mockClear();
		await sponsorStatusAction({ json: true }, { cwd, claudeSettingsPath: settingsPath });
		let parsed = parseWire(JSON.parse(printedLog()), wireObject({ "spinner": wireBoolean }), "test JSON value");
		expect(parsed.spinner).toBe(false);

		const { wire, pubB64 } = makeSignedWire(FEED);
		process.env.INTERLINKED_SPONSOR_PUBKEY = pubB64;
		const fetchImpl: typeof fetch = async () => new Response(wire);
		await sponsorEnableAction({ spinner: true }, { cwd, claudeSettingsPath: settingsPath, fetchImpl });
		vi.mocked(console.log).mockClear();
		await sponsorStatusAction({ json: true }, { cwd, claudeSettingsPath: settingsPath });
		parsed = parseWire(JSON.parse(printedLog()), wireObject({ "spinner": wireBoolean }), "test JSON value");
		expect(parsed.spinner).toBe(true);
	});

	// test-contract: mutation-kill — the json branch's `feed_url` fallback
	// must be DEFAULT_FEED_URL when unset; mutant 056449167614935e swaps the
	// `??` for `&&`, which yields `undefined` instead.
	it("status --json falls back to DEFAULT_FEED_URL when no feed_url is configured", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		vi.mocked(console.log).mockClear();
		await sponsorStatusAction({ json: true }, { cwd, claudeSettingsPath: settingsPath });
		const parsed = parseWire(JSON.parse(printedLog()), wireObject({ "feed_url": wireString }), "test JSON value");
		expect(parsed.feed_url).toBe(DEFAULT_FEED_URL);
	});

	// test-contract: mutation-kill — the non-json branch's feed/telemetry/
	// enabled lines must reflect the real defaults; mutants ce395b7f40383bf1
	// (feed `??` -> `&&`), f5653d95d7268e96 + 813a26db1f886bac (telemetry
	// `?? true` weakened), dee8b74525a17434 (blanks "on"), and
	// 0d950e6363b233b2 (blanks "enabled") each break one of these lines.
	it("status (non-json) on a freshly-enabled project prints feed/telemetry/enabled defaults", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		vi.mocked(console.log).mockClear();
		await sponsorStatusAction({}, { cwd, claudeSettingsPath: settingsPath });
		const printed = printedLog();
		expect(printed).toContain(`feed: ${DEFAULT_FEED_URL}`);
		expect(printed).toContain("telemetry: on");
		expect(printed).toContain("Sponsor slot: ");
		expect(printed).toContain("enabled");
	});

	// test-contract: mutation-kill — the live-status "text" fallback must be
	// the empty string, not a marker string; mutant 4c16166246a8df4a swaps
	// `""` for `"Stryker was here!"`.
	it("status (non-json) never renders a placeholder for a missing text= line", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		writeFileSync(join(cwd, ".interlinked", SPONSOR_STATUS_FILE), "enabled=1\ncreative=alpha\n");
		vi.mocked(console.log).mockClear();
		await sponsorStatusAction({}, { cwd, claudeSettingsPath: settingsPath });
		expect(printedLog()).not.toContain("Stryker was here!");
	});

	// test-contract: mutation-kill — readLiveStatus must skip a line with no
	// "=" (eq === -1) and a line where "=" is the FIRST character (eq === 0);
	// mutant 1cbf0b54d1f3751d forces the guard `true` (admits the eq===-1
	// line), and mutant 4476587c20ea0105 weakens `> 0` to `>= 0` (admits the
	// eq===0 line). Only "creative=alpha" should ever produce a key.
	it("status --json ignores malformed lines in the live status file", async () => {
		await sponsorEnableAction({}, { cwd, claudeSettingsPath: settingsPath });
		writeFileSync(
			join(cwd, ".interlinked", SPONSOR_STATUS_FILE),
			"noequalsline\n=bogus\ncreative=alpha\n",
		);
		vi.mocked(console.log).mockClear();
		await sponsorStatusAction({ json: true }, { cwd, claudeSettingsPath: settingsPath });
		const parsed = parseWire(JSON.parse(printedLog()), wireObject({ "live": wireRecord(wireString) }), "test JSON value");
		expect(parsed.live).toEqual({ creative: "alpha" });
	});
});
