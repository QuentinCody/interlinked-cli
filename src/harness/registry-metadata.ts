// ===========================================
// Admission-time registry metadata + OSV advisory lookup
// ===========================================
//
// NETWORK CODE — used ONLY by the human-invoked `interlinked allowlist add`
// admission screens (same posture as the typosquat check: the catastrophic
// failure mode is approving a bad package, so admission may spend a network
// round-trip). The harness daemon's per-edit hook path must never import
// this module; per-edit enforcement consumes only fields already recorded
// in .interlinked/package-allowlist.json.
//
// Every function fails open to `null` (offline, timeout, unsupported
// ecosystem, unparseable response) — callers surface a loud "screen skipped"
// note instead of blocking the bootstrap path.

import type { Ecosystem } from "./package-install-parser.js";

export interface RegistryPackageMetadata {
	latestVersion?: string | undefined;
	/** SPDX license expression as declared on the registry, when available. */
	license?: string | undefined;
}

interface OsvAdvisory {
	id: string;
	summary?: string | undefined;
}

type FetchImpl = typeof globalThis.fetch;

interface NetworkOptions {
	timeoutMs?: number | undefined;
	/** Test seam — defaults to global fetch. */
	fetchImpl?: FetchImpl | undefined;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const USER_AGENT = "interlinked-cli (allowlist admission screen)";

async function fetchJson(
	url: string,
	opts: NetworkOptions,
	init?: RequestInit,
): Promise<unknown | null> {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, {
			...init,
			headers: { "User-Agent": USER_AGENT, ...(init?.headers ?? {}) },
			signal: controller.signal,
		});
		if (!res.ok) return null;
		return (await res.json()) as unknown;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Fetch latest-version + declared-license metadata for a registry package.
 * Returns null when the ecosystem has no queryable registry API (go) or the
 * lookup fails for any reason.
 */
export async function fetchRegistryMetadata(
	ecosystem: Ecosystem,
	name: string,
	opts: NetworkOptions = {},
): Promise<RegistryPackageMetadata | null> {
	switch (ecosystem) {
		case "npm": {
			// Scoped names keep the leading @ but escape the inner slash.
			const escaped = name.startsWith("@") ? name.replace("/", "%2F") : name;
			const json = rec(await fetchJson(`https://registry.npmjs.org/${escaped}/latest`, opts));
			if (Object.keys(json).length === 0) return null;
			return { latestVersion: str(json.version), license: str(json.license) };
		}
		case "pypi": {
			const json = rec(
				await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, opts),
			);
			const info = rec(json.info);
			if (Object.keys(info).length === 0) return null;
			// PEP 639 license_expression is the SPDX field; legacy `license`
			// free-text is the fallback (matches against the allowlist only
			// when it happens to be a bare SPDX id, which is fine).
			return {
				latestVersion: str(info.version),
				license: str(info.license_expression) ?? str(info.license),
			};
		}
		case "cargo": {
			const json = rec(
				await fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, opts),
			);
			const crate = rec(json.crate);
			if (Object.keys(crate).length === 0) return null;
			const versions = Array.isArray(json.versions) ? json.versions : [];
			// latestVersion is the max STABLE release; the license must describe THAT
			// same version. versions[0] is newest-overall, which can be a PRERELEASE
			// when max_version > max_stable_version — recording its license screened
			// one version but enforced another (finding 2026-06, round 7). Select the
			// entry whose `num` matches the chosen version; fall back to versions[0]
			// only when no entry matches.
			const chosen = str(crate.max_stable_version) ?? str(crate.max_version);
			const matching = versions.map(rec).find((v) => str(v.num) === chosen);
			const newest = matching ?? rec(versions[0]);
			// crates.io spells dual licensing "MIT/Apache-2.0"; normalize to SPDX OR.
			const rawLicense = str(newest.license);
			return {
				latestVersion: chosen,
				license: rawLicense?.replace(/\s*\/\s*/g, " OR "),
			};
		}
		case "rubygems": {
			const json = rec(
				await fetchJson(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`, opts),
			);
			if (Object.keys(json).length === 0) return null;
			const licenses = Array.isArray(json.licenses)
				? json.licenses.filter((l): l is string => typeof l === "string" && l.trim() !== "")
				: [];
			// Multiple license entries on rubygems mean "choose any" → SPDX OR.
			return {
				latestVersion: str(json.version),
				license: licenses.length > 0 ? licenses.join(" OR ") : undefined,
			};
		}
		case "go":
			// No stable license/version metadata API; pkg.go.dev is HTML-only.
			return null;
		default:
			return null;
	}
}

/**
 * Fetch the declared license of ONE SPECIFIC version. The admission screens
 * must inspect the version the allowlist actually approves: `--version-range`
 * pins an older release, and a clean, permissively-licensed LATEST said
 * nothing about it (finding 2026-06, round 6 — screen/approve identity
 * mismatch). Fails open to `null` like every lookup here; callers note the
 * skipped screen loudly.
 */
export async function fetchVersionMetadata(
	ecosystem: Ecosystem,
	name: string,
	version: string,
	opts: NetworkOptions = {},
): Promise<RegistryPackageMetadata | null> {
	switch (ecosystem) {
		case "npm": {
			const escaped = name.startsWith("@") ? name.replace("/", "%2F") : name;
			const json = rec(
				await fetchJson(`https://registry.npmjs.org/${escaped}/${encodeURIComponent(version)}`, opts),
			);
			if (Object.keys(json).length === 0) return null;
			return { latestVersion: str(json.version), license: str(json.license) };
		}
		case "pypi": {
			const json = rec(
				await fetchJson(
					`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
					opts,
				),
			);
			const info = rec(json.info);
			if (Object.keys(info).length === 0) return null;
			return {
				latestVersion: str(info.version),
				license: str(info.license_expression) ?? str(info.license),
			};
		}
		case "cargo": {
			// The crate response already carries every version's license.
			const json = rec(
				await fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, opts),
			);
			const versions = Array.isArray(json.versions) ? json.versions : [];
			const match = versions.map(rec).find((v) => str(v.num) === version);
			if (!match) return null;
			return {
				latestVersion: version,
				license: str(match.license)?.replace(/\s*\/\s*/g, " OR "),
			};
		}
		case "rubygems": {
			const json = rec(
				await fetchJson(
					`https://rubygems.org/api/v2/rubygems/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}.json`,
					opts,
				),
			);
			if (Object.keys(json).length === 0) return null;
			const licenses = Array.isArray(json.licenses)
				? json.licenses.filter((l): l is string => typeof l === "string" && l.trim() !== "")
				: [];
			return {
				latestVersion: version,
				license: licenses.length > 0 ? licenses.join(" OR ") : undefined,
			};
		}
		default:
			return null;
	}
}

/** Ecosystem names as OSV spells them (https://ossf.github.io/osv-schema/). */
const OSV_ECOSYSTEM: Record<Ecosystem, string> = {
	npm: "npm",
	pypi: "PyPI",
	cargo: "crates.io",
	rubygems: "RubyGems",
	go: "Go",
	composer: "Packagist",
	// Maven and Gradle both resolve from Maven Central — OSV keys them under "Maven".
	maven: "Maven",
	gradle: "Maven",
	nuget: "NuGet",
};

/**
 * Query OSV for advisories affecting `name@version`. The version matters:
 * querying without one returns every historical (long-fixed) advisory, which
 * would refuse approval of basically every popular package. Returns null on
 * any failure so callers can say "screen skipped" rather than guess.
 */
export async function queryOsvAdvisories(
	ecosystem: Ecosystem,
	name: string,
	version: string,
	opts: NetworkOptions = {},
): Promise<OsvAdvisory[] | null> {
	const raw = await fetchJson("https://api.osv.dev/v1/query", opts, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			version,
			package: { name, ecosystem: OSV_ECOSYSTEM[ecosystem] },
		}),
	});
	// Null = network/HTTP failure → "screen skipped". A successful `{}` body
	// is OSV's legitimate "no known vulns" answer → clean empty result. The
	// null check must run BEFORE any object coercion or the two collapse.
	if (raw === null) return null;
	const json = rec(raw);
	const vulns = Array.isArray(json.vulns) ? json.vulns : [];
	return vulns
		.map((v) => rec(v))
		.filter((v) => typeof v.id === "string" && v.id !== "")
		.map((v) => ({ id: v.id as string, summary: str(v.summary) }));
}

/**
 * npm publish timestamps for every version of a package (the packument `time`
 * map: version → ISO date, plus the "created"/"modified" bookkeeping keys the
 * caller must ignore). Powers the libyear admission screen. npm-only — other
 * registries expose no equivalent stable API — and admission-time only, like
 * everything in this module. The FULL packument can be MB-scale for huge
 * packages; acceptable at human-invoked admission, never on the hook path.
 * Fails open to null (screen skipped, loudly, by the caller).
 */
export async function fetchNpmPublishDates(
	name: string,
	opts: NetworkOptions = {},
): Promise<Record<string, string> | null> {
	const escaped = name.startsWith("@") ? name.replace("/", "%2F") : name;
	const json = rec(await fetchJson(`https://registry.npmjs.org/${escaped}`, opts));
	const time = rec(json.time);
	if (Object.keys(time).length === 0) return null;
	const out: Record<string, string> = {};
	for (const [version, iso] of Object.entries(time)) {
		const s = str(iso);
		if (s !== undefined) out[version] = s;
	}
	return out;
}
