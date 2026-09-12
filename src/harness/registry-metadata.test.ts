import { parseWire, wireObject, wireString } from "../lib/value-validation.js";
// Admission-screen network module. No real network anywhere in here — every
// test injects fetchImpl, and the assertions pin the exact URLs/bodies sent so
// a refactor can't silently start querying the wrong registry.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	fetchNpmPublishDates,
	fetchRegistryMetadata,
	fetchVersionMetadata,
	queryOsvAdvisories,
} from "./registry-metadata.js";

type FetchImpl = typeof globalThis.fetch;

function fakeFetch(body: unknown, opts: { ok?: boolean } = {}): FetchImpl {
	return vi.fn<FetchImpl>(async () => new Response(JSON.stringify(body), {
		status: opts.ok === false ? 500 : 200,
		headers: { "Content-Type": "application/json" },
	}));
}

function throwingFetch(): FetchImpl {
	return vi.fn(async () => {
		throw new Error("network down");
	});
}

function urlOf(f: FetchImpl): string {
	return parseWire(nonNull((vi.mocked(f)).mock.calls[0])[0], wireString, "test JSON value");
}

function initOf(f: FetchImpl): RequestInit {
	return nonNull(nonNull((vi.mocked(f)).mock.calls[0])[1]);
}

describe("fetchRegistryMetadata — per ecosystem", () => {
	it.each(["composer", "maven", "gradle", "nuget"] as const)("returns no metadata for unsupported registry %s without fetching", async (ecosystem) => {
		const fetchImpl = fakeFetch({ version: "1.0.0" });
		expect(await fetchRegistryMetadata(ecosystem, "example", { fetchImpl })).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("npm: reads version + license from the /latest dist-tag endpoint", async () => {
		const f = fakeFetch({ version: "4.17.21", license: "MIT" });
		const meta = await fetchRegistryMetadata("npm", "lodash", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "4.17.21", license: "MIT" });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/lodash/latest");
	});

	it("npm: escapes the inner slash of a scoped name", async () => {
		const f = fakeFetch({ version: "1.0.0", license: "MIT" });
		await fetchRegistryMetadata("npm", "@types/node", { fetchImpl: f });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/@types%2Fnode/latest");
	});

	// Proves the ternary actually GATES on startsWith("@") rather than always
	// escaping — a non-scoped name's slash must reach the URL untouched. (npm
	// itself never issues such a name, but the function doesn't validate input,
	// and this is the only way to distinguish "always escape" from "escape only
	// when scoped".)
	it("npm: a non-scoped name's slash is left unescaped (the @ guard actually gates the replace)", async () => {
		const f = fakeFetch({ version: "1.0.0", license: "MIT" });
		await fetchRegistryMetadata("npm", "not-scoped/weird", { fetchImpl: f });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/not-scoped/weird/latest");
	});

	it("pypi: prefers PEP 639 license_expression over legacy license prose", async () => {
		const f = fakeFetch({
			info: { version: "2.32.0", license: "long prose here", license_expression: "Apache-2.0" },
		});
		const meta = await fetchRegistryMetadata("pypi", "requests", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "2.32.0", license: "Apache-2.0" });
		expect(urlOf(f)).toBe("https://pypi.org/pypi/requests/json");
	});

	it("pypi: falls back to the legacy license field", async () => {
		const f = fakeFetch({ info: { version: "1.0.0", license: "MIT" } });
		const meta = await fetchRegistryMetadata("pypi", "leftpadpy", { fetchImpl: f });
		expect(meta?.license).toBe("MIT");
	});

	it("cargo: normalizes crates.io slash dual-licensing to SPDX OR", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.219", max_version: "2.0.0-rc.1" },
			versions: [{ license: "MIT/Apache-2.0" }],
		});
		const meta = await fetchRegistryMetadata("cargo", "serde", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "1.0.219", license: "MIT OR Apache-2.0" });
		expect(urlOf(f)).toBe("https://crates.io/api/v1/crates/serde");
	});

	// Round 7 (finding 2026-06): versions[0] is newest-OVERALL, which can be a
	// prerelease when max_version > max_stable_version. The license must come
	// from the entry whose `num` equals the CHOSEN (stable) version, not the
	// prerelease — otherwise advisories are screened for one version and the
	// license enforced for another.
	it("cargo: takes the license of the STABLE version, not a newer prerelease", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.0", max_version: "2.0.0-rc.1" },
			versions: [
				{ num: "2.0.0-rc.1", license: "GPL-3.0-only" }, // newest overall (prerelease)
				{ num: "1.0.0", license: "MIT" }, // the chosen stable release
			],
		});
		const meta = await fetchRegistryMetadata("cargo", "somecrate", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "1.0.0", license: "MIT" });
	});

	it("cargo: falls back to newest-overall license when no entry matches the chosen version", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.0", max_version: "1.0.0" },
			versions: [{ license: "BSD-3-Clause" }], // no `num` — cannot be matched
		});
		const meta = await fetchRegistryMetadata("cargo", "oldcrate", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "1.0.0", license: "BSD-3-Clause" });
	});

	it("rubygems: joins the licenses array as an OR choice", async () => {
		const f = fakeFetch({ version: "7.1.0", licenses: ["MIT", "Ruby"] });
		const meta = await fetchRegistryMetadata("rubygems", "rails", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "7.1.0", license: "MIT OR Ruby" });
		expect(urlOf(f)).toBe("https://rubygems.org/api/v1/gems/rails.json");
	});

	it("go: returns null without touching the network (no metadata API)", async () => {
		const f = fakeFetch({});
		const meta = await fetchRegistryMetadata("go", "github.com/pkg/errors", { fetchImpl: f });
		expect(meta).toBeNull();
		expect(f).not.toHaveBeenCalled();
	});

	it("cargo: empty crate object → null (no version recorded)", async () => {
		const f = fakeFetch({ crate: {}, versions: [{ license: "MIT" }] });
		const meta = await fetchRegistryMetadata("cargo", "ghost", { fetchImpl: f });
		expect(meta).toBeNull();
	});

	it("cargo: a non-array `versions` field is treated as empty", async () => {
		// crate present (so we don't early-return) but versions is malformed →
		// the Array.isArray guard yields [], newest = rec(undefined) = {}, license undefined.
		const f = fakeFetch({
			crate: { max_stable_version: "3.2.1" },
			versions: "not-an-array",
		});
		const meta = await fetchRegistryMetadata("cargo", "weirdcrate", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "3.2.1", license: undefined });
	});

	it("cargo: falls back to max_version when max_stable_version is absent", async () => {
		const f = fakeFetch({
			crate: { max_version: "0.5.0" },
			versions: [{ num: "0.5.0", license: "Apache-2.0" }],
		});
		const meta = await fetchRegistryMetadata("cargo", "prerelease-only", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "0.5.0", license: "Apache-2.0" });
	});

	it("rubygems: empty json object → null", async () => {
		const f = fakeFetch({});
		const meta = await fetchRegistryMetadata("rubygems", "ghost-gem", { fetchImpl: f });
		expect(meta).toBeNull();
	});

	it("rubygems: a non-array `licenses` field yields an undefined license", async () => {
		const f = fakeFetch({ version: "2.0.0", licenses: null });
		const meta = await fetchRegistryMetadata("rubygems", "no-license-gem", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "2.0.0", license: undefined });
	});

	it("rubygems: an empty (or fully blank) licenses array yields undefined, not an empty string", async () => {
		const f = fakeFetch({ version: "2.0.0", licenses: ["", "   "] });
		const meta = await fetchRegistryMetadata("rubygems", "blank-license-gem", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "2.0.0", license: undefined });
	});

	// Distinct from the all-blank case above: a non-string entry MIXED with real
	// license strings must be filtered out by the typeof guard, not just the
	// blank-string guard — a malformed API response could plausibly contain a
	// stray non-string element in an otherwise-valid array.
	it("rubygems: drops a non-string entry mixed into an otherwise-valid licenses array", async () => {
		const f = fakeFetch({ version: "1.0.0", licenses: ["MIT", 42, "Ruby"] });
		const meta = await fetchRegistryMetadata("rubygems", "mixed-license-gem", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "1.0.0", license: "MIT OR Ruby" });
	});
});

describe("fetchRegistryMetadata — default fetch implementation", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses globalThis.fetch when no fetchImpl is injected", async () => {
		const stub = fakeFetch({ version: "9.9.9", license: "MIT" });
		vi.stubGlobal("fetch", stub);
		// No fetchImpl in opts → the `opts.fetchImpl ?? globalThis.fetch` fallback fires.
		const meta = await fetchRegistryMetadata("npm", "lodash");
		expect(meta).toEqual({ latestVersion: "9.9.9", license: "MIT" });
		expect(stub).toHaveBeenCalledOnce();
		expect(urlOf(stub)).toBe("https://registry.npmjs.org/lodash/latest");
	});
});

describe("fetchRegistryMetadata — failure shapes (all fail open to null)", () => {
	// Body carries a real version+license payload — an empty `{}` body would
	// collapse into the exact same "empty json → null" path the missing-shape
	// test below already covers, regardless of whether the `!res.ok` check
	// fires, so it couldn't tell a broken ok-check from a working one. A
	// populated body means only the ok-check stands between this and a
	// non-null result.
	it("HTTP error status", async () => {
		const meta = await fetchRegistryMetadata("npm", "ghost-pkg", {
			fetchImpl: fakeFetch({ version: "1.0.0", license: "MIT" }, { ok: false }),
		});
		expect(meta).toBeNull();
	});

	it("network throw", async () => {
		const meta = await fetchRegistryMetadata("npm", "lodash", { fetchImpl: throwingFetch() });
		expect(meta).toBeNull();
	});

	it("response missing the expected shape", async () => {
		const meta = await fetchRegistryMetadata("pypi", "x", { fetchImpl: fakeFetch("not json obj") });
		expect(meta).toBeNull();
	});

	// Direct single-indirection ecosystem (npm reads json.version straight off
	// the rec() result, unlike pypi's nested json.info) — proves rec()'s own
	// typeof-object guard, not just a downstream nested-field emptiness check,
	// is what turns a bare truthy non-object body into null.
	it("npm: a bare non-object truthy body (e.g. a JSON string, not an object) fails open to null", async () => {
		const meta = await fetchRegistryMetadata("npm", "weird", {
			fetchImpl: fakeFetch("just-a-string-not-an-object"),
		});
		expect(meta).toBeNull();
	});

	it("absent fields come back undefined, not invented", async () => {
		const meta = await fetchRegistryMetadata("npm", "no-license-pkg", {
			fetchImpl: fakeFetch({ version: "1.0.0" }),
		});
		expect(meta).toEqual({ latestVersion: "1.0.0", license: undefined });
	});

	it("timeout: the abort timer fires and the rejected fetch fails open to null", async () => {
		// fetchImpl honours the injected AbortSignal — it never resolves on its own,
		// so the only way it settles is the setTimeout(abort) firing. timeoutMs:1
		// guarantees the timer wins, exercising the abort callback + catch arm.
		const abortAwareFetch = vi.fn<FetchImpl>((_url, init) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) {
					reject(new DOMException("aborted", "AbortError"));
					return;
				}
				signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		});
		const meta = await fetchRegistryMetadata("npm", "slow-pkg", {
			fetchImpl: abortAwareFetch,
			timeoutMs: 1,
		});
		expect(meta).toBeNull();
		expect(abortAwareFetch).toHaveBeenCalledOnce();
	});
});

describe("queryOsvAdvisories", () => {
	it("posts the OSV ecosystem spelling and version, parses vuln ids", async () => {
		const f = fakeFetch({
			vulns: [
				{ id: "RUSTSEC-2023-0071", summary: "timing side-channel" },
				{ id: "GHSA-xxxx", summary: "" },
				{ id: "", summary: "blank id must be dropped too, not just missing id" },
				{ notAnId: true },
			],
		});
		const advisories = await queryOsvAdvisories("cargo", "rsa", "0.9.0", { fetchImpl: f });
		expect(advisories).toEqual([
			{ id: "RUSTSEC-2023-0071", summary: "timing side-channel" },
			{ id: "GHSA-xxxx", summary: undefined },
		]);
		expect(advisories).toHaveLength(2);
		const call = (vi.mocked(f)).mock.calls[0];
		expect(nonNull(call)[0]).toBe("https://api.osv.dev/v1/query");
		const body = JSON.parse((parseWire(nonNull(call)[1], wireObject({ "body": wireString }), "test JSON value")).body);
		expect(body).toEqual({
			version: "0.9.0",
			package: { name: "rsa", ecosystem: "crates.io" },
		});
	});

	// Exercises fetchJson's shared header/method plumbing through the one call
	// site that actually supplies both a method and its own headers — proves
	// the POST verb, OSV's Content-Type, AND the module-wide User-Agent all
	// survive the merge (`{ "User-Agent": USER_AGENT, ...(init?.headers ?? {}) }`)
	// rather than any one of them silently dropping out.
	it("POSTs with the OSV Content-Type header merged alongside the module's own User-Agent", async () => {
		const f = fakeFetch({ vulns: [] });
		await queryOsvAdvisories("npm", "lodash", "4.17.21", { fetchImpl: f });
		const init = initOf(f);
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"Content-Type": "application/json",
			"User-Agent": "interlinked-cli (allowlist admission screen)",
		});
	});

	it("maps the remaining ecosystems to OSV spellings", async () => {
		for (const [eco, spelled] of [
			["npm", "npm"],
			["pypi", "PyPI"],
			["rubygems", "RubyGems"],
			["go", "Go"],
			["composer", "Packagist"],
			["maven", "Maven"],
			["gradle", "Maven"],
			["nuget", "NuGet"],
		] as const) {
			const f = fakeFetch({ vulns: [] });
			await queryOsvAdvisories(eco, "pkg", "1.0.0", { fetchImpl: f });
			const body = JSON.parse(
				(parseWire(nonNull((vi.mocked(f)).mock.calls[0])[1], wireObject({ "body": wireString }), "test JSON value")).body,
			);
			expect(body.package.ecosystem).toBe(spelled);
		}
	});

	it("treats OSV's empty-object response as a clean empty result, not a failure", async () => {
		const advisories = await queryOsvAdvisories("npm", "lodash", "4.17.21", {
			fetchImpl: fakeFetch({}),
		});
		expect(advisories).toEqual([]);
	});

	it("returns null (screen skipped) on network failure", async () => {
		expect(
			await queryOsvAdvisories("npm", "lodash", "4.17.21", { fetchImpl: throwingFetch() }),
		).toBeNull();
	});

	it("returns null on HTTP error status", async () => {
		expect(
			await queryOsvAdvisories("npm", "lodash", "4.17.21", {
				fetchImpl: fakeFetch({}, { ok: false }),
			}),
		).toBeNull();
	});
});

describe("fetchVersionMetadata — pins the version-specific endpoint per ecosystem", () => {
	it("npm: queries the exact version dist-tag, returns its license", async () => {
		const f = fakeFetch({ version: "4.17.20", license: "MIT" });
		const meta = await fetchVersionMetadata("npm", "lodash", "4.17.20", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "4.17.20", license: "MIT" });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/lodash/4.17.20");
	});

	it("npm: escapes a scoped name's inner slash and url-encodes the version", async () => {
		const f = fakeFetch({ version: "18.0.0", license: "MIT" });
		await fetchVersionMetadata("npm", "@types/node", "18.0.0", { fetchImpl: f });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/@types%2Fnode/18.0.0");
	});

	it("npm: an empty body fails open to null", async () => {
		const meta = await fetchVersionMetadata("npm", "ghost", "1.0.0", { fetchImpl: fakeFetch({}) });
		expect(meta).toBeNull();
	});

	it("npm: a non-scoped name's slash is left unescaped (the @ guard actually gates the replace)", async () => {
		const f = fakeFetch({ version: "1.0.0", license: "MIT" });
		await fetchVersionMetadata("npm", "not-scoped/weird", "1.0.0", { fetchImpl: f });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/not-scoped/weird/1.0.0");
	});

	it("pypi: hits the /{name}/{version}/json endpoint and prefers license_expression", async () => {
		const f = fakeFetch({
			info: { version: "2.31.0", license: "legacy prose", license_expression: "Apache-2.0" },
		});
		const meta = await fetchVersionMetadata("pypi", "requests", "2.31.0", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "2.31.0", license: "Apache-2.0" });
		expect(urlOf(f)).toBe("https://pypi.org/pypi/requests/2.31.0/json");
	});

	it("pypi: falls back to the legacy license field when no expression", async () => {
		const f = fakeFetch({ info: { version: "1.2.3", license: "BSD-3-Clause" } });
		const meta = await fetchVersionMetadata("pypi", "somepkg", "1.2.3", { fetchImpl: f });
		expect(meta?.license).toBe("BSD-3-Clause");
	});

	it("pypi: an absent info block fails open to null", async () => {
		const meta = await fetchVersionMetadata("pypi", "x", "1.0.0", { fetchImpl: fakeFetch({}) });
		expect(meta).toBeNull();
	});

	it("cargo: selects the matching version's license and normalizes slash dual-licensing", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.219" },
			versions: [
				{ num: "1.0.219", license: "MIT/Apache-2.0" },
				{ num: "1.0.218", license: "GPL-3.0-only" },
			],
		});
		const meta = await fetchVersionMetadata("cargo", "serde", "1.0.219", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "1.0.219", license: "MIT OR Apache-2.0" });
		// Always queries the whole-crate endpoint — the per-version license is already in it.
		expect(urlOf(f)).toBe("https://crates.io/api/v1/crates/serde");
	});

	it("cargo: returns null when the requested version is not among the crate's versions", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.0" },
			versions: [{ num: "1.0.0", license: "MIT" }],
		});
		const meta = await fetchVersionMetadata("cargo", "serde", "0.0.1", { fetchImpl: f });
		expect(meta).toBeNull();
	});

	it("cargo: a non-array versions field means no match → null", async () => {
		const f = fakeFetch({ crate: {}, versions: undefined });
		const meta = await fetchVersionMetadata("cargo", "broken", "1.0.0", { fetchImpl: f });
		expect(meta).toBeNull();
	});

	// Proves the `?.` in `str(match.license)?.replace(...)` is load-bearing: a
	// matched version entry with no `license` field at all must yield an
	// undefined license, not throw on calling .replace on undefined.
	it("cargo: a matched version with no license field yields undefined instead of throwing", async () => {
		const f = fakeFetch({
			crate: { max_stable_version: "1.0.0" },
			versions: [{ num: "1.0.0" }], // no license key
		});
		const meta = await fetchVersionMetadata("cargo", "serde", "1.0.0", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "1.0.0", license: undefined });
	});

	it("rubygems: hits the v2 versioned endpoint and ORs the licenses array", async () => {
		const f = fakeFetch({ licenses: ["MIT", "Ruby"] });
		const meta = await fetchVersionMetadata("rubygems", "rails", "7.0.0", { fetchImpl: f });
		expect(meta).toEqual({ latestVersion: "7.0.0", license: "MIT OR Ruby" });
		expect(urlOf(f)).toBe("https://rubygems.org/api/v2/rubygems/rails/versions/7.0.0.json");
	});

	it("rubygems: an empty json object fails open to null", async () => {
		const meta = await fetchVersionMetadata("rubygems", "ghost", "1.0.0", {
			fetchImpl: fakeFetch({}),
		});
		expect(meta).toBeNull();
	});

	it("rubygems: a present body with an empty licenses array yields an undefined license", async () => {
		// Body is non-empty (version key) so it is not the null path; licenses is
		// an array but empty → license must come back undefined, not "".
		const f = fakeFetch({ version: "ignored", licenses: [] });
		const meta = await fetchVersionMetadata("rubygems", "no-license-gem", "3.1.0", {
			fetchImpl: f,
		});
		expect(meta).toEqual({ latestVersion: "3.1.0", license: undefined });
	});

	it("rubygems: drops a non-string entry mixed into an otherwise-valid licenses array", async () => {
		const f = fakeFetch({ version: "ignored", licenses: ["MIT", 42, "Ruby"] });
		const meta = await fetchVersionMetadata("rubygems", "mixed-license-gem", "1.0.0", {
			fetchImpl: f,
		});
		expect(meta).toEqual({ latestVersion: "1.0.0", license: "MIT OR Ruby" });
	});

	it("rubygems: drops a blank-after-trim string mixed into an otherwise-valid licenses array", async () => {
		const f = fakeFetch({ version: "ignored", licenses: ["MIT", "   ", "Ruby"] });
		const meta = await fetchVersionMetadata("rubygems", "blank-mixed-license-gem", "1.0.0", {
			fetchImpl: f,
		});
		expect(meta).toEqual({ latestVersion: "1.0.0", license: "MIT OR Ruby" });
	});

	it("rubygems: a non-array licenses field takes the [] fallback branch", async () => {
		// Distinct from the empty-array case above: exercises the Array.isArray=false
		// arm of the ternary so a malformed `licenses` can't throw or leak a value.
		const f = fakeFetch({ version: "ignored", licenses: "MIT" });
		const meta = await fetchVersionMetadata("rubygems", "weird-license-gem", "3.2.0", {
			fetchImpl: f,
		});
		expect(meta).toEqual({ latestVersion: "3.2.0", license: undefined });
	});

	it("unsupported ecosystem (go): returns null without a request", async () => {
		const goFetch = fakeFetch({ version: "1.0.0" });
		expect(
			await fetchVersionMetadata("go", "github.com/pkg/errors", "1.0.0", { fetchImpl: goFetch }),
		).toBeNull();
		expect(goFetch).not.toHaveBeenCalled();

	});
});

describe("fetchNpmPublishDates", () => {
	it("returns the full version→date time map verbatim, including the created/modified bookkeeping keys", async () => {
		// The doc comment says the CALLER must ignore created/modified — the
		// function itself does not filter them. Pin that the whole map comes back.
		const f = fakeFetch({
			time: {
				created: "2010-01-01T00:00:00.000Z",
				modified: "2024-01-01T00:00:00.000Z",
				"1.0.0": "2010-01-02T00:00:00.000Z",
				"2.0.0": "2020-06-15T00:00:00.000Z",
			},
		});
		const dates = await fetchNpmPublishDates("lodash", { fetchImpl: f });
		expect(dates).toEqual({
			created: "2010-01-01T00:00:00.000Z",
			modified: "2024-01-01T00:00:00.000Z",
			"1.0.0": "2010-01-02T00:00:00.000Z",
			"2.0.0": "2020-06-15T00:00:00.000Z",
		});
		expect(Object.keys(dates ?? {})).toHaveLength(4);
		expect(urlOf(f)).toBe("https://registry.npmjs.org/lodash");
	});

	it("escapes a scoped package name's inner slash (no /latest or version suffix, unlike the sibling fetchers)", async () => {
		const f = fakeFetch({ time: { "1.0.0": "2020-01-01T00:00:00.000Z" } });
		await fetchNpmPublishDates("@types/node", { fetchImpl: f });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/@types%2Fnode");
	});

	it("a non-scoped name's slash is left unescaped (the @ guard actually gates the replace)", async () => {
		const f = fakeFetch({ time: { "1.0.0": "2020-01-01T00:00:00.000Z" } });
		await fetchNpmPublishDates("not-scoped/weird", { fetchImpl: f });
		expect(urlOf(f)).toBe("https://registry.npmjs.org/not-scoped/weird");
	});

	it("drops non-string / blank entries from a malformed time map but keeps the valid ones", async () => {
		const f = fakeFetch({
			time: {
				"1.0.0": "2020-01-01T00:00:00.000Z",
				"2.0.0": 12345, // malformed — not a string
				"3.0.0": null,
				"4.0.0": "   ", // blank after trim — str() rejects it too
				"5.0.0": "2021-03-04T00:00:00.000Z",
			},
		});
		const dates = await fetchNpmPublishDates("weird-pkg", { fetchImpl: f });
		expect(dates).toEqual({
			"1.0.0": "2020-01-01T00:00:00.000Z",
			"5.0.0": "2021-03-04T00:00:00.000Z",
		});
		expect(Object.keys(dates ?? {})).toHaveLength(2);
	});

	it("a packument with no `time` field fails open to null", async () => {
		const dates = await fetchNpmPublishDates("no-time-pkg", {
			fetchImpl: fakeFetch({ name: "no-time-pkg", versions: {} }),
		});
		expect(dates).toBeNull();
	});

	it("an empty `time` object also fails open to null (not an empty {} success)", async () => {
		const dates = await fetchNpmPublishDates("empty-time-pkg", {
			fetchImpl: fakeFetch({ time: {} }),
		});
		expect(dates).toBeNull();
	});

	// Body carries a REAL time map — an empty `{}` failure body would
	// collapse into the exact same "no `time` field" path exercised above,
	// regardless of whether the `!res.ok` check fires, so it couldn't tell a
	// broken ok-check from a working one (this is the test the audit found
	// could not fail). A populated body means only the ok-check stands
	// between this and a non-null result.
	it("HTTP error status fails open to null", async () => {
		const dates = await fetchNpmPublishDates("ghost-pkg", {
			fetchImpl: fakeFetch({ time: { "1.0.0": "2020-01-01T00:00:00.000Z" } }, { ok: false }),
		});
		expect(dates).toBeNull();
	});

	it("a network throw fails open to null", async () => {
		const dates = await fetchNpmPublishDates("lodash", { fetchImpl: throwingFetch() });
		expect(dates).toBeNull();
	});

	it("uses globalThis.fetch and the default {} opts when none is passed at all", async () => {
		const stub = fakeFetch({ time: { "1.0.0": "2020-01-01T00:00:00.000Z" } });
		vi.stubGlobal("fetch", stub);
		try {
			const dates = await fetchNpmPublishDates("lodash");
			expect(dates).toEqual({ "1.0.0": "2020-01-01T00:00:00.000Z" });
			expect(urlOf(stub)).toBe("https://registry.npmjs.org/lodash");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
