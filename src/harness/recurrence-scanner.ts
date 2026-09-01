// ===========================================
// Recurrence Scanner — codebase_existing pattern detector
// ===========================================
//
// Walks the working tree, runs the same inline detectors the harness
// uses on PostToolUse against every source file, and surfaces patterns
// that already exist in the codebase. Useful for the third "kind" of
// recurrence: codebase_existing — pre-existing replications of patterns
// the harness now catches at edit time but hasn't been used to clean
// up the inherited code.
//
// Per `feedback_harness_deterministic_only.md`: counting + grouping +
// regex / AST detectors only. No LLM.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { buildAgentSafetyChecks } from "./check-registry/index.js";
import type { DetectorFinding } from "./checks/endpoint-security.js";
import { extractCICommands, isCIFile } from "./ci-command-extractor.js";
import { matchesRule } from "./evaluator/rule-matching.js";
import { recordRecurrenceEvent } from "./recurrence.js";
import { loadRules } from "./rules-loader.js";
import type { GuardRule } from "./types.js";

/** Default directory roots scanned when the caller doesn't override. The
 *  intent is "user-authored source" — node_modules / dist / build / vendor
 *  are skipped via SKIP_DIR_NAMES below regardless of which root we walk. */
const DEFAULT_SCAN_ROOTS = ["src"];

/** File extensions inspected by default. The inline detectors target
 *  TS/JS family and Python/Go/Rust/etc. via the language profile path,
 *  but the agent_safety pipeline is dominated by JS/TS. Add others as
 *  the registry grows. */
const DEFAULT_SCAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Subtree names skipped during the walk — agent-untouchable code paths. */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	"dist",
	"build",
	"vendor",
	".next",
	".git",
	".interlinked",
	"coverage",
]);

/** A single detector hit found by the codebase scan. */
export interface ScanCodebaseFinding {
	/** Path relative to `cwd`. */
	file: string;
	/** Registry check id (e.g., "eval_usage", "misused_promises"). */
	check_id: string;
	/** 1-based line number of the matched line. */
	line: number;
	/** Trimmed source-line text (capped). */
	text: string;
}

interface ScanCodebaseOptions {
	/** Working directory the scan is rooted at. Defaults to process.cwd(). */
	cwd?: string;
	/** Subdirectories of `cwd` to walk. Defaults to ["src"]. */
	roots?: string[];
	/** File extensions to inspect. Defaults to TS/JS family. */
	extensions?: string[];
	/** When true, append a codebase_existing recurrence event per finding
	 *  to `.interlinked/recurrences.jsonl`. Default false (dry run). */
	recordEvents?: boolean;
	/** When false, skip the CI/build-file destructive-command scan. Default
	 *  true — workflow/Dockerfile/Makefile commands never pass a PreToolUse
	 *  hook, so this is the only surface that audits them. */
	includeCI?: boolean;
}

/** Walk the working tree and return every inline-detector hit found in
 *  the working source. Optionally records a `codebase_existing`
 *  recurrence event per hit (for `interlinked recurrence list` to
 *  aggregate). */
export function scanCodebaseForRecurrences(
	options: ScanCodebaseOptions = {},
): ScanCodebaseFinding[] {
	const cwd = resolve(options.cwd ?? process.cwd());
	const roots = options.roots ?? DEFAULT_SCAN_ROOTS;
	const extensions = options.extensions ?? DEFAULT_SCAN_EXTENSIONS;
	const findings: ScanCodebaseFinding[] = [];

	for (const rootRel of roots) {
		const rootAbs = resolve(cwd, rootRel);
		for (const fileAbs of walk(rootAbs)) {
			if (!extensions.some((ext) => fileAbs.endsWith(ext))) continue;
			const relPath = relative(cwd, fileAbs).split(sep).join("/");
			let content: string;
			try {
				content = readFileSync(fileAbs, "utf-8");
			} catch (_err) {
				/* unreadable (permission, race) — skip */
				continue;
			}
			// Inline detectors registered in CHECK_REGISTRY for the agent_safety
			// pipeline. We pass relPath so detectors that gate on the file path
			// (e.g. test-file detection) see the right shape.
			const checks = buildAgentSafetyChecks(content, relPath);
			for (const check of checks) {
				let matches: Array<{ line: number; text: string }>;
				try {
					matches = check.fn();
				} catch (_err) {
					/* a single buggy detector must not break the whole scan */
					continue;
				}
				for (const m of matches) {
					findings.push({
						file: relPath,
						check_id: check.name,
						line: m.line,
						text: m.text,
					});
				}
			}
		}
	}

	appendCIFindings(findings, options, cwd);

	if (options.recordEvents) {
		const ts = new Date().toISOString();
		for (const f of findings) {
			recordRecurrenceEvent(
				{
					ts,
					kind: "codebase_existing",
					check_id: f.check_id,
					file: f.file,
					message: f.text,
				},
				cwd,
			);
		}
	}

	return findings;
}

/** Append CI/build-file destructive-command findings unless `includeCI` is
 *  explicitly false. Kept as a helper so the option branch doesn't raise
 *  `scanCodebaseForRecurrences`'s cyclomatic count. */
function appendCIFindings(
	findings: ScanCodebaseFinding[],
	options: ScanCodebaseOptions,
	cwd: string,
): void {
	if (options.includeCI === false) return;
	findings.push(...scanCIFilesForRecurrences(cwd));
}

/** Bash/Shell destructive rules (block / ask / soft_block) from the loaded
 *  config that a CI command should be evaluated against. Temporal rules are
 *  included but stay dormant in this path — `matchesRule` returns false for
 *  `requires_prior` / `forbids_after` predicates when no session is supplied. */
function destructiveBashRules(cwd: string): GuardRule[] {
	return loadRules(cwd).rules.filter((r) => {
		if (!r.enabled) return false;
		if (r.action !== "block" && r.action !== "ask" && r.action !== "soft_block") return false;
		if (r.trigger !== "PreToolUse" && r.trigger !== "both") return false;
		return r.tool_match.some((t) => {
			const l = t.toLowerCase();
			return l === "bash" || l === "shell" || l === "run_command" || l === "*";
		});
	});
}

/**
 * Walk the working tree for CI/build files (workflow YAML, Dockerfile,
 * Makefile), extract their commands, and run the destructive guard rules over
 * each — surfacing destructive commands that ship in CI but never pass a
 * PreToolUse hook. Each hit becomes a `codebase_existing`-shaped finding whose
 * `check_id` is the guard rule it tripped. Adapted from
 * destructive_command_guard's `dcg scan`; see
 * docs/external-pulse/destructive-command-guard.md.
 */
export function scanCIFilesForRecurrences(cwdInput?: string): ScanCodebaseFinding[] {
	const cwd = resolve(cwdInput ?? process.cwd());
	const rules = destructiveBashRules(cwd);
	const findings: ScanCodebaseFinding[] = [];
	for (const fileAbs of walk(cwd)) {
		const relPath = relative(cwd, fileAbs).split(sep).join("/");
		if (!isCIFile(relPath)) continue;
		let content: string;
		try {
			content = readFileSync(fileAbs, "utf-8");
		} catch (_err) {
			continue;
		}
		for (const { line, command } of extractCICommands(relPath, content)) {
			for (const rule of rules) {
				const hit = matchesRule({
					command,
					toolInput: { command },
					rule,
					toolName: "Bash",
				});
				if (hit) {
					findings.push({ file: relPath, check_id: rule.id, line, text: command.slice(0, 200) });
					break; // first matching rule wins — mirrors the live evaluator
				}
			}
		}
	}
	return findings;
}

// ===========================================
// Phase D — scoped-scan API for a single detector
// ===========================================
//
// `scanFilesForDetector` is the file-scoped sibling of
// `scanCodebaseForRecurrences`. It runs ONE arbitrary detector against an
// explicit list of files (the Phase D bundle for sibling rescan + the
// cloud-extensibility seam called out in the plan). The existing
// full-tree scanner pivots on the entire registry, which is the wrong
// shape for "rescan one detector against a small file set"; this
// function is the dedicated kernel.
//
// The implementation deliberately duplicates the ~15 lines of file-read +
// skip-on-ENOENT logic from `scanCodebaseForRecurrences` instead of
// factoring it out: the result types differ (`DetectorFinding[]` here vs
// `ScanCodebaseFinding[]` there) and the loop bodies converge to one
// `detector(file, content)` call vs an N-detector loop. Factoring out
// would force a generic wrapper or a callback for the per-file step,
// neither of which is cleaner than the current split.

/** Detector function signature accepted by `scanFilesForDetector`. Pure:
 * the caller's responsibility to make sure the function has no side
 * effects. */
type DetectorFn = (file: string, content: string) => DetectorFinding[];

interface ScanFilesForDetectorOpts {
	/** The single detector to run against each file. */
	detector: DetectorFn;
	/** Absolute paths to scan. */
	files: string[];
	/** Injectable file reader for tests. Defaults to
	 * `fs.readFileSync(p, "utf-8")`. ENOENT and other read errors are
	 * logged on stderr (matching the existing scanner) and the file is
	 * skipped — they never throw out of this function. */
	readFile?: (p: string) => string;
}

/**
 * Run `detector` against each absolute path in `files`. Returns the flat
 * array of findings across all files; unreadable files are logged via
 * stderr and skipped.
 *
 * This is the scoped-scan API the existing full-tree `scanCodebaseForRecurrences`
 * lacks. Phase D's sibling-expansion transformer wraps this for the
 * file-local case; the eventual cloud Agent CI worker reuses it verbatim
 * for full-repo sweeps (per the plan's cloud-extensibility seam).
 */
export function scanFilesForDetector(opts: ScanFilesForDetectorOpts): DetectorFinding[] {
	const readFn = opts.readFile ?? defaultReadFile;
	const out: DetectorFinding[] = [];
	for (const file of opts.files) {
		let content: string;
		try {
			content = readFn(file);
		} catch (err) {
			// The existing scanner logs nothing on read failure (just skips);
			// downstream tooling needs visibility for misbehaving callers, so
			// we surface a warning here on stderr. Same fail-open posture.
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[interlinked:scanFilesForDetector] skipping ${file}: ${msg}\n`);
			continue;
		}
		try {
			out.push(...opts.detector(file, content));
		} catch (err) {
			// A buggy detector must not break the whole batch.
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[interlinked:scanFilesForDetector] detector threw on ${file}: ${msg}\n`);
		}
	}
	return out;
}

function defaultReadFile(p: string): string {
	return readFileSync(p, "utf-8");
}

/** Recursive walker that yields absolute file paths. Uses lstatSync and
 *  skips symlinked entries entirely so we can't follow a link out of the
 *  project tree or into a cycle. */
function* walk(dirAbs: string): Iterable<string> {
	let entries: string[];
	try {
		entries = readdirSync(dirAbs);
	} catch (_err) {
		/* root doesn't exist or is unreadable — empty walk */
		return;
	}
	for (const name of entries) {
		if (SKIP_DIR_NAMES.has(name)) continue;
		const abs = join(dirAbs, name);
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(abs);
		} catch (_err) {
			continue;
		}
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) yield* walk(abs);
		else if (st.isFile()) yield abs;
	}
}
