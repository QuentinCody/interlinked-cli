// Structure Commands — Generic Artifact Structure V1 CLI
// All harness/structure imports are lazy (dynamic) to keep startup fast.

import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactFileKey, ArtifactKind } from "../harness/structure/types.js";
import { c } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import { buildAcceptLines, collectAccepts } from "./structure-accept.js";
import type { Issue } from "./structure-helpers.js";
import {
	badge,
	catalogToNode,
	doctorCheckFiles,
	doctorCheckPaths,
	doctorValidateConfig,
	KEY_TO_KIND,
	KIND_TO_CAT,
	pctColor,
	SCAFFOLDS,
	writeJson,
} from "./structure-helpers.js";

// --- Option shapes ---
interface StructureOpts {
	json?: boolean;
}
interface InitOpts extends StructureOpts {
	mode?: string;
	with?: string;
	write?: boolean;
}
interface ScanOpts extends StructureOpts {
	full?: boolean;
	incremental?: boolean;
}
type BaselineOpts = StructureOpts;

// --- Helpers ---
function out(json: boolean | undefined, data: unknown, text: string): void {
	console.log(json ? JSON.stringify(data, null, 2) : text);
}
function fatal(msg: string): never {
	console.error(c.red(`Error: ${msg}`));
	process.exitCode = 1;
	throw new Error(msg);
}
function relTo(cwd: string, p: string): string {
	return p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
}

// --- 1. structure init ---
async function runStructureInit(opts: InitOpts): Promise<void> {
	const cwd = process.cwd();
	const mode = opts.mode || "standard";
	const { VALID_MODES } = await import("../harness/structure/types.js");
	if (!(VALID_MODES as readonly string[]).includes(mode))
		fatal(`Invalid mode "${mode}". Must be one of: ${VALID_MODES.join(", ")}`);

	const cats = opts.with ? opts.with.split(",").map((s) => s.trim()) : [];
	for (const cat of cats) {
		if (!SCAFFOLDS[cat])
			fatal(`Unknown category "${cat}". Available: ${Object.keys(SCAFFOLDS).join(", ")}`);
	}

	const dir = join(cwd, "interlinked");
	const arts: Record<string, string> = {};
	for (const cat of cats) arts[cat] = nonNull(SCAFFOLDS[cat]).file;
	const cfg: JsonObject = { version: 1, mode };
	if (Object.keys(arts).length > 0) cfg.artifacts = arts;

	const files = [
		{ path: join(dir, "structure.json"), data: cfg },
		...cats.map((cat) => ({
			path: join(dir, nonNull(SCAFFOLDS[cat]).file),
			data: nonNull(SCAFFOLDS[cat]).content,
		})),
	];
	const names = files.map((f) => relTo(cwd, f.path));

	if (!opts.write) {
		const lines = [
			c.bold("Structure init (dry-run)"),
			"",
			`  Mode: ${c.cyan(mode)}`,
			`  Categories: ${cats.length > 0 ? cats.join(", ") : c.dim("(none)")}`,
			"",
			c.bold("Files that would be created:"),
		];
		for (const f of files) {
			const tag = existsSync(f.path) ? c.yellow("overwrite") : c.green("create");
			lines.push(`  ${tag}  ${relTo(cwd, f.path)}`);
		}
		lines.push("", c.dim("Run with --write to create files."));
		return out(
			opts.json,
			{ dry_run: true, mode, categories: cats, files: names },
			lines.join("\n"),
		);
	}

	for (const f of files) writeJson(f.path, f.data);
	const lines = [
		c.green("Structure initialized."),
		"",
		`  Mode: ${c.cyan(mode)}`,
		"  Config: interlinked/structure.json",
	];
	if (cats.length > 0) lines.push(`  Artifacts: ${cats.join(", ")}`);
	lines.push("", c.dim("Next: run `interlinked structure scan` to build the artifact catalog."));
	out(opts.json, { created: true, mode, categories: cats, files: names }, lines.join("\n"));
}

export async function structureInitCommand(opts: InitOpts): Promise<void> {
	try {
		await runStructureInit(opts);
	} catch (e) {
		if (process.exitCode === 1) return;
		console.error(c.red(`structure init failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}

// --- 2. structure scan ---
export async function structureScanCommand(opts: ScanOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		const t0 = Date.now();
		const loader = await import("../harness/structure/structure-loader.js");
		const { runAllExtractors } = await import("../harness/structure/extractors/index.js");
		const { ArtifactGraph } = await import("../harness/structure/artifact-graph.js");
		const cm = await import("../harness/structure/cache-manager.js");

		const loaded = loader.loadStructureConfig(cwd);
		const config = loaded.config || loader.getImplicitConfig();
		for (const err of loaded.errors) console.error(c.yellow(`  Warning: ${err}`));

		const existing = cm.readCatalogMeta(cwd);
		const incremental = opts.incremental ?? (opts.full ? false : !!existing);
		if (incremental && !existing) console.log(c.dim("No cache found. Running full scan."));

		const result = runAllExtractors(cwd);
		const graph = new ArtifactGraph();
		for (const n of result.nodes) graph.addNode(n);
		for (const e of result.edges) graph.addEdge(e);

		// Layer declared artifacts from committed manifests onto the extracted graph
		const { layerDeclaredArtifacts } = await import("../harness/structure/structure-checks.js");
		layerDeclaredArtifacts(graph, cwd, config);

		cm.ensureCacheDir(cwd);
		const hash = cm.computeManifestHash(cwd);
		const meta = {
			schema_version: 1 as const,
			cli_version: "0.0.0",
			built_at: new Date().toISOString(),
			repo_root: cwd,
			last_scanned_commit: "",
			manifest_hash: hash,
			extractor_versions: {} as Record<string, number>,
		};
		try {
			const { execSync } = await import("node:child_process");
			meta.last_scanned_commit = execSync("git rev-parse HEAD", {
				cwd,
				encoding: "utf-8",
			}).trim();
		} catch {
			/* intentional: repo metadata is optional outside a git worktree */
		}
		cm.writeCatalogMeta(cwd, meta);

		writeScanCaches(cm, cwd, graph);

		const ms = Date.now() - t0;
		const summary = {
			mode: incremental ? "incremental" : "full",
			nodes: graph.nodeCount,
			edges: graph.edgeCount,
			elapsed_ms: ms,
			config_mode: config.mode,
		};
		out(
			opts.json,
			summary,
			[
				c.green("Scan complete."),
				"",
				`  Mode:    ${c.cyan(summary.mode)} scan`,
				`  Config:  ${c.cyan(config.mode)}`,
				`  Nodes:   ${c.bold(String(summary.nodes))}`,
				`  Edges:   ${c.bold(String(summary.edges))}`,
				`  Time:    ${String(ms)}ms`,
			].join("\n"),
		);
	} catch (e) {
		if (process.exitCode === 1) return;
		console.error(c.red(`structure scan failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}

type CacheModule = typeof import("../harness/structure/cache-manager.js");
type Graph = import("../harness/structure/artifact-graph.js").ArtifactGraph;

// n.id is the global ref (e.g. "public_symbol:pkg-index#createClient"). Extract local_id by stripping the kind prefix.
function extractLocalId(globalRef: string): string {
	const idx = globalRef.indexOf(":");
	return idx >= 0 ? globalRef.slice(idx + 1) : globalRef;
}

function toItems(nodes: import("../harness/structure/types.js").ArtifactNode[]) {
	return nodes.map((n) => ({
		local_id: extractLocalId(n.id),
		global_ref: n.id,
		file: n.file,
		provenance: n.provenance,
		determinism_ceiling: n.determinism_ceiling,
	}));
}

function writeScanCaches(cm: CacheModule, cwd: string, graph: Graph): void {
	cm.writeCategoryCache(cwd, "artifact-nodes", {
		schema_version: 1,
		items: toItems(graph.toNodesJson().nodes),
	});
	cm.writeCategoryCache(cwd, "artifact-edges", {
		schema_version: 1,
		items: graph.toEdgesJson().edges.map((e) => ({
			local_id: e.id,
			global_ref: e.id,
			file: "",
			provenance: e.provenance,
			determinism_ceiling: "fully_deterministic",
		})),
	});
	for (const [kind, cat] of Object.entries(KIND_TO_CAT))
		cm.writeCategoryCache(cwd, cat, {
			schema_version: 1,
			items: toItems(graph.getNodesByKind(kind as ArtifactKind)),
		});

	const adoption = {} as Record<ArtifactFileKey, number>;
	for (const key of Object.keys(SCAFFOLDS)) {
		const nodes = graph.getNodesByKind((KEY_TO_KIND[key] ?? key) as ArtifactKind);
		const decl = nodes.filter((n) => n.provenance === "declared").length;
		adoption[key as ArtifactFileKey] = nodes.length > 0 ? decl / nodes.length : 0;
	}
	cm.writeAdoptionReport(cwd, { schema_version: 1, categories: adoption });
}

// --- 3. structure status ---
export async function structureStatusCommand(opts: StructureOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		const [loader, cm] = await Promise.all([
			import("../harness/structure/structure-loader.js"),
			import("../harness/structure/cache-manager.js"),
		]);
		const loaded = loader.loadStructureConfig(cwd);
		const config = loaded.config || loader.getImplicitConfig();
		const meta = cm.readCatalogMeta(cwd);
		const adopt = cm.readAdoptionReport(cwd);
		const stale = meta ? cm.isCacheStale(cwd, cm.computeManifestHash(cwd)) : true;

		const invalid: string[] = [];
		for (const [key, rel] of Object.entries(config.artifacts)) {
			if (rel && !existsSync(resolve(cwd, "interlinked", rel)))
				invalid.push(`${key}: interlinked/${rel}`);
		}

		const data = {
			config_mode: config.mode,
			implicit: loaded.implicit,
			cache_exists: !!meta,
			cache_stale: stale,
			cache_built_at: meta?.built_at || null,
			adoption: adopt?.categories || null,
			invalid_files: invalid,
			errors: loaded.errors,
		};
		if (opts.json) return out(opts.json, data, "");

		console.log(
			buildStatusLines({ mode: config.mode, loaded, meta, adopt, stale, invalid }).join("\n"),
		);
	} catch (e) {
		console.error(c.red(`structure status failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}

type LoadedStructure = ReturnType<
	typeof import("../harness/structure/structure-loader.js").loadStructureConfig
>;

interface StatusView {
	mode: string;
	loaded: LoadedStructure;
	meta: ReturnType<CacheModule["readCatalogMeta"]>;
	adopt: ReturnType<CacheModule["readAdoptionReport"]>;
	stale: boolean;
	invalid: string[];
}

function buildStatusLines({ mode, loaded, meta, adopt, stale, invalid }: StatusView): string[] {
	const imp = loaded.implicit ? c.dim(" (implicit, no structure.json)") : "";
	let cl = c.dim("not built");
	if (meta && stale) cl = c.yellow("stale");
	else if (meta) cl = c.green("fresh");
	const lines = [
		c.bold("Structure Status"),
		"",
		`  Mode:     ${c.cyan(mode)}${imp}`,
		`  Cache:    ${cl}`,
	];
	if (meta?.built_at) lines.push(`  Built:    ${c.dim(meta.built_at)}`);
	if (adopt) {
		lines.push("", c.bold("  Adoption:"));
		for (const [cat, score] of Object.entries(adopt.categories))
			lines.push(
				`    ${cat.padEnd(12)} ${pctColor(Math.round(score * 100))(`${String(Math.round(score * 100))}%`)}`,
			);
	}
	if (invalid.length > 0) {
		lines.push("", c.yellow("  Invalid manifest references:"));
		for (const f of invalid) lines.push(`    ${c.red("missing")}  ${f}`);
	}
	for (const err of loaded.errors) lines.push(`    ${c.red("error")}  ${err}`);
	return lines;
}

// --- 4. structure accept ---

export async function structureAcceptCommand(opts: StructureOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		const { readCategoryCache } = await import("../harness/structure/cache-manager.js");
		const loader = await import("../harness/structure/structure-loader.js");
		const config = loader.loadStructureConfig(cwd).config || loader.getImplicitConfig();
		const { accepted, skipped } = collectAccepts(cwd, config, readCategoryCache);

		if (opts.json) return out(true, { accepted, skipped }, "");
		if (accepted.length === 0 && skipped.length === 0)
			return void console.log(
				c.dim("Nothing to accept. Run `interlinked structure scan` first."),
			);
		console.log(buildAcceptLines(accepted, skipped).join("\n"));
	} catch (e) {
		console.error(c.red(`structure accept failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}

// --- 5. structure doctor ---
export async function structureDoctorCommand(opts: StructureOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		const loader = await import("../harness/structure/structure-loader.js");
		const { validateStructureJson } = await import("../harness/structure/schema-validator.js");
		const cm = await import("../harness/structure/cache-manager.js");

		const issues: Issue[] = [];
		issues.push(
			...doctorValidateConfig(
				join(cwd, "interlinked", "structure.json"),
				validateStructureJson,
			),
		);
		const loaded = loader.loadStructureConfig(cwd);
		const config = loaded.config || loader.getImplicitConfig();
		issues.push(...doctorCheckFiles(config, cwd, loader.loadArtifactFile));
		issues.push(...doctorCheckPaths(config, cwd, loader.loadArtifactFile));

		const meta = cm.readCatalogMeta(cwd);
		if (!meta)
			issues.push({
				severity: "warning",
				message: "No scan cache. Run `interlinked structure scan`.",
			});
		else if (cm.isCacheStale(cwd, cm.computeManifestHash(cwd)))
			issues.push({
				severity: "warning",
				message: "Scan cache is stale. Re-run `interlinked structure scan`.",
			});

		if (opts.json) return out(true, { issues, total: issues.length }, "");
		if (issues.length === 0)
			return void console.log(c.green("Structure doctor: no issues found."));
		const lines = [c.bold(`Structure Doctor: ${String(issues.length)} issue(s)`), ""];
		for (const i of issues) lines.push(`  ${badge(i.severity)}  ${i.message}`);
		console.log(lines.join("\n"));
		if (issues.some((i) => i.severity === "error")) process.exitCode = 1;
	} catch (e) {
		console.error(c.red(`structure doctor failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}

// --- 6. structure baseline ---
async function blSave(cwd: string, opts: BaselineOpts): Promise<void> {
	const loader = await import("../harness/structure/structure-loader.js");
	const { ArtifactGraph } = await import("../harness/structure/artifact-graph.js");
	const { evaluateStructureRules } = await import("../harness/structure/rules/index.js");
	const { readCategoryCache, writeBaseline } = await import(
		"../harness/structure/cache-manager.js"
	);
	const config = loader.loadStructureConfig(cwd).config || loader.getImplicitConfig();
	const nodes = readCategoryCache(cwd, "artifact-nodes");
	if (!nodes) fatal("No scan cache. Run `interlinked structure scan` first.");
	const graph = new ArtifactGraph();
	for (const item of nodes.items) graph.addNode(catalogToNode(item));
	const findings = evaluateStructureRules(graph, config, [], cwd);
	const bl = {
		schema_version: 1 as const,
		entries: findings.map((f) => ({
			finding_name: f.name,
			artifact_ref: f.artifact_id,
			source_file: f.file,
			determinism: f.determinism,
			required_companion_files: f.required_updates.map((u) => u.file),
			context_hash: "",
		})),
	};
	writeBaseline(cwd, bl);
	out(
		opts.json,
		{ saved: true, entry_count: bl.entries.length },
		`${c.green("Baseline saved.")} ${String(bl.entries.length)} findings baselined.`,
	);
}

function blClear(cwd: string, opts: BaselineOpts): void {
	const p = join(cwd, ".interlinked", "structure-cache", "baseline.json");
	if (existsSync(p)) {
		rmSync(p);
		out(opts.json, { cleared: true }, c.green("Baseline cleared."));
	} else
		out(opts.json, { cleared: false, reason: "no baseline" }, c.dim("No baseline to clear."));
}

async function blStatus(cwd: string, opts: BaselineOpts): Promise<void> {
	const { readBaseline } = await import("../harness/structure/cache-manager.js");
	const bl = readBaseline(cwd);
	if (bl.entries.length === 0)
		return out(opts.json, { exists: false, entry_count: 0 }, c.dim("No baseline saved."));
	const byName: Record<string, number> = {};
	for (const e of bl.entries) byName[e.finding_name] = (byName[e.finding_name] || 0) + 1;
	if (opts.json)
		return out(true, { exists: true, entry_count: bl.entries.length, by_finding: byName }, "");
	const lines = [c.bold(`Baseline: ${String(bl.entries.length)} entries`), ""];
	for (const [name, n] of Object.entries(byName))
		lines.push(`  ${name.padEnd(30)} ${c.bold(String(n))}`);
	console.log(lines.join("\n"));
}

export async function structureBaselineCommand(sub: string, opts: BaselineOpts): Promise<void> {
	try {
		const cwd = process.cwd();
		if (sub === "save") await blSave(cwd, opts);
		else if (sub === "clear") blClear(cwd, opts);
		else if (sub === "status") await blStatus(cwd, opts);
		else fatal(`Unknown baseline subcommand "${sub}". Use: save, clear, status`);
	} catch (e) {
		if (process.exitCode === 1) return;
		console.error(c.red(`structure baseline failed: ${(e as Error).message}`));
		process.exitCode = 1;
	}
}
