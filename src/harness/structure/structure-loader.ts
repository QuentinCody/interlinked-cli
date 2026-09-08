// ===========================================
// Generic Artifact Structure V1 — Structure Loader
// ===========================================
// Loads interlinked/structure.json, validates, resolves mode defaults,
// and loads artifact files.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import {
	resolveStructureConfig,
	validateArtifactFile,
	validateDeclaredPaths,
	validateStructureJson,
} from "./schema-validator.js";
import type { ArtifactFileKey, StructureConfig, StructureMode } from "./types.js";
import { DEFAULT_ADOPTION_THRESHOLDS, DEFAULT_BUILTINS, MODE_DEFAULTS } from "./types.js";
// -------------------------------------------
// Load structure.json
// -------------------------------------------

export interface LoadStructureResult {
	config: StructureConfig | null;
	errors: string[];
	implicit: boolean;
}

export function loadStructureConfig(repoRoot: string): LoadStructureResult {
	const structurePath = resolve(repoRoot, "interlinked", "structure.json");

	if (!existsSync(structurePath)) {
		// Implicit minimal mode per spec — no structure.json is valid
		return { config: null, errors: [], implicit: true };
	}

	let raw: string;
	try {
		raw = readFileSync(structurePath, "utf-8");
	} catch {
		return { config: null, errors: [`Failed to read ${structurePath}`], implicit: false };
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			config: null,
			errors: [`Invalid JSON in structure.json: ${msg}`],
			implicit: false,
		};
	}

	// Validate structure
	const validation = validateStructureJson(data);
	if (!validation.valid || !isJsonObject(data)) {
		const errors = validation.errors.map((e) => `${e.path}: ${e.message}`);
		return { config: null, errors, implicit: false };
	}

	// Resolve with mode defaults
	const config = resolveStructureConfig(data);

	// Check declared file paths exist
	const pathErrors = validateDeclaredPaths(config, repoRoot);
	const errorStrings = pathErrors.map((e) => `${e.path}: ${e.message}`);

	return { config, errors: errorStrings, implicit: false };
}

// -------------------------------------------
// Load individual artifact file
// -------------------------------------------

export interface LoadArtifactResult {
	data: JsonObject | null;
	errors: string[];
}

export function loadArtifactFile(
	repoRoot: string,
	key: ArtifactFileKey,
	relPath: string,
): LoadArtifactResult {
	const absPath = resolve(repoRoot, "interlinked", relPath);

	if (!existsSync(absPath)) {
		return { data: null, errors: [`File not found: interlinked/${relPath}`] };
	}

	let raw: string;
	try {
		raw = readFileSync(absPath, "utf-8");
	} catch {
		return { data: null, errors: [`Failed to read interlinked/${relPath}`] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { data: null, errors: [`Invalid JSON in ${relPath}: ${msg}`] };
	}

	const validation = validateArtifactFile(key, parsed);
	if (!validation.valid || !isJsonObject(parsed)) {
		const errors = validation.errors.map((e) => `${e.path}: ${e.message}`);
		return { data: null, errors };
	}

	return { data: parsed, errors: [] };
}

// -------------------------------------------
// Implicit (no structure.json) config
// -------------------------------------------

export function getImplicitConfig(): StructureConfig {
	const mode: StructureMode = "minimal";
	const defaults = MODE_DEFAULTS[mode];

	return {
		version: 1,
		mode,
		artifacts: {},
		verify: { ...defaults.verify },
		posttooluse: { ...defaults.posttooluse },
		adoption: {
			coverage_thresholds: { ...DEFAULT_ADOPTION_THRESHOLDS },
		},
		builtins: { ...DEFAULT_BUILTINS },
	};
}
