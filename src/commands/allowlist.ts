// ===========================================
// interlinked allowlist — manage the supply-chain allowlist
// ===========================================
// Subcommands:
//   add <ecosystem> <package>      — approve a single package
//   remove <ecosystem> <package>   — un-approve
//   list                           — show all approved entries
//   snapshot                       — hash manifest + lockfile state, store
//   verify                         — diff manifest deps vs allowlist
//
// The allowlist lives at `.interlinked/package-allowlist.json` (committed).
// Edit only via this CLI or via PR; agents are blocked from running these
// add/remove operations because they target an `interlinked` subcommand
// path that flips the file's authority bit.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { findTyposquatMatch } from "../harness/checks/supply-chain.js";
import { isLicenseAllowed } from "../harness/license-policy.js";
import { findManifestFiles } from "../harness/manifest-file-walk.js";
import {
	type Allowlist,
	addToAllowlist,
	effectiveLicenseAllowlist,
	hashLockfile,
	loadAllowlist,
	saveAllowlist,
} from "../harness/package-allowlist.js";
import type { Ecosystem } from "../harness/package-install-parser.js";
// The version the supply-chain screens inspect for a `--version-range` approval
// — the range's in-range resolution FLOOR — comes from this reusable, directly
// unit-tested helper. The old inline regex grabbed the FIRST version literal,
// which is the EXCLUDED upper bound for an upper-bounded range (`<2.0.0` →
// `2.0.0`), so a clean screen there vouched for in-range versions it never
// inspected (finding 2026-06, round 8).
import { resolveScreenVersion } from "../harness/package-version-range.js";
import {
	fetchNpmPublishDates,
	fetchRegistryMetadata,
	fetchVersionMetadata,
	queryOsvAdvisories,
	type RegistryPackageMetadata,
} from "../harness/registry-metadata.js";
// ECOSYSTEMS is parity-locked to the parser's `Ecosystem` union in its own
// module (the supply-chain guard blocks installs for all of them, so `add` /
// `snapshot` must be able to approve all of them — finding 2026-06).
import { ECOSYSTEMS } from "./allowlist-ecosystems.js";

// `interlinked allowlist verify` lives in ./allowlist-verify.ts — extracted to
// keep this file under the per-file line cap. That module also walks the
// variably-named *.csproj and the Gradle version catalog (libs.versions.toml),
// which the fixed-name extractor table can't reach.
export { type VerifyOpts, verifyAllowlistCommand } from "./allowlist-verify.js";

function isEcosystem(s: string): s is Ecosystem {
	return (ECOSYSTEMS as readonly string[]).includes(s);
}

interface AddOpts {
	cwd: string;
	by: string;
	reason?: string;
	versionRange?: string;
}

/** Shared state of one admission run: identifies the package and collects
 *  the loud notes each screen appends. */
interface ScreenContext {
	ecosystem: Ecosystem;
	pkg: string;
	cwd: string;
	force: boolean;
	notes: string[];
}

/**
 * License gate (screen 2): the declared SPDX expression of the version being
 * approved — the pinned resolution when `--version-range` was given, the
 * latest otherwise (finding 2026-06, round 6: screening only the latest let a
 * differently-licensed pinned release through). Throws unless --force; returns
 * the license to record on the allowlist entry.
 */
async function screenLicense(
	ctx: ScreenContext,
	meta: RegistryPackageMetadata,
	pinned: string | null,
): Promise<string | undefined> {
	let license = meta.license;
	if (pinned !== null) {
		const vMeta = await fetchVersionMetadata(ctx.ecosystem, ctx.pkg, pinned);
		if (vMeta?.license !== undefined) {
			license = vMeta.license;
		} else {
			// The LATEST release's license must neither screen NOR be recorded for a
			// PINNED approval: an older pinned release can be differently licensed
			// (MIT latest, GPL at the pin), and later hook checks trust ONLY the
			// recorded `license` field. Stamping the latest's license here would let
			// a transient version-lookup failure record a wrong license onto the
			// pinned entry (finding 2026-06, round 9). Drop to unknown — fall through
			// to the "unknown ⇒ not recorded, not screened" path below.
			license = undefined;
			ctx.notes.push(
				`license for pinned ${pinned} unavailable — recorded as unknown (the latest release's license is not used to vouch for a pinned approval)`,
			);
		}
	}
	const spdxAllowlist = effectiveLicenseAllowlist(loadAllowlist(ctx.cwd));
	if (license === undefined) {
		ctx.notes.push(
			"license: unknown — not recorded; review the package and set it in package-allowlist.json",
		);
	} else if (!isLicenseAllowed(license, spdxAllowlist)) {
		if (!ctx.force) {
			throw new Error(
				`refusing to approve "${ctx.pkg}" — license "${license}" is not in the SPDX license allowlist (${spdxAllowlist.join(", ")}). If acceptable, re-run with --force or extend license_allowlist in .interlinked/package-allowlist.json.`,
			);
		}
		ctx.notes.push(`license "${license}" outside the SPDX allowlist — approved via --force`);
	}
	return license;
}

/**
 * Advisory gate (screen 3): OSV vulns affecting the version being APPROVED —
 * the pinned resolution when `--version-range` was given, otherwise the
 * registry latest (what an unpinned install would fetch). A clean latest must
 * never vouch for a vulnerable pinned release (round 6).
 *
 * `meta` is NULLABLE on purpose (finding 2026-06, round 7): OSV needs only
 * ecosystem + name + version, so an EXACT version pin is screened even when
 * `fetchRegistryMetadata` returned null — which it ALWAYS does for Go (no
 * metadata API), where OSV nonetheless has full coverage. With no pin and no
 * metadata there is no version to screen, and the gate notes the skip.
 * Throws unless --force.
 */
/** Staleness (not malice) threshold: warn when the approved version's publish
 *  date trails the latest release by more than this many years. Warn-only —
 *  a stale-but-clean dependency is a maintenance risk, never a refusal. */
const LIBYEAR_WARN_YEARS = 2;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Years the approved version trails the newest release, from the npm `time`
 * map. Pure; exported for tests. "created"/"modified"/"unpublished" are
 * bookkeeping keys, not versions. Null when the approved version has no
 * recorded date (screen skipped).
 */
export function libyearsBehind(
	dates: Record<string, string>,
	approvedVersion: string,
): { years: number; latestVersion: string } | null {
	const approvedIso = dates[approvedVersion];
	if (approvedIso === undefined) return null;
	const approvedMs = Date.parse(approvedIso);
	if (!Number.isFinite(approvedMs)) return null;
	let latestVersion = approvedVersion;
	let latestMs = approvedMs;
	for (const [version, iso] of Object.entries(dates)) {
		if (version === "created" || version === "modified" || version === "unpublished") continue;
		const ms = Date.parse(iso);
		if (Number.isFinite(ms) && ms > latestMs) {
			latestMs = ms;
			latestVersion = version;
		}
	}
	return { years: (latestMs - approvedMs) / MS_PER_YEAR, latestVersion };
}

/**
 * Libyear gate (screen 4, warn-only, npm-only): how far behind the newest
 * release is the version being approved? Complements the advisory screen —
 * OSV says "known-bad", libyear says "unmaintained-by-us". Never refuses:
 * staleness is a maintenance signal, not a supply-chain verdict.
 */
async function screenLibyear(ctx: ScreenContext, pinned: string | null): Promise<void> {
	if (ctx.ecosystem !== "npm") return;
	if (pinned === null) return; // approving latest ⇒ zero years behind by definition
	const dates = await fetchNpmPublishDates(ctx.pkg);
	if (dates === null) {
		ctx.notes.push("npm publish-date fetch failed — libyear screen skipped");
		return;
	}
	const behind = libyearsBehind(dates, pinned);
	if (behind === null) {
		ctx.notes.push(`no publish date recorded for ${pinned} — libyear screen skipped`);
		return;
	}
	if (behind.years <= LIBYEAR_WARN_YEARS) return;
	ctx.notes.push(
		`libyear: pinned ${pinned} is ${behind.years.toFixed(1)} years behind latest ` +
			`${behind.latestVersion} (warn threshold ${LIBYEAR_WARN_YEARS}y) — stale pins ` +
			"miss upstream fixes; consider approving a newer release.",
	);
}

async function screenAdvisories(
	ctx: ScreenContext,
	meta: RegistryPackageMetadata | null,
	pinned: string | null,
	versionRange: string | undefined,
): Promise<void> {
	const screenVersion = pinned ?? meta?.latestVersion;
	const screenLabel = pinned !== null ? "pinned" : "latest";
	if (screenVersion === undefined) {
		ctx.notes.push("no version to screen (registry latest unknown) — advisory screen skipped");
		return;
	}
	if (pinned !== null) {
		ctx.notes.push(`screens inspected pinned ${pinned} (resolved from "${versionRange}")`);
	}
	const advisories = await queryOsvAdvisories(ctx.ecosystem, ctx.pkg, screenVersion);
	if (advisories === null) {
		ctx.notes.push("OSV query failed — advisory screen skipped");
		return;
	}
	if (advisories.length === 0) return;
	const ids = advisories
		.slice(0, 5)
		.map((a) => a.id)
		.join(", ");
	const plural = advisories.length === 1 ? "y" : "ies";
	if (!ctx.force) {
		throw new Error(
			`refusing to approve "${ctx.pkg}" — ${advisories.length} open advisor${plural} against ${screenLabel} ${screenVersion}: ${ids}. See https://osv.dev — if the risk is accepted, re-run with --force.`,
		);
	}
	ctx.notes.push(
		`${advisories.length} open advisor${plural} against ${screenLabel} ${screenVersion} (${ids}) — approved via --force`,
	);
}

export async function addAllowlistCommand(
	ecosystem: string,
	pkg: string,
	opts: AddOpts & { force?: boolean },
): Promise<void> {
	if (!isEcosystem(ecosystem)) {
		throw new Error(
			`Unknown ecosystem "${ecosystem}". Valid: ${ECOSYSTEMS.join(", ")}`,
		);
	}
	// Three admission screens, cheapest first. The most catastrophic failure
	// mode is APPROVING a bad package by mistake (after which install proceeds
	// silently), so each refuses the add unless the caller passes --force.
	//
	// 1. Typosquat gate (local, no network).
	if (ecosystem === "npm") {
		const match = findTyposquatMatch(pkg);
		if (match && !opts.force) {
			throw new Error(
				`refusing to approve "${pkg}" — Levenshtein distance ${match.distance} from popular package "${match.popular}". If this is intentional, re-run with --force.`,
			);
		}
	}
	// Screens 2 + 3 spend a network round-trip — acceptable here (human-invoked
	// admission, same posture as the typosquat list) and NOWHERE on the hook
	// path, which only ever reads the recorded fields. Both fail open with a
	// loud note: offline must not break bootstrap. Both inspect the version
	// being APPROVED — the pinned resolution of --version-range when given
	// (finding 2026-06, round 6: screening only the registry latest let a
	// vulnerable or differently-licensed pinned release through).
	const notes: string[] = [];
	let license: string | undefined;
	const pinned = opts.versionRange !== undefined ? resolveScreenVersion(opts.versionRange) : null;
	if (opts.versionRange !== undefined && pinned === null) {
		notes.push(
			`version range "${opts.versionRange}" not statically resolvable — screens fall back to the registry latest`,
		);
	}
	const meta = await fetchRegistryMetadata(ecosystem, pkg);
	const ctx: ScreenContext = { ecosystem, pkg, cwd: opts.cwd, force: opts.force === true, notes };
	// License needs the registry's DECLARED license, so it genuinely depends on
	// metadata. The advisory screen does NOT — OSV takes ecosystem+name+version
	// directly — so it runs whenever a version is resolvable, including an exact
	// --version-range on an ecosystem with no metadata API (Go; finding 2026-06,
	// round 7: a vulnerable pinned Go module was approved without --force because
	// the whole screen block sat behind `meta !== null`).
	if (meta === null) {
		notes.push(
			"registry metadata unavailable (offline or unsupported ecosystem) — license screen skipped",
		);
	} else {
		license = await screenLicense(ctx, meta, pinned);
	}
	await screenAdvisories(ctx, meta, pinned, opts.versionRange);
	await screenLibyear(ctx, pinned);
	addToAllowlist(opts.cwd, ecosystem, pkg, {
		approved_by: opts.by,
		...(opts.reason !== undefined ? { reason: opts.reason } : {}),
		...(opts.versionRange !== undefined ? { version_range: opts.versionRange } : {}),
		...(license !== undefined ? { license } : {}),
	});
	process.stdout.write(
		`approved: ${ecosystem}:${pkg} (by ${opts.by})${license !== undefined ? ` — license ${license}` : ""}\n`,
	);
	for (const note of notes) process.stdout.write(`  note: ${note}\n`);
}

interface RemoveOpts {
	cwd: string;
}

export function removeAllowlistCommand(
	ecosystem: string,
	pkg: string,
	opts: RemoveOpts,
): void {
	if (!isEcosystem(ecosystem)) {
		throw new Error(
			`Unknown ecosystem "${ecosystem}". Valid: ${ECOSYSTEMS.join(", ")}`,
		);
	}
	const al = loadAllowlist(opts.cwd);
	if (!al.packages[ecosystem][pkg]) {
		process.stdout.write(`no entry: ${ecosystem}:${pkg}\n`);
		return;
	}
	delete al.packages[ecosystem][pkg];
	saveAllowlist(opts.cwd, al);
	process.stdout.write(`removed: ${ecosystem}:${pkg}\n`);
}

interface ListOpts {
	cwd: string;
	ecosystem?: string;
	json?: boolean;
}

function printEcosystemEntries(
	ecosystem: Ecosystem,
	entries: Allowlist["packages"][Ecosystem],
): void {
	const rows = Object.entries(entries);
	if (rows.length === 0) return;
	process.stdout.write(`${ecosystem}:\n`);
	for (const [name, meta] of rows) {
		process.stdout.write(
			`  ${name}  (by ${meta.approved_by}${meta.reason ? `, ${meta.reason}` : ""}${meta.license ? `, license ${meta.license}` : ""})\n`,
		);
	}
}

export function listAllowlistCommand(opts: ListOpts): void {
	const al = loadAllowlist(opts.cwd);
	const filtered: Allowlist = opts.ecosystem
		? {
				...al,
				packages: Object.fromEntries(
					ECOSYSTEMS.map((e) => [
						e,
						e === opts.ecosystem ? al.packages[e] : {},
					]),
				) as Allowlist["packages"],
			}
		: al;
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
		return;
	}
	const totals = ECOSYSTEMS.reduce(
		(n, e) => n + Object.keys(filtered.packages[e]).length,
		0,
	);
	if (totals === 0 && Object.keys(filtered.lockfile_snapshots).length === 0) {
		process.stdout.write("allowlist is empty — no entries approved\n");
		return;
	}
	for (const e of ECOSYSTEMS) {
		printEcosystemEntries(e, filtered.packages[e]);
	}
	const snaps = Object.entries(filtered.lockfile_snapshots);
	if (snaps.length > 0) {
		process.stdout.write("snapshots:\n");
		for (const [file, meta] of snaps) {
			process.stdout.write(`  ${file}  ${meta.sha256.slice(0, 12)}…  (by ${meta.approved_by})\n`);
		}
	}
}

interface SnapshotOpts {
	cwd: string;
	by: string;
	reason?: string;
	lockfile?: string;
}

const SNAPSHOT_CANDIDATES = [
	"package.json",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"requirements.txt",
	"requirements.lock",
	"Pipfile",
	"Pipfile.lock",
	"pyproject.toml",
	"poetry.lock",
	"uv.lock",
	"pdm.lock",
	"Cargo.toml",
	"Cargo.lock",
	"Gemfile",
	"Gemfile.lock",
	"go.mod",
	"go.sum",
	// composer (PHP) / maven (Java) / gradle (Java-Kotlin) / nuget (.NET) — the
	// manifest + lockfile per ecosystem the parser now guards. A variably-named
	// `*.csproj` is snapshotted via `--lockfile <name>.csproj`.
	"composer.json",
	"composer.lock",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"gradle.lockfile",
	"packages.lock.json",
	"packages.config",
] as const;

/** Hash every present manifest/lockfile into an approving snapshot grant.
 *  Extracted from the CLI command (2026-08-17) so `interlinked adopt` can
 *  pre-approve the repo's CURRENT dependency state during onboarding — the
 *  fail-closed install gate then only ever prompts on genuinely NEW packages,
 *  which is the gate's actual job. Saves only when something was taken. */
export function takeAllowlistSnapshot(opts: SnapshotOpts): { taken: string[] } {
	const al = loadAllowlist(opts.cwd);
	const candidates = opts.lockfile
		? [opts.lockfile]
		: [...SNAPSHOT_CANDIDATES, ...discoverCsprojFiles(opts.cwd)];
	const taken: string[] = [];
	for (const name of candidates) {
		const p = join(opts.cwd, name);
		if (!existsSync(p)) continue;
		try {
			if (!statSync(p).isFile()) continue;
		} catch {
			continue;
		}
		const sha = hashLockfile(p);
		if (!sha) continue;
		al.lockfile_snapshots[name] = {
			sha256: sha,
			approved_at: new Date().toISOString(),
			approved_by: opts.by,
			...(opts.reason !== undefined ? { reason: opts.reason } : {}),
		};
		taken.push(name);
	}
	if (taken.length > 0) saveAllowlist(opts.cwd, al);
	return { taken };
}

export function snapshotAllowlistCommand(opts: SnapshotOpts): void {
	const { taken } = takeAllowlistSnapshot(opts);
	if (taken.length === 0) {
		process.stdout.write(
			"no manifest/lockfile found to snapshot in this directory\n",
		);
		return;
	}
	process.stdout.write(`snapshotted ${taken.length} file(s):\n`);
	for (const name of taken) process.stdout.write(`  ${name}\n`);
}

// SDK-style NuGet keeps deps in a variably-named, often NESTED *.csproj absent
// from the fixed candidate list. Auto-discover them RECURSIVELY (relative-path
// keys, matching the install guard's recursive scan) so a plain `snapshot`
// captures every project the guard checks — otherwise the guard's "Run
// `interlinked allowlist snapshot`" hint is circular for nested .csproj.
function discoverCsprojFiles(cwd: string): string[] {
	return findManifestFiles(cwd, (name) => name.endsWith(".csproj"));
}
