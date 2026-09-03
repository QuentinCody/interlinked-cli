// ===========================================
// Env Extractor — discovers environment variable references
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { nonNull } from "../../../lib/non-null.js";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
import { consumeWalkEntry, createWalkBudget, type WalkBudget, warnWalkTruncated } from "./bounded-walk.js";
import { isRootScratchDir, resolveIgnoredDirs, SHARED_SKIP_DIRS } from "./skip-dirs.js";

const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".rs",
	".go",
	".java",
	".c",
	".cpp",
	".h",
]);

const SKIP_DIRS = SHARED_SKIP_DIRS;

const ENV_PATTERNS = [
	/process\.env\.([A-Z][A-Z0-9_]*)/g,
	/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
	/os\.Getenv\("([A-Z][A-Z0-9_]*)"\)/g,
	/os\.environ\["([A-Z][A-Z0-9_]*)"\]/g,
	/getenv\("([A-Z][A-Z0-9_]*)"\)/g,
	/std::env::var\("([A-Z][A-Z0-9_]*)"\)/g,
];

export const metadata: ExtractorMetadata = {
	name: "env-extractor",
	supported_patterns: [
		"process.env.*",
		"import.meta.env.*",
		"os.Getenv()",
		"os.environ[]",
		"getenv()",
		"std::env::var()",
	],
	output_kinds: ["env_key"],
	provenance: "extracted",
	max_determinism: "partially_deterministic",
	version: 1,
};

type EnvKeyMap = Map<string, { provenance: "extracted" | "declared"; file: string }>;

function scanFile(filePath: string, content: string, envKeys: EnvKeyMap): void {
	for (const pattern of ENV_PATTERNS) {
		pattern.lastIndex = 0;
		for (;;) {
			const match = pattern.exec(content);
			if (match === null) break;
			const key = nonNull(match[1]);
			if (!envKeys.has(key)) {
				envKeys.set(key, { provenance: "extracted", file: filePath });
			}
		}
	}
}

/** Classify ONE file into its env_key nodes: declared keys from `.env.example`,
 *  or extracted `process.env.X`-style refs from a source file. Reads the file
 *  (catch → no keys) so it works per-edited-file in the incremental refresh;
 *  aggregate dedup is the caller's job. `extract` keeps its own walk + ordering
 *  (`.env.example` first so declared wins). */
export function classifyFile(repoRoot: string, relPath: string): ExtractorResult {
	const name = path.basename(relPath);
	const envKeys: EnvKeyMap = new Map();
	if (name === ".env.example") {
		try {
			const content = fs.readFileSync(path.join(repoRoot, relPath), "utf-8");
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "" || trimmed.startsWith("#")) continue;
				const eqIdx = trimmed.indexOf("=");
				const key = eqIdx >= 0 ? trimmed.slice(0, eqIdx).trim() : trimmed;
				if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
					envKeys.set(key, { provenance: "declared", file: relPath });
				}
			}
		} catch {
			return { nodes: [], edges: [] };
		}
	} else if (SOURCE_EXTENSIONS.has(path.extname(name))) {
		try {
			const content = fs.readFileSync(path.join(repoRoot, relPath), "utf-8");
			scanFile(relPath, content, envKeys);
		} catch {
			return { nodes: [], edges: [] };
		}
	}
	const nodes: ArtifactNode[] = [];
	for (const [key, info] of envKeys) {
		nodes.push({
			id: makeGlobalRef("env_key", key),
			kind: "env_key",
			label: key,
			file: info.file,
			provenance: info.provenance,
			determinism_ceiling: "partially_deterministic",
		});
	}
	return { nodes, edges: [] };
}

interface WalkContext {
	repoRoot: string;
	envKeys: EnvKeyMap;
	budget: WalkBudget;
	ignoredDirs?: ReadonlySet<string>;
}

/** Process one directory entry during the walk. Returns true when the caller
 *  should stop iterating (budget exhausted, or a recursive descent tripped
 *  the truncation flag) — mirrors the `return`/`continue` split that used to
 *  live inline in `walkDir`'s loop body. */
function processEntry(dir: string, entry: fs.Dirent, ctx: WalkContext): boolean {
	// Hard cap: stop descending/iterating once the entry or time budget trips.
	if (!consumeWalkEntry(ctx.budget)) return true;
	if (entry.isDirectory()) {
		const sub = path.join(dir, entry.name);
		if (SKIP_DIRS.has(entry.name) || isRootScratchDir(ctx.repoRoot, sub) || ctx.ignoredDirs?.has(sub)) return false;
		walkDir(sub, ctx);
		return ctx.budget.truncated;
	}
	if (entry.isFile()) {
		const ext = path.extname(entry.name);
		if (!SOURCE_EXTENSIONS.has(ext)) return false;
		const fullPath = path.join(dir, entry.name);
		const relPath = path.relative(ctx.repoRoot, fullPath);
		try {
			const content = fs.readFileSync(fullPath, "utf-8");
			scanFile(relPath, content, ctx.envKeys);
		} catch (_err) {
			void 0; /* intentional: skip unreadable files */
		}
	}
	return false;
}

function walkDir(dir: string, ctx: WalkContext): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (processEntry(dir, entry, ctx)) return;
	}
}

function scanEnvExample(repoRoot: string, envKeys: EnvKeyMap): void {
	const examplePath = path.join(repoRoot, ".env.example");
	try {
		const content = fs.readFileSync(examplePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;
			const eqIdx = trimmed.indexOf("=");
			const key = eqIdx >= 0 ? trimmed.slice(0, eqIdx).trim() : trimmed;
			if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
				envKeys.set(key, { provenance: "declared", file: ".env.example" });
			}
		}
	} catch (_err) {
		void 0; /* intentional: no .env.example present */
	}
}

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	const envKeys: EnvKeyMap = new Map();
	scanEnvExample(repoRoot, envKeys);
	walkDir(repoRoot, { repoRoot, envKeys, budget, ignoredDirs: resolveIgnoredDirs(repoRoot) });
	if (budget.truncated) warnWalkTruncated(metadata.name, repoRoot);
	const nodes: ArtifactNode[] = [];
	for (const [key, info] of envKeys) {
		nodes.push({
			id: makeGlobalRef("env_key", key),
			kind: "env_key",
			label: key,
			file: info.file,
			provenance: info.provenance,
			determinism_ceiling: "partially_deterministic",
		});
	}
	return { nodes, edges: [] };
}
