import { describe, expect, it } from "vitest";
import { scanSecrets } from "./signatures.js";
import {
	PUBLIC_CREDENTIAL_CONTEXTS,
	publicContextsCovering,
} from "./public-credential-contexts.js";

// Built at run time so this source file carries no literal key shape.
const KEY = ["AIza", "SyB3xQ7mNp2LkR8vT1wZ5cH9jF4gD6sA0eU"].join("");
const OTHER_KEY = ["AIza", "SyZ9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF_e"].join("");
const GCP = "sig-secret-gcp-api";

describe("PUBLIC_CREDENTIAL_CONTEXTS registry shape", () => {
	it("every entry names a real signature, a rationale and a public source URL", () => {
		const known = new Set(["sig-secret-gcp-api"]);
		expect(PUBLIC_CREDENTIAL_CONTEXTS.map((e) => e.id)).toEqual([
			"youtube-innertube-api-key",
			"firebase-web-config-api-key",
		]);
		for (const entry of PUBLIC_CREDENTIAL_CONTEXTS) {
			expect(known.has(entry.signature_id)).toBe(true);
			expect(entry.rationale.length).toBeGreaterThan(40);
			expect(entry.source_url).toMatch(/^https:\/\//);
		}
	});

	it("the test key is itself a sig-secret-gcp-api hit (fixture sanity)", () => {
		expect(scanSecrets(`x ${KEY} y`).map((m) => m.rule_id)).toContain(GCP);
	});
});

describe("publicContextsCovering — positive (must fire)", () => {
	it("P1: YouTube ytcfg JSON `\"INNERTUBE_API_KEY\":\"<key>\"` (rg -o output with a file prefix)", () => {
		const text = `yt.html:"INNERTUBE_API_KEY":"${KEY}"\n`;
		expect(publicContextsCovering(text, [GCP])).toEqual(["youtube-innertube-api-key"]);
	});

	it("P2: YouTube `innertubeApiKey` JS property form", () => {
		const text = `var cfg = {innertubeApiKey: '${KEY}', hl: "en"};`;
		expect(publicContextsCovering(text, [GCP])).toEqual(["youtube-innertube-api-key"]);
	});

	it("P3: Firebase web config `const firebaseConfig = { …, apiKey: \"<key>\" }`", () => {
		const text = `const firebaseConfig = {\n  authDomain: "demo.firebaseapp.com",\n  apiKey: "${KEY}",\n};`;
		expect(publicContextsCovering(text, [GCP])).toEqual(["firebase-web-config-api-key"]);
	});

	it("P4: Firebase `initializeApp({ apiKey: … })` call", () => {
		const text = `initializeApp({ "apiKey": "${KEY}", "projectId": "demo" })`;
		expect(publicContextsCovering(text, [GCP])).toEqual(["firebase-web-config-api-key"]);
	});

	it("P5: two occurrences, both in a context, are covered", () => {
		const text = `"INNERTUBE_API_KEY":"${KEY}"\n"INNERTUBE_API_KEY":"${OTHER_KEY}"`;
		expect(publicContextsCovering(text, [GCP])).toEqual(["youtube-innertube-api-key"]);
	});
});

describe("publicContextsCovering — negative (must not fire)", () => {
	it("N1: a bare key with no context is not public", () => {
		expect(publicContextsCovering(`GOOGLE_API_KEY=${KEY}\n`, [GCP])).toBeNull();
	});

	it("N2: a key under an unregistered JSON name (`api_key`) is not public", () => {
		expect(publicContextsCovering(`{"api_key":"${KEY}"}`, [GCP])).toBeNull();
	});

	it("N3: one key in context plus one key outside any context is not public", () => {
		const text = `"INNERTUBE_API_KEY":"${KEY}"\nexport GOOGLE_API_KEY=${OTHER_KEY}`;
		expect(publicContextsCovering(text, [GCP])).toBeNull();
	});

	it("N4: `apiKey` in an object that is not a Firebase config is not public", () => {
		const text = `const cfg = { apiKey: "${KEY}" };`;
		expect(publicContextsCovering(text, [GCP])).toBeNull();
	});

	it("N5: a second signature with no registered context makes the set not public", () => {
		const text = `"INNERTUBE_API_KEY":"${KEY}"`;
		expect(publicContextsCovering(text, [GCP, "sig-secret-aws-key"])).toBeNull();
	});

	it("N6: a key longer than the context's 35-char body does not sit inside the context", () => {
		const text = `"INNERTUBE_API_KEY":"${KEY}EXTRA"`;
		expect(publicContextsCovering(text, [GCP])).toBeNull();
	});

	it("N7: an empty rule list is never public", () => {
		expect(publicContextsCovering(`"INNERTUBE_API_KEY":"${KEY}"`, [])).toBeNull();
	});
});
