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

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
	findDeadExports,
	findDeadTypeExports,
	type DeadExportsRepo,
} from "../harness/checks/dead-exports-inline.js";
import { consumptionPathKey, type SpecifierKeyResolver } from "../harness/checks/export-consumption.js";
import { getGitSourceFiles } from "../harness/checks/export-ripple.js";
import { ProjectGraph } from "../harness/project-graph.js";
import { componentKind, maskComponentScripts } from "../lib/import-resolution/component-scripts.js";
import { reachabilityRoots } from "./deadcode-entries.js";
import { scriptCommandEntries } from "./deadcode-command-entries.js";
import { gitFileList } from "./check-python-files.js";
import { htmlReferences } from "./deadcode-html.js";
import { createImportResolver } from "../lib/import-resolution/import-resolver.js";
import { fsRepoView, type RepoView } from "../lib/import-resolution/repo-view.js";
import { isJsonObject } from "../lib/json-types.js";
import { findDeadImports } from "./check-dead-imports.js";
import { applySetAside, type DeadCodeSetAside, printSetAside, setAsideDecision } from "./deadcode-set-aside.js";
import { pythonSummaryLines, scanPythonDeadCode, withPython, type PythonDeadCode } from "./deadcode-python.js";

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
	/** Which languages the rows come from. Set by `deadcodeCommand`, which adds the Python half. */
	language?: "typescript" | "python" | "mixed";
	/** The Python graph evidence (entry roots, unresolved imports, dynamic imports); present when the tree holds Python. */
	python?: PythonDeadCode["python"];
	/** Files that source roles set aside (generated, vendor, unlinted), with the evidence; their findings are not in the lists above. */
	setAside?: DeadCodeSetAside;
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
/** Conventional + package.json entry points; shared with `jev doc-claims` so an entry file never reads as "unimported". */
export function entryPoints(cwd: string, files: readonly string[]): Set<string> {
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

/** Every syntactic form that makes one file reference another by relative
 *  specifier. `from` covers BOTH `import … from` and `export … from` (the
 *  barrel edge the project graph never records — it parses import statements
 *  only); the lookbehind keeps `Array.from(` and `.from"` out. */
const FROM_SPEC_RE = /(?<![.\w])from\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["']([^"']+)["']/g;
const REQUIRE_RE = /(?<![.\w])require\s*\(\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
const SPEC_PATTERNS = [FROM_SPEC_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE, SIDE_EFFECT_IMPORT_RE];

/** Drop comment LINES before specifier matching so a commented-out or merely
 *  documented import never counts as a live edge (that would hide a real dead
 *  file). Line-shaped on purpose: a span-matching block-comment strip
 *  mis-pairs against regex literals and template strings and then swallows the
 *  real import block — measured on `structural-checks.ts`, where it hid all 16
 *  specifiers and left a barrel-re-exported file looking test-only. */
function stripComments(content: string): string {
	return content
		.split("\n")
		.filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
		.join("\n");
}

function isTestPath(path: string): boolean {
	return TEST_OR_FIXTURE_RE.test(path.split(sep).join("/"));
}

/** Relative-specifier targets, split by whether the REFERENCING file is a
 *  test/fixture. `byNonTest` is what disqualifies a file from the test-only
 *  bucket; `byTest` is what puts it there. */
export interface ReferenceSets {
	byTest: Set<string>;
	byNonTest: Set<string>;
}

/** Mark every relative specifier the pattern captures as a reached file,
 *  under each resolvable extension. */
function markSpecTargets(reached: Set<string>, ctx: { dir: string; resolveBare?: ((specifier: string) => string | null) | undefined }, content: string, re: RegExp): void {
	const { dir } = ctx;
	for (const m of content.matchAll(re)) {
		const spec = m[1];
		if (spec && !spec.startsWith(".")) {
			const aliased = ctx.resolveBare?.(spec);
			if (aliased) reached.add(aliased);
			continue;
		}
		if (!spec) continue;
		const base = join(dir, spec).split(sep).join("/").replace(/\.js$/, "");
		for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"]) {
			reached.add(`${base}${ext}`);
		}
	}
}

/** Resolve EVERY relative specifier in every scanned file, split by whether
 *  the referencing file is a test. The project graph records static import
 *  statements only, so `export … from` barrel edges and dynamic `import()`
 *  are invisible to it — a file reached only through either looked
 *  importerless (layer 1) AND looked test-only (the categorizer signal),
 *  which is how the test-only bucket over-reported 142 against a
 *  ground truth of 43 (campaign 2026-09-02).
 *
 *  Deliberately ONE HOP, matching the ground-truth resolution: any reference
 *  from a non-test file clears the target, even when that referencer is
 *  itself dead. Propagating "the barrel is test-only too" needs a reachability
 *  fixpoint seeded from a COMPLETE entry set, and this repo's entry discovery
 *  is incomplete (npm scripts naming dist/*.js are not mapped back to src),
 *  so the fixpoint would over-report far worse than the bug it fixes. */
export function collectReferences(
	cwd: string,
	files: readonly string[],
	resolveBare?: (specifier: string, importerRel: string) => string | null,
): ReferenceSets {
	const refs: ReferenceSets = { byTest: new Set<string>(), byNonTest: new Set<string>() };
	for (const relRaw of files) {
		const rel = relRaw.split(sep).join("/");
		let content: string;
		try {
			content = stripComments(readImporterText(cwd, rel));
		} catch (err) {
			void err; // unreadable — no edges from it
			continue;
		}
		const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
		const into = isTestPath(rel) ? refs.byTest : refs.byNonTest;
		const ctx = { dir, resolveBare: resolveBare && ((spec: string) => resolveBare(spec, rel)) };
		for (const re of SPEC_PATTERNS) markSpecTargets(into, ctx, content, re);
	}
	return refs;
}

/** Importer text as the import scan reads it: a single-file component shows only its script blocks. */
function readImporterText(cwd: string, rel: string): string {
	const text = readFileSync(join(cwd, rel), "utf-8");
	const kind = componentKind(rel);
	return kind === null ? text : maskComponentScripts(text, kind);
}

/** Tracked and untracked-but-not-ignored single-file components (`.svelte`, `.vue`, `.astro`). */
function gitComponentFiles(cwd: string): string[] {
	try {
		const raw = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.svelte", "*.vue", "*.astro"], {
			cwd, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
		});
		return raw.split("\0").filter(Boolean);
	} catch (err) {
		void err; // not a git tree — walk the directory instead
		return walkComponents(cwd, "");
	}
}

function walkComponents(root: string, dir: string): string[] {
	const out: string[] = [];
	try {
		for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!WALK_SKIP_DIRS.has(entry.name)) out.push(...walkComponents(root, rel));
			} else if (componentKind(entry.name) !== null) out.push(rel);
		}
	} catch (err) {
		void err; // unreadable directory — skip
	}
	return out;
}

/** `(specifier, importerRel) => repo-relative target file` for alias and workspace imports, from static config reads. */
function aliasTargets(cwd: string): { target: (specifier: string, importerRel: string) => string | null; key: SpecifierKeyResolver; view: RepoView } {
	const view = fsRepoView(cwd);
	const resolver = createImportResolver(view);
	const target = (specifier: string, importerRel: string): string | null => {
		const found = resolver.resolve(importerRel, specifier);
		return found?.kind === "local" ? found.target : null;
	};
	return { target, key: (specifier, importer) => { const hit = target(specifier, importer); return hit === null ? null : consumptionPathKey(hit); }, view };
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
function buildDeadExportsRepo(cwd: string, importerFiles: string[], resolveBare?: SpecifierKeyResolver): {
	repo: DeadExportsRepo;
	prime: (rel: string, content: string) => void;
} {
	const importerContent = new Map<string, string | null>();
	const repo: DeadExportsRepo = {
		listFiles: () => importerFiles,
		...(resolveBare ? { resolveBare } : {}),
		readFile: (rel) => {
			const cached = importerContent.get(rel);
			if (cached !== undefined) return cached;
			try {
				const content = readImporterText(cwd, rel);
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

/** Exposed for its contract test: an unreadable importer must read as `null`
 *  rather than throw — an exception here would abort the whole scan. */
export { buildDeadExportsRepo };

/** Reachability classification for one file (layer 1 + the test-only signal). */
/** Who references `rel`, over BOTH mechanisms: the resolved specifier sets
 *  (barrels, dynamic import, require, static) and the project graph's static
 *  import edges. The graph is the backstop for anything the regexes miss. */
function reachFlags(
	importers: readonly { fromFile: string }[],
	refs: ReferenceSets,
	rel: string,
): { nonTest: boolean; fromTest: boolean } {
	return {
		nonTest: refs.byNonTest.has(rel) || importers.some((e) => !isTestPath(e.fromFile)),
		fromTest: refs.byTest.has(rel) || importers.some((e) => isTestPath(e.fromFile)),
	};
}

function classifyFileReachability(
	graph: ProjectGraph,
	entries: Set<string>,
	refs: ReferenceSets,
	rel: string,
	abs: string,
	out: { unreachableFiles: string[]; testOnlyImporterFiles: string[] },
): void {
	const importers = graph.getImporters(abs);
	const { nonTest, fromTest } = reachFlags(importers, refs, rel);
	const isEntry = entries.has(rel);
	if (!isEntry && !nonTest && !fromTest) out.unreachableFiles.push(rel);
	if (fromTest && !nonTest && !isEntry) out.testOnlyImporterFiles.push(rel);
}

interface ScanContext {
	graph: ProjectGraph;
	roots: Set<string>;
	frameworkEntries: ReadonlySet<string>;
	deadExportsRepo: DeadExportsRepo;
	prime: (rel: string, content: string) => void;
	refs: ReferenceSets;
}

/** Everything the per-file loop reads: the import graph, entry roots, reference sets and the importer view. */
function buildScanContext(cwd: string, files: readonly string[]): ScanContext {
	const graph = new ProjectGraph(cwd);
	graph.initialize();
	const relFiles = files.map((f) => f.split(sep).join("/"));
	const alias = aliasTargets(cwd);
	const components = gitComponentFiles(cwd);
	// Framework route, layout and hook files are loaded by path, never imported.
	const { entries: roots, frameworkEntries } = reachabilityRoots(alias.view, relFiles, components, entryPoints(cwd, relFiles));
	for (const target of scriptCommandEntries(gitFileList(cwd) ?? [], alias.view.read, new Set(relFiles))) roots.add(target);
	const { repo: deadExportsRepo, prime } = buildDeadExportsRepo(cwd, [...getGitSourceFiles(cwd), ...components], alias.key);
	const refs = collectReferences(cwd, [...files, ...components], alias.target);
	// A static page loads scripts by path; that is a reference the import scan cannot see.
	for (const { html, targets } of htmlReferences(cwd, new Set(relFiles))) {
		for (const target of targets) (isTestPath(html) ? refs.byTest : refs.byNonTest).add(target);
	}
	return { graph, roots, frameworkEntries, deadExportsRepo, prime, refs };
}

/** Cross-file export findings (values, then types) for one file. */
function scanExports(
	file: { cwd: string; rel: string; abs: string; content: string },
	repo: DeadExportsRepo,
	out: { deadExports: DeadExportFinding[]; deadTypeExports: DeadExportFinding[] },
): void {
	const args = { content: file.content, filePath: file.abs, cwd: file.cwd };
	for (const m of findDeadExports(args, repo)) out.deadExports.push({ file: file.rel, detail: m.text });
	for (const m of findDeadTypeExports(args, repo)) out.deadTypeExports.push({ file: file.rel, detail: m.text });
}

/** Sweep the repo once and report the reachability-layer candidates. */
export function scanDeadCode(cwd: string): DeadCodeReport {
	const files = discoverScanFiles(cwd);
	const { graph, roots, frameworkEntries, deadExportsRepo, prime, refs } = buildScanContext(cwd, files);
	const out: { unreachableFiles: string[]; deadImportBindings: DeadImportBinding[]; deadExports: DeadExportFinding[]; deadTypeExports: DeadExportFinding[]; testOnlyImporterFiles: string[]; scannedPaths: string[] } = {
		unreachableFiles: [],
		deadImportBindings: [],
		deadExports: [],
		deadTypeExports: [],
		testOnlyImporterFiles: [],
		scannedPaths: [],
	};

	for (const relRaw of files) {
		const rel = relRaw.split(sep).join("/");
		if (TEST_OR_FIXTURE_RE.test(rel)) continue;
		const abs = join(cwd, rel);
		if (!existsSync(abs)) continue;
		const content = readFileSync(abs, "utf-8");
		prime(rel, content);
		out.scannedPaths.push(rel);

		classifyFileReachability(graph, roots, refs, rel, abs, out);
		for (const binding of findDeadImports(content)) {
			out.deadImportBindings.push({ file: rel, binding });
		}
		// A framework loads route modules by path, so their exports (`load`, `GET`) have no importer.
		if (!frameworkEntries.has(rel)) scanExports({ cwd, rel, abs, content }, deadExportsRepo, out);
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
	const scripts = applySetAside(scanDeadCode(cwd), setAsideDecision(cwd));
	// The categorizer reads TypeScript; Python rows are listed in the plain and JSON reports only.
	if (opts.categorize) {
		return printCategorized(cwd, scripts, opts.json === true);
	}
	const report = applySetAside(withPython(scripts, scanPythonDeadCode(cwd)), setAsideDecision(cwd));
	if (opts.json) {
		console.log(JSON.stringify(report, null, 2));
		return 0;
	}
	console.log(`Dead-code scan — ${report.scannedFiles} files (reachability layers; candidates, not verdicts)`);
	for (const line of pythonSummaryLines(report)) console.log(line);
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
	printSetAside(report);
	console.log(
		"\nSemantic (behaviorally inert) dead code is the mutation lane's job: interlinked mutation disposition --list dead_code.",
	);
	return 0;
}
