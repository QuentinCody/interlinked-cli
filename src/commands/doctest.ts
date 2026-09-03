// ===========================================
// `interlinked doctest` — run doctest-tagged doc code blocks (DW P4)
// ===========================================
// Walks markdown, extracts fenced blocks that opted in with a `doctest` tag,
// runs each under bash, and fails (exit 1) if any block exits non-zero — a
// CI-gateable guard that documented commands actually still work. Only tagged
// blocks run (safe by construction). The suite is pure over injected
// {readFile, exec} so it is unit-testable without a shell.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { type DoctestExec, extractDoctestBlocks, runDocExamples } from "../harness/doctest.js";

/** Reads directory entries, or null if `dir` can't be read (missing/permission). */
function safeReadNames(dir: string): string[] | null {
	try {
		return readdirSync(dir);
	} catch (err) {
		void err;
		return null;
	}
}

/** Checks whether `path` is a directory, or null if it can't be stat'd. */
function safeIsDirectory(path: string): boolean | null {
	try {
		return statSync(path).isDirectory();
	} catch (err) {
		void err;
		return null;
	}
}

/** Visits one directory entry: recurses into subdirectories, collects `*.md` files. */
function visitDirEntry(dir: string, name: string, out: string[], recurse: (d: string) => void): void {
	if (name === "node_modules" || name === ".git" || name === "dist") return;
	const full = join(dir, name);
	const isDir = safeIsDirectory(full);
	if (isDir === null) return;
	if (isDir) recurse(full);
	else if (name.endsWith(".md")) out.push(full);
}

/** Recursively collect `*.md` files under `root` (skips node_modules/.git/dist). */
export function findMarkdownFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		const names = safeReadNames(dir);
		if (names === null) return;
		for (const name of names) visitDirEntry(dir, name, out, walk);
	};
	walk(root);
	return out;
}

interface DoctestSuiteResult {
	total: number;
failed: number;
	failures: { file: string; line: number; exitCode: number }[];
}

/** Run every doctest block across `files` (pure over injected readFile + exec). */
export function runDoctestSuite(
	files: readonly string[],
	readFile: (path: string) => string,
	exec: DoctestExec,
): DoctestSuiteResult {
	let total = 0;
	let failed = 0;
	const failures: { file: string; line: number; exitCode: number }[] = [];
	for (const file of files) {
		let blocks: ReturnType<typeof extractDoctestBlocks>;
		try {
			blocks = extractDoctestBlocks(readFile(file));
		} catch (err) {
			void err;
			continue;
		}
		if (blocks.length === 0) continue;
		const summary = runDocExamples(blocks, exec);
		total += summary.total;
		failed += summary.failed;
		for (const res of summary.results) {
			if (!res.ok) failures.push({ file, line: res.block.line, exitCode: res.exitCode });
		}
	}
	return { total, failed, failures };
}

const bashExec: DoctestExec = (code) => {
	const r = spawnSync("bash", ["-c", code], { encoding: "utf-8", timeout: 60_000 });
	return { exitCode: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
};

export function doctestCommand(opts: { path?: string; json?: boolean }): void {
	const root = opts.path ?? process.cwd();
	let files: string[];
	try {
		files = statSync(root).isDirectory() ? findMarkdownFiles(root) : [root];
	} catch {
		files = [];
	}
	const result = runDoctestSuite(files, (p) => readFileSync(p, "utf-8"), bashExec);
	if (opts.json) {
		console.log(JSON.stringify(result));
	} else {
		for (const f of result.failures) {
			console.log(`✗ ${f.file}:${f.line} — exit ${f.exitCode}`);
		}
		console.log(`doctest: ${result.total - result.failed}/${result.total} block(s) passed`);
	}
	if (result.failed > 0) process.exitCode = 1;
}

export function registerDoctestCommand(program: Command): void {
	program
		.command("doctest")
		.description("Run doctest-tagged (```bash doctest) code blocks in docs and verify they exit 0")
		.option("--path <path>", "File or directory to scan (default: cwd)")
		.option("--json", "Machine-readable output")
		.action(doctestCommand);
}
