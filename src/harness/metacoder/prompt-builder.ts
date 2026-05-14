// ===========================================
// Metacoder — Prompt context builder
// ===========================================
// Assembles the JSON input the metacoder LLM receives. Inputs come from:
//
//   - The PII-scanner-redacted prompt (caller's job; see plan §6)
//   - AGENTS.md / CLAUDE.md / .clinerules/*.md from the project root
//   - Floor rule ids from the current GuardRulesConfig
//   - Optional project graph summary from `.interlinked/structure-cache/`
//
// All disk reads are wrapped in best-effort try/catch — a malformed file
// degrades to "no input from that source", never throws. Total
// `project_instructions` length is capped so the metacoder doesn't see a
// 200kB AGENTS.md.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { AgentSource } from "../types.js";
import { overlayIdPrefix } from "./overlay-loader.js";
import type { MetacoderConfig, MetacoderInputContext } from "./types.js";

const PROJECT_INSTRUCTIONS_BYTE_CAP = 20_000;
const PROJECT_INSTRUCTIONS_HARD_CAP = 25_000; // safety margin for joined separators
const PER_FILE_BYTE_CAP = 8_000;

const TOP_LEVEL_GUIDANCE_FILES = [
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
	"INSTRUCTIONS.md",
] as const;

const CLINERULES_DIR = ".clinerules";

export interface BuildContextInput {
	prompt: string;
	client: AgentSource;
	sessionId: string;
	cwd: string;
	floorRuleIds: string[];
	config: MetacoderConfig;
}

/** Public API — consumed by `src/harness/metacoder/index.ts::runMetacoderForPrompt`
 *  to assemble the JSON envelope sent to the metacoder LLM. Pure-ish: reads
 *  disk under `cwd`, never writes. Disk failures degrade silently. */
export function buildMetacoderContext(input: BuildContextInput): MetacoderInputContext {
	const projectInstructions = readProjectInstructions(input.cwd);
	const projectGraphSummary = readProjectGraphSummary(input.cwd);
	return {
		prompt: input.prompt,
		client: input.client,
		session_id: input.sessionId,
		cwd: input.cwd,
		overlay_prefix: overlayIdPrefix(input.sessionId),
		project_instructions: projectInstructions,
		floor_rule_ids: input.floorRuleIds,
		project_graph_summary: projectGraphSummary,
	};
}

// ============================================================================
// Project guidance reader
// ============================================================================

function readProjectInstructions(cwd: string): string {
	const parts: string[] = [];
	let remaining = PROJECT_INSTRUCTIONS_BYTE_CAP;

	for (const filename of TOP_LEVEL_GUIDANCE_FILES) {
		if (remaining <= 0) break;
		const path = join(cwd, filename);
		const text = readFileCapped(path, Math.min(PER_FILE_BYTE_CAP, remaining));
		if (text === null) continue;
		parts.push(`# ${filename}\n${text}`);
		remaining -= text.length;
	}

	const clinerules = readClinerules(cwd, remaining);
	if (clinerules.length > 0) {
		parts.push(clinerules);
	}

	const joined = parts.join("\n\n");
	if (joined.length > PROJECT_INSTRUCTIONS_HARD_CAP) {
		return joined.slice(0, PROJECT_INSTRUCTIONS_HARD_CAP);
	}
	return joined;
}

function readClinerules(cwd: string, budget: number): string {
	if (budget <= 0) return "";
	const dir = join(cwd, CLINERULES_DIR);
	if (!existsSync(dir)) return "";
	let entries: string[];
	try {
		entries = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
	} catch (_err) {
		return "";
	}
	const parts: string[] = [];
	let remaining = budget;
	for (const name of entries) {
		if (remaining <= 0) break;
		const path = join(dir, name);
		const text = readFileCapped(path, Math.min(PER_FILE_BYTE_CAP, remaining));
		if (text === null) continue;
		parts.push(`# ${CLINERULES_DIR}/${name}\n${text}`);
		remaining -= text.length;
	}
	return parts.join("\n\n");
}

function readFileCapped(path: string, byteCap: number): string | null {
	if (!existsSync(path)) return null;
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return null;
		const raw = readFileSync(path, "utf-8");
		return raw.length > byteCap ? raw.slice(0, byteCap) : raw;
	} catch (_err) {
		return null;
	}
}

// ============================================================================
// Project graph summary
// ============================================================================

function readProjectGraphSummary(cwd: string): string | undefined {
	const cacheDir = join(cwd, ".interlinked", "structure-cache");
	const metaPath = join(cacheDir, "catalog-meta.json");
	if (!existsSync(metaPath)) return undefined;
	try {
		const raw = readFileSync(metaPath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		return formatGraphSummary(parsed, cacheDir);
	} catch (_err) {
		return undefined;
	}
}

/** Format the actual `CatalogMeta` schema written by
 *  `src/harness/structure/cache-manager.ts::writeCatalogMeta`. The real
 *  shape is `{ schema_version, cli_version, built_at, repo_root,
 *  last_scanned_commit, manifest_hash, extractor_versions }` — NOT
 *  `file_count` / `by_extension`, which a previous version of this code
 *  invented. The per-category item counts live in sibling
 *  `<category>.json` files (e.g. `module.json`, `package.json`); we sum
 *  those for a useful "N catalog items" signal. Plan §reviewer-P3
 *  (round 6). */
function formatGraphSummary(meta: unknown, cacheDir: string): string | undefined {
	if (!isPlainRecord(meta)) return undefined;
	if (meta.schema_version !== 1) return undefined;
	const parts: string[] = [];
	if (typeof meta.last_scanned_commit === "string" && meta.last_scanned_commit.length > 0) {
		parts.push(`commit ${meta.last_scanned_commit.slice(0, 8)}`);
	}
	if (typeof meta.built_at === "string" && meta.built_at.length > 0) {
		parts.push(`indexed ${meta.built_at}`);
	}
	const itemCount = countCatalogedItems(cacheDir);
	if (itemCount !== null) parts.push(`${itemCount} catalog items`);
	return parts.length > 0 ? parts.join("; ") : undefined;
}

/** Sum `items.length` across every sibling `<category>.json` in the
 *  structure-cache directory. Each cache file matches `CategoryCatalog`
 *  shape `{ schema_version, items: [...] }`. Returns null on any failure
 *  (cache empty, files missing, parse errors) so the caller drops the
 *  summary field entirely rather than emitting a misleading zero. */
function countCatalogedItems(cacheDir: string): number | null {
	if (!existsSync(cacheDir)) return null;
	let entries: string[];
	try {
		entries = readdirSync(cacheDir);
	} catch {
		return null;
	}
	let total = 0;
	let counted = 0;
	for (const name of entries) {
		if (!name.endsWith(".json")) continue;
		if (name === "catalog-meta.json" || name === "baseline.json") continue;
		try {
			const raw = readFileSync(join(cacheDir, name), "utf-8");
			const parsed = JSON.parse(raw) as { items?: unknown };
			if (Array.isArray(parsed.items)) {
				total += parsed.items.length;
				counted++;
			}
		} catch {
			// best-effort; skip unreadable files
		}
	}
	return counted > 0 ? total : null;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
