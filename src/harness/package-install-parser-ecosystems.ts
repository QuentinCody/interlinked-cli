// Per-ecosystem install-command parsers extracted from package-install-parser.ts.
// Import from package-install-parser.ts, not directly from here.
//
// Imports ONLY from package-install-parser-shared.ts — no imports from
// package-install-parser.ts, so the dependency graph is acyclic:
//   shared ← pypi ← ecosystems ← package-install-parser (main)
//
// The PyPI family (pip / pip3 / pipx / poetry / uv) lives in the sibling
// package-install-parser-pypi.ts (extracted for the per-file line cap) and is
// re-exported below so existing importers are unchanged.

import { nonNull } from "../lib/non-null.js";
import type {
	InstallAction,
	InstallCommand,
	PackageSpec,
} from "./package-install-parser-shared.js";
import {
	dropPreVerbFlags,
	envRegistryFor,
} from "./package-install-parser-shared.js";


// Composer / NuGet / Maven family — re-exported from the sibling module (line-cap extraction).
export { parseComposer, parseMaven, parseNuget } from "./package-install-parser-ecosystems-extra.js";
// PyPI family — re-exported from the sibling module (line-cap extraction).
export { classifyPipSpec, parsePip, parsePoetry, parseUv } from "./package-install-parser-pypi.js";

// ===========================================================
// npm / pnpm / yarn / bun
// ===========================================================
const NPM_ADD_VERBS = new Set(["install", "i", "add", "isntall"]);
const NPM_SYNC_VERBS = new Set(["ci"]);
const NPM_REMOVE_VERBS = new Set([
	"uninstall",
	"remove",
	"rm",
	"un",
	"unlink",
]);

export function isNpmVerb(s: string): boolean {
	return NPM_ADD_VERBS.has(s) || NPM_SYNC_VERBS.has(s) || NPM_REMOVE_VERBS.has(s);
}

// Decide the high-level action for an npm-family invocation, or null when the
// verb isn't one we recognize as an install/sync/remove. `bareYarn` is true for
// `yarn` with literally zero args (== `yarn install`); see parseNpmLike for why
// we require exactly zero rather than "no recognized verb".
function npmActionFor(sub: string, bareYarn: boolean): InstallAction | null {
	if (bareYarn) return "sync";
	if (NPM_SYNC_VERBS.has(sub)) return "sync";
	if (NPM_ADD_VERBS.has(sub)) return "add";
	if (NPM_REMOVE_VERBS.has(sub)) return "remove";
	return null;
}

interface NpmFlagScan {
	positionals: string[];
	customRegistry: string | undefined;
	frozenLockfile: boolean;
}

const NPM_FLAG_TAKES_VALUE = new Set([
	"--prefix",
	"--cache",
	"--user-agent",
	"--workspace",
	"-w",
	"--save-prefix",
]);

// Advance past flag `a` at index `i`; null means `a` isn't a flag (positional).
function skipNpmFlagArg(args: string[], i: number, a: string): number | null {
	if (!a.startsWith("-")) return null;
	if (!NPM_FLAG_TAKES_VALUE.has(a)) return i;
	// Empty value (`--prefix ""`) IS the value; test absence, not `/^[^-]/` (misses "").
	const next = args[i + 1];
	if (next !== undefined && !next.startsWith("-")) return i + 1;
	return i;
}

// Walk the post-verb args of an npm-family command, separating positional package
// specs from flags. Captures a custom --registry and any frozen/immutable flag.
function scanNpmFlags(args: string[]): NpmFlagScan {
	const positionals: string[] = [];
	let customRegistry: string | undefined;
	let frozenLockfile = false;

	for (let i = 0; i < args.length; i++) {
		const a = nonNull(args[i]);
		if (a === "--registry" || a === "--registry-url") {
			customRegistry = args[i + 1];
			i++;
			continue;
		}
		const m = a.match(/^--(?:registry|registry-url)=(.+)$/);
		if (m) {
			customRegistry = m[1];
			continue;
		}
		if (isNpmFrozenFlag(a)) {
			frozenLockfile = true;
			continue;
		}
		const skipTo = skipNpmFlagArg(args, i, a);
		if (skipTo !== null) {
			i = skipTo;
			continue;
		}
		positionals.push(a);
	}

	return { positionals, customRegistry, frozenLockfile };
}

function isNpmFrozenFlag(a: string): boolean {
	return (
		a === "--frozen-lockfile" ||
		a === "--frozen" ||
		a === "--prefer-offline" ||
		a === "--immutable" ||
		a === "--no-update"
	);
}

// Whether a `sync` action reads the lockfile, given the manager and whether any
// positionals were present. `npm` always uses the lockfile on sync; pnpm only
// when no positionals; an explicit frozen/immutable flag forces it for any.
function npmSyncFromLockfile(
	bin: string,
	frozenLockfile: boolean,
	noPositionals: boolean,
): boolean {
	if (bin === "npm") return true;
	if (frozenLockfile) return true;
	return bin === "pnpm" && noPositionals;
}

export function parseNpmLike(
	bin: string,
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	// Drop pre-verb flags ("npm --prefix app install …") so the verb is at [0].
	const trailing = dropPreVerbFlags(bin, tokens.slice(1), isNpmVerb);
	const sub = trailing[0] || "";
	const args = trailing.slice(1);

	// `yarn` with no args at all == `yarn install`. We require ZERO args (not
	// "trailing produced nothing") because the latter happens when the user
	// invoked a non-install yarn subcommand whose verb we don't recognize —
	// e.g. `yarn workspaces foreach run build`. Treating that as `yarn install`
	// would be a false positive.
	const action = npmActionFor(sub, bin === "yarn" && tokens.length === 1);
	if (action === null) return null;

	const notes: string[] = [];
	const scan = scanNpmFlags(args);
	const positionals = scan.positionals;
	const frozenLockfile = scan.frozenLockfile;
	// Env-var registry override only fires when no inline --registry was given.
	const customRegistry = scan.customRegistry ?? envRegistryFor("npm", envVars);

	if (action === "add" && positionals.length === 0) {
		return {
			ecosystem: "npm",
			manager: bin,
			action: "sync",
			packages: [],
			fromLockfile: frozenLockfile,
			fromManifest: true,
			customRegistry,
			notes,
		};
	}

	const isSync = action === "sync";
	const noPositionals = positionals.length === 0;
	const fromLockfile =
		isSync && npmSyncFromLockfile(bin, frozenLockfile, noPositionals);
	const fromManifest = isSync && noPositionals;

	const packages: PackageSpec[] = positionals.map(classifyNpmSpec);
	if (isSync && !noPositionals) {
		notes.push(`unexpected positional args to ${bin} ${sub}`);
	}

	return {
		ecosystem: "npm",
		manager: bin,
		action,
		packages,
		fromLockfile,
		fromManifest,
		customRegistry,
		notes,
	};
}

function classifyNpmSpec(spec: string): PackageSpec {
	if (/^https?:\/\/.+\.(tgz|tar\.gz|zip)(?:[?#].*)?$/i.test(spec))
		return { kind: "tarball_url", url: spec };
	if (
		/^(git\+(https?|ssh|file):|github:|gitlab:|bitbucket:|gist:)/.test(spec) ||
		/^https?:\/\/.+\.git(?:#.+)?$/.test(spec)
	)
		return { kind: "git_url", url: spec };
	if (spec.startsWith("file:")) return { kind: "file_url", path: spec.slice(5) };
	if (
		spec.startsWith("./") ||
		spec.startsWith("../") ||
		spec.startsWith("/") ||
		spec.startsWith("~/")
	)
		return { kind: "local_path", path: spec };
	if (spec.startsWith("@")) {
		const slash = spec.indexOf("/");
		if (slash > 0) {
			const rest = spec.slice(slash + 1);
			const at = rest.indexOf("@");
			if (at < 0) return { kind: "registry", name: spec };
			return {
				kind: "registry",
				name: spec.slice(0, slash + 1 + at),
				version: rest.slice(at + 1),
			};
		}
		return { kind: "registry", name: spec };
	}
	const at = spec.indexOf("@");
	if (at > 0)
		return { kind: "registry", name: spec.slice(0, at), version: spec.slice(at + 1) };
	return { kind: "registry", name: spec };
}

// ===========================================================
// cargo
// ===========================================================
const CARGO_SYNC_VERBS = new Set(["build", "test", "run", "check"]);

export function parseCargo(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub === "add") return parseCargoAdd(args, envVars);
	if (sub === "install") return parseCargoInstall(args, envVars);
	if (CARGO_SYNC_VERBS.has(sub)) return cargoSync(args, envVars);
	return null;
}

interface CargoArgScan {
	positionals: string[];
	customRegistry: string | undefined;
	// Separate-flag version pin (`--vers`/`--version`), as opposed to the glued
	// `crate@1.0.0`. Captured so the value isn't mistaken for a second crate and
	// so the spec carries its pin for the exact-pin gate.
	pinnedVersion: string | undefined;
}

// Walk cargo's post-verb args, separating positional crate specs from flags.
// `withGit` controls whether `--git URL` is folded into a positional (only
// `cargo add` accepts it) — `cargo install --git` exists too but we keep the
// existing install behavior (git not captured as a spec) unchanged.
function scanCargoArgs(args: string[], withGit: boolean): CargoArgScan {
	const positionals: string[] = [];
	let customRegistry: string | undefined;
	let pinnedVersion: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = nonNull(args[i]);
		if (a === "--registry") {
			customRegistry = args[i + 1];
			i++;
			continue;
		}
		if (withGit && a === "--git") {
			positionals.push(`git+${args[i + 1]}`);
			i++;
			continue;
		}
		const inlineVers = a.match(/^(?:--vers|--version)=(.+)$/);
		if (inlineVers) {
			pinnedVersion = inlineVers[1];
			continue;
		}
		if (a === "--vers" || a === "--version") {
			pinnedVersion = args[i + 1];
			i++;
			continue;
		}
		if (a.startsWith("-")) continue;
		positionals.push(a);
	}
	return { positionals, customRegistry, pinnedVersion };
}

function parseCargoAdd(
	args: string[],
	envVars: Record<string, string>,
): InstallCommand {
	const scan = scanCargoArgs(args, true);
	return {
		ecosystem: "cargo",
		manager: "cargo",
		action: "add",
		packages: scan.positionals.map((p) => classifyCargoSpec(p, scan.pinnedVersion)),
		fromLockfile: false,
		fromManifest: false,
		customRegistry: scan.customRegistry ?? envRegistryFor("cargo", envVars),
		notes: [],
	};
}

function parseCargoInstall(
	args: string[],
	envVars: Record<string, string>,
): InstallCommand {
	const scan = scanCargoArgs(args, false);
	return {
		ecosystem: "cargo",
		manager: "cargo",
		action: "install_global",
		packages: scan.positionals.map((p) => classifyCargoSpec(p, scan.pinnedVersion)),
		fromLockfile: false,
		fromManifest: false,
		customRegistry: scan.customRegistry ?? envRegistryFor("cargo", envVars),
		notes: [],
	};
}

function cargoSync(
	args: string[],
	envVars: Record<string, string>,
): InstallCommand {
	const fromLockfile = args.includes("--locked") || args.includes("--frozen");
	return {
		ecosystem: "cargo",
		manager: "cargo",
		action: "sync",
		packages: [],
		fromLockfile,
		fromManifest: true,
		manifestFile: "Cargo.toml",
		customRegistry: envRegistryFor("cargo", envVars),
		notes: [],
	};
}

function classifyCargoSpec(spec: string, flagVersion?: string): PackageSpec {
	if (spec.startsWith("git+")) return { kind: "git_url", url: spec.slice(4) };
	if (
		spec.startsWith("./") ||
		spec.startsWith("../") ||
		spec.startsWith("/") ||
		spec === "."
	)
		return { kind: "local_path", path: spec };
	// Glued `crate@1.0.0` form. cargo treats `@1.0.0` as a caret range in its
	// own semantics; the strict cargo pin is `=1.0.0`. We surface the literal
	// version string here and let pinnedVersionViolation accept both bare and
	// `=`-prefixed forms (see its cargo note).
	const at = spec.indexOf("@");
	if (at > 0) {
		return { kind: "registry", name: spec.slice(0, at), version: spec.slice(at + 1) };
	}
	const nameMatch = spec.match(/^([A-Za-z0-9._-]+)/);
	return { kind: "registry", name: nameMatch ? nonNull(nameMatch[1]) : spec, version: flagVersion };
}

// ===========================================================
// gem / bundle
// ===========================================================
export function parseGem(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub !== "install") return null;
	const positionals: string[] = [];
	let customRegistry: string | undefined;
	// `gem install x -v 1.2.3` pins x to 1.2.3. The version flag's value is the
	// pin, NOT a second package — without capturing it the value would be
	// mis-parsed as a phantom package name AND the spec would look unpinned.
	let pinnedVersion: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = nonNull(args[i]);
		if (a === "--source" || a === "-s" || a === "--add-source") {
			customRegistry = args[i + 1];
			i++;
			continue;
		}
		const inline = a.match(/^(?:-v|--version)=(.+)$/);
		if (inline) {
			pinnedVersion = inline[1];
			continue;
		}
		if (a === "-v" || a === "--version") {
			pinnedVersion = args[i + 1];
			i++;
			continue;
		}
		if (a.startsWith("-")) continue;
		positionals.push(a);
	}
	if (!customRegistry) customRegistry = envRegistryFor("rubygems", envVars);
	return {
		ecosystem: "rubygems",
		manager: "gem",
		action: "install_global",
		packages: positionals.map((p) => gemSpec(p, pinnedVersion)),
		fromLockfile: false,
		fromManifest: false,
		customRegistry,
		notes: [],
	};
}

// A gem name may already carry a glued `name:version` (gem's own colon form);
// otherwise apply a `-v`/`--version` pin captured from a sibling flag. The
// glued colon form wins when both are present.
function gemSpec(spec: string, flagVersion: string | undefined): PackageSpec {
	const colon = spec.indexOf(":");
	if (colon > 0) {
		return { kind: "registry", name: spec.slice(0, colon), version: spec.slice(colon + 1) };
	}
	return { kind: "registry", name: spec, version: flagVersion };
}

export function parseBundle(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub === "install") {
		const fromLockfile = args.includes("--frozen") || args.includes("--deployment");
		return {
			ecosystem: "rubygems",
			manager: "bundle",
			action: "sync",
			packages: [],
			fromLockfile,
			fromManifest: true,
			manifestFile: "Gemfile",
			customRegistry: envRegistryFor("rubygems", envVars),
			notes: [],
		};
	}
	if (sub === "add") {
		const positionals = args.filter((a) => !a.startsWith("-"));
		return {
			ecosystem: "rubygems",
			manager: "bundle",
			action: "add",
			packages: positionals.map((p) => ({ kind: "registry" as const, name: p })),
			fromLockfile: false,
			fromManifest: false,
			customRegistry: envRegistryFor("rubygems", envVars),
			notes: [],
		};
	}
	return null;
}

// ===========================================================
// go get / go install
// ===========================================================
export function parseGo(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub !== "get" && sub !== "install") return null;
	const positionals = args.filter((a) => !a.startsWith("-"));
	const action: InstallAction = sub === "install" ? "install_global" : "add";
	return {
		ecosystem: "go",
		manager: "go",
		action,
		packages: positionals.map((p) => {
			const at = p.lastIndexOf("@");
			if (at > 0)
				return {
					kind: "registry" as const,
					name: p.slice(0, at),
					version: p.slice(at + 1),
				};
			return { kind: "registry" as const, name: p };
		}),
		fromLockfile: false,
		fromManifest: false,
		customRegistry: envRegistryFor("go", envVars),
		notes: [],
	};
}
