// ===========================================
// interlinked index — Trigram index management
// ===========================================
// Build, update, and inspect the trigram search index.
// The index accelerates grep/ripgrep calls by narrowing
// the file set before scanning.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { TrigramIndex } from "../harness/trigram-index.js";
import type { IndexStats } from "../harness/trigram-primitives.js";

export function registerIndexCommand(program: Command): void {
	const index = program
		.command("index")
		.description("Manage the trigram search index for grep acceleration");

	// --- build ---
	index
		.command("build")
		.description("Build a full trigram index from the current codebase")
		.option("--cwd <path>", "Working directory", process.cwd())
		.option("--max-file-size <bytes>", "Skip files larger than this", "1048576")
		.option("--stop-threshold <ratio>", "Stop trigram threshold (0-1)", "0.4")
		.action(async (opts) => {
			const cwd = resolve(opts.cwd);
			console.log(`Building trigram index for ${cwd}...`);

			const startTime = Date.now();
			let lastReport = 0;

			const index = TrigramIndex.build({
				cwd,
				maxFileSize: Number.parseInt(opts.maxFileSize, 10),
				stopThreshold: Number.parseFloat(opts.stopThreshold),
				onProgress: (indexed, total) => {
					const now = Date.now();
					if (now - lastReport > 500) {
						process.stdout.write(`\r  Indexing... ${indexed}/${total} files`);
						lastReport = now;
					}
				},
			});

			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			process.stdout.write("\r"); // clear progress line

			index.save(join(cwd, ".interlinked"));
			const stats = index.stats();

			console.log(`Index built in ${elapsed}s`);
			console.log(`  Files:       ${stats.fileCount.toLocaleString()}`);
			console.log(`  Trigrams:    ${stats.trigramCount.toLocaleString()}`);
			console.log(`  Stop grams:  ${stats.stopTrigramCount.toLocaleString()}`);
			console.log(`  Index size:  ${formatBytes(stats.indexSizeBytes)}`);
			console.log(`  Base commit: ${stats.baseCommit.slice(0, 8)}`);
		});

	// --- update ---
	index
		.command("update")
		.description("Incrementally update the index from git changes")
		.option("--cwd <path>", "Working directory", process.cwd())
		.action(async (opts) => {
			const cwd = resolve(opts.cwd);
			const existing = TrigramIndex.load(cwd);

			if (!existing) {
				console.log("No existing index found. Run `interlinked index build` first.");
				process.exitCode = 1;
				return;
			}

			console.log(`Updating index (base: ${existing.baseCommit.slice(0, 8)})...`);
			const startTime = Date.now();
			const updated = existing.incrementalUpdate();
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

			if (updated === 0) {
				console.log("Index is up to date (no changes since base commit).");
				return;
			}

			existing.save(join(cwd, ".interlinked"));
			console.log(`Updated ${updated} files in ${elapsed}s`);
		});

	// --- status ---
	index
		.command("status")
		.description("Show index status and statistics")
		.option("--cwd <path>", "Working directory", process.cwd())
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			const cwd = resolve(opts.cwd);
			const meta = TrigramIndex.loadMeta(cwd);

			if (!meta) {
				printNoIndexFound(Boolean(opts.json));
				return;
			}

			if (opts.json) {
				console.log(JSON.stringify({ exists: true, ...meta }, null, 2));
				return;
			}

			console.log("Trigram Search Index");
			console.log(`  Files:       ${meta.fileCount.toLocaleString()}`);
			console.log(`  Trigrams:    ${meta.trigramCount.toLocaleString()}`);
			console.log(`  Stop grams:  ${meta.stopTrigramCount.toLocaleString()}`);
			console.log(`  Index size:  ${formatBytes(meta.indexSizeBytes)}`);
			console.log(`  Base commit: ${meta.baseCommit.slice(0, 8)}`);
			console.log(`  Built at:    ${meta.builtAt}`);

			printMaskAndSizeBreakdown(meta);
			printIndexFreshness(cwd);
		});

	// --- query (debug/test) ---
	index
		.command("query <pattern>")
		.description("Query the index for candidate files (debug tool)")
		.option("--cwd <path>", "Working directory", process.cwd())
		.option("--regex", "Treat pattern as regex", false)
		.action(async (pattern, opts) => {
			const cwd = resolve(opts.cwd);
			const idx = TrigramIndex.load(cwd);

			if (!idx) {
				console.log("No index found. Run `interlinked index build` first.");
				process.exitCode = 1;
				return;
			}

			const { decomposePattern } = await import("../harness/regex-trigrams.js");
			const decomp = decomposePattern(pattern, opts.regex);

			if (!decomp.hasLiterals) {
				console.log("No extractable trigrams from pattern.");
				return;
			}

			const candidates = idx.queryCandidatePaths(decomp.requiredTrigrams);

			console.log(
				`Pattern: ${pattern} → ${decomp.requiredTrigrams.length} trigrams, ${candidates.length}/${idx.totalFiles} candidate files`,
			);
			console.log();

			if (candidates.length === 0) {
				console.log("No matching files.");
			} else {
				for (const p of candidates.slice(0, 50)) {
					console.log(`  ${p}`);
				}
				if (candidates.length > 50) {
					console.log(`  ... and ${candidates.length - 50} more`);
				}
			}
		});
}

/** Tell the user no index exists yet, in whichever format they asked for. */
function printNoIndexFound(asJson: boolean): void {
	if (asJson) {
		console.log(JSON.stringify({ exists: false }));
		return;
	}
	console.log("No trigram index found.");
	console.log("Run `interlinked index build` to create one.");
}

/** Print the optional posting-mask averages and on-disk size breakdown. */
function printMaskAndSizeBreakdown(meta: IndexStats): void {
	if (meta.avgLocMaskBits !== undefined) {
		console.log(`  Avg locMask:  ${meta.avgLocMaskBits.toFixed(1)} bits/entry`);
		console.log(`  Avg nextMask: ${meta.avgNextMaskBits?.toFixed(1)} bits/entry`);
	}
	if (meta.lookupSizeBytes !== undefined) {
		console.log(`  Lookup file:  ${formatBytes(meta.lookupSizeBytes)}`);
		console.log(`  Postings:     ${formatBytes(meta.postingsSizeBytes ?? 0)}`);
	}
}

/** Print how long ago the lookup file was written, when it is present. */
function printIndexFreshness(cwd: string): void {
	const indexPath = join(cwd, ".interlinked", "index", "trigram.lookup");
	if (!existsSync(indexPath)) return;

	const { mtimeMs } = statSync(indexPath);
	const ageMinutes = Math.floor((Date.now() - mtimeMs) / 60000);
	if (ageMinutes < 1) {
		console.log("  Freshness:   just built");
		return;
	}
	if (ageMinutes < 60) {
		console.log(`  Freshness:   ${ageMinutes}min ago`);
		return;
	}
	const ageHours = Math.floor(ageMinutes / 60);
	console.log(`  Freshness:   ${ageHours}h ago`);
}

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

function formatBytes(bytes: number): string {
	if (bytes < BYTES_PER_KB) return `${bytes} B`;
	if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
	return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}
