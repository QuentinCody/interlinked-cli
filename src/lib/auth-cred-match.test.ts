import { describe, expect, it } from "vitest";
import { matchCredByPrefix, matchCredByServerName } from "./auth-cred-match.js";

const future = "2099-01-01T00:00:00.000Z";
const past = "2000-01-01T00:00:00.000Z";

describe("matchCredByPrefix", () => {
	it("returns null when mcpPrefix is not provided", () => {
		const entries = { "foo:bar": { accessToken: "tok" } };
		expect(matchCredByPrefix(entries, undefined)).toBeNull();
	});

	it("returns the access token for a key matching the prefix and not expired", () => {
		const entries = {
			"interlinked:abc": { accessToken: "tok-1", token_expires_at: future },
		};
		expect(matchCredByPrefix(entries, "interlinked:")).toBe("tok-1");
	});

	it("skips entries whose key does not start with the prefix", () => {
		const entries = { "other:abc": { accessToken: "tok-1" } };
		expect(matchCredByPrefix(entries, "interlinked:")).toBeNull();
	});

	it("skips a matching-prefix entry that is expired", () => {
		const entries = {
			"interlinked:abc": { accessToken: "tok-1", token_expires_at: past },
		};
		expect(matchCredByPrefix(entries, "interlinked:")).toBeNull();
	});

	it("skips a matching-prefix entry that is not a valid cred object", () => {
		const entries = { "interlinked:abc": { notAccessToken: "tok-1" } };
		expect(matchCredByPrefix(entries, "interlinked:")).toBeNull();
	});
});

describe("matchCredByServerName", () => {
	it("returns the access token for a serverName containing 'interlinked' (case-insensitive)", () => {
		const entries = {
			k1: { accessToken: "tok-2", serverName: "My Interlinked Server", token_expires_at: future },
		};
		expect(matchCredByServerName(entries)).toBe("tok-2");
	});

	it("returns null when no entry's serverName mentions interlinked", () => {
		const entries = { k1: { accessToken: "tok-2", serverName: "Other Server" } };
		expect(matchCredByServerName(entries)).toBeNull();
	});

	it("skips a matching serverName entry that is expired", () => {
		const entries = {
			k1: { accessToken: "tok-2", serverName: "Interlinked", token_expires_at: past },
		};
		expect(matchCredByServerName(entries)).toBeNull();
	});

	it("skips an entry with no serverName at all", () => {
		const entries = { k1: { accessToken: "tok-2" } };
		expect(matchCredByServerName(entries)).toBeNull();
	});
});
