import { parseWire, wireArray, wireString } from "../../lib/value-validation.js";
import { execFileSync } from "node:child_process";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type ConformanceFinding,
	type CorpusItem,
	canonicalizeFindings,
	classifyDivergence,
	isDeterminismCritical,
	runCorpusConformance,
	runInlinePipeline,
	scanDeterminismHazards,
} from "../determinism-conformance.js";

// Synthetic inputs crafted to trip a spread of detector families. We do NOT
// assert WHICH checks fire (that would couple this test to the registry) — only
// that the pipeline is deterministic on them. The real-file corpus below
// guarantees broad coverage regardless.
const SYNTHETIC: CorpusItem[] = [
	{
		path: "syn/sql.ts",
		content: 'export function q(id: string) {\n\treturn db.query("SELECT * FROM users WHERE id = " + id);\n}\n',
	},
	{ path: "syn/eval.ts", content: "export function run(src: string) {\n\treturn eval(src);\n}\n" },
	{
		path: "syn/magic.ts",
		content: "export function t() {\n\tsetTimeout(fn, 86400000);\n\treturn 3600 * 24 * 7;\n}\n",
	},
	{
		path: "syn/secret.ts",
		content: 'const apiKey = "AKIA1234567890ABCDEF";\nconst t = "ghp_0123456789abcdefghijklmnopqrstuvwxyz12";\n',
	},
	{
		path: "syn/exec.ts",
		content:
			'import { exec } from "node:child_process";\nexport function rm(p: string) {\n\texec("rm -rf " + p);\n}\n',
	},
	{ path: "syn/any.ts", content: "export function f(x: any): any {\n\treturn (x as any).y;\n}\n" },
];

/**
 * Real detector source files as inputs — broad, realistic coverage. The file
 * list is codepoint-sorted before sampling: `readdirSync` order is filesystem-
 * dependent, so an unsorted sample would make THIS test machine-nondeterministic
 * (exactly the failure mode under test).
 */
function realFileCorpus(limit: number): CorpusItem[] {
	const dir = fileURLToPath(new URL("../checks", import.meta.url));
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".test.ts"))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.slice(0, limit);
	return files.map((f) => ({
		path: `checks/${f}`,
		content: readFileSync(`${dir}/${f}`, "utf-8"),
	}));
}

describe("determinism-replay conformance (proof-of-enforcement §15 step 0)", () => {
	it("inline check pipeline is bit-stable across repeated runs", () => {
		// Bounded for CI: the property surfaces on run 2 of any triggering input,
		// so 12 real files × 3 runs is ample (the exhaustive 73×8 sweep lives in
		// the manual driver/probe, not this gated test).
		//
		// The margin is NOT wide, despite what this comment used to claim: the
		// body costs ~25s in isolation against the 30s global timeout, so ~17%
		// headroom. Under the full-suite run the worker contention consumed it —
		// observed at 85s and a timeout, which blocked a push on a green tree.
		// Hence the explicit override below, matching the 60s already used by
		// the replay test at the bottom of this file.
		const corpus = [...SYNTHETIC, ...realFileCorpus(12)];
		const report = runCorpusConformance(corpus, 3);

		// Meaningful, not vacuous: the corpus must actually exercise the pipeline,
		// otherwise "stable" is trivially true on an empty finding set.
		expect(report.totalFindings).toBeGreaterThan(0);
		expect(report.distinctChecks).toBeGreaterThanOrEqual(3);

		// The property under test: every run produced bit-identical findings.
		const unstableMsg = report.unstable
			.map((u) => `${u.path}: [${u.divergence.kind}] ${u.divergence.detail}`)
			.join("\n");
		expect(report.unstable, `unstable inputs:\n${unstableMsg}`).toEqual([]);

		// Cross-machine guard: no machine-specific working-directory path leaked
		// into any finding (the canonical pure-pipeline cross-host divergence).
		const leakMsg = report.leaks.map((l) => `${l.path}: ${l.text}`).join("\n");
		expect(report.leaks, `cwd leaks:\n${leakMsg}`).toEqual([]);

		// Diagnostic line for the run log (the "quantify divergence" deliverable).
		console.log(
			`[determinism] ${report.itemCount} inputs · ${report.totalFindings} findings · ` +
				`${report.distinctChecks} distinct checks · ${report.stableItems}/${report.itemCount} stable`,
		);
	}, 120_000);

	it("canonicalizeFindings is order-independent", () => {
		const a: ConformanceFinding[] = [
			{ check_id: "b_check", severity: "warning", line: 2, text: "y" },
			{ check_id: "a_check", severity: "error", line: 1, text: "x" },
		];
		const b = [...a].reverse();
		expect(canonicalizeFindings(a)).toEqual(canonicalizeFindings(b));
	});

	it("classifyDivergence names a wall-clock drift", () => {
		const base: ConformanceFinding[] = [
			{ check_id: "c", severity: "warning", line: 1, text: "ran at 2026-06-04T00:00" },
		];
		const drift: ConformanceFinding[] = [
			{ check_id: "c", severity: "warning", line: 1, text: "ran at 2026-06-04T11:11" },
		];
		expect(classifyDivergence(base, drift).kind).toBe("timestamp");
	});

	it("classifyDivergence names a count drift", () => {
		const one: ConformanceFinding[] = [
			{ check_id: "c", severity: "warning", line: 1, text: "x" },
		];
		expect(classifyDivergence([], one).kind).toBe("count");
		expect(classifyDivergence(one, one).kind).toBe("none");
	});
});

// Some suites create UNIQUE mkdtemp scratch dirs UNDER the source tree (the
// tsc-overlay fixture, e.g., must sit under a tsconfig root). Under Vitest file
// parallelism those dirs can appear and vanish mid-walk, so this walk is
// concurrency-hardened two ways (finding 6): it (a) skips scratch dirs by name,
// and (b) reads every file defensively — a sibling suite's afterAll deleting a
// fixture between `readdir` and `readFileSync` must not ENOENT-crash the walk.
const SCRATCH_DIR_RE = /(?:^|[._-])(?:fixtures?|overlay|tmp|scratch)-[A-Za-z0-9]{4,}$/;

/** True for a dir that must never be descended: deps, build output, or a
 *  transient per-process fixture/scratch dir created by a parallel suite. */
function isExcludedDir(name: string): boolean {
	return name === "node_modules" || name === "dist" || SCRATCH_DIR_RE.test(name);
}

/** Read a source file, or null when it vanished mid-walk (a raced fixture
 *  deletion under parallelism) — the caller skips it rather than crashing. */
function readTextOrNull(file: string): string | null {
	try {
		return readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

// Recursively collect `.ts` source under a root, sorting dir entries for a
// machine-stable walk (the same trap the harness now guards against).
function walkTs(dir: string, out: string[] = []): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out; // dir vanished mid-walk (transient scratch) — skip it
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const e of entries) {
		if (isExcludedDir(e.name)) continue;
		const p = `${dir}/${e.name}`;
		if (e.isDirectory()) walkTs(p, out);
		else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

describe("determinism hygiene — @determinism-critical substrate", () => {
	const srcRoot = fileURLToPath(new URL("../../", import.meta.url));
	const marked = walkTs(srcRoot).filter((f) => {
		const text = readTextOrNull(f);
		return text !== null && isDeterminismCritical(text);
	});

	it("the conformance module declares itself determinism-critical", () => {
		expect(marked.some((f) => f.endsWith("/determinism-conformance.ts"))).toBe(true);
	});

	it("every @determinism-critical file is free of locale/FS-order hazards", () => {
		const offenders = marked
			.map((f) => ({ f, hz: scanDeterminismHazards(readTextOrNull(f) ?? "") }))
			.filter((o) => o.hz.length > 0)
			.map((o) => `${o.f}: ${o.hz.map((h) => `L${h.line} ${h.kind}`).join(", ")}`);
		expect(offenders, offenders.join("\n")).toEqual([]);
	});

	it("scanDeterminismHazards flags the idioms (positive)", () => {
		const pos = [
			"const r = a.localeCompare(b);",
			"const s = n.toLocaleString();",
			"const files = readdirSync(dir);",
		].join("\n");
		const kinds = scanDeterminismHazards(pos).map((h) => h.kind);
		expect(kinds).toContain("locale_compare");
		expect(kinds).toContain("locale_format");
		expect(kinds).toContain("unsorted_readdir");
	});

	it("scanDeterminismHazards is quiet on deterministic idioms (negative)", () => {
		const neg = [
			"const r = a < b ? -1 : a > b ? 1 : 0;",
			"const files = readdirSync(dir).sort();",
			"const x = n.toString();",
			"const low = s.toLowerCase();",
		].join("\n");
		expect(scanDeterminismHazards(neg)).toEqual([]);
	});
});

describe("fresh-process replay (proof-of-enforcement §15 step 0)", () => {
	// Run the pipeline in a FRESH process, under a perturbed timezone + locale,
	// and compare byte-for-byte against an in-process run. This catches
	// nondeterminism seeded at process start (import-time constants, environment,
	// timezone) that a same-process repeat cannot — a proxy for the cross-machine
	// (cloud-Sandbox) rung. `TZ` genuinely changes Node's `Date`, so a check that
	// leaked wall-clock/timezone into a finding would diverge here.
	it("inline pipeline is byte-identical in a fresh process under perturbed TZ/locale", () => {
		const corpus = [...SYNTHETIC, ...realFileCorpus(10)];
		const inProcess = corpus.map((it) =>
			canonicalizeFindings(runInlinePipeline(it.content, it.path)),
		);

		const driver = fileURLToPath(new URL("../determinism-replay-driver.ts", import.meta.url));
		const childOut = execFileSync(process.execPath, ["--import", "tsx", driver], {
			input: JSON.stringify(corpus),
			encoding: "utf-8",
			env: { ...process.env, TZ: "Asia/Kolkata", LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" },
			maxBuffer: 64 * 1024 * 1024,
		});
		const child = parseWire(JSON.parse(childOut), wireArray(wireString), "test JSON value");

		expect(child.length).toBe(inProcess.length);
		const diverged = corpus
			.map((it, i) => ({ path: it.path, same: child[i] === inProcess[i] }))
			.filter((d) => !d.same)
			.map((d) => d.path);
		expect(diverged, `fresh-process divergence:\n${diverged.join("\n")}`).toEqual([]);
		// 240s, raised from 60s on 2026-08-05. This body spawns a FRESH process and
		// replays the whole inline pipeline, so its cost tracks the size of the
		// check registry and the corpus — both of which grow as the repo does. It
		// was measured at 137s against the old 60s ceiling right after ~10 test
		// files and several source modules landed, having passed comfortably in
		// full-suite runs hours earlier.
		//
		// Verified NOT a check regression before raising: the one inline detector
		// changed that day (redos_catastrophic, which gained a per-line
		// comment scan) measures 0.148 ms/call on a large file — far too cheap to
		// explain a 2x. The budget was simply outgrown.
		//
		// A ceiling like this is a latency alarm, not a correctness assertion; the
		// determinism property is what the body actually checks. Keep it generous
		// so a growing repo doesn't read as a broken pipeline.
	}, 240_000);
});
