#!/usr/bin/env node
// Scan discovered YC open-source repos with `interlinked verify --all-checks
// --json`, aggregate findings, and emit per-finding JSONL + per-repo JSON.
//
// Usage:
//   node scripts/scan-yc-oss-repos.mjs [--limit N] [--timeout-ms 600000]
//                                      [--input <path>] [--include-secondary]
//
// Reads reference-repos/y-combinator/discovered.json (produced by
// scripts/discover-yc-oss-repos.mjs). Skips repos already scanned (resumable).

import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MS_PER_SECOND = 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * MS_PER_SECOND; // 10 minutes per repo
const MAX_DETAILS_PER_CHECK = 20; // cap stored detail rows to keep files small

const REPO_ROOT = process.cwd();
const OUT_DIR = join(REPO_ROOT, "reference-repos/y-combinator");
const INPUT_DEFAULT = join(OUT_DIR, "discovered.json");
const FINDINGS_JSONL = join(OUT_DIR, "scan-findings.jsonl");
const SUMMARIES_DIR = join(OUT_DIR, "scan-summaries");
const SUMMARY_INDEX = join(OUT_DIR, "scan-index.json");
const VERIFY_BIN = join(REPO_ROOT, "dist/index.js");

// Language whitelist for which `interlinked verify` actually has meaningful
// checks. Skip the rest to save scan time.
const SCANNABLE_LANGS = new Set([
	"TypeScript",
	"JavaScript",
	"Python",
	"Go",
	"Rust",
	"Java",
	"Ruby",
	"Swift",
	"C",
	"C++",
	"C#",
	"Elixir",
	"Kotlin",
	"PHP",
]);

// Top-level JSON keys produced by `outputJson` that are NOT individual check
// findings — these are metadata or structured sections we handle separately.
const NON_CHECK_KEYS = new Set([
	"files_scanned",
	"project_setup",
	"registry_parity",
	"suggestions",
	"structure",
]);

const args = process.argv.slice(2);
function flag(name, def) {
	const i = args.indexOf(name);
	if (i < 0) return def;
	return args[i + 1] ?? true;
}
const LIMIT = parseInt(flag("--limit", "0"), 10) || Number.POSITIVE_INFINITY;
const TIMEOUT_MS = parseInt(flag("--timeout-ms", String(DEFAULT_TIMEOUT_MS)), 10);
const INPUT_PATH = flag("--input", INPUT_DEFAULT);
const INCLUDE_SECONDARY = args.includes("--include-secondary");

function safeParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function loadInput() {
	if (!existsSync(INPUT_PATH)) {
		throw new Error(`Input not found: ${INPUT_PATH}. Run discover-yc-oss-repos.mjs first.`);
	}
	const parsed = safeParse(readFileSync(INPUT_PATH, "utf-8"));
	if (!Array.isArray(parsed)) {
		throw new Error(`Malformed input at ${INPUT_PATH}`);
	}
	return parsed;
}

function loadIndex() {
	if (!existsSync(SUMMARY_INDEX)) return { scanned: {}, started_at: new Date().toISOString() };
	const parsed = safeParse(readFileSync(SUMMARY_INDEX, "utf-8"));
	return parsed ?? { scanned: {}, started_at: new Date().toISOString() };
}

function saveIndex(index) {
	writeFileSync(SUMMARY_INDEX, JSON.stringify(index, null, 2));
}

function repoTargets(entry) {
	const { primary, secondary } = entry.github;
	const list = [];
	if (primary?.scannable) list.push({ ...primary, role: "primary" });
	if (INCLUDE_SECONDARY && Array.isArray(secondary)) {
		for (const r of secondary) if (r.scannable) list.push({ ...r, role: "secondary" });
	}
	return list;
}

function repoUrl(repo) {
	return repo.html_url ?? `https://github.com/${repo.full_name}`;
}

function summaryPath(fullName) {
	return join(SUMMARIES_DIR, `${fullName.replace("/", "__")}.json`);
}

function runVerify(repo, timeoutMs) {
	const url = repoUrl(repo);
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const child = spawn("node", [VERIFY_BIN, "verify", "--all-checks", "--json", url], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({
				ok: false,
				reason: "timeout",
				elapsed_ms: Date.now() - startedAt,
				stderr: stderr.slice(-2000),
				stdout: "",
			});
		}, timeoutMs);

		child.stdout.on("data", (b) => {
			stdout += b.toString();
		});
		child.stderr.on("data", (b) => {
			stderr += b.toString();
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({
				ok: false,
				reason: `spawn-error:${e.message}`,
				elapsed_ms: Date.now() - startedAt,
				stderr,
				stdout: "",
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			// verify exits 1 when findings exist; that's a successful scan, not a failure.
			const acceptable = code === 0 || code === 1;
			resolve({
				ok: acceptable,
				reason: acceptable ? null : `exit-${code}`,
				exit_code: code,
				elapsed_ms: Date.now() - startedAt,
				stderr: stderr.slice(-4000),
				stdout,
			});
		});
	});
}

function checkFindingEntry(key, value) {
	if (NON_CHECK_KEYS.has(key)) return null;
	if (!value || typeof value !== "object") return null;
	const issues = Number.isFinite(value.issues) ? value.issues : 0;
	if (issues <= 0) return null;
	const details = Array.isArray(value.details) ? value.details : [];
	return {
		issues,
		files: Array.isArray(value.files) ? value.files.length : 0,
		sample: details.slice(0, MAX_DETAILS_PER_CHECK),
	};
}

function extractFindings(verifyJson) {
	const out = {};
	if (!verifyJson || typeof verifyJson !== "object") return out;
	for (const [key, value] of Object.entries(verifyJson)) {
		const entry = checkFindingEntry(key, value);
		if (entry) out[key] = entry;
	}
	return out;
}

function appendFindings(repo, entry, findings) {
	for (const [checkId, body] of Object.entries(findings)) {
		const row = {
			ts: new Date().toISOString(),
			company_slug: entry.company.slug,
			company_name: entry.company.name,
			batch: entry.company.batch,
			github_login: entry.github.login,
			repo_full_name: repo.full_name,
			repo_role: repo.role,
			language: repo.language,
			stars: repo.stars,
			check_id: checkId,
			issues: body.issues,
			files: body.files,
		};
		appendFileSync(FINDINGS_JSONL, `${JSON.stringify(row)}\n`);
	}
}

function fmtCheckSummary(findings) {
	const ordered = Object.entries(findings)
		.sort((a, b) => b[1].issues - a[1].issues)
		.slice(0, 5);
	if (ordered.length === 0) return "no findings";
	return ordered.map(([id, b]) => `${id}=${b.issues}`).join(", ");
}

async function scanOne(entry, repo, index) {
	const repoKey = `${repo.full_name}@${repo.role}`;
	if (index.scanned[repoKey]) {
		console.error(`  [skip] ${repoKey} (already scanned)`);
		return;
	}

	process.stderr.write(`  [scan] ${repo.full_name} (${repo.language})... `);
	const result = await runVerify(repo, TIMEOUT_MS);
	const elapsedSec = (result.elapsed_ms / MS_PER_SECOND).toFixed(1);

	if (!result.ok) {
		console.error(`✗ ${result.reason} (${elapsedSec}s)`);
		index.scanned[repoKey] = {
			scanned_at: new Date().toISOString(),
			ok: false,
			reason: result.reason,
			elapsed_ms: result.elapsed_ms,
			stderr_tail: result.stderr,
		};
		saveIndex(index);
		return;
	}

	const verifyJson = safeParse(result.stdout);
	if (!verifyJson) {
		console.error(`✗ malformed JSON (${elapsedSec}s)`);
		index.scanned[repoKey] = {
			scanned_at: new Date().toISOString(),
			ok: false,
			reason: "malformed-json",
			elapsed_ms: result.elapsed_ms,
			stdout_tail: result.stdout.slice(-2000),
			stderr_tail: result.stderr,
		};
		saveIndex(index);
		return;
	}

	const findings = extractFindings(verifyJson);
	const totalIssues = Object.values(findings).reduce((s, f) => s + f.issues, 0);
	console.error(`✓ ${totalIssues} issues, ${Object.keys(findings).length} checks (${elapsedSec}s) [${fmtCheckSummary(findings)}]`);

	const summary = {
		scanned_at: new Date().toISOString(),
		company: entry.company,
		repo: repo,
		files_scanned: verifyJson.files_scanned ?? null,
		total_issues: totalIssues,
		findings,
	};
	writeFileSync(summaryPath(repo.full_name), JSON.stringify(summary, null, 2));
	appendFindings(repo, entry, findings);

	index.scanned[repoKey] = {
		scanned_at: summary.scanned_at,
		ok: true,
		total_issues: totalIssues,
		check_count: Object.keys(findings).length,
		files_scanned: summary.files_scanned,
		elapsed_ms: result.elapsed_ms,
	};
	saveIndex(index);
}

async function main() {
	mkdirSync(SUMMARIES_DIR, { recursive: true });
	if (!existsSync(VERIFY_BIN)) {
		throw new Error(`verify binary not found at ${VERIFY_BIN}. Run \`npm run build\` first.`);
	}
	const entries = loadInput();
	const index = loadIndex();

	const targets = [];
	for (const entry of entries) {
		for (const repo of repoTargets(entry)) {
			if (!SCANNABLE_LANGS.has(repo.language)) continue;
			targets.push({ entry, repo });
			if (targets.length >= LIMIT) break;
		}
		if (targets.length >= LIMIT) break;
	}

	console.error(
		`Scanning ${targets.length} repos (timeout ${TIMEOUT_MS / MS_PER_SECOND}s/repo)`,
	);
	const startedAt = Date.now();
	for (const { entry, repo } of targets) {
		await scanOne(entry, repo, index);
	}
	const elapsed = ((Date.now() - startedAt) / MS_PER_SECOND).toFixed(0);
	console.error(`\nDone. Index: ${SUMMARY_INDEX} · findings: ${FINDINGS_JSONL} · ${elapsed}s total`);
}

main().catch((e) => {
	console.error(`fatal: ${e.message}`);
	process.exit(1);
});
