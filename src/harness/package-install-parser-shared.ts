// Shared types and pure helpers for the package-install-parser family.
// No imports from package-install-parser.ts or package-install-parser-ecosystems.ts.
// Both of those files import from here — dependency flows one way only.
//
// Pure functions only: no fs, no env, no module-scope side effects.

// ---------------------------------------------------------------------------
// Public types (re-exported from package-install-parser.ts for back-compat)
// ---------------------------------------------------------------------------

import { nonNull } from "../lib/non-null.js";

export type Ecosystem =
	| "npm"
	| "pypi"
	| "cargo"
	| "rubygems"
	| "go"
	| "composer"
	| "maven"
	| "gradle"
	| "nuget";

export type InstallAction =
	| "add"
	| "sync"
	| "install_global"
	| "remove"
	| "noop";

export type PackageSpec =
	| { kind: "registry"; name: string; version?: string | undefined }
	| { kind: "git_url"; url: string }
	| { kind: "tarball_url"; url: string }
	| { kind: "local_path"; path: string }
	| { kind: "file_url"; path: string };

export interface InstallCommand {
	ecosystem: Ecosystem;
	manager: string;
	action: InstallAction;
	packages: PackageSpec[];
	fromLockfile: boolean;
	fromManifest: boolean;
	manifestFile?: string | undefined;
	customRegistry?: string | undefined;
	notes: string[];
	/** Relative-or-absolute cwd this command runs in, when shifted from
	 *  the script's cwd by a preceding `cd <path>` segment in the same
	 *  compound shell line. Resolved against the harness event's cwd. */
	effectiveCwd?: string;
}

// ---------------------------------------------------------------------------
// Exact-pinned-version gate
// ---------------------------------------------------------------------------
//
// An allowlisted name is necessary but not sufficient: `npm install lodash`
// (floating latest) can silently resolve to a newer, compromised release the
// next time it runs. The supply-chain guard additionally requires every
// registry spec to carry a CONCRETE full version (major.minor.patch).
//
// `pinnedVersionViolation` is the single source of truth for "is this spec
// exactly pinned?". It is a pure function over the already-parsed PackageSpec
// — the per-ecosystem parsers normalize the version into `spec.version`
// (operator/leading-`v` handling differs per ecosystem; see the parser tests
// for the exact stored form), so this helper reasons over that normalized
// string and is ecosystem-agnostic apart from the small carve-outs noted
// below (Go pseudo-versions, the cargo `@1.0.0`-is-caret note).

/** Dist-tags / branch refs that resolve to a moving target, never a pin. */
const FLOATING_DIST_TAGS = new Set([
	"latest",
	"next",
	"stable",
	"canary",
	"beta",
	"alpha",
	"rc",
	"dev",
	"nightly",
	"edge",
	"snapshot",
	"master",
	"main",
	"head",
]);

// A semver-style concrete full version (after the exact-operator prefix is
// stripped): optional leading `v`, then major.minor.patch, with an optional
// `-prerelease` and/or `+build`. The prerelease body is permissive enough to
// admit Go pseudo-versions (`v0.0.0-20191109021931-daa7c04131f5`), whose
// timestamp-and-hash tail is a single dotted-and-hyphenated identifier.
const SEMVER_EXACT_RE =
	/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

// Per-ecosystem "concrete exact version" shapes (finding 2026-06): the old
// UNIVERSAL major.minor.patch rule falsely blocked valid exact pins in
// ecosystems whose version grammar is not three-component semver — most
// damagingly PyPI, where `packaging==24.2` is EXACT under PEP 440 (only the
// `.*` prefix form floats; trailing zeros compare equal, so ==24.2 cannot
// resolve to 24.3), so the always-on supply-chain guard blocked legitimate
// pinned installs.
const EXACT_VERSION_RES: Record<Ecosystem, RegExp> = {
	// npm semver: `1.2` IS a floating range to npm (>=1.2.0 <1.3.0) — all three
	// components stay required.
	npm: SEMVER_EXACT_RE,
	// PEP 440 exact: [epoch!]N(.N)* + optional pre (aN|bN|cN|rcN), .postN,
	// .devN, +local — canonical forms. The floating prefix form (`==24.*`) is
	// rejected earlier by RANGE_OPERATOR_RE.
	pypi: /^v?(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|c|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[0-9A-Za-z][0-9A-Za-z.]*)?$/i,
	// cargo: a bare or `=`-prefixed PARTIAL version is a range in cargo's own
	// semantics (`=1.2` ⇒ >=1.2.0 <1.3.0) — all three components stay required.
	cargo: SEMVER_EXACT_RE,
	// RubyGems: `'1.2'` means exactly version 1.2 (Gem::Version does no
	// component padding), with dotted prerelease segments like `7.1.0.rc1`.
	rubygems: /^\d+(?:\.\d+)*(?:\.[A-Za-z][0-9A-Za-z]*)*$/,
	// Go modules: vX.Y.Z, including pseudo-versions (their timestamp-and-hash
	// tail rides the prerelease slot).
	go: SEMVER_EXACT_RE,
	// Composer (Packagist): semver; partial versions float, so all three
	// components stay required.
	composer: SEMVER_EXACT_RE,
	// Maven/Gradle (Maven Central coordinates): a concrete dotted version,
	// rejecting `-SNAPSHOT` (a moving build).
	maven: /^v?\d+(?:\.\d+){1,3}(?:-(?!snapshot\b)[0-9A-Za-z][0-9A-Za-z.-]*)?$/i,
	gradle: /^v?\d+(?:\.\d+){1,3}(?:-(?!snapshot\b)[0-9A-Za-z][0-9A-Za-z.-]*)?$/i,
	// NuGet: 2–4 numeric components plus optional prerelease.
	nuget: /^v?\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/i,
};

// Range / compound / wildcard operators that disqualify an exact pin.
// Note `=`/`==`/`===` are EXACT operators and are intentionally NOT here.
const RANGE_OPERATOR_RE = /[\^~><*]|\|\||,| - |\.x\b|\.\*/;

/** Strip the version down to its bare value for the "looks floating?" tests:
 *  drop a single leading exact operator and a single leading `v`. */
function stripExactPrefix(version: string): string {
	return version.replace(/^={1,3}/, "").replace(/^v/, "");
}

/** True when `version` names a dist-tag / branch (latest, next, master, …)
 *  rather than a concrete release. Case-insensitive. */
function isFloatingTag(version: string): boolean {
	return FLOATING_DIST_TAGS.has(stripExactPrefix(version).toLowerCase());
}

/** True when `version` is a concrete EXACT version under `ecosystem`'s own
 *  version grammar (with the allowed exact-operator / leading-`v` / prerelease /
 *  build decorations). Defaults to npm's semver rule — the strictest — for
 *  callers that predate the ecosystem parameter (finding 2026-06: one universal
 *  three-component rule falsely blocked valid PyPI/RubyGems exact pins). */
export function isExactPinnedVersion(version: string, ecosystem: Ecosystem = "npm"): boolean {
	const bare = version.trim().replace(/^={1,3}/, "");
	return EXACT_VERSION_RES[ecosystem].test(bare);
}

/**
 * Return a human-readable reason when a `kind:"registry"` spec is NOT
 * exactly pinned, or null when it is exact (or not a registry spec).
 *
 * BLOCK when the version is: absent; a range/compound operator
 * (`^ ~ > < * || ,`, a ` - ` range, or a `.x`/`.*` wildcard); a dist-tag /
 * branch ref; or not a concrete exact version under the ECOSYSTEM's own
 * grammar (finding 2026-06: one universal major.minor.patch rule falsely
 * blocked valid PyPI pins — `packaging==24.2` is exact under PEP 440, and a
 * RubyGems `'7.1'` is exact under Gem::Version — while npm/cargo/go partials
 * really do float and stay blocked). ALLOW a concrete exact version,
 * optionally prefixed with an exact operator (`==`/`===`/`=`) or a leading
 * `v`, optionally suffixed with `-prerelease`/`+build`/PEP 440 post/dev/local
 * segments. Go pseudo-versions count as exact.
 *
 * Cargo note: `@1.0.0` is a CARET range in cargo's own semantics, so the
 * strict cargo pin is `=1.0.0`. We accept both bare `1.0.0` and `=1.0.0`
 * here for now (parity with the other ecosystems' bare-version pins); tighten
 * to require the leading `=` for cargo if/when we surface a cargo-specific
 * pin policy.
 */
export function pinnedVersionViolation(
	spec: PackageSpec,
	ecosystem: Ecosystem,
): string | null {
	if (spec.kind !== "registry") return null;
	const version = spec.version?.trim();
	if (!version) {
		return `'${spec.name}' has no pinned version — floating installs resolve to whatever the registry serves next`;
	}
	if (RANGE_OPERATOR_RE.test(version)) {
		return `'${spec.name}@${version}' uses a version range, not an exact pin — a range can resolve to a newer, compromised release`;
	}
	if (isFloatingTag(version)) {
		return `'${spec.name}@${version}' is a moving dist-tag/branch, not an exact pin — it can point at a newer, compromised release`;
	}
	if (!isExactPinnedVersion(version, ecosystem)) {
		return `'${spec.name}@${version}' is not a concrete exact version under ${ecosystem}'s version rules — a partial version floats to the newest matching release`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Registry env-var helpers
// ---------------------------------------------------------------------------

/** Map of recognized package-registry env vars per ecosystem. */
export const ENV_REGISTRY_KEYS: Record<Ecosystem, readonly string[]> = {
	npm: [
		"NPM_CONFIG_REGISTRY",
		"npm_config_registry",
		"YARN_REGISTRY",
		"BUN_CONFIG_REGISTRY",
	],
	pypi: [
		"PIP_INDEX_URL",
		"PIP_EXTRA_INDEX_URL",
		"UV_INDEX_URL",
		"UV_EXTRA_INDEX_URL",
		"POETRY_HTTP_BASIC_DEFAULT_URL",
	],
	cargo: [],
	rubygems: ["GEM_SOURCE"],
	go: ["GOPROXY"],
	composer: [],
	maven: [],
	gradle: [],
	nuget: [],
};

const CARGO_REGISTRY_RE = /^CARGO_REGISTRIES_[A-Z0-9_]+_INDEX$/;

export function envRegistryFor(
	ecosystem: Ecosystem,
	envVars: Record<string, string>,
): string | undefined {
	for (const key of ENV_REGISTRY_KEYS[ecosystem]) {
		if (envVars[key]) return envVars[key];
	}
	if (ecosystem === "cargo") {
		for (const [k, v] of Object.entries(envVars)) {
			if (CARGO_REGISTRY_RE.test(k)) return v;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Pre-verb flag dropper (used by npm-like parser)
// ---------------------------------------------------------------------------

/** How many tokens a flag at position `a` consumes: 1 for a bare flag or
 *  a `--flag=val` form, 2 for `--flag VAL` where VAL doesn't look like a
 *  flag or the verb itself. Returns null when `a` isn't a flag at all. */
function flagTokenSpan(
	a: string,
	next: string | undefined,
	verbRecognizer: (s: string) => boolean,
): number | null {
	if (a.startsWith("--") && a.includes("=")) return 1;
	if (a.startsWith("-")) {
		// Looks-like-takes-value: next token is non-flag → consume pair
		if (next && !next.startsWith("-") && !verbRecognizer(next)) return 2;
		return 1;
	}
	return null;
}

/** Yarn's two documented pre-verb shapes: `workspace <name> <verb>` (skip
 *  the name, 2 tokens) and `workspaces` (plural — not an install shape,
 *  signal the caller to bail). Returns null for every other bin/token. */
function yarnPreVerbSpan(
	bin: string,
	a: string,
	next: string | undefined,
	verbRecognizer: (s: string) => boolean,
): number | "bail" | null {
	if (bin !== "yarn") return null;
	if (a === "workspace" && next && !verbRecognizer(next)) return 2;
	if (a === "workspaces") return "bail";
	return null;
}

/** Drop pre-verb flags (and their values) until we land on the first
 *  argument-shaped token. Used to handle `npm --prefix app install evil`,
 *  `pnpm --filter app add evil`, `yarn workspace app add evil`.
 *
 *  Heuristic: any `--flag` consumes itself; any `--flag=val` consumes
 *  itself; any `--flag VAL` where VAL doesn't start with `-` consumes
 *  both. `yarn workspace <name>` is a documented pre-verb shape — handled
 *  as a special case. */
export function dropPreVerbFlags(
	bin: string,
	args: string[],
	verbRecognizer: (s: string) => boolean,
): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < args.length) {
		const a = nonNull(args[i]);
		if (verbRecognizer(a)) {
			out.push(...args.slice(i));
			return out;
		}
		const flagSpan = flagTokenSpan(a, args[i + 1], verbRecognizer);
		if (flagSpan !== null) {
			i += flagSpan;
			continue;
		}
		const yarnSpan = yarnPreVerbSpan(bin, a, args[i + 1], verbRecognizer);
		if (yarnSpan === "bail") return [];
		if (yarnSpan !== null) {
			i += yarnSpan;
			continue;
		}
		break;
	}
	return out;
}
