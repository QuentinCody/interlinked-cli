// -----------------------------------------------------------------------------
// Installer manifest — STRICT tri-state reader + atomic writer
// -----------------------------------------------------------------------------
// Extracted from installer.ts 2026-08-30 (that file hit its line cap while
// the reader hardened). The manifest is a record of what THE ADAPTER wrote,
// not a free-form deletion list: every entry is bound to its adapter's
// derived settings path, prototype-chain path segments are refused, and one
// bad row makes the WHOLE manifest corrupt — the lenient coercer used to
// drop malformed rows silently, so a damaged manifest read as a smaller
// valid one and later writes clobbered the evidence.

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { getAdapter, type InstallerManifestEntry } from "./adapters/index.js";
import {
	ensureDir,
	FORBIDDEN_PATH_SEGMENTS,
	resolveSettingsPath,
	writeAtomic,
} from "./installer-merge-engine.js";
import type { InstallScope } from "./installer-purge.js";
import type { RunnerId } from "./unified-event.js";

export const MANIFEST_SCHEMA_VERSION = "1" as const;

const VALID_MANIFEST_RUNNERS = new Set<string>([
	"claude-code",
	"copilot-cli",
	"cursor",
	"gemini-cli",
	"codex",
	"opencode",
	"opencode2",
	"pi",
]);

/** Tri-state manifest read: MISSING is a legitimate never-installed state,
 *  but CORRUPT bytes must never be flattened into "nothing installed". */
export type ManifestState =
	| { kind: "missing" }
	| { kind: "valid"; entries: InstallerManifestEntry[] }
	| { kind: "corrupt"; reason: string };

function forbiddenSegmentIn(path: string): boolean {
	return path.split(/[.[]/).some((seg) => FORBIDDEN_PATH_SEGMENTS.has(seg.replace(/\]$/, "")));
}

function artifactFieldError(r: JsonObject, at: string): string | null {
	const kind = r.artifact_kind;
	if (kind !== undefined && kind !== "json-settings" && kind !== "managed-file") {
		return `${at} has invalid artifact_kind ${JSON.stringify(kind)}`;
	}
	const hash = r.artifact_sha256;
	if (hash !== undefined && (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
		return `${at} has invalid artifact_sha256`;
	}
	return kind === "managed-file" && typeof hash !== "string"
		? `${at} managed-file artifact has no artifact_sha256`
		: null;
}

/** Field-level validation for one row; the returned string is the reason. */
function fieldError(r: JsonObject, at: string): string | null {
	if (typeof r.runner !== "string" || !VALID_MANIFEST_RUNNERS.has(r.runner)) {
		return `${at} has unknown runner ${JSON.stringify(r.runner)}`;
	}
	if (r.scope !== "user" && r.scope !== "project" && r.scope !== "local") {
		return `${at} has invalid scope ${JSON.stringify(r.scope)}`;
	}
	if (typeof r.settings_path !== "string" || r.settings_path === "") return `${at} has no settings_path`;
	if (!Array.isArray(r.added_paths) || r.added_paths.some((x) => typeof x !== "string")) {
		return `${at} has a non-string added_paths array`;
	}
	for (const p of r.added_paths as string[]) {
		if (forbiddenSegmentIn(p)) return `${at} has a forbidden added_paths segment in ${JSON.stringify(p)}`;
	}
	if (typeof r.binary_path !== "string" || r.binary_path === "") return `${at} has no binary_path`;
	if (typeof r.installed_at !== "string") return `${at} has no installed_at`;
	if (r.post_install !== undefined && r.post_install !== "ok" && r.post_install !== "failed") {
		return `${at} has invalid post_install ${JSON.stringify(r.post_install)}`;
	}
	return artifactFieldError(r, at);
}

/** ADAPTER/PATH BINDING: the stored path must equal what the named adapter
 *  derives for the stored scope — a Gemini row pointing at an arbitrary
 *  absolute path is hostile or corrupt, never an install record. */
function bindingError(r: JsonObject, at: string, cwd: string): string | null {
	// SAFETY: runner and scope were validated by fieldError against the
	// adapter registry and the InstallScope union.
	const adapter = getAdapter(r.runner as RunnerId);
	if (adapter === null) return `${at} names a runner with no adapter`;
	const derived = resolveSettingsPath(
		cwd,
		adapter.renderSettingsFragment(r.binary_path as string, r.scope as InstallScope).path,
	);
	if (r.settings_path !== derived) {
		return `${at} settings_path ${JSON.stringify(r.settings_path)} does not match the adapter-derived path ${JSON.stringify(derived)}`;
	}
	return null;
}

/** STRICT per-entry validation; the returned string is the corrupt reason. */
function manifestEntryError(row: unknown, index: number, cwd: string): string | null {
	const at = `entry[${index}]`;
	if (row == null || typeof row !== "object" || Array.isArray(row)) return `${at} is not an object`;
	const r = row as JsonObject;
	return fieldError(r, at) ?? bindingError(r, at, cwd);
}

function coerceManifestEntry(row: unknown): InstallerManifestEntry {
	// SAFETY: callers run manifestEntryError first; every field below was
	// individually type-checked there.
	const r = row as JsonObject & { runner: RunnerId; scope: InstallScope };
	const entry: InstallerManifestEntry = {
		runner: r.runner,
		scope: r.scope,
		settings_path: r.settings_path as string,
		added_paths: r.added_paths as string[],
		binary_path: r.binary_path as string,
		installed_at: r.installed_at as string,
		// A manifest written before `post_install` existed carries no value; read
		// that as "ok" — the field records a KNOWN failure.
		post_install: r.post_install === "failed" ? "failed" : "ok",
		schema_version: MANIFEST_SCHEMA_VERSION,
	};
	if (typeof r.post_install_error === "string") entry.post_install_error = r.post_install_error;
	copyArtifactFields(r, entry);
	return entry;
}

function copyArtifactFields(r: JsonObject, entry: InstallerManifestEntry): void {
	if (r.artifact_kind === "json-settings" || r.artifact_kind === "managed-file") {
		entry.artifact_kind = r.artifact_kind;
	}
	if (typeof r.artifact_sha256 === "string") entry.artifact_sha256 = r.artifact_sha256;
}

export function readManifestState(path: string): ManifestState {
	if (!existsSync(path)) return { kind: "missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		return { kind: "corrupt", reason: err instanceof Error ? err.message : String(err) };
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { kind: "corrupt", reason: "manifest is not a JSON object" };
	}
	const wrapper = parsed as { schema_version?: unknown; entries?: unknown };
	if (wrapper.schema_version !== MANIFEST_SCHEMA_VERSION) {
		return { kind: "corrupt", reason: `unknown schema_version ${JSON.stringify(wrapper.schema_version)}` };
	}
	if (!Array.isArray(wrapper.entries)) {
		return { kind: "corrupt", reason: "manifest has no entries array" };
	}
	const out: InstallerManifestEntry[] = [];
	const seen = new Set<string>();
	// The manifest lives at <cwd>/.interlinked/<file>, so the install root the
	// adapter binding derives paths against is two levels up.
	const cwd = dirname(dirname(path));
	for (let i = 0; i < wrapper.entries.length; i++) {
		const error = manifestEntryError(wrapper.entries[i], i, cwd);
		if (error !== null) return { kind: "corrupt", reason: error };
		const entry = coerceManifestEntry(wrapper.entries[i]);
		// One entry per RUNNER: multi-scope installs of the same runner are not
		// a supported design, and duplicates made uninstall order-dependent.
		if (seen.has(entry.runner)) return { kind: "corrupt", reason: `duplicate row for runner ${entry.runner}` };
		seen.add(entry.runner);
		out.push(entry);
	}
	return { kind: "valid", entries: out };
}

/** Legacy flat reader: missing/corrupt → []. Kept for callers whose contract
 *  is best-effort (status displays); anything that WRITES based on the result
 *  must use {@link readManifestState}. */
export function readManifest(path: string): InstallerManifestEntry[] {
	const state = readManifestState(path);
	return state.kind === "valid" ? state.entries : [];
}

/** Atomic (temp + rename): a crash mid-write must never leave a torn
 *  manifest — the tri-state reader would then refuse every later repair. */
export function writeManifest(path: string, entries: InstallerManifestEntry[]): void {
	ensureDir(dirname(path));
	writeAtomic(path, { schema_version: MANIFEST_SCHEMA_VERSION, entries });
}
