// Allowlist for package-install commands.
//
// File: .interlinked/package-allowlist.json (committed, reviewed in PRs).
// The harness blocks every install whose package is not on the allowlist;
// human-only sign-off via `interlinked allowlist add` or an in-repo PR.
//
// Two grant kinds:
//   1. Per-package — explicit per-name approval, ecosystem-keyed.
//   2. Lockfile snapshot — sha256 of a lockfile, approving its entire
//      resolved package set as a unit. Re-snapshot whenever the lockfile
//      changes.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { DEFAULT_LICENSE_ALLOWLIST } from "./license-policy.js";
import type { Ecosystem, PackageSpec } from "./package-install-parser.js";

export interface AllowlistEntry {
	approved_at: string;
	approved_by: string;
	reason?: string | undefined;
	version_range?: string | undefined;
	/** SPDX license expression recorded at admission time (registry-declared).
	 *  Per-edit license enforcement reads ONLY this field — never the network. */
	license?: string | undefined;
}

interface LockfileSnapshot {
	sha256: string;
	approved_at: string;
	approved_by: string;
	reason?: string | undefined;
}

export interface Allowlist {
	version: 1;
	packages: Record<Ecosystem, Record<string, AllowlistEntry>>;
	lockfile_snapshots: Record<string, LockfileSnapshot>;
	/** Committed SPDX license allowlist. Absent → DEFAULT_LICENSE_ALLOWLIST
	 *  (use effectiveLicenseAllowlist(), don't read this field directly). */
	license_allowlist?: string[] | undefined;
}

interface AllowDecision {
	allowed: boolean;
	reason?: string;
}

const FILE_NAME = "package-allowlist.json";

export function allowlistPath(cwd: string): string {
	return join(cwd, ".interlinked", FILE_NAME);
}

function emptyAllowlist(): Allowlist {
	return {
		version: 1,
		packages: {
			npm: {},
			pypi: {},
			cargo: {},
			rubygems: {},
			go: {},
			composer: {},
			maven: {},
			gradle: {},
			nuget: {},
		},
		lockfile_snapshots: {},
	};
}

/**
 * Validate one package's allowlist grant. `approved_at`/`approved_by` are
 * required (matching `AllowlistEntry`); a raw entry missing either is
 * dropped rather than let a non-string `version_range`/`license` reach
 * `isPackageAllowed`/`isLicenseAllowed`, which call string methods on them
 * with no further runtime check.
 */
function parseAllowlistEntry(value: unknown): AllowlistEntry | null {
	if (!isJsonObject(value)) return null;
	const { approved_at, approved_by, reason, version_range, license } = value;
	if (typeof approved_at !== "string" || typeof approved_by !== "string") return null;
	const entry: AllowlistEntry = { approved_at, approved_by };
	if (typeof reason === "string") entry.reason = reason;
	if (typeof version_range === "string") entry.version_range = version_range;
	if (typeof license === "string") entry.license = license;
	return entry;
}

/** Validate one lockfile-snapshot grant (`sha256`/`approved_at`/`approved_by` required). */
function parseLockfileSnapshot(value: unknown): LockfileSnapshot | null {
	if (!isJsonObject(value)) return null;
	const { sha256, approved_at, approved_by, reason } = value;
	if (
		typeof sha256 !== "string" ||
		typeof approved_at !== "string" ||
		typeof approved_by !== "string"
	) {
		return null;
	}
	const snap: LockfileSnapshot = { sha256, approved_at, approved_by };
	if (typeof reason === "string") snap.reason = reason;
	return snap;
}

/**
 * Parse `parsed.packages` (already known to be a JSON object) into
 * `base.packages`, mutating `base` in place. Extracted from
 * `loadAllowlist` to keep that function's nesting shallow.
 */
function applyParsedPackages(base: Allowlist, packagesValue: Record<string, unknown>): void {
	for (const eco of [
		"npm",
		"pypi",
		"cargo",
		"rubygems",
		"go",
		"composer",
		"maven",
		"gradle",
		"nuget",
	] as Ecosystem[]) {
		const ecoEntry = packagesValue[eco];
		if (!isJsonObject(ecoEntry)) continue;
		const entries: Record<string, AllowlistEntry> = {};
		for (const [name, rawEntry] of Object.entries(ecoEntry)) {
			const entry = parseAllowlistEntry(rawEntry);
			if (entry) entries[name] = entry;
		}
		base.packages[eco] = entries;
	}
}

export function loadAllowlist(cwd: string): Allowlist {
	const p = allowlistPath(cwd);
	if (!existsSync(p)) return emptyAllowlist();
	try {
		const raw = readFileSync(p, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		const base = emptyAllowlist();
		if (!isJsonObject(parsed)) return base;
		if (isJsonObject(parsed.packages)) {
			applyParsedPackages(base, parsed.packages);
		}
		if (isJsonObject(parsed.lockfile_snapshots)) {
			const snapshots: Record<string, LockfileSnapshot> = {};
			for (const [name, rawSnap] of Object.entries(parsed.lockfile_snapshots)) {
				const snap = parseLockfileSnapshot(rawSnap);
				if (snap) snapshots[name] = snap;
			}
			base.lockfile_snapshots = snapshots;
		}
		if (
			Array.isArray(parsed.license_allowlist) &&
			parsed.license_allowlist.every((id): id is string => typeof id === "string")
		) {
			base.license_allowlist = parsed.license_allowlist;
		}
		return base;
	} catch {
		// Malformed file: fail safe — empty allowlist. The verify command will
		// surface the parse error separately; we never block on JSON syntax
		// because that would leave the user unable to bootstrap.
		return emptyAllowlist();
	}
}

export function saveAllowlist(cwd: string, al: Allowlist): void {
	const p = allowlistPath(cwd);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(al, null, 2)}\n`, "utf-8");
}

export function addToAllowlist(
	cwd: string,
	ecosystem: Ecosystem,
	name: string,
	meta: Partial<Omit<AllowlistEntry, "approved_at">> & { approved_by: string },
): void {
	const al = loadAllowlist(cwd);
	al.packages[ecosystem][name] = {
		approved_at: new Date().toISOString(),
		approved_by: meta.approved_by,
		reason: meta.reason,
		version_range: meta.version_range,
		license: meta.license,
	};
	saveAllowlist(cwd, al);
}

/** The project's SPDX license allowlist: the committed `license_allowlist`
 *  field when present, otherwise the built-in permissive default seed. */
export function effectiveLicenseAllowlist(al: Allowlist): readonly string[] {
	return al.license_allowlist ?? DEFAULT_LICENSE_ALLOWLIST;
}

export function isPackageAllowed(
	al: Allowlist,
	ecosystem: Ecosystem,
	spec: PackageSpec,
): AllowDecision {
	if (spec.kind === "git_url") {
		return {
			allowed: false,
			reason: `git URL installs are never auto-allowed (${spec.url}). Vet the source, vendor it locally, or publish to the registry.`,
		};
	}
	if (spec.kind === "tarball_url") {
		return {
			allowed: false,
			reason: `tarball URL installs are never auto-allowed (${spec.url}). Tarballs bypass registry signing and audit.`,
		};
	}
	if (spec.kind === "file_url") {
		return {
			allowed: false,
			reason: `file: installs are never auto-allowed (${spec.path}). If the package is in-repo, depend on it by relative path; otherwise vendor it.`,
		};
	}
	if (spec.kind === "local_path") {
		// Local paths point into the workspace itself — same code that's
		// already version-controlled. Not a supply-chain vector.
		return { allowed: true };
	}
	// registry
	const entry = al.packages[ecosystem][spec.name];
	if (!entry) {
		return {
			allowed: false,
			reason: `'${spec.name}' is not in the ${ecosystem} allowlist. Run \`interlinked allowlist add ${ecosystem} ${spec.name}\` after reviewing the package.`,
		};
	}
	if (entry.version_range) {
		const verdict = matchesVersionRange(spec.version, entry.version_range);
		if (!verdict.ok) {
			return {
				allowed: false,
				reason: `'${spec.name}' requested at ${spec.version ?? "<unspecified>"}, but the allowlist pins it to ${entry.version_range}. ${verdict.detail}`,
			};
		}
	}
	return { allowed: true };
}

/**
 * Version-range matcher used by isPackageAllowed when the allowlist entry
 * pins a range. v1 supports exact-string match and common semver-range
 * prefixes (`^x.y.z`, `~x.y.z`, comparator chains). Falls back to exact
 * match when the range syntax isn't recognized so an unparseable entry
 * fails closed (any mismatch → block) rather than silently allowing.
 */
function matchesVersionRange(
	specVersion: string | undefined,
	range: string,
): { ok: boolean; detail: string } {
	if (!specVersion) {
		return { ok: false, detail: "spec carries no version" };
	}
	const trimmed = specVersion.trim();
	const cleanRange = range.trim();
	if (trimmed === cleanRange) return { ok: true, detail: "" };
	// Strip a leading ^/~/v from both sides for forgiving comparison.
	const stripPrefix = (s: string): string => s.replace(/^[~^v=]+/, "");
	if (stripPrefix(trimmed) === stripPrefix(cleanRange)) return { ok: true, detail: "" };
	// Caret range: ^x.y.z allows >=x.y.z, <(x+1).0.0. Conservative interp:
	// match on same major version.
	if (cleanRange.startsWith("^")) {
		const r = stripPrefix(cleanRange);
		const rMajor = r.split(".")[0];
		const sMajor = stripPrefix(trimmed).split(".")[0];
		if (rMajor === sMajor && rMajor !== "") return { ok: true, detail: "" };
	}
	// Tilde range: ~x.y.z allows >=x.y.z, <x.(y+1).0. Match on major.minor.
	if (cleanRange.startsWith("~")) {
		const r = stripPrefix(cleanRange);
		const rParts = r.split(".");
		const sParts = stripPrefix(trimmed).split(".");
		if (rParts[0] === sParts[0] && rParts[1] === sParts[1]) return { ok: true, detail: "" };
	}
	return {
		ok: false,
		detail: "Update the allowlist entry's version_range if the new version is intentional.",
	};
}

export function hashLockfile(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		const content = readFileSync(path);
		return createHash("sha256").update(content).digest("hex");
	} catch {
		return null;
	}
}

export function matchSnapshot(al: Allowlist, lockfileName: string, lockfilePath: string): boolean {
	const snap = al.lockfile_snapshots[lockfileName];
	if (!snap) return false;
	const actual = hashLockfile(lockfilePath);
	if (!actual) return false;
	return actual === snap.sha256;
}
