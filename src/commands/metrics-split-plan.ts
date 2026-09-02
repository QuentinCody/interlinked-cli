// ===========================================
// interlinked metrics split-plan — where to cut an over-cap file
// ===========================================
// For ONE JS/TS file: build the intra-file reference graph (which top-level
// declarations use which — calls, type uses, constant reads — plus each one's
// external imports), cluster it into 2–4 cohesive groups, and print each
// proposed module with its units, line count, ΣCC, import set, and a
// suggested filename — together with the references the split would turn into
// cross-module imports. Read-only and deterministic: the same file always
// yields the same plan. It is advice, not a refactor; the line-cap gate
// (`large-file-policy.ts`) decides whether the file needs one.
//
// Pieces: `metrics-split-plan-graph.ts` (AST → units + edges) and
// `metrics-split-plan-cluster.ts` (agglomerative grouping).

import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { maxLinesFor } from "../harness/large-file-policy.js";
import { getOutputMode, output } from "../lib/output.js";
import {
	clusterUnits,
	crossClusterEdges,
	DEFAULT_CLUSTER_OPTIONS,
	type SplitCluster,
} from "./metrics-split-plan-cluster.js";
import { buildSplitGraph, type SplitGraph, type SplitUnit } from "./metrics-split-plan-graph.js";

interface SplitPlanUnit {
	name: string;
	kind: SplitUnit["kind"];
	lines: number;
	cyclomatic: number;
	exported: boolean;
}

interface SplitPlanModule {
	/** Suggested basename, next to the source file. */
	file: string;
	units: SplitPlanUnit[];
	lines: number;
	cyclomatic: number;
	imports: string[];
}

interface SplitPlanCrossEdge {
	from: string;
	fromModule: string;
	to: string;
	toModule: string;
}

export interface SplitPlan {
	source: string;
	totalLines: number;
	lineCap: number;
	overCap: boolean;
	unitCount: number;
	/** Header + imports + non-declaration statements; each module re-carries its share. */
	preambleLines: number;
	cyclomatic: number;
	modules: SplitPlanModule[];
	crossEdges: SplitPlanCrossEdge[];
	/** Cross-edge targets that are not exported today. */
	newlyExported: string[];
}

interface SplitPlanOptions {
	lineCap: number;
	maxClusters?: number;
	maxShareOfLines?: number;
}

/** `parseConfig` → `parse-config`, `HTTPServer` → `http-server`, `MAX_LINES` → `max-lines`. */
export function toKebabCase(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.replace(/_+/g, "-")
		.toLowerCase();
}

/** In-cluster in-degree per unit: how many siblings in the same cluster reference it. */
function inClusterInDegree(cluster: SplitCluster, graph: SplitGraph): Map<number, number> {
	const members = new Set(cluster.unitIds);
	const degree = new Map<number, number>();
	for (const e of graph.edges) {
		if (members.has(e.from) && members.has(e.to)) degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
	}
	return degree;
}

/** The unit the cluster is "about": most referenced inside it, exported first, then earliest. */
function hubUnit(cluster: SplitCluster, graph: SplitGraph): SplitUnit | undefined {
	const degree = inClusterInDegree(cluster, graph);
	let best: SplitUnit | undefined;
	let bestScore = -1;
	for (const id of cluster.unitIds) {
		const unit = graph.units[id];
		if (!unit) continue;
		const score = (degree.get(id) ?? 0) * 2 + (unit.exported ? 1 : 0);
		if (score > bestScore) {
			best = unit;
			bestScore = score;
		}
	}
	return best;
}

/** The cluster holding the file's first exported unit keeps the source name. */
function entryClusterIndex(clusters: SplitCluster[], graph: SplitGraph): number {
	const firstExport = graph.units.find((u) => u.exported);
	if (!firstExport) return 0;
	const idx = clusters.findIndex((c) => c.unitIds.includes(firstExport.id));
	return idx < 0 ? 0 : idx;
}

function uniqueName(candidate: string, taken: Set<string>): string {
	if (!taken.has(candidate)) return candidate;
	const ext = extname(candidate);
	const stem = candidate.slice(0, -ext.length);
	let n = 2;
	while (taken.has(`${stem}-${n}${ext}`)) n++;
	return `${stem}-${n}${ext}`;
}

/**
 * The sibling-module suffix for a cluster: the hub's kebab name with the
 * file's own base name stripped off its front (`SimplificationAgentCiRequestV1`
 * in `simplification-agent-ci-request.ts` → `v1`, not the base name twice).
 * When nothing distinctive is left, fall back to the cluster's position.
 */
export function moduleSlug(base: string, hubName: string, index = 0): string {
	const slug = toKebabCase(hubName);
	const stripped = slug.startsWith(`${base}-`) ? slug.slice(base.length + 1) : slug;
	if (stripped === "" || stripped === base) return `part-${index + 1}`;
	return stripped;
}

function suggestFilenames(clusters: SplitCluster[], graph: SplitGraph): string[] {
	const ext = extname(graph.filePath);
	const base = basename(graph.filePath, ext);
	const entry = entryClusterIndex(clusters, graph);
	const taken = new Set<string>();
	return clusters.map((cluster, i) => {
		const hub = hubUnit(cluster, graph);
		const stem = i === entry || !hub ? base : `${base}-${moduleSlug(base, hub.name, i)}`;
		const file = uniqueName(`${stem}${ext}`, taken);
		taken.add(file);
		return file;
	});
}

function toPlanUnit(unit: SplitUnit): SplitPlanUnit {
	return {
		name: unit.name,
		kind: unit.kind,
		lines: unit.lines,
		cyclomatic: unit.cyclomatic,
		exported: unit.exported,
	};
}

function toModule(cluster: SplitCluster, file: string, graph: SplitGraph): SplitPlanModule {
	const units = cluster.unitIds
		.map((id) => graph.units[id])
		.filter((u): u is SplitUnit => u !== undefined)
		.map(toPlanUnit);
	return { file, units, lines: cluster.lines, cyclomatic: cluster.cyclomatic, imports: cluster.imports };
}

function toCrossEdges(clusters: SplitCluster[], files: string[], graph: SplitGraph): SplitPlanCrossEdge[] {
	const fileOf = new Map<number, string>();
	clusters.forEach((c, i) => {
		for (const id of c.unitIds) fileOf.set(id, files[i] ?? "");
	});
	const out: SplitPlanCrossEdge[] = [];
	for (const e of crossClusterEdges(clusters, graph.edges)) {
		const from = graph.units[e.from];
		const to = graph.units[e.to];
		if (!from || !to) continue;
		out.push({
			from: from.name,
			fromModule: fileOf.get(e.from) ?? "",
			to: to.name,
			toModule: fileOf.get(e.to) ?? "",
		});
	}
	return out;
}

/**
 * A proposed module should land under the line cap WITH headroom — a split
 * whose biggest piece sits at 90% of the cap is back over it after the next
 * feature. So the merge share is the tighter of the clusterer's default and
 * `MODULE_HEADROOM × cap` expressed as a share of this file.
 */
const MODULE_HEADROOM = 0.8;

function shareOfLines(graph: SplitGraph, opts: SplitPlanOptions): number {
	if (opts.maxShareOfLines !== undefined) return opts.maxShareOfLines;
	if (graph.totalLines <= 0) return DEFAULT_CLUSTER_OPTIONS.maxShareOfLines;
	const headroomShare = (MODULE_HEADROOM * opts.lineCap) / graph.totalLines;
	return Math.min(DEFAULT_CLUSTER_OPTIONS.maxShareOfLines, headroomShare);
}

/** Assemble the plan for a parsed graph. Pure. */
export function buildSplitPlan(graph: SplitGraph, opts: SplitPlanOptions): SplitPlan {
	const clusters = clusterUnits(graph, {
		...(opts.maxClusters !== undefined ? { maxClusters: opts.maxClusters } : {}),
		maxShareOfLines: shareOfLines(graph, opts),
	});
	const files = suggestFilenames(clusters, graph);
	const crossEdges = toCrossEdges(clusters, files, graph);
	const exportedNames = new Set(graph.units.filter((u) => u.exported).map((u) => u.name));
	const newlyExported = [...new Set(crossEdges.map((e) => e.to))].filter((n) => !exportedNames.has(n)).sort();
	return {
		source: graph.filePath,
		totalLines: graph.totalLines,
		lineCap: opts.lineCap,
		overCap: graph.totalLines > opts.lineCap,
		unitCount: graph.units.length,
		preambleLines: graph.preambleLines,
		cyclomatic: graph.units.reduce((sum, u) => sum + u.cyclomatic, 0),
		modules: clusters.map((c, i) => toModule(c, files[i] ?? "", graph)),
		crossEdges,
		newlyExported,
	};
}

function renderModule(index: number, m: SplitPlanModule): string[] {
	const imports = m.imports.length > 0 ? m.imports.join(", ") : "(none)";
	const lines = [`  ${index + 1}. ${m.file} — ${m.lines} lines, ΣCC ${m.cyclomatic}, imports: ${imports}`];
	for (const u of m.units) {
		const flag = u.exported ? "  export" : "";
		lines.push(
			`       ${u.name.padEnd(32)} ${u.kind.padEnd(8)} ${String(u.lines).padStart(4)} lines  CC ${String(u.cyclomatic).padStart(3)}${flag}`,
		);
	}
	return lines;
}

function renderCrossEdges(plan: SplitPlan): string[] {
	const lines = [`Cross-module references (${plan.crossEdges.length}):`];
	if (plan.crossEdges.length === 0) lines.push("  (none — every reference stays inside its module)");
	for (const e of plan.crossEdges) {
		lines.push(`  ${e.fromModule}:${e.from} → ${e.toModule}:${e.to}`);
	}
	if (plan.newlyExported.length > 0) {
		lines.push(`Needs \`export\` to cross the boundary: ${plan.newlyExported.join(", ")}`);
	}
	return lines;
}

export function renderSplitPlan(plan: SplitPlan): string {
	const capNote = plan.overCap ? "OVER" : "under";
	const lines = [
		`Split plan — ${plan.source}: ${plan.totalLines} lines (cap ${plan.lineCap}, ${capNote}), ` +
			`${plan.unitCount} units, ΣCC ${plan.cyclomatic}, preamble ${plan.preambleLines} lines`,
		"",
	];
	if (plan.modules.length === 0) lines.push("  (no named top-level declarations — nothing to split)");
	plan.modules.forEach((m, i) => lines.push(...renderModule(i, m)));
	lines.push("", ...renderCrossEdges(plan), "");
	lines.push("Preamble (header, imports, statements) is not assigned; each module carries the part it needs.");
	return lines.join("\n");
}

export function renderSplitPlanShort(plan: SplitPlan): string {
	const sizes = plan.modules.map((m) => m.lines).join(" / ");
	return `${plan.source}: ${plan.totalLines} lines → ${plan.modules.length} modules (${sizes} lines), ${plan.crossEdges.length} cross edges`;
}

interface MetricsSplitPlanOpts {
	file: string;
	cwd?: string;
	maxClusters?: string;
	json?: boolean;
	short?: boolean;
}

const JS_TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function fail(message: string): void {
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}

function parseMaxClusters(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return undefined;
	return Math.max(2, Math.min(4, n));
}

/** Public API — wired by `interlinked metrics split-plan <file>` in registrars/metrics.ts. */
export async function metricsSplitPlanCommand(opts: MetricsSplitPlanOpts): Promise<void> {
	const cwd = resolve(opts.cwd || process.cwd());
	const abs = isAbsolute(opts.file) ? opts.file : resolve(cwd, opts.file);
	if (!JS_TS_EXTS.has(extname(abs).toLowerCase())) {
		fail(`split-plan reads JS/TS files only: ${opts.file}`);
		return;
	}
	let content: string;
	try {
		content = readFileSync(abs, "utf-8");
	} catch {
		fail(`cannot read ${opts.file}`);
		return;
	}
	const graph = buildSplitGraph(content, abs);
	if (!graph) {
		fail("split-plan needs the optional `typescript` dependency (AST parse) — install it and retry");
		return;
	}
	const maxClusters = parseMaxClusters(opts.maxClusters);
	const plan = buildSplitPlan(
		{ ...graph, filePath: opts.file },
		{ lineCap: maxLinesFor(cwd), ...(maxClusters !== undefined ? { maxClusters } : {}) },
	);
	output(getOutputMode(opts), plan, {
		json: () => plan,
		short: () => renderSplitPlanShort(plan),
		normal: () => renderSplitPlan(plan),
	});
}
