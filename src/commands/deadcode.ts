// ===========================================
// `interlinked deadcode` — whole-repo dead-code scan (plan 25 follow-on)
// ===========================================
// The SCAN half of the two dead-code controls (operator decision 2026-08-17):
// per-edit detection lives in the structural checks (`dead_imports` /
// `dead_exports`, gated by `structural_checks.enabled`); this verb sweeps the
// WHOLE repo on demand. Three layers, weakest-claim-first, and every section
// is labeled a CANDIDATE list — import analysis cannot see runtime-loaded
// files (fixtures loaded by path, dynamic imports), so a row here is a lead
// to verify, never a deletion order. The fourth layer — behaviorally inert
// code inside reachable functions — belongs to mutation adjudication
// (`interlinked mutation disposition`), not to reachability analysis.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
	findDeadExports,
	findDeadTypeExports,
	type DeadExportsRepo,
} from "../harness/checks/dead-exports-inline.js";
import { getGitSourceFiles } from "../harness/checks/export-ripple.js";
import { ProjectGraph } from "../harness/project-graph.js";
import { isJsonObject } from "../lib/json-types.js";
import { findDeadImports } from "./check-dead-imports.js";

const WALK_SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".interlinked"]);

/** Plain recursive walk (no git dependency — the scan must work in any tree). */
function walkSourceFiles(root: string, dir = "src"): string[] {
	const out: string[] = [];
	const absDir = join(root, dir);
	if (!existsSync(absDir)) return out;
	for (const name of readdirSync(absDir)) {
		if (WALK_SKIP_DIRS.has(name)) continue;
		const rel = `${dir}/${name}`;
		try {
			if (statSync(join(root, rel)).isDirectory()) out.push(...walkSourceFiles(root, rel));
			else if (/\.[jt]sx?$/.test(name)) out.push(rel);
		} catch (err) {
			void err; // vanished mid-walk — skip
		}
	}
	return out;
}

const TEST_OR_FIXTURE_RE =
	/\.(test|spec|bench)\.[jt]sx?$|(^|\/)__tests__\/|(^|\/)__fixtures__\/|(^|\/)__mocks__\/|(^|\/)(?:test|tests|bench|benchmarks?|fixtures?|evals?)\/|\.d\.ts$|(^|\/)(?:generated|__generated__)\//;

export interface DeadImportBinding {
	file: string;
	binding: string;
}

export interface DeadExportFinding {
	file: string;
	detail: string;
}

export interface DeadCodeReport {
	/** Repo-relative files no other source file imports (entry points excluded). */
	unreachableFiles: string[];
	/** Import bindings never referenced in their own file's body. */
	deadImportBindings: DeadImportBinding[];
	/** Exported symbols the cross-file detector finds no consumer for. */
	deadExports: DeadExportFinding[];
	/** Exported TYPES (interfaces / aliases / `export type {…}`) with no
	 *  consumer. Separate lane: types are erased at compile time, so deletion
	 *  can never change runtime behavior — only external consumers gate it. */
	deadTypeExports: DeadExportFinding[];
	/** Files alive ONLY because test files import them (categorizer signal). */
	testOnlyImporterFiles?: string[];
	/** How many files the scan covered. */
	scannedFiles: number;
	/** Exact repository-relative files whose contents the scan inspected. */
	scannedPaths: string[];
}

/** Collect entries declared by package.json: `bin` targets (mapped
 *  dist/x.js → src/x.ts) and any source file named in ANY script value —
 *  a file an npm script runs is reachable by definition, whatever the
 *  script is called (build, docs, bench, …). */
function packageJsonEntries(cwd: string, entries: Set<string>): void {
	const raw: unknown = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
	if (!isJsonObject(raw)) return;
	if (isJsonObject(raw.bin)) {
		for (const v of Object.values(raw.bin)) {
			if (typeof v === "string") {
				entries.add(v.replace(/^\.\//, "").replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
			}
		}
	}
	const scripts = isJsonObject(raw.scripts) ? raw.scripts : {};
	for (const v of Object.values(scripts)) {
		if (typeof v !== "string") continue;
		for (const m of v.matchAll(/[\w./-]+\.(?:tsx?|[cm]?js)\b/g)) {
			entries.add(m[0].replace(/^\.\//, ""));
		}
	}
}

/** Entry points that are reachable by definition. Beyond package.json:
 *  root-level tool config files (vitest/tsup/eslint/… load them by path or
 *  --config flag, never by import), and a `src/index.*` under any directory
 *  carrying its own package.json or wrangler manifest (an embedded
 *  sub-project — its entry is invisible to this repo's import graph).
 *  Fail-soft: unreadable/missing package.json ⇒ conventional entries only. */
function entryPoints(cwd: string, files: readonly string[]): Set<string> {
	const entries = new Set<string>(["src/index.ts", "src/index.tsx"]);
	try {
		packageJsonEntries(cwd, entries);
	} catch (err) {
		void err; // fail-soft — conventional entries only
	}
	for (const rel of files) {
		if (/^[^/]+\.config\.[cm]?[jt]s$/.test(rel)) entries.add(rel);
		const subRoot = rel.match(/^(.+?)\/(?:src\/)?index\.[cm]?[jt]sx?$/)?.[1];
		if (
			subRoot &&
			(existsSync(join(cwd, subRoot, "package.json")) ||
				existsSync(join(cwd, subRoot, "wrangler.toml")) ||
				existsSync(join(cwd, subRoot, "wrangler.jsonc")))
		) {
			entries.add(rel);
		}
	}
	return entries;
}

const REEXPORT_FROM_RE = /export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["']([^"']+)["']/g;

/** Mark every relative specifier the pattern captures as a reached file,
 *  under each resolvable extension. */
function markSpecTargets(reached: Set<string>, dir: string, content: string, re: RegExp): void {
	for (const m of content.matchAll(re)) {
		const spec = m[1];
		if (!spec || !spec.startsWith(".")) continue;
		const base = join(dir, spec).split(sep).join("/").replace(/\.js$/, "");
		for (const ext of [".ts", ".tsx", ".js", ".jsx", "/index.ts"]) {
			reached.add(`${base}${ext}`);
		}
	}
}

/** Files consumed through `export … from` barrels or dynamic `import()`:
 *  the project graph tracks static import statements only, so both edge
 *  kinds need their own pass (the checks/<family> barrel made every family
 *  file look importerless; the lazily-loaded categorizer module repeated the
 *  class for dynamic imports). */
function reExportTargets(cwd: string, files: string[]): Set<string> {
	const reached = new Set<string>();
	for (const rel of files) {
		let content: string;
		try {
			content = readFileSync(join(cwd, rel), "utf-8");
		} catch (err) {
			void err; // unreadable — no edges from it
			continue;
		}
		const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
		markSpecTargets(reached, dir, content, REEXPORT_FROM_RE);
		markSpecTargets(reached, dir, content, DYNAMIC_IMPORT_RE);
	}
	return reached;
}

/** Discovery is git-first: `git ls-files` covers every tracked/untracked
 *  non-ignored source file regardless of layout (lib/, app/, packages/*), and
 *  inherits .gitignore so leaked fixture/temp trees can't pollute the report.
 *  The src/ walk survives only as the non-git-tree fallback. */
function discoverScanFiles(cwd: string): string[] {
	const gitFiles = getGitSourceFiles(cwd).filter((f) => /\.[jt]sx?$/.test(f));
	return gitFiles.length > 0 ? gitFiles : walkSourceFiles(cwd);
}

/** Caching repo view shared by the per-symbol detectors. */
function buildDeadExportsRepo(cwd: string, importerFiles: string[]): {
	repo: DeadExportsRepo;
	prime: (rel: string, content: string) => void;
} {
	const importerContent = new Map<string, string | null>();
	const repo: DeadExportsRepo = {
		listFiles: () => importerFiles,
		readFile: (rel) => {
			const cached = importerContent.get(rel);
			if (cached !== undefined) return cached;
			try {
				const content = readFileSync(join(cwd, rel), "utf-8");
				importerContent.set(rel, content);
				return content;
			} catch {
				importerContent.set(rel, null);
				return null;
			}
		},
	};
	return { repo, prime: (rel, content) => importerContent.set(rel, content) };
}

/** Reachability classification for one file (layer 1 + the test-only signal). */
function classifyFileReachability(
	graph: ProjectGraph,
	entries: Set<string>,
	reExported: Set<string>,
	rel: string,
	abs: string,
	out: { unreachableFiles: string[]; testOnlyImporterFiles: string[] },
): void {
	const importers = graph.getImporters(abs);
	if (!entries.has(rel) && !reExported.has(rel) && importers.length === 0) {
		out.unreachableFiles.push(rel);
	}
	if (
		importers.length > 0 &&
		importers.every((e) => TEST_OR_FIXTURE_RE.test(e.fromFile.split(sep).join("/")))
	) {
		out.testOnlyImporterFiles.push(rel);
	}
}

/** Sweep the repo once and report the reachability-layer candidates. */
export function scanDeadCode(cwd: string): DeadCodeReport {
	const graph = new ProjectGraph(cwd);
	graph.initialize();
	const files = discoverScanFiles(cwd);
	const entries = entryPoints(cwd, files.map((f) => f.split(sep).join("/")));
	const { repo: deadExportsRepo, prime } = buildDeadExportsRepo(cwd, getGitSourceFiles(cwd));
	const reExported = reExportTargets(cwd, files);
	const out = {
		unreachableFiles: [] as string[],
		deadImportBindings: [] as DeadImportBinding[],
		deadExports: [] as DeadExportFinding[],
		deadTypeExports: [] as DeadExportFinding[],
		testOnlyImporterFiles: [] as string[],
		scannedPaths: [] as string[],
	};

	for (const relRaw of files) {
		const rel = relRaw.split(sep).join("/");
		if (TEST_OR_FIXTURE_RE.test(rel)) continue;
		const abs = join(cwd, rel);
		if (!existsSync(abs)) continue;
		const content = readFileSync(abs, "utf-8");
		prime(rel, content);
		out.scannedPaths.push(rel);

		classifyFileReachability(graph, entries, reExported, rel, abs, out);
		for (const binding of findDeadImports(content)) {
			out.deadImportBindings.push({ file: rel, binding });
		}
		for (const m of findDeadExports({ content, filePath: abs, cwd }, deadExportsRepo)) {
			out.deadExports.push({ file: rel, detail: m.text });
		}
		for (const m of findDeadTypeExports({ content, filePath: abs, cwd }, deadExportsRepo)) {
			out.deadTypeExports.push({ file: rel, detail: m.text });
		}
	}

	out.unreachableFiles.sort((a, b) => a.localeCompare(b));
	return { ...out, scannedFiles: files.length };
}

/** The `--categorize` path (operator decision 2026-08-17): every candidate
 *  buckets by mechanical signals; only the compiler/mutation-guarded buckets
 *  are recommended for deletion. */
async function printCategorized(
	cwd: string,
	report: DeadCodeReport,
	json: boolean,
): Promise<number> {
	const { categorizeDeadCode, formatCategorizeReport } = await import("./deadcode-categorize.js");
	const testOnly = new Set(report.testOnlyImporterFiles ?? []);
	const categories = categorizeDeadCode(cwd, {
		unreachableFiles: report.unreachableFiles,
		deadExports: report.deadExports,
		testOnlyImportersFor: (rel) => testOnly.has(rel),
	});
	if (json) {
		console.log(JSON.stringify({ ...report, categories }, null, 2));
		return 0;
	}
	console.log(
		`Dead-code categorization — ${categories.items.length} candidate(s) bucketed by deletion safety`,
	);
	for (const line of formatCategorizeReport(categories)) console.log(line);
	console.log(
		"\nSafe-to-act buckets: reexport-residue, orphaned-type, superseded, inert branches. keep/annotate buckets are deliberate or planned code.",
	);
	return 0;
}

/** CLI action: print the report, grouped, with the candidate caveat. */
export async function deadcodeCommand(opts: {
	json?: boolean;
	categorize?: boolean;
	cwd?: string;
}): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const report = scanDeadCode(cwd);
	if (opts.categorize) {
		return printCategorized(cwd, report, opts.json === true);
	}
	if (opts.json) {
		console.log(JSON.stringify(report, null, 2));
		return 0;
	}
	console.log(`Dead-code scan — ${report.scannedFiles} files (reachability layers; candidates, not verdicts)`);
	console.log(`\nUnreachable files (${report.unreachableFiles.length}) — nothing imports them; verify no runtime path loads them:`);
	for (const f of report.unreachableFiles) console.log(`  ${f}`);
	console.log(`\nDead import bindings (${report.deadImportBindings.length}) — imported, never referenced:`);
	for (const b of report.deadImportBindings.slice(0, 40)) console.log(`  ${b.file}: ${b.binding}`);
	if (report.deadImportBindings.length > 40)
		console.log(`  … +${report.deadImportBindings.length - 40} more (use --json)`);
	console.log(`\nDead export candidates (${report.deadExports.length}) — no consumer found:`);
	for (const d of report.deadExports.slice(0, 40)) console.log(`  ${d.file}: ${d.detail}`);
	if (report.deadExports.length > 40)
		console.log(`  … +${report.deadExports.length - 40} more (use --json)`);
	console.log(`\nDead TYPE exports (${report.deadTypeExports.length}) — erased at compile time, deletion is runtime-safe; only external consumers gate it:`);
	for (const d of report.deadTypeExports.slice(0, 40)) console.log(`  ${d.file}: ${d.detail}`);
	if (report.deadTypeExports.length > 40)
		console.log(`  … +${report.deadTypeExports.length - 40} more (use --json)`);
	console.log(
		"\nSemantic (behaviorally inert) dead code is the mutation lane's job: interlinked mutation disposition --list dead_code.",
	);
	return 0;
}
