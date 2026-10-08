// ===========================================
// Lockfile package inventory (npm ecosystem)
// ===========================================
// The resolved package set a JS lockfile carries, with the evidence that a
// package is NATIVE (install script, platform-constrained, `.node` binary,
// `binding.gyp`). Consumed by the PostToolUse `lockfile_transitive_deps`
// check (evaluator/lockfile-install-check.ts) and by `interlinked allowlist
// verify`: the PreToolUse install gate screens only the specs named on the
// command line, so a transitive native dependency — `koffi@3.3.2` pulling
// `@koromix/koffi-darwin-arm64` — never met the allowlist (Hegel trial
// 2026-10-03). The lockfile is the first artifact that names the closure.
//
// Parsers are deliberately shallow and fail to `null` on an unrecognized
// shape: a wrong inventory would either hide a package or invent one, and
// both surfaces that consume this module prefer "not measured" to either.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";

/** Lockfiles in the order the install dir is probed. */
export const JS_LOCKFILE_NAMES: readonly string[] = [
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
];

export interface LockfilePackage {
	name: string;
	version: string | null;
	/** Human-readable native evidence; empty for a plain JS package. */
	native: string[];
}

export type LockfileInventory = Map<string, LockfilePackage>;

export interface LockfileSnapshot {
	/** Lockfile basename, or null when the directory carries none. */
	file: string | null;
	packages: LockfileInventory;
}

/** Platform-package naming convention (`@scope/name-<os>-<cpu>[-<abi>]`). */
const PLATFORM_SUFFIX_RE =
	/-(?:darwin|linux|win32|freebsd|openbsd|android|sunos|aix)-(?:arm64|x64|ia32|arm|s390x|ppc64|riscv64|loong64)(?:-(?:musl|gnu|msvc)[a-z0-9]*)?$/i;

function pushOnce(list: string[], item: string): void {
	if (!list.includes(item)) list.push(item);
}

function addPackage(
	inventory: LockfileInventory,
	name: string,
	version: string | null,
	native: string[],
): void {
	if (!name) return;
	if (PLATFORM_SUFFIX_RE.test(name) && !native.some((n) => n.startsWith("platform"))) {
		native.push("platform package (name)");
	}
	const prior = inventory.get(name);
	if (prior) {
		for (const n of native) pushOnce(prior.native, n);
		return;
	}
	inventory.set(name, { name, version, native });
}

function versionOf(entry: Record<string, unknown>): string | null {
	return typeof entry.version === "string" ? entry.version : null;
}

function platformEvidence(entry: Record<string, unknown>): string[] {
	const out: string[] = [];
	if (Array.isArray(entry.os) || Array.isArray(entry.cpu)) {
		const os = Array.isArray(entry.os) ? entry.os.join("/") : "any";
		const cpu = Array.isArray(entry.cpu) ? entry.cpu.join("/") : "any";
		out.push(`platform package (os ${os}, cpu ${cpu})`);
	}
	if (entry.optional === true) out.push("optionalDependency");
	return out;
}

// ── package-lock.json / npm-shrinkwrap.json ────────────────────────────────

/** v2/v3 `packages` map keyed `node_modules/<name>` (nested paths included);
 *  v1 `dependencies` tree. `hasInstallScript` is npm's own native marker. */
function parsePackageLock(content: string): LockfileInventory | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	if (!isJsonObject(parsed)) return null;
	const inventory: LockfileInventory = new Map();
	if (isJsonObject(parsed.packages)) {
		addV3Packages(parsed.packages, inventory);
		return inventory;
	}
	if (isJsonObject(parsed.dependencies)) {
		walkV1Dependencies(parsed.dependencies, inventory);
		return inventory;
	}
	return null;
}

function addV3Packages(packages: Record<string, unknown>, inventory: LockfileInventory): void {
	for (const [key, entry] of Object.entries(packages)) {
		if (key === "" || !isJsonObject(entry)) continue;
		const at = key.lastIndexOf("node_modules/");
		if (at === -1) continue; // workspace link, not a registry package
		const native = platformEvidence(entry);
		if (entry.hasInstallScript === true) native.unshift("install script");
		addPackage(inventory, key.slice(at + "node_modules/".length), versionOf(entry), native);
	}
}

function walkV1Dependencies(deps: Record<string, unknown>, inventory: LockfileInventory): void {
	for (const [name, entry] of Object.entries(deps)) {
		if (!isJsonObject(entry)) continue;
		addPackage(inventory, name, versionOf(entry), platformEvidence(entry));
		if (isJsonObject(entry.dependencies)) walkV1Dependencies(entry.dependencies, inventory);
	}
}

// ── pnpm-lock.yaml ─────────────────────────────────────────────────────────

type PnpmSection = "packages" | "snapshots" | null;

/** `packages:` keys are `/name@version` (v6) or `name@version` (v9), quoted
 *  or bare; per-package fields sit two indents deeper. `requiresBuild` is
 *  pnpm's native marker. The `snapshots:` section (v9) repeats the keys with
 *  `optional: true`, so it is folded into the same entry. */
function parsePnpmLock(content: string): LockfileInventory | null {
	if (!/^packages:\s*$/m.test(content)) return null;
	const inventory: LockfileInventory = new Map();
	let section: PnpmSection = null;
	let current: LockfilePackage | null = null;
	for (const line of content.split(/\r?\n/)) {
		if (/^\S/.test(line)) {
			section = pnpmSectionOf(line);
			current = null;
			continue;
		}
		if (section === null) continue;
		const keyed = pnpmPackageKey(line);
		if (keyed) {
			addPackage(inventory, keyed.name, keyed.version, []);
			current = inventory.get(keyed.name) ?? null;
		} else if (current) {
			applyPnpmField(current, line);
		}
	}
	return inventory;
}

function pnpmSectionOf(line: string): PnpmSection {
	if (/^packages:/.test(line)) return "packages";
	if (/^snapshots:/.test(line)) return "snapshots";
	return null;
}

/** A two-space-indented `name@version…:` key, or null. */
function pnpmPackageKey(line: string): { name: string; version: string | null } | null {
	const key = line.match(/^  ['"]?\/?((?:@[^/'"@\s]+\/)?[^/'"@\s]+)@([^'"\s(:]+)[^:]*:\s*$/);
	if (!key) return null;
	return { name: key[1] ?? "", version: key[2] ?? null };
}

/** A four-space-indented field under the current key. */
function applyPnpmField(current: LockfilePackage, line: string): void {
	const field = line.match(/^    (requiresBuild|os|cpu|optional):\s*(.*)$/);
	if (!field) return;
	const [, fieldName, raw] = field;
	const isTrue = raw?.trim() === "true";
	if (fieldName === "requiresBuild" && isTrue) pushOnce(current.native, "install script");
	if (fieldName === "optional" && isTrue) pushOnce(current.native, "optionalDependency");
	if (fieldName === "os" || fieldName === "cpu") {
		pushOnce(current.native, `platform package (${fieldName} constraint)`);
	}
}

// ── yarn.lock (v1 and berry) ───────────────────────────────────────────────

/** Entry headers are unindented and end with `:`; each comma-separated
 *  descriptor is `name@range` (quoted in v1, `name@npm:range` in berry). The
 *  name is everything before the LAST `@` that is not the scope marker. */
function parseYarnLock(content: string): LockfileInventory | null {
	if (!/^# yarn lockfile v1|^__metadata:/m.test(content)) return null;
	const inventory: LockfileInventory = new Map();
	let pending: string[] = [];
	for (const line of content.split(/\r?\n/)) {
		// Unindented `descriptor[, descriptor…]:` — the whole header may be quoted
		// (v1) and a berry descriptor carries its own `npm:` colon, so the match
		// is anchored on the closing quote, not the first colon.
		const header = line.match(/^(["']?)([^\s#].*?)\1:\s*$/);
		if (header) {
			pending = yarnHeaderNames(header[2] ?? "");
			continue;
		}
		const version = line.match(/^  version:?\s+["']?([^"'\s]+)["']?\s*$/);
		if (version && pending.length > 0) {
			for (const name of pending) addPackage(inventory, name, version[1] ?? null, []);
			pending = [];
		}
	}
	return inventory;
}

function yarnHeaderNames(header: string): string[] {
	return header
		.split(",")
		.map((d) => d.trim().replace(/^["']|["']$/g, ""))
		.map(descriptorName)
		.filter((n) => n !== "" && n !== "__metadata");
}

function descriptorName(descriptor: string): string {
	const at = descriptor.lastIndexOf("@");
	return at <= 0 ? descriptor : descriptor.slice(0, at);
}

// ── bun.lock ───────────────────────────────────────────────────────────────

/** JSONC: `packages` maps name → `["name@version", …, {os?, cpu?, …}, sha]`. */
function parseBunLock(content: string): LockfileInventory | null {
	let parsed: unknown;
	try {
		const jsonish = content.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
		parsed = JSON.parse(jsonish);
	} catch {
		return null;
	}
	if (!isJsonObject(parsed) || !isJsonObject(parsed.packages)) return null;
	const inventory: LockfileInventory = new Map();
	for (const [name, tuple] of Object.entries(parsed.packages)) {
		if (!Array.isArray(tuple)) continue;
		const spec = typeof tuple[0] === "string" ? tuple[0] : "";
		const version = spec.startsWith(`${name}@`) ? spec.slice(name.length + 1) : null;
		addPackage(inventory, name, version, bunPlatformEvidence(tuple));
	}
	return inventory;
}

function bunPlatformEvidence(tuple: unknown[]): string[] {
	const meta = tuple.find((part) => isJsonObject(part) && ("os" in part || "cpu" in part));
	if (!isJsonObject(meta)) return [];
	return [`platform package (os ${String(meta.os ?? "any")}, cpu ${String(meta.cpu ?? "any")})`];
}

// ── public surface ─────────────────────────────────────────────────────────

/** Parse one lockfile by basename. `null` = unrecognized name or shape. */
export function parseLockfilePackages(fileName: string, content: string): LockfileInventory | null {
	switch (fileName) {
		case "package-lock.json":
		case "npm-shrinkwrap.json":
			return parsePackageLock(content);
		case "pnpm-lock.yaml":
			return parsePnpmLock(content);
		case "yarn.lock":
			return parseYarnLock(content);
		case "bun.lock":
			return parseBunLock(content);
		default:
			return null;
	}
}

/** The first JS lockfile present in `dir`, parsed. `file: null` when none
 *  exists (a fresh install creates one — diffed against the empty set);
 *  `null` when one exists but could not be parsed. */
export function readLockfileSnapshot(dir: string): LockfileSnapshot | null {
	for (const file of JS_LOCKFILE_NAMES) {
		const path = join(dir, file);
		if (!existsSync(path)) continue;
		let content: string;
		try {
			content = readFileSync(path, "utf-8");
		} catch {
			return null;
		}
		const packages = parseLockfilePackages(file, content);
		return packages ? { file, packages } : null;
	}
	return { file: null, packages: new Map() };
}

/** Packages present in `after` and absent (by name) from `before`. */
export function newLockfilePackages(
	before: LockfileInventory,
	after: LockfileInventory,
): LockfilePackage[] {
	const added: LockfilePackage[] = [];
	for (const [name, pkg] of after) if (!before.has(name)) added.push(pkg);
	return added;
}

/** Install-phase scripts declared by an installed package's manifest. */
function installScriptEvidence(pkgDir: string): string | null {
	try {
		const manifest: unknown = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
		const scripts = isJsonObject(manifest) ? manifest.scripts : undefined;
		if (!isJsonObject(scripts)) return null;
		const phases = ["preinstall", "install", "postinstall"].filter((p) => typeof scripts[p] === "string");
		return phases.length > 0 ? `install script (${phases.join(", ")})` : null;
	} catch {
		return null; // no manifest or unreadable — the other evidence still counts
	}
}

function hasNodeBinary(pkgDir: string): boolean {
	for (const sub of ["", join("build", "Release")]) {
		try {
			if (readdirSync(join(pkgDir, sub)).some((f) => f.endsWith(".node"))) return true;
		} catch {
			/* directory absent */
		}
	}
	return false;
}

/** On-disk native evidence for an INSTALLED package: `binding.gyp`, an
 *  install-phase script, or a `.node` binary at the top level or under
 *  `build/Release`. Two directory reads at most; absent package ⇒ nothing. */
export function nativeEvidenceOnDisk(dir: string, name: string): string[] {
	const pkgDir = join(dir, "node_modules", name);
	if (!existsSync(pkgDir)) return [];
	const evidence: string[] = [];
	if (existsSync(join(pkgDir, "binding.gyp"))) evidence.push("binding.gyp");
	const script = installScriptEvidence(pkgDir);
	if (script) evidence.push(script);
	if (hasNodeBinary(pkgDir)) evidence.push(".node binary");
	return evidence;
}

/** One `name@version (evidence, …)` token for a warning or report line. */
export function describeLockfilePackage(pkg: LockfilePackage, extraEvidence: string[] = []): string {
	const evidence = [...pkg.native];
	for (const e of extraEvidence) pushOnce(evidence, e);
	const spec = pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
	return evidence.length > 0 ? `${spec} [NATIVE: ${evidence.join("; ")}]` : spec;
}
