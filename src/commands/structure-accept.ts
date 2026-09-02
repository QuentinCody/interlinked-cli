// Structure Accept — collection and rendering helpers for `interlinked structure accept`.
// Split out of structure.ts to keep that module under the per-file line cap.

import { join } from "node:path";
import type { CategoryCatalog, StructureConfig } from "../harness/structure/types.js";
import { c } from "../lib/formatter.js";
import type { AcceptBatch, SkipEntry } from "./structure-helpers.js";
import { acceptEnv, acceptSymbols } from "./structure-helpers.js";

type ReadCategoryCache = (cwd: string, name: string) => CategoryCatalog | null;

export function collectAccepts(
	cwd: string,
	config: StructureConfig,
	readCategoryCache: ReadCategoryCache,
): { accepted: AcceptBatch[]; skipped: SkipEntry[] } {
	const dir = join(cwd, "interlinked");
	const accepted: AcceptBatch[] = [];
	const skipped: SkipEntry[] = [];

	const syms = readCategoryCache(cwd, "public-symbols");
	if (syms && syms.items.length > 0) {
		const r = acceptSymbols(
			syms,
			join(dir, config.artifacts.public_api || "artifacts/public-api.json"),
		);
		if (r.accepted > 0) accepted.push({ category: "public_api", count: r.accepted });
		skipped.push(...r.skipped);
	}
	const envs = readCategoryCache(cwd, "env-keys");
	if (envs && envs.items.length > 0) {
		const r = acceptEnv(envs, join(dir, config.artifacts.env || "artifacts/env.json"));
		if (r.accepted > 0) accepted.push({ category: "env", count: r.accepted });
		skipped.push(...r.skipped);
	}
	return { accepted, skipped };
}

export function buildAcceptLines(accepted: AcceptBatch[], skipped: SkipEntry[]): string[] {
	const lines = [c.bold("Structure Accept")];
	for (const a of accepted)
		lines.push(`  ${c.green("accepted")}  ${a.category}: ${String(a.count)} items`);
	if (skipped.length > 0) {
		lines.push("", c.dim("  Skipped (already declared):"));
		for (const s of skipped.slice(0, 10))
			lines.push(`    ${c.yellow("skip")}  ${s.category}/${s.item}: ${s.reason}`);
		if (skipped.length > 10)
			lines.push(c.dim(`    ... and ${String(skipped.length - 10)} more`));
	}
	return lines;
}
