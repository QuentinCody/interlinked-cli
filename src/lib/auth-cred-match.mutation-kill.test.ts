import { expect, it } from "vitest";
import { matchCredByPrefix } from "./auth-cred-match.js";

// test-contract: bug — an OAuth `expires_at` in epoch SECONDS (the JWT/OAuth convention) must be read as seconds; read as milliseconds a token valid until 2099 looks expired in January 1970 and auth silently falls back
it("accepts an unexpired token whose expiry is given in epoch seconds", () => {
	const in2099Seconds = Math.floor(Date.parse("2099-01-01T00:00:00Z") / 1000);
	expect(matchCredByPrefix({ "interlinked:abc": { accessToken: "tok-s", expires_at: in2099Seconds } }, "interlinked:")).toBe("tok-s");
});

// test-contract: boundary — an epoch-seconds expiry in the past still rejects the token
it("rejects a token whose epoch-seconds expiry has passed", () => {
	const in2000Seconds = Math.floor(Date.parse("2000-01-01T00:00:00Z") / 1000);
	expect(matchCredByPrefix({ "interlinked:abc": { accessToken: "tok-s", expires_at: in2000Seconds } }, "interlinked:")).toBeNull();
});
