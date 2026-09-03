// ===========================================
// Software Version Regression / Freshness Detection
// ===========================================
// PostToolUse-only detector for edits that move software identifiers
// backward: model names, package/dependency versions, Docker tags, GitHub
// action versions, API dates, and common config/code version assignments.
// It also identifies newly introduced freshness-sensitive references so the
// agent verifies official sources instead of relying on remembered timelines.

import { basename } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { isTestFile } from "../checks/shared.js";
import {
	freshnessConcernForRef,
	referenceIdentity,
} from "./software-version-regression-freshness.js";
import { computeObjectPathByLine as computeScopedObjectPathByLine } from "./software-version-regression-object-path.js";
import {
	classifyGenericKind,
	isVersionRegression,
	looksComparable,
	MODEL_PROVIDER_RE,
	modelFamilyOf,
	modelProviderOf,
} from "./software-version-regression-version-parse.js";

export interface SoftwareVersionReference {
	anchor: string;
	label: string;
	kind: "package" | "model" | "docker_image" | "github_action" | "api_version" | "generic";
	version: string;
	line: number;
	text: string;
}

export interface SoftwareVersionRegression {
	before: SoftwareVersionReference;
	after: SoftwareVersionReference;
}

export interface SoftwareVersionVerificationHint {
	source: string;
	instruction: string;
}

export interface SoftwareVersionFreshnessConcern {
	ref: SoftwareVersionReference;
	reason: string;
	verifyHint: SoftwareVersionVerificationHint;
}

const PACKAGE_SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
	"resolutions",
	"overrides",
] as const;

const SOFTWARE_KEY_RE =
	/(?:^|[_\-.])(?:version|model|modelname|api[_\-.]?version|runtime|engine|image|sdk|tool|package|dependency|node|python|go|rust|java)(?:$|[_\-.])/i;

const GENERIC_ASSIGNMENT_RE =
	/(?:^|[\s{,(])(?<key>[A-Za-z_][\w.-]{0,80})\s*(?::|=)\s*["'](?<value>[^"'\n]{1,160})["']/g;

const JSON_STRING_PROP_RE =
	/"(?<key>[^"\n]{1,100})"\s*:\s*"(?<value>[^"\n]{1,160})"/g;

const GITHUB_ACTION_RE = /\buses:\s*(?<action>[\w.-]+\/[\w.-]+)@(?<version>[^\s#]+)/i;

const DOCKER_FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(?<image>[^\s:@]+(?:\/[^\s:@]+)*)(?::(?<version>[^\s@]+))?/i;

const REQUIREMENT_RE =
	/^\s*(?<name>[A-Za-z0-9_.-]+)\s*(?:==|~=|>=|<=|=)\s*(?<version>[^\s;#]+)/;

// The inner class EXCLUDES `/`. With `[^\s]+` it swallowed the very delimiter
// the outer group repeats on, so a slash-heavy line with no following space
// partitioned exponentially: a 66-BYTE input took 51 SECONDS (measured
// 2026-08-04). This regex reads go.mod content inside a daemon-side check, so
// that is a hang of the guard, not a slow lint. Excluding the delimiter makes
// each segment unambiguous; matching is unchanged (a path segment never
// contains a slash).
const GO_REQUIRE_RE =
	/^\s*(?<module>[A-Za-z0-9_.-]+(?:\/[^\s/]+)+)\s+v?(?<version>\d+\.\d+\.\d+[^\s]*)/;

const CARGO_DEP_RE = /^\s*(?<name>[A-Za-z0-9_-]+)\s*=\s*["'](?<version>[^"']+)["']/;

export function collectSoftwareVersionReferences(
	content: string,
	filePath: string,
): SoftwareVersionReference[] {
	const refs: SoftwareVersionReference[] = [];
	const seen = new Set<string>();
	const base = basename(filePath).toLowerCase();

	if (base === "package.json") {
		refs.push(...collectPackageJsonRefs(content));
	}

	const lines = content.split("\n");
	const pathByLine = computeScopedObjectPathByLine(content, lines.length);
	const testFile = isTestFile(filePath);
	for (const [i, line] of lines.entries()) {
		const lineNo = i + 1;

		collectLineRef(refs, seen, collectDockerFromRef(line, lineNo));
		collectLineRef(refs, seen, collectGithubActionRef(line, lineNo));
		collectLineRef(refs, seen, collectRequirementRef(line, lineNo));
		collectLineRef(refs, seen, collectGoRequireRef(line, lineNo));
		if (base === "cargo.toml" || filePath.endsWith(".toml")) {
			collectLineRef(refs, seen, collectCargoDependencyRef(line, lineNo));
		}

		for (const ref of collectGenericAssignmentRefs(line, lineNo, pathByLine[i] ?? "")) {
			// Test fixtures pin arbitrary versions by design — comparing
			// them across edits is meaningless (the registry-metadata.test.ts
			// cross-block FP). Keep only model refs (freshness still applies);
			// the manifest/Docker/action collectors above are unaffected.
			if (testFile && ref.kind !== "model") continue;
			collectLineRef(refs, seen, ref);
		}
	}

	return refs;
}

export function detectSoftwareVersionRegressions(
	beforeRefs: readonly SoftwareVersionReference[],
	afterRefs: readonly SoftwareVersionReference[],
): SoftwareVersionRegression[] {
	const beforeByAnchor = new Map<string, SoftwareVersionReference[]>();
	for (const ref of beforeRefs) {
		const list = beforeByAnchor.get(ref.anchor) ?? [];
		list.push(ref);
		beforeByAnchor.set(ref.anchor, list);
	}

	const afterVersionsByFamily = collectVersionsByAnchorFamily(afterRefs);
	const regressions: SoftwareVersionRegression[] = [];
	const emitted = new Set<string>();
	for (const after of afterRefs) {
		const before = regressionBaselineFor(after, beforeByAnchor, afterVersionsByFamily);
		if (!before) continue;
		const key = `${after.anchor}\0${before.version}\0${after.version}`;
		if (emitted.has(key)) continue;
		emitted.add(key);
		regressions.push({ before, after });
	}
	return regressions;
}

// The scoped object-path walker disambiguates anonymous sibling scopes with a
// `#n` occurrence counter (see software-version-regression-object-path.ts).
// Stripping the counter recovers the pre-disambiguation "family": an edit that
// inserts a sibling above shifts downstream counters, so survival checks must
// look family-wide or a version that merely MOVED anchors reads as removed.
export function anchorFamilyOf(anchor: string): string {
	return anchor.replace(/#\d+/g, "");
}

// Set of versions present per anchor FAMILY in the after-content. Lets the
// regression check tell a real downgrade (the higher version is GONE after the
// edit) from a catalog that merely lists many versions side by side (all still
// present, possibly under counter-shifted sibling anchors).
function collectVersionsByAnchorFamily(
	refs: readonly SoftwareVersionReference[],
): Map<string, Set<string>> {
	const byFamily = new Map<string, Set<string>>();
	for (const ref of refs) {
		const family = anchorFamilyOf(ref.anchor);
		const set = byFamily.get(family) ?? new Set<string>();
		set.add(ref.version);
		byFamily.set(family, set);
	}
	return byFamily;
}

// The before-reference an `after` ref regressed FROM, or undefined when this is
// not a regression. The two guards keep model CATALOGS from self-tripping: a
// file listing many `{ id, name }` entries collapses every sibling into one
// anchor (array indices are not tracked; a model's "family" is just its
// provider), so the old "compare against the first before-ref" logic flagged
// every lower-versioned sibling as a downgrade of the highest — even when the
// catalog was byte-identical and only an unrelated line (e.g. a DEFAULT_MODEL_ID
// pin) changed.
function regressionBaselineFor(
	after: SoftwareVersionReference,
	beforeByAnchor: ReadonlyMap<string, SoftwareVersionReference[]>,
	afterVersionsByFamily: ReadonlyMap<string, Set<string>>,
): SoftwareVersionReference | undefined {
	const beforeList = beforeByAnchor.get(after.anchor);
	if (!beforeList) return undefined;
	// Unchanged: this exact version was already at this anchor, so the edit did
	// not introduce it — it cannot be a regression.
	if (beforeList.some((b) => b.version === after.version)) return undefined;
	// Else require a strictly-higher version to have been REMOVED (a real
	// replacement, checked family-wide so counter-shifted siblings still count
	// as surviving), not merely joined by a lower-versioned sibling.
	return pickReplacedHigherBaseline(
		beforeList,
		after,
		afterVersionsByFamily.get(anchorFamilyOf(after.anchor)),
	);
}

// Real replacements are in-place: the new version lands on (or near) the line
// the old one occupied. Residual anchor collisions — two same-key versions
// inside ONE scope, duplicate it()-titles — sit far apart, so a generous
// window screens them without touching genuine downgrades.
const MAX_REGRESSION_LINE_DISTANCE = 15;

// Among one anchor's before-refs, the highest that is strictly higher than
// `after`, absent from the after-content (replaced, not just co-listed), and
// near enough in the file to plausibly be the same reference.
function pickReplacedHigherBaseline(
	beforeList: readonly SoftwareVersionReference[],
	after: SoftwareVersionReference,
	afterVersions: ReadonlySet<string> | undefined,
): SoftwareVersionReference | undefined {
	let best: SoftwareVersionReference | undefined;
	for (const before of beforeList) {
		if (afterVersions?.has(before.version)) continue;
		if (Math.abs(before.line - after.line) > MAX_REGRESSION_LINE_DISTANCE) continue;
		if (!isVersionRegression(before, after)) continue;
		if (!best || isVersionRegression(before, best)) best = before;
	}
	return best;
}

export function detectSoftwareVersionFreshnessConcerns(
	beforeRefs: readonly SoftwareVersionReference[],
	afterRefs: readonly SoftwareVersionReference[],
): SoftwareVersionFreshnessConcern[] {
	const beforeKeys = new Set(beforeRefs.map((ref) => referenceIdentity(ref)));
	const concerns: SoftwareVersionFreshnessConcern[] = [];
	const emitted = new Set<string>();

	for (const ref of afterRefs) {
		if (beforeKeys.has(referenceIdentity(ref))) continue;
		const concern = freshnessConcernForRef(ref);
		if (!concern) continue;
		const key = `${ref.anchor}\0${ref.version}\0${concern.reason}`;
		if (emitted.has(key)) continue;
		emitted.add(key);
		concerns.push({ ref, ...concern });
	}

	return concerns;
}

export function formatSoftwareVersionRegressionDetail(
	regressions: readonly SoftwareVersionRegression[],
): string {
	const lines: string[] = [];
	const shownRegressions = regressions.slice(0, 8);
	if (shownRegressions.length > 0) lines.push("Likely regressions:");
	lines.push(...shownRegressions.map(({ before, after }) => {
		return `  L${after.line}: ${after.label} ${before.version} -> ${after.version}`;
	}));
	if (regressions.length > shownRegressions.length) {
		lines.push(`  ... and ${regressions.length - shownRegressions.length} more`);
	}

	return lines.join("\n");
}

export function formatSoftwareVersionFreshnessDetail(
	concerns: readonly SoftwareVersionFreshnessConcern[],
): string {
	const lines: string[] = [];
	const shownConcerns = concerns.slice(0, 8);
	if (shownConcerns.length > 0) {
		lines.push("Freshness-sensitive new references:");
	}
	lines.push(...shownConcerns.map(({ ref, reason, verifyHint }) => {
		return `  L${ref.line}: ${ref.label} ${ref.version} - ${reason}; verify: ${verifyHint.source}`;
	}));
	if (concerns.length > shownConcerns.length) {
		lines.push(`  ... and ${concerns.length - shownConcerns.length} more`);
	}

	return lines.join("\n");
}

function collectPackageJsonRefs(content: string): SoftwareVersionReference[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const obj = parsed as JsonObject;
	const refs: SoftwareVersionReference[] = [];

	if (typeof obj.version === "string") {
		refs.push({
			anchor: "package:self-version",
			label: "package version",
			kind: "package",
			version: obj.version,
			line: findJsonPropLine(content, "version", obj.version),
			text: `"version": "${obj.version}"`,
		});
	}

	for (const section of PACKAGE_SECTIONS) {
		const deps = obj[section];
		if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
		for (const [name, version] of Object.entries(deps as JsonObject)) {
			if (typeof version !== "string") continue;
			refs.push({
				anchor: `package:${name}`,
				label: `${section} ${name}`,
				kind: "package",
				version,
				line: findJsonPropLine(content, name, version),
				text: `"${name}": "${version}"`,
			});
		}
	}

	return refs;
}

function collectDockerFromRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = DOCKER_FROM_RE.exec(line);
	const image = match?.groups?.image;
	const version = match?.groups?.version;
	if (!image || !version || version.toLowerCase() === "latest") return undefined;
	return {
		anchor: `docker:${image}`,
		label: `Docker image ${image}`,
		kind: "docker_image",
		version,
		line: lineNo,
		text: line.trim(),
	};
}

function collectGithubActionRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = GITHUB_ACTION_RE.exec(line);
	const action = match?.groups?.action;
	const version = match?.groups?.version;
	if (!action || !version) return undefined;
	return {
		anchor: `github-action:${action.toLowerCase()}`,
		label: `GitHub Action ${action}`,
		kind: "github_action",
		version,
		line: lineNo,
		text: line.trim(),
	};
}

function collectRequirementRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = REQUIREMENT_RE.exec(line);
	const name = match?.groups?.name;
	const version = match?.groups?.version;
	if (!name || !version) return undefined;
	return {
		anchor: `package:${name.toLowerCase()}`,
		label: `Python package ${name}`,
		kind: "package",
		version,
		line: lineNo,
		text: line.trim(),
	};
}

function collectGoRequireRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = GO_REQUIRE_RE.exec(line);
	const module = match?.groups?.module;
	const version = match?.groups?.version;
	if (!module || !version) return undefined;
	return {
		anchor: `package:${module.toLowerCase()}`,
		label: `Go module ${module}`,
		kind: "package",
		version,
		line: lineNo,
		text: line.trim(),
	};
}

function collectCargoDependencyRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = CARGO_DEP_RE.exec(line);
	const name = match?.groups?.name;
	const version = match?.groups?.version;
	if (!name || !version || !looksComparable(version)) return undefined;
	return {
		anchor: `package:${name.toLowerCase()}`,
		label: `Cargo package ${name}`,
		kind: "package",
		version,
		line: lineNo,
		text: line.trim(),
	};
}

function collectGenericAssignmentRefsForPattern(
	line: string,
	lineNo: number,
	objectPath: string,
	re: RegExp,
): SoftwareVersionReference[] {
	const found: SoftwareVersionReference[] = [];
	re.lastIndex = 0;
	for (const match of line.matchAll(re)) {
		const key = match.groups?.key;
		const value = match.groups?.value;
		if (!key || !value) continue;
		const hasSoftwareKey = SOFTWARE_KEY_RE.test(key);
		if (!hasSoftwareKey && !MODEL_PROVIDER_RE.test(value)) continue;
		const modelProvider = modelProviderOf(value);
		const kind = classifyGenericKind(key, value);
		if (!modelProvider && !looksComparable(value, kind)) continue;
		const modelFamily = kind === "model" ? modelFamilyOf(value) : undefined;
		const baseAnchor =
			kind === "model"
				? `model:${key.toLowerCase()}:${modelFamily ?? modelProvider ?? "unknown"}`
				: `${kind}:${key.toLowerCase()}`;
		const anchor = objectPath ? `${baseAnchor}@${objectPath}` : baseAnchor;
		found.push({
			anchor,
			label: `${key}`,
			kind,
			version: value,
			line: lineNo,
			text: line.trim(),
		});
	}
	return found;
}

function collectGenericAssignmentRefs(
	line: string,
	lineNo: number,
	objectPath: string,
): SoftwareVersionReference[] {
	const refs: SoftwareVersionReference[] = [];
	for (const re of [GENERIC_ASSIGNMENT_RE, JSON_STRING_PROP_RE]) {
		refs.push(...collectGenericAssignmentRefsForPattern(line, lineNo, objectPath, re));
	}
	return refs;
}

function collectLineRef(
	refs: SoftwareVersionReference[],
	seen: Set<string>,
	ref: SoftwareVersionReference | undefined,
): void {
	if (!ref) return;
	const key = `${ref.anchor}\0${ref.line}\0${ref.version}`;
	if (seen.has(key)) return;
	seen.add(key);
	refs.push(ref);
}

function findJsonPropLine(content: string, key: string, value: string): number {
	const escapedKey = escapeRegExp(key);
	const escapedValue = escapeRegExp(value);
	const re = new RegExp(`"${escapedKey}"\\s*:\\s*"${escapedValue}"`);
	const lines = content.split("\n");
	for (const [i, line] of lines.entries()) {
		if (re.test(line)) return i + 1;
	}
	return 1;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
