// ===========================================
// Registry Parity Detector
// ===========================================
// Detects drift between paired registries / exception lists in any
// codebase. Configurable via `.interlinked/registry-parity.json` so each
// project declares its own pairs. Generic mechanism — no project-specific
// knowledge baked in.
//
// Use case: you maintain two arrays of `{ check, ... }` entries in
// different files (e.g. a hook-side registry and a CLI-side registry),
// and a contributor must update both whenever they add an entry. Without
// drift detection, divergence is silent. With this check, drift surfaces
// at `interlinked verify` time as a project-level finding.
//
// Each pair has a `name`, two source files with regex-extracted IDs, and
// optional asymmetric allowlists for IDs that legitimately exist on only
// one side (e.g. checks deliberately not mirrored to offline verify).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonObject } from "../lib/json-types.js";

interface RegistrySource {
	/** Path relative to cwd. */
	file: string;
	/** Regex with one capture group. Each capture-1 match is one ID. */
	key_re: string;
}

export interface RegistryPair {
	name: string;
	left: RegistrySource;
	right: RegistrySource;
	/** IDs allowed to exist on `left` but not `right`. */
	left_only_allowed?: readonly string[];
	/** IDs allowed to exist on `right` but not `left`. */
	right_only_allowed?: readonly string[];
}

export interface RegistryParityConfig {
	pairs: readonly RegistryPair[];
}

type RegistryDriftKind =
	| "missing-from-right"
	| "missing-from-left"
	| "missing-file";

export interface RegistryDriftFinding {
	pair: string;
	kind: RegistryDriftKind;
	id: string;
	source_file: string;
	target_file: string;
	message: string;
}

export const REGISTRY_PARITY_CONFIG_PATH = ".interlinked/registry-parity.json";

/** Load and validate the per-project config. Returns null if not present. */
export function loadRegistryParityConfig(cwd: string): RegistryParityConfig | null {
	const path = join(cwd, REGISTRY_PARITY_CONFIG_PATH);
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`registry-parity config at ${path} is not valid JSON: ${(err as Error).message}`,
			{ cause: err },
		);
	}
	return validateConfig(parsed);
}

function validateConfig(value: unknown): RegistryParityConfig {
	if (!isObject(value)) throw new Error("registry-parity config must be an object");
	const pairs = value.pairs;
	if (!Array.isArray(pairs)) throw new Error("registry-parity.pairs must be an array");
	return { pairs: pairs.map((p, i) => validatePair(p, `pairs[${i}]`)) };
}

function validatePair(value: unknown, ctx: string): RegistryPair {
	if (!isObject(value)) throw new Error(`${ctx} must be an object`);
	return {
		name: requireString(value.name, `${ctx}.name`),
		left: validateSource(value.left, `${ctx}.left`),
		right: validateSource(value.right, `${ctx}.right`),
		left_only_allowed: arrayOfString(value.left_only_allowed, `${ctx}.left_only_allowed`),
		right_only_allowed: arrayOfString(value.right_only_allowed, `${ctx}.right_only_allowed`),
	};
}

function validateSource(value: unknown, ctx: string): RegistrySource {
	if (!isObject(value)) throw new Error(`${ctx} must be an object`);
	return {
		file: requireString(value.file, `${ctx}.file`),
		key_re: requireString(value.key_re, `${ctx}.key_re`),
	};
}

function isObject(v: unknown): v is JsonObject {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function requireString(v: unknown, ctx: string): string {
	if (typeof v !== "string") throw new Error(`${ctx} must be a string`);
	return v;
}

function arrayOfString(v: unknown, ctx: string): readonly string[] {
	if (v === undefined) return [];
	if (!Array.isArray(v)) throw new Error(`${ctx} must be an array`);
	for (const item of v) {
		if (typeof item !== "string") throw new Error(`${ctx} entries must be strings`);
	}
	return v as readonly string[];
}

/** Extract IDs from `content` using `pattern`. Pattern must have one
 *  capture group; each capture-1 match becomes one ID. */
export function extractKeys(content: string, pattern: string): Set<string> {
	const re = new RegExp(pattern, "g");
	const out = new Set<string>();
	let m: RegExpExecArray | null;
	for (;;) {
		m = re.exec(content);
		if (m === null) break;
		if (m[1] !== undefined) out.add(m[1]);
	}
	return out;
}

/**
 * Compare already-read LEFT/RIGHT content for one pair and return its drift
 * findings — the reusable core of {@link checkRegistryParity}. Takes plain
 * strings (not paths) so a caller with a non-working-tree source of content
 * (a `git show :<path>` staged blob, for the commit-time backstop in
 * `evaluator/commit-registry-parity-gate.ts`) can reuse the exact same
 * comparison rather than re-deriving it.
 */
export function diffPairContent(
	pair: RegistryPair,
	leftContent: string,
	rightContent: string,
): RegistryDriftFinding[] {
	const findings: RegistryDriftFinding[] = [];
	const leftKeys = extractKeys(leftContent, pair.left.key_re);
	const rightKeys = extractKeys(rightContent, pair.right.key_re);
	const leftOnlyAllowed = new Set(pair.left_only_allowed ?? []);
	const rightOnlyAllowed = new Set(pair.right_only_allowed ?? []);

	for (const id of leftKeys) {
		if (rightKeys.has(id)) continue;
		if (leftOnlyAllowed.has(id)) continue;
		findings.push({
			pair: pair.name,
			kind: "missing-from-right",
			id,
			source_file: pair.left.file,
			target_file: pair.right.file,
			message: `[${pair.name}] "${id}" is in ${pair.left.file} but not ${pair.right.file}`,
		});
	}
	for (const id of rightKeys) {
		if (leftKeys.has(id)) continue;
		if (rightOnlyAllowed.has(id)) continue;
		findings.push({
			pair: pair.name,
			kind: "missing-from-left",
			id,
			source_file: pair.right.file,
			target_file: pair.left.file,
			message: `[${pair.name}] "${id}" is in ${pair.right.file} but not ${pair.left.file}`,
		});
	}
	return findings;
}

/** Run drift detection across all configured pairs. */
export function checkRegistryParity(
	config: RegistryParityConfig,
	cwd: string,
): RegistryDriftFinding[] {
	const findings: RegistryDriftFinding[] = [];
	for (const pair of config.pairs) {
		const leftAbs = resolve(cwd, pair.left.file);
		const rightAbs = resolve(cwd, pair.right.file);

		if (!existsSync(leftAbs)) {
			findings.push({
				pair: pair.name,
				kind: "missing-file",
				id: pair.left.file,
				source_file: pair.left.file,
				target_file: pair.right.file,
				message: `Left file missing: ${pair.left.file}`,
			});
			continue;
		}
		if (!existsSync(rightAbs)) {
			findings.push({
				pair: pair.name,
				kind: "missing-file",
				id: pair.right.file,
				source_file: pair.right.file,
				target_file: pair.left.file,
				message: `Right file missing: ${pair.right.file}`,
			});
			continue;
		}

		findings.push(
			...diffPairContent(
				pair,
				readFileSync(leftAbs, "utf-8"),
				readFileSync(rightAbs, "utf-8"),
			),
		);
	}
	return findings;
}

/** Convenience wrapper that loads config + runs detection. Returns an
 *  empty array if no config exists (no-op for projects that don't opt in). */
export function runRegistryParityCheck(cwd: string): RegistryDriftFinding[] {
	const config = loadRegistryParityConfig(cwd);
	if (!config) return [];
	return checkRegistryParity(config, cwd);
}
