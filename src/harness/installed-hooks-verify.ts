// ===========================================
// Semantic verification of one runner's installed hooks
// ===========================================
// Review 2026-08-30 rewrite: the first version collected every STRING in the
// settings document, so a valid hooks object moved under `unrelated_note`
// (with the real hooks deleted) still verified, and the Codex flag check was
// a document-wide regex that accepted `[other] hooks = true`. Verification
// is now STRUCTURAL:
//   - the adapter's freshly rendered fragment is the expected shape; every
//     expected element must appear (deep-equal) EXACTLY once at its native
//     JSON path — a copy elsewhere in the document does not count;
//   - owned entries at native paths the fragment does not declare fail
//     (a deregistered event like Claude's PermissionRequest);
//   - any command claiming this runner without the current binary fails at
//     project/local scope (user-scope files host other projects);
//   - Codex's flag is read by the ONE table-aware reader
//     (lib/codex-feature-flag.ts), at the entry's scope-resolved path;
//   - the manifest row's recorded binary must match the expected one.

import { existsSync, readFileSync } from "node:fs";
import {
	findFeaturesHooksAssignmentCounts,
	findFeaturesTableHeaderLines,
	readCodexHooksFlag,
} from "../lib/codex-feature-flag.js";
import {
	hookEntryCommands,
	isHookEntryInvokingBinary,
	isInterlinkedHookCommand,
} from "../lib/hook-ownership.js";
import { getAdapter } from "./adapters/index.js";
import { resolveSettingsPath } from "./installer.js";
import { isManagedProviderFile, managedProviderFileHash } from "./managed-provider-file.js";
import type { RunnerId } from "./unified-event.js";

interface VerifiableInstallEntry {
	runner: RunnerId;
	settings_path: string;
	scope: string;
	binary_path?: string;
	artifact_kind?: "json-settings" | "managed-file";
	artifact_sha256?: string;
}

export interface HookVerification {
	runner: string;
	settings_path: string;
	verified: boolean;
	problems: string[];
}

/** JSON-semantic structural equality. Object insertion order and prototype
 *  are not part of a settings document's meaning; array order remains exact. */
function structurallyEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a)) return arraysStructurallyEqual(a, b);
	if (Array.isArray(b)) return false;
	const aObject = asObject(a);
	const bObject = asObject(b);
	if (aObject === null || bObject === null) return false;
	return objectsStructurallyEqual(aObject, bObject);
}

/** Arrays match element-for-element in exact order. */
function arraysStructurallyEqual(a: readonly unknown[], b: unknown): boolean {
	if (!Array.isArray(b) || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (!structurallyEqual(a[i], b[i])) return false;
	}
	return true;
}

/** Objects match on their JSON-visible keys, insertion order aside. */
function objectsStructurallyEqual(
	aObject: Record<string, unknown>,
	bObject: Record<string, unknown>,
): boolean {
	// JSON serialization omits object properties whose value is undefined;
	// adapter fragments may retain such optional properties before installation.
	const aKeys = Object.keys(aObject).filter((key) => aObject[key] !== undefined);
	const bKeys = Object.keys(bObject).filter((key) => bObject[key] !== undefined);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.hasOwn(bObject, key) || !structurallyEqual(aObject[key], bObject[key])) {
			return false;
		}
	}
	return true;
}

function containsOwnedBinary(value: unknown, binaryAbs: string): boolean {
	if (Array.isArray(value)) {
		return value.some((entry) => isHookEntryInvokingBinary(entry, binaryAbs));
	}
	return isHookEntryInvokingBinary(value, binaryAbs);
}

/** Commands registered under native hook containers, never prose metadata. */
function collectHookCommands(value: unknown, out: string[]): void {
	if (Array.isArray(value)) {
		for (const entry of value) out.push(...hookEntryCommands(entry));
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) collectHookCommands(item, out);
	}
}

function asObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** One expected native array (e.g. `hooks.PreToolUse`): the document's array
 *  at the same path must hold each expected element deep-equal exactly once,
 *  and no OTHER owned element. */
function checkNativeArray(
	path: string,
	expected: readonly unknown[],
	docValue: unknown,
	binaryAbs: string,
	problems: string[],
): void {
	if (!Array.isArray(docValue)) {
		problems.push(`${path}: expected an array of hook entries, found ${docValue === undefined ? "nothing" : typeof docValue}`);
		return;
	}
	let ownedInDoc = 0;
	for (const el of docValue) {
		if (isHookEntryInvokingBinary(el, binaryAbs)) ownedInDoc++;
	}
	let matched = 0;
	for (const want of expected) {
		const hits = docValue.filter((el) => structurallyEqual(el, want)).length;
		if (hits !== 1) {
			problems.push(`${path}: expected hook entry present ${hits} time(s); expected exactly 1`);
		} else {
			matched++;
		}
	}
	if (ownedInDoc > matched) {
		problems.push(`${path}: ${ownedInDoc - matched} extra owned hook entr(ies) beyond the adapter's expected shape`);
	}
}

/** Handle the case where the expected fragment node at `pathPrefix` is a
 *  plain object: recurse into each expected key, then flag owned entries
 *  under native keys the fragment does NOT declare (e.g. a deregistered
 *  event still registered in the document). Extracted from
 *  `checkFragmentShape` to keep its nesting shallow. */
function handleExpectedObj(
	pathPrefix: string,
	expectedObj: Record<string, unknown>,
	docNode: unknown,
	binaryAbs: string,
	problems: string[],
): void {
	const docObj = asObject(docNode);
	for (const [key, value] of Object.entries(expectedObj)) {
		const childPath = pathPrefix === "" ? key : `${pathPrefix}.${key}`;
		checkFragmentShape(childPath, value, docObj?.[key], binaryAbs, problems);
	}
	if (docObj === null) return;
	for (const [key, value] of Object.entries(docObj)) {
		if (Object.hasOwn(expectedObj, key)) continue;
		if (!containsOwnedBinary(value, binaryAbs)) continue;
		const childPath = pathPrefix === "" ? key : `${pathPrefix}.${key}`;
		problems.push(`${childPath}: owned hook entry at a native path the adapter no longer declares`);
	}
}

/** Walk the expected fragment against the document AT THE SAME PATHS. */
function checkFragmentShape(
	pathPrefix: string,
	expectedNode: unknown,
	docNode: unknown,
	binaryAbs: string,
	problems: string[],
): void {
	if (Array.isArray(expectedNode)) {
		checkNativeArray(pathPrefix, expectedNode, docNode, binaryAbs, problems);
		return;
	}
	const expectedObj = asObject(expectedNode);
	if (expectedObj !== null) {
		handleExpectedObj(pathPrefix, expectedObj, docNode, binaryAbs, problems);
		return;
	}
	if (!structurallyEqual(expectedNode, docNode)) {
		problems.push(`${pathPrefix}: expected ${JSON.stringify(expectedNode)}, found ${JSON.stringify(docNode)}`);
	}
}

/** Codex's flag via the ONE table-aware reader, at the entry's scope path
 *  (the same resolver the installer writes through — user scope lives under
 *  $HOME, never under cwd). */
function checkCodexFeatureFlag(cwd: string, scope: string, problems: string[]): void {
	const rel = scope === "user" ? "~/.codex/config.toml" : ".codex/config.toml";
	const resolved = resolveSettingsPath(cwd, rel);
	const toml = existsSync(resolved) ? readFileSync(resolved, "utf-8") : "";
	// Duplicate [features] tables are INVALID TOML Codex rejects wholesale,
	// and duplicate assignments are ambiguous — "last one wins" must not
	// verify a config Codex will refuse (review 2026-08-30, second pass).
	if (findFeaturesTableHeaderLines(toml).length > 1) {
		problems.push(`${resolved} has duplicate [features] tables — invalid TOML, Codex rejects it`);
		return;
	}
	const counts = findFeaturesHooksAssignmentCounts(toml);
	if (counts.hooks + counts.codex_hooks > 1) {
		problems.push(`${resolved} has duplicate hooks/codex_hooks assignments in [features]`);
		return;
	}
	if (readCodexHooksFlag(toml) !== "enabled") {
		problems.push(`${resolved} must carry \`hooks = true\` inside the [features] table`);
	}
}

/** Any Interlinked-owned command (the CANONICAL recognizer from
 *  lib/hook-ownership.ts — never a current-binary substring or an exact
 *  quoting format) that is not one of the freshly rendered expected
 *  commands is stale: an old binary, a legacy `.mjs` install, or a hook at
 *  an event the adapter no longer declares. Project/local scope only — a
 *  shared user-scope file legitimately hosts other projects' hooks. */
function checkStaleCommands(
	entry: VerifiableInstallEntry,
	parsed: unknown,
	expectedFragment: unknown,
	problems: string[],
): void {
	if (entry.scope === "user") return;
	const expected: string[] = [];
	collectHookCommands(expectedFragment, expected);
	const expectedSet = new Set(expected);
	const strings: string[] = [];
	const parsedObject = asObject(parsed);
	collectHookCommands(parsedObject?.hooks, strings);
	for (const s of strings) {
		if (isInterlinkedHookCommand(s) && !expectedSet.has(s)) {
			problems.push(`stale Interlinked-owned command not in the adapter's current render: ${s.slice(0, 120)}`);
		}
	}
}

function checkManagedFile(
	entry: VerifiableInstallEntry,
	expectedContent: string,
	problems: string[],
): void {
	if (!existsSync(entry.settings_path)) {
		problems.push(`managed provider file missing: ${entry.settings_path}`);
		return;
	}
	let content: string;
	try {
		content = readFileSync(entry.settings_path, "utf-8");
	} catch (readError) {
		problems.push(`managed provider file unreadable: ${String(readError)}`);
		return;
	}
	if (!isManagedProviderFile(content)) {
		problems.push(`${entry.settings_path} is not an Interlinked-managed provider file`);
		return;
	}
	const actualHash = managedProviderFileHash(content);
	if (entry.artifact_kind !== "managed-file") problems.push("manifest does not identify this provider bridge as a managed-file artifact");
	if (entry.artifact_sha256 !== undefined && entry.artifact_sha256 !== actualHash) {
		problems.push("managed provider file changed after installation; uninstall will preserve it");
	}
	if (content !== expectedContent) problems.push("managed provider file is stale relative to the adapter's current render");
}

function checkJsonSettings(
	entry: VerifiableInstallEntry,
	expectedFragment: unknown,
	binaryAbs: string,
	problems: string[],
): void {
	if (!existsSync(entry.settings_path)) {
		problems.push(`settings file missing: ${entry.settings_path}`);
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(entry.settings_path, "utf-8"));
	} catch (parseError) {
		problems.push(`settings file unparseable: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
		return;
	}
	checkFragmentShape("", expectedFragment, parsed, binaryAbs, problems);
	checkStaleCommands(entry, parsed, expectedFragment, problems);
}

export function verifyInstalledRunner(
	cwd: string,
	entry: VerifiableInstallEntry,
	binaryAbs: string,
): HookVerification {
	const problems: string[] = [];
	const adapter = getAdapter(entry.runner);
	if (adapter === null) problems.push(`no adapter for runner ${entry.runner}`);
	if (adapter !== null) {
		// SAFETY: manifest scopes are validated by readManifestState against the
		// same InstallScope union the adapter render accepts.
		const rendered = adapter.renderSettingsFragment(binaryAbs, entry.scope as never);
		if (rendered.fileContent === undefined) {
			checkJsonSettings(entry, rendered.fragment, binaryAbs, problems);
		} else {
			checkManagedFile(entry, rendered.fileContent, problems);
		}
	}
	if (entry.runner === "codex") checkCodexFeatureFlag(cwd, entry.scope, problems);
	if (entry.binary_path !== undefined && entry.binary_path !== binaryAbs) {
		problems.push(
			`manifest records binary ${entry.binary_path} but the current binary is ${binaryAbs}`,
		);
	}

	return {
		runner: entry.runner,
		settings_path: entry.settings_path,
		verified: problems.length === 0,
		problems,
	};
}
