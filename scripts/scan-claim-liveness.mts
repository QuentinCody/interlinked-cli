// Read-only, reproducible measurement for the claim_liveness spike.
// Run from this checkout:
//   npx tsx scripts/scan-claim-liveness.mts [--root <dir>] [--negation off|on] [--commits 400]
//                                           [--verbs brief|wide] [--basenames] [--no-entries] [--json]
// --root points at another checkout (a historical worktree); --verbs wide adds the
// past-tense / descriptive forms listed in WIDE_VERB_RE below (iteration 1);
// --basenames is iteration 2 (unique backtick basenames resolve); --no-entries drops the caller-supplied entry list to show what a repo without
// declared entries would see (portability stress, not a precision number).
// Claims: CLAUDE.md, top-level docs/*.md (docs/reviews excluded), and the last
// N commit messages. Importers: the union of the ProjectGraph's static import
// edges and a regex pass over every tracked JS/TS file that counts
// `import … from`, `export … from`, dynamic `import("…")` and `require("…")`
// with a literal relative specifier (comment lines stripped first, like
// `interlinked deadcode`). Entry points: package.json bin / exports / script
// args (dist → src), the declared bundler entries, knip entries, vitest
// setupFiles. Nothing is written. Precision is adjudicated by hand in
// docs/reviews/claim-liveness-spike.md — this prints candidates.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	type ClaimSource,
	detectClaimLiveness,
	NEGATION_RE,
	splitMarkdownParagraphs,
} from "../src/harness/checks/claim-liveness.js";
import { resolveImportPath } from "../src/harness/project-graph/resolve.js";
import { ProjectGraph } from "../src/harness/project-graph.js";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
	const i = args.indexOf(name);
	return i >= 0 ? (args[i + 1] ?? dflt) : dflt;
};
const negationMode = flag("--negation", "on");
const commitCount = Number(flag("--commits", "400"));
const asJson = args.includes("--json");
const root = resolve(flag("--root", "."));
const verbMode = flag("--verbs", "brief");
const noEntries = args.includes("--no-entries");
/** Iteration-1 verb list: the brief's present-tense set plus the past-tense and
 *  descriptive forms this repo's docs actually use when they assert something
 *  runs ("landed", "shipped", "wired in", "lives in", "runs on", "enforced",
 *  "blocks", "added"). Measured separately so the brief's list stays the control. */
const WIDE_VERB_RE =
	/\b(?:now runs|runs|wired|live|enabled|lands|ships|is called|default[- ]on|landed|shipped|lives in|runs on|enforced|blocks|added|promoted|registered)\b/i;

const git = (...a: string[]): string =>
	execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const files = git("ls-files", "-z").split("\0").filter(Boolean);
const fileSet = new Set(files);
const codeFiles = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !f.startsWith("node_modules/"));

// ---- importers: regex pass (barrels, dynamic, require, static) ----
const FROM_SPEC_RE = /(?<![.\w])from\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["']([^"']+)["']/g;
const REQUIRE_RE = /(?<![.\w])require\s*\(\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
const stripCommentLines = (c: string): string =>
	c.split("\n").filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l)).join("\n");

const importerMap = new Map<string, Set<string>>();
const addEdge = (target: string, from: string): void => {
	const set = importerMap.get(target) ?? new Set<string>();
	set.add(from);
	importerMap.set(target, set);
};
for (const rel of codeFiles) {
	let content: string;
	try {
		content = stripCommentLines(readFileSync(join(root, rel), "utf8"));
	} catch {
		continue;
	}
	const abs = join(root, rel);
	for (const re of [FROM_SPEC_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE, SIDE_EFFECT_IMPORT_RE]) {
		for (const m of content.matchAll(re)) {
			const spec = m[1];
			if (!spec || !spec.startsWith(".")) continue;
			const resolved = resolveImportPath(abs, spec);
			if (!resolved) continue;
			addEdge(relative(root, resolved).split("\\").join("/"), rel);
		}
	}
}
// ---- importers: project graph static edges (backstop) ----
const graph = new ProjectGraph(root);
graph.initialize();
const importers = (file: string): string[] => {
	const out = new Set(importerMap.get(file) ?? []);
	for (const e of graph.getImporters(join(root, file))) out.add(relative(root, e.fromFile).split("\\").join("/"));
	return [...out];
};

// ---- entry points ----
const entries = new Set<string>();
const distToSrc = (p: string): string => p.replace(/^\.\//, "").replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
for (const v of Object.values((pkg.bin as Record<string, string>) ?? {})) entries.add(distToSrc(v));
const walkExports = (v: unknown): void => {
	if (typeof v === "string") entries.add(distToSrc(v));
	else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walkExports(x);
};
walkExports(pkg.exports);
for (const v of Object.values((pkg.scripts as Record<string, string>) ?? {})) {
	for (const m of v.matchAll(/[\w./-]+\.(?:tsx?|[cm]?js)\b/g)) entries.add(distToSrc(m[0]));
}
try {
	const knip = JSON.parse(readFileSync(join(root, "knip.json"), "utf8")) as { entry?: string[] };
	for (const e of knip.entry ?? []) if (!e.includes("*")) entries.add(e);
} catch {
	/* no knip */
}
try {
	const fp = readFileSync(join(root, "scripts/build-input-fingerprint.mjs"), "utf8");
	for (const m of fp.matchAll(/"(src\/[\w./-]+\.ts)"/g)) entries.add(m[1] ?? "");
} catch {
	/* no fingerprint script */
}
for (const f of readdirSync(root)) {
	if (!/^vitest.*\.config\.[cm]?[jt]s$/.test(f)) continue;
	const c = readFileSync(join(root, f), "utf8");
	for (const m of c.matchAll(/["']\.\/(src\/[\w./-]+)["']/g)) entries.add(m[1] ?? "");
}

// ---- claims ----
const claims: ClaimSource[] = [];
let proseLines = 0;
const docFiles = ["CLAUDE.md", ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)].filter((f) => fileSet.has(f));
for (const f of docFiles) {
	const c = readFileSync(join(root, f), "utf8");
	proseLines += c.split("\n").length;
	claims.push(...splitMarkdownParagraphs(c, f));
}
const log = git("log", `-n${commitCount}`, "--format=%H%x00%B%x1e");
let commits = 0;
for (const rec of log.split("\x1e")) {
	const [sha, body] = rec.replace(/^\n/, "").split("\0");
	if (!sha || body === undefined) continue;
	commits++;
	proseLines += body.split("\n").length;
	claims.push({ source: `commit:${sha.slice(0, 7)}`, line: 1, text: body });
}

const findings = detectClaimLiveness({
	claims,
	files,
	importers,
	entryPoints: noEntries ? [] : [...entries],
	negation: negationMode === "off" ? null : NEGATION_RE,
	verbs: verbMode === "wide" ? WIDE_VERB_RE : undefined,
	basenames: args.includes("--basenames"),
});

const summary = {
	root: relative(resolve("."), root) || ".",
	negation: negationMode,
	verbs: verbMode,
	basenames: args.includes("--basenames") ? "on" : "off",
	entries: noEntries ? "off" : "on",
	docFiles: docFiles.length,
	commits,
	claimUnits: claims.length,
	proseLines,
	entryPoints: entries.size,
	findings: findings.length,
	per1kLines: Number(((findings.length / proseLines) * 1000).toFixed(2)),
};
if (asJson) {
	console.log(JSON.stringify({ summary, findings }, null, 2));
} else {
	console.log(JSON.stringify(summary));
	findings.forEach((f, i) => {
		console.log(`\n#${i + 1} ${f.source}:${f.line} → ${f.path} (verb "${f.verb}", test importers ${f.testImporters})`);
		console.log(`   ${f.sentence.slice(0, 300)}`);
	});
}
