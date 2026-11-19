import { execFileSync } from "node:child_process";
import { isCappableFile } from "../harness/large-file-policy.js";
import { measurePythonFiles } from "../lib/metrics/python-measure.js";
import { collectCensusRows, type CensusAnalyzers, type CensusRows, type CensusSource } from "./metrics-complexity-census.js";

export function isPythonSource(file: string): boolean { return file.endsWith(".py"); }

/** Git-visible `.py` files (tracked or untracked, minus ignored). Failure is an empty list, as for the JavaScript listing. */
export function listPythonSources(cwd: string): string[] {
	try {
		const raw = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{ cwd, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
		return raw.split("\0").filter(file => file !== "" && isPythonSource(file));
	} catch {
		return [];
	}
}

function lineCount(content: string): number {
	return content.split(/\r?\n/).length - Number(content.endsWith("\n"));
}

/**
 * The census over JavaScript/TypeScript (unchanged) plus Python files, measured by one isolated `python3` batch with the
 * standard-library AST. A Python file that cannot be parsed, or every Python file when `python3` is missing, is listed in
 * `notMeasured` with its reason; it never counts as a clean file. Cyclomatic follows the score adapter's stdlib counting,
 * not radon: `with` blocks and lambdas add no branch.
 */
export function collectMixedCensus(sources: readonly CensusSource[], root: string, analyzers?: CensusAnalyzers, binary?: string): CensusRows | null {
	const rows = collectCensusRows(sources.filter(source => !isPythonSource(source.file)), root, analyzers);
	if (rows === null) return null;
	const python = sources.filter(source => isPythonSource(source.file) && isCappableFile({ filePath: source.file, content: source.content, root }));
	if (!python.length) return rows;
	const measured = measurePythonFiles(python.map(source => ({ path: source.file, content: source.content, language: "python", role: "product" as const, sha256: "" })), binary);
	const notMeasured: { file: string; reason: string }[] = [];
	python.forEach((source, index) => {
		const row = measured[index];
		if (!row || "error" in row) {
			notMeasured.push({ file: source.file, reason: row?.error ?? "Python analyzer returned no row" });
			return;
		}
		rows.files += 1;
		rows.lines.push({ file: source.file, value: lineCount(source.content) });
		for (const fn of row.functions) {
			rows.cyclomatic.push({ file: source.file, name: fn.name, line: fn.line, value: fn.cyclomatic });
			rows.cognitive.push({ file: source.file, name: fn.name, line: fn.line, value: fn.cognitive });
		}
	});
	if (notMeasured.length) rows.notMeasured = notMeasured;
	return rows;
}
