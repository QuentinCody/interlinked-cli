// PyPI-family install-command parsers (pip / pip3 / pipx / poetry / uv),
// extracted from package-install-parser-ecosystems.ts to keep that module under
// the per-file line cap. Import from package-install-parser.ts (or the
// ecosystems barrel), not directly from here.
//
// Imports ONLY from package-install-parser-shared.ts — the dependency graph
// stays acyclic: shared ← pypi ← ecosystems ← package-install-parser (main).

import { nonNull } from "../lib/non-null.js";
import type {
	InstallAction,
	InstallCommand,
	PackageSpec,
} from "./package-install-parser-shared.js";
import { envRegistryFor } from "./package-install-parser-shared.js";

// ===========================================================
// pip / pip3 / pipx
// ===========================================================
interface PipFlagScan {
	positionals: string[];
	customRegistry: string | undefined;
	manifestFile: string | undefined;
	fromConstraints: boolean;
}

// `-e` / `--editable` is intentionally NOT a value-consuming flag — its value IS
// the spec, and dropping that value would let `pip install -e git+URL` slip past
// the guard. We capture the next token as a positional spec in scanPipFlags.
const PIP_FLAG_TAKES_VALUE = new Set([
	"--target",
	"-t",
	"--prefix",
	"--root",
	"--src",
	"--build",
	"--cache-dir",
	"--log",
	"--proxy",
	"--retries",
	"--timeout",
	"--exists-action",
	"--trusted-host",
	"--client-cert",
	"--cert",
	"--python",
	"--find-links",
	"-f",
	"--platform",
	"--python-version",
	"--implementation",
	"--abi",
]);

// Walk pip's post-`install` args, separating positional package specs from flags.
// Captures a custom index URL, a -r/--requirement manifest file, and whether a
// -c/--constraint was present. Editable (-e/--editable) targets are positionals.
// The per-token matching lives in `consumePipToken` — a top-level function
// (not a closure over the loop) so its if-chain scores at nesting 0 instead of
// nesting 1; this loop is deliberately just the iteration, with no branching.
function scanPipFlags(args: string[]): PipFlagScan {
	const scan: PipFlagScan = {
		positionals: [],
		customRegistry: undefined,
		manifestFile: undefined,
		fromConstraints: false,
	};

	for (let i = 0; i < args.length; i++) {
		i += consumePipToken(args, i, scan);
	}

	return scan;
}

// Classify ONE pip argument token at `args[i]`, mutating `scan` for its
// effect. Returns the count of ADDITIONAL tokens consumed beyond `args[i]`
// itself (0 or 1) — same semantics as the original inline `i++`ing loop body,
// relocated here so the caller's `for` stays a single unbranched statement.
type PipTokenHandler = (
	args: string[],
	i: number,
	scan: PipFlagScan,
) => number | undefined;

// Each handler below returns `undefined` when the token at `args[i]` isn't its
// kind of flag, letting `consumePipToken` try the next handler in sequence.
// Order matches the original inline if-chain exactly (index-url, requirement,
// constraint, editable, glued short-option), so behavior is unchanged.

function consumePipIndexUrlToken(
	args: string[],
	i: number,
	scan: PipFlagScan,
): number | undefined {
	const a = nonNull(args[i]);
	if (a === "--index-url" || a === "-i" || a === "--extra-index-url") {
		scan.customRegistry = args[i + 1];
		return 1;
	}
	const m = a.match(/^(?:--index-url|--extra-index-url|-i)=(.+)$/);
	if (m) {
		scan.customRegistry = m[1];
		return 0;
	}
	return undefined;
}

function consumePipRequirementToken(
	args: string[],
	i: number,
	scan: PipFlagScan,
): number | undefined {
	const a = nonNull(args[i]);
	if (a === "-r" || a === "--requirement") {
		scan.manifestFile = args[i + 1];
		return 1;
	}
	const mr = a.match(/^--requirement=(.+)$/);
	if (mr) {
		scan.manifestFile = mr[1];
		return 0;
	}
	return undefined;
}

function consumePipConstraintToken(
	args: string[],
	i: number,
	scan: PipFlagScan,
): number | undefined {
	const a = nonNull(args[i]);
	if (a === "-c" || a === "--constraint") {
		scan.fromConstraints = true;
		return 1;
	}
	return undefined;
}

function consumePipEditableToken(
	args: string[],
	i: number,
	scan: PipFlagScan,
): number | undefined {
	const a = nonNull(args[i]);
	if (scanPipEditable(a, args[i + 1], scan.positionals)) {
		return 1;
	}
	const meq = a.match(/^--editable=(.+)$/);
	if (meq) {
		scan.positionals.push(nonNull(meq[1]));
		return 0;
	}
	return undefined;
}

// ATTACHED short-option values — optparse-style pip accepts the value glued
// to the flag: `-rreqs.txt`, `-ihttps://mirror`, `-cconstraints.txt`,
// `-egit+URL`. Without this branch each parsed as an unknown flag and was
// silently skipped, so `pip install -rhttps://evil/r.txt` looked like a
// bare manifest sync and the manifest/registry/editable signals were lost —
// the same attached-value class as the git `-mfix` finding (2026-06).
function consumePipGluedToken(
	args: string[],
	i: number,
	scan: PipFlagScan,
): number | undefined {
	const a = nonNull(args[i]);
	const glued = a.match(/^-([rice])(.+)$/);
	if (!glued) return undefined;
	const value = glued[2] ?? "";
	if (glued[1] === "r") scan.manifestFile = value;
	else if (glued[1] === "i") scan.customRegistry = value;
	else if (glued[1] === "c") scan.fromConstraints = true;
	else scan.positionals.push(value); // -e<spec>: the value IS the install spec
	return 0;
}

const PIP_TOKEN_HANDLERS: PipTokenHandler[] = [
	consumePipIndexUrlToken,
	consumePipRequirementToken,
	consumePipConstraintToken,
	consumePipEditableToken,
	consumePipGluedToken,
];

function consumePipToken(args: string[], i: number, scan: PipFlagScan): number {
	const a = nonNull(args[i]);
	for (const handler of PIP_TOKEN_HANDLERS) {
		const consumed = handler(args, i, scan);
		if (consumed !== undefined) return consumed;
	}
	if (a.startsWith("-")) {
		return pipFlagConsumesValue(a, args[i + 1]) ? 1 : 0;
	}
	scan.positionals.push(a);
	return 0;
}

// True when a generic pip flag `a` takes a separate value token (and that token,
// `next`, is present and isn't itself a flag) — so the scanner should skip it.
function pipFlagConsumesValue(a: string, next: string | undefined): boolean {
	return PIP_FLAG_TAKES_VALUE.has(a) && /^[^-]/.test(next || "");
}

// Handle `-e <spec>` / `--editable <spec>`: push the following token as a
// positional when it's a real spec (not another flag / missing). Returns true
// when `a` was the editable flag (so the caller advances past the consumed spec),
// regardless of whether a spec followed.
function scanPipEditable(
	a: string,
	next: string | undefined,
	positionals: string[],
): boolean {
	if (a !== "-e" && a !== "--editable") return false;
	if (next && !next.startsWith("-")) {
		positionals.push(next);
		return true;
	}
	return false;
}

export function parsePip(
	bin: string,
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const isPipxSubcommand =
		bin === "pipx" && (sub === "install" || sub === "inject" || sub === "run");
	if (sub !== "install" && !isPipxSubcommand) return null;
	const args = tokens.slice(2);

	const scan = scanPipFlags(args);
	// `pipx inject <venv> <pkgs…>`: the FIRST positional names the EXISTING pipx
	// environment being injected into, not a package being installed — classifying
	// it as a spec made `pipx inject black requests==2.31.0` treat `black` as an
	// unpinned package and block under exact-version enforcement (finding
	// 2026-06). Only the remaining positionals are the real injected specs.
	const positionals =
		bin === "pipx" && sub === "inject" ? scan.positionals.slice(1) : scan.positionals;
	const manifestFile = scan.manifestFile;
	const customRegistry = scan.customRegistry ?? envRegistryFor("pypi", envVars);

	const packages: PackageSpec[] = positionals.map(classifyPipSpec);
	const noPositionals = positionals.length === 0;
	let action: InstallAction = noPositionals ? "sync" : "add";
	const fromManifest = !!manifestFile || (noPositionals && !scan.fromConstraints);
	if (bin === "pipx") action = "install_global";

	return {
		ecosystem: "pypi",
		manager: bin,
		action,
		packages,
		fromLockfile: false,
		fromManifest,
		manifestFile,
		customRegistry,
		notes: [],
	};
}

export function classifyPipSpec(spec: string): PackageSpec {
	if (/^https?:\/\/.+\.(tar\.gz|whl|zip|tgz)(?:[?#].*)?$/i.test(spec))
		return { kind: "tarball_url", url: spec };
	if (/^git\+/.test(spec)) return { kind: "git_url", url: spec };
	if (spec.startsWith("file://")) return { kind: "file_url", path: spec.slice(7) };
	if (
		spec.startsWith("./") ||
		spec.startsWith("../") ||
		spec.startsWith("/") ||
		spec === "."
	)
		return { kind: "local_path", path: spec };
	const nameMatch = spec.match(/^([A-Za-z0-9._-]+)/);
	const name = nameMatch ? nonNull(nameMatch[1]) : spec;
	// RETAIN the comparison operator (finding 2026-06): storing only the numeric
	// portion let `requests~=2.31.0` / `>=2.31.0` / `!=2.31.0` reach the pin check
	// as a bare `2.31.0` and pass as an exact pin, bypassing the supply-chain
	// exact-pin guarantee for PEP 508 range syntax. With the operator kept,
	// `pinnedVersionViolation` blocks `~=`/`>=`/`<=`/`>`/`<` (RANGE_OPERATOR_RE) and
	// `!=` (fails EXACT_FULL_VERSION_RE), while `==`/`===` remain exact pins.
	const versionMatch = spec.match(/(===|==|>=|<=|~=|!=|>|<)\s*([A-Za-z0-9._+-]+)/);
	return {
		kind: "registry",
		name,
		version: versionMatch ? `${versionMatch[1]}${versionMatch[2]}` : undefined,
	};
}

// ===========================================================
// poetry
// ===========================================================
export function parsePoetry(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub === "add") {
		const positionals: string[] = [];
		let customRegistry: string | undefined;
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (a === "--source") {
				customRegistry = args[i + 1];
				i++;
				continue;
			}
			if (nonNull(a).startsWith("-")) continue;
			positionals.push(nonNull(a));
		}
		if (!customRegistry) customRegistry = envRegistryFor("pypi", envVars);
		return {
			ecosystem: "pypi",
			manager: "poetry",
			action: "add",
			packages: positionals.map(classifyPipSpec),
			fromLockfile: false,
			fromManifest: false,
			customRegistry,
			notes: [],
		};
	}
	if (sub === "install") {
		let fromLockfile = false;
		for (const a of args) {
			if (a === "--no-update" || a === "--locked") fromLockfile = true;
		}
		return {
			ecosystem: "pypi",
			manager: "poetry",
			action: "sync",
			packages: [],
			fromLockfile,
			fromManifest: true,
			manifestFile: "pyproject.toml",
			customRegistry: envRegistryFor("pypi", envVars),
			notes: [],
		};
	}
	if (sub === "remove") {
		return {
			ecosystem: "pypi",
			manager: "poetry",
			action: "remove",
			packages: [],
			fromLockfile: false,
			fromManifest: false,
			notes: [],
		};
	}
	return null;
}

// ===========================================================
// uv
// ===========================================================
export function parseUv(
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	const sub = tokens[1] || "";
	const args = tokens.slice(2);
	if (sub === "add") {
		const positionals = args.filter((a) => !a.startsWith("-"));
		return {
			ecosystem: "pypi",
			manager: "uv",
			action: "add",
			packages: positionals.map(classifyPipSpec),
			fromLockfile: false,
			fromManifest: false,
			customRegistry: envRegistryFor("pypi", envVars),
			notes: [],
		};
	}
	if (sub === "sync") {
		const fromLockfile = args.includes("--frozen") || args.includes("--locked");
		return {
			ecosystem: "pypi",
			manager: "uv",
			action: "sync",
			packages: [],
			fromLockfile,
			fromManifest: true,
			manifestFile: "pyproject.toml",
			customRegistry: envRegistryFor("pypi", envVars),
			notes: [],
		};
	}
	if (sub === "pip") {
		const inner = args[0] || "";
		if (inner === "install") {
			const sub2 = parsePip("pip", ["pip", ...args], envVars);
			if (sub2 && !sub2.customRegistry)
				sub2.customRegistry = envRegistryFor("pypi", envVars);
			return sub2;
		}
		return null;
	}
	if (sub === "tool") {
		const inner = args[0] || "";
		if (inner === "install") {
			const positionals = args.slice(1).filter((a) => !a.startsWith("-"));
			return {
				ecosystem: "pypi",
				manager: "uv",
				action: "install_global",
				packages: positionals.map(classifyPipSpec),
				fromLockfile: false,
				fromManifest: false,
				customRegistry: envRegistryFor("pypi", envVars),
				notes: [],
			};
		}
	}
	return null;
}
