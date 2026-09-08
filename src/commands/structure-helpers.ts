import { ARTIFACT_FILE_KEYS } from "../harness/structure/schema-validator.js";
import { VALID_ARTIFACT_KINDS } from "../harness/structure/types.js";
import { parseWire } from "../lib/value-validation.js";
import { isEditableEnv, isEditablePublicApi } from "./structure-edit-files.js";
import { errorMessage } from "../lib/error-message.js";
// interlinked-tdd: exempt
// Structure command helpers — leaf utilities extracted from structure.ts.
// Pure I/O, formatting, accept-batch, and doctor-check helpers. No module-private
// state from structure.ts; every dependency is an import or a passed-in argument.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
	ArtifactFileKey,
	ArtifactKind,
	CatalogItem,
	StructureConfig,
} from "../harness/structure/types.js";
import { c } from "../lib/formatter.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

// --- Catalog constants ---
export const KEY_TO_KIND: Record<string, ArtifactKind> = {
	public_api: "public_symbol",
	env: "env_key",
	config: "config_key",
	tests: "test",
	docs: "doc",
	examples: "example",
	glossary: "term",
	layers: "layer",
	packages: "package",
};
export const KIND_TO_CAT: Record<string, string> = {
	module: "modules",
	public_symbol: "public-symbols",
	package: "packages",
	env_key: "env-keys",
	config_key: "config-keys",
	test: "tests",
	doc: "docs",
	example: "examples",
	term: "glossary",
	layer: "layers",
};
export const SCAFFOLDS: Record<string, { file: string; content: JsonObject }> = {
	public_api: { file: "artifacts/public-api.json", content: { version: 1, modules: [] } },
	env: {
		file: "artifacts/env.json",
		content: { version: 1, sources: { declarations: [], defaults: [] }, keys: [] },
	},
	config: { file: "artifacts/config.json", content: { version: 1, roots: [], keys: [] } },
	tests: { file: "artifacts/tests.json", content: { version: 1, tests: [] } },
	docs: { file: "artifacts/docs.json", content: { version: 1, docs: [] } },
	examples: { file: "artifacts/examples.json", content: { version: 1, examples: [] } },
	glossary: { file: "artifacts/glossary.json", content: { version: 1, terms: [] } },
	layers: { file: "artifacts/layers.json", content: { version: 1, layers: [], rules: [] } },
	packages: { file: "artifacts/packages.json", content: { version: 1, packages: [] } },
};

// --- I/O helpers ---
export function readJson(path: string, fallback: unknown): unknown {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return fallback;
	}
}
export function writeJson(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

// --- Formatting helpers ---
export function pctColor(pct: number): (s: string) => string {
	if (pct >= 80) return c.green;
	return pct >= 50 ? c.yellow : c.red;
}
export function badge(sev: string): string {
	if (sev === "error") return c.red("ERROR");
	return sev === "warning" ? c.yellow("WARN") : c.dim("INFO");
}

export function catalogToNode(item: CatalogItem): import("../harness/structure/types.js").ArtifactNode {
	const idx = item.global_ref.indexOf(":");
	return {
		id: item.global_ref,
		kind: VALID_ARTIFACT_KINDS.find((kind) => kind === item.global_ref.slice(0, idx)) ?? "module",
		label: item.local_id,
		file: item.file,
		provenance: item.provenance,
		determinism_ceiling: item.determinism_ceiling,
	};
}

// --- structure accept helpers ---
export interface AcceptBatch {
	category: string;
	count: number;
}
export interface SkipEntry {
	category: string;
	item: string;
	reason: string;
}

export function acceptSymbols(
	catalog: import("../harness/structure/types.js").CategoryCatalog,
	path: string,
): { accepted: number; skipped: SkipEntry[] } {
	const file = parseWire(readJson(path, { version: 1, modules: [] }), isEditablePublicApi, "public API artifact");
	// Build set of existing "moduleId#symbolName" entries for dedup
	const have = new Set<string>();
	for (const m of file.modules) for (const s of m.symbols) have.add(`${m.id}#${s.name}`);
	const skipped: SkipEntry[] = [];
	let n = 0;
	for (const item of catalog.items) {
		// local_id is e.g. "pkg-index#createClient" (moduleId#symbolName)
		const localId = item.local_id;
		if (have.has(localId)) {
			skipped.push({ category: "public_api", item: localId, reason: "already declared" });
			continue;
		}
		const hashIdx = localId.indexOf("#");
		const moduleId = hashIdx >= 0 ? localId.slice(0, hashIdx) : localId;
		const symbolName = hashIdx >= 0 ? localId.slice(hashIdx + 1) : localId;
		let mod = file.modules.find((m) => m.id === moduleId);
		if (!mod) {
			mod = { id: moduleId, file: item.file, symbols: [] };
			file.modules.push(mod);
		}
		mod.symbols.push({
			name: symbolName,
			kind: "function",
			stability: "public",
			docs: [],
			tests: [],
			examples: [],
		});
		have.add(localId);
		n++;
	}
	if (n > 0) writeJson(path, file);
	return { accepted: n, skipped };
}

export function acceptEnv(
	catalog: import("../harness/structure/types.js").CategoryCatalog,
	path: string,
): { accepted: number; skipped: SkipEntry[] } {
	const file = parseWire(readJson(path, {
		version: 1,
		sources: { declarations: [], defaults: [] },
		keys: [],
	}), isEditableEnv, "environment artifact");
	const have = new Set(file.keys.map((k) => k.name));
	const skipped: SkipEntry[] = [];
	let n = 0;
	for (const item of catalog.items) {
		const name = item.local_id;
		if (have.has(name)) {
			skipped.push({ category: "env", item: name, reason: "already declared" });
			continue;
		}
		file.keys.push({
			name,
			required: false,
			docs: [],
			tests: [],
			examples: [],
			default_sources: [],
		});
		n++;
	}
	if (n > 0) writeJson(path, file);
	return { accepted: n, skipped };
}

// --- structure doctor helpers ---
export interface Issue {
	severity: "error" | "warning" | "info";
	message: string;
}

export function doctorValidateConfig(
	path: string,
	validateFn: (d: unknown) => import("../harness/structure/schema-validator.js").ValidationResult,
): Issue[] {
	if (!existsSync(path))
		return [
			{
				severity: "info",
				message: "No interlinked/structure.json found (implicit minimal mode)",
			},
		];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		return [
			{ severity: "error", message: `structure.json: invalid JSON: ${errorMessage(e)}` },
		];
	}
	const result = validateFn(parsed);
	return result.valid
		? []
		: result.errors.map((e) => ({
				severity: "error" as const,
				message: `structure.json ${e.path}: ${e.message}`,
			}));
}

export function doctorCheckFiles(
	config: StructureConfig,
	cwd: string,
	load: (
		cwd: string,
		key: ArtifactFileKey,
		rel: string,
	) => { data: JsonObject | null; errors: string[] },
): Issue[] {
	const issues: Issue[] = [];
	for (const key of ARTIFACT_FILE_KEYS) {
		const rel = config.artifacts[key];
		if (!rel) continue;
		if (!existsSync(resolve(cwd, "interlinked", rel))) {
			issues.push({
				severity: "error",
				message: `Artifact file missing: interlinked/${rel}`,
			});
			continue;
		}
		for (const err of load(cwd, key, rel).errors)
			issues.push({ severity: "error", message: `${key} (${rel}): ${err}` });
	}
	return issues;
}

function extractPathsFromData(data: JsonObject): string[] {
	const paths: string[] = [];
	for (const col of ["modules", "tests", "docs", "examples", "packages"]) {
		const arr = data[col];
		if (!Array.isArray(arr)) continue;
		for (const item of arr) {
			if (!isJsonObject(item)) continue;
			const rec = item;
			if (typeof rec.file === "string") paths.push(rec.file);
			if (typeof rec.root === "string") paths.push(rec.root);
		}
	}
	return paths;
}

export function doctorCheckPaths(
	config: StructureConfig,
	cwd: string,
	load: (
		cwd: string,
		key: ArtifactFileKey,
		rel: string,
	) => { data: JsonObject | null; errors: string[] },
): Issue[] {
	const issues: Issue[] = [];
	for (const key of ARTIFACT_FILE_KEYS) {
		const rel = config.artifacts[key];
		if (!rel) continue;
		const { data } = load(cwd, key, rel);
		if (!data) continue;
		for (const fp of extractPathsFromData(data)) {
			if (!existsSync(resolve(cwd, fp)))
				issues.push({
					severity: "warning",
					message: `${key}: declared path not found: ${fp}`,
				});
		}
	}
	return issues;
}
