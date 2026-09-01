// ===========================================
// Hand-rolled patch-applier guard (PreToolUse)
// ===========================================
// The evasion channel this closes was found in the archive, not theorised: a
// 2026-07 session wrote `plm/apply.mjs` plus six `rN.anchor.txt` / `rN.new.txt`
// pairs into its session scratchpad — an anchor/replacement patch applier that
// read the pairs and wrote the result straight into repo source. That is a
// re-implementation of the Edit tool with the content gates removed. Every
// quality signal the harness produces (tsc/biome overlay, pre_block registry,
// coverage + complexity ratchets, reservations, trajectory accounting) is
// attached to the Write/Edit tool path; a script that calls `writeFileSync` on
// `src/**` bypasses all of it while still landing the change.
//
// Scope is deliberately narrow — agent-authored SCRIPTS aimed at an ephemeral
// temp path or the in-repo probe dir (`scratch/`). A committed codegen script
// under `scripts/` or `tools/` writing into `src/` is the legitimate version of
// this shape and must not fire; those live in the repo, are reviewed, and are
// not what an agent reaches for mid-refactor. See `docs/design/`-adjacent notes
// in `scratchpad-write-guard.ts` for the sibling placement policy.
//
// Detection is two-signal and both must hold:
//   1. the script performs a filesystem WRITE (language-specific call set), and
//   2. it aims that write at a path outside its own sandbox — a repo-relative
//      source path, `process.cwd()`, or a `..` escape.
// Requiring a READ as well was considered and rejected: inlining the payload
// would then be a one-line bypass, and a script that writes generated content
// into `src/` from inline strings is the same evasion.

import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { stripCommentsAndStrings } from "../checks/shared-text-utils.js";

/** Script extensions this guard inspects. Non-scripts cannot execute a write,
 *  so they are not a channel. */
const SCRIPT_EXT_RE = /\.(?:mjs|cjs|js|mts|cts|ts|py|sh|bash|zsh|rb)$/i;

/** Filesystem-write calls, across the languages an agent writes probes in.
 *  Shell redirection is covered by the sibling bash-write detector, so this set
 *  is deliberately about in-script APIs. */
const WRITE_CALL_RE =
	/\b(?:writeFileSync|appendFileSync|createWriteStream|copyFileSync|renameSync|fs\.promises\.writeFile|fs\.writeFile|write_text|os\.replace|shutil\.(?:copy|move)|File\.write)\s*\(|\bopen\s*\([^)]*['"][wa]\+?['"]/;

/** Evidence that the write escapes the script's own sandbox and lands in the
 *  guarded project. A quoted repo-relative source path is the dominant form
 *  (`"src/harness/foo.ts"`); `process.cwd()` and `..` cover the computed ones. */
const REPO_TARGET_RE =
	/['"`](?:\.\.\/|\/)?(?:src|lib|app|packages|tests?|docs)\/[^'"`\s]+['"`]|process\.cwd\s*\(\s*\)|\bos\.getcwd\s*\(\s*\)|['"`]\.\.\//;

/** Module-specifier positions: `import … from "x"`, bare `import "x"`,
 *  `export … from "x"`, `require("x")`, and dynamic `import("x")`. */
const MODULE_SPECIFIER_RE =
	/\b(?:import|export)\b[^;\n]*?\bfrom\s*['"`][^'"`]+['"`]|\bimport\s*\(\s*['"`][^'"`]+['"`]\s*\)|\bimport\s+['"`][^'"`]+['"`]|\brequire\s*\(\s*['"`][^'"`]+['"`]\s*\)/g;

/** Remove module specifiers before looking for a write DESTINATION.
 *
 *  A path in an import position is resolved by the module loader; it is never
 *  somewhere a script writes. Scanning raw content conflated the two, so this
 *  guard twice blocked a scratch PROBE whose only repo-shaped literal was its
 *  own import (`from "../src/lib/hooks-template.js"`) while every write it
 *  made targeted an mkdtemp path (2026-08-27 dogfood). The write-call signal is
 *  unchanged, and a real applier's destination appears in the write call rather
 *  than in an import, so removing these positions costs no detection. */
function stripModuleSpecifiers(content: string): string {
	return content.replace(MODULE_SPECIFIER_RE, " ");
}

/** What fired, for the block reason. Both fields are the matched source text,
 *  trimmed — the agent needs to see its own line to know what to remove. */
interface PatchApplierEvidence {
	writeCall: string;
	repoTarget: string;
}

/** One-command bypass, mirroring the sibling guards' convention. Separate from
 *  INTERLINKED_DISABLE_SCRATCH_GUARD so a placement-policy bypass does not
 *  silently also open the evasion channel. */
export function isPatchApplierGuardDisabled(): boolean {
	return process.env.INTERLINKED_DISABLE_PATCH_APPLIER_GUARD === "1";
}

/**
 * Detect a hand-rolled patch applier in `content`. Returns the matched
 * evidence, or null when the content is not a script, performs no write, or
 * keeps its writes inside its own sandbox.
 *
 * Public API — exported for the guard wiring and for direct unit testing
 * without constructing a hook event.
 */
export function detectPatchApplier(
	content: string,
	filePath: string,
): PatchApplierEvidence | null {
	if (!SCRIPT_EXT_RE.test(filePath)) return null;
	// Red-team F3: match the WRITE CALL against comment- and string-stripped
	// source. A write call quoted inside a string is data, not a write — this
	// guard blocked a probe script that only carried write-shaped payloads, and
	// any review tool or security fixture that quotes offending code hits the
	// same wire. The repo TARGET still matches raw content: a real applier's
	// destination is normally a string literal, which stripping would erase.
	const write = WRITE_CALL_RE.exec(stripCommentsAndStrings(content));
	if (!write) return null;
	const target = REPO_TARGET_RE.exec(stripModuleSpecifiers(content));
	if (!target) return null;
	return { writeCall: write[0].trim(), repoTarget: target[0].trim() };
}

/** Interpreters that can execute a script file passed as an argument. */
const EXEC_INTERPRETER_RE =
	/(?:^|[;&|]\s*)(?:node|tsx|npx\s+tsx|python3?|bash|sh|zsh|ruby|deno\s+run|bun)\s+((?:[^\s;&|]+\/)?[^\s;&|]+\.(?:mjs|cjs|js|mts|cts|ts|py|sh|bash|zsh|rb))\b/g;

/** Reviewed in-repo homes for legitimate codegen — executing those is fine. */
const REVIEWED_SCRIPT_DIR_RE = /(?:^|\/)(?:scripts|tools|node_modules|dist|build)\//;

const EXEC_SCAN_MAX_BYTES = 64 * 1024;

/**
 * Gap 5 (2026-08-25 audit): the write-time guard above fires when the applier
 * SCRIPT is written — but a script written before the guard existed, or
 * fetched, evades it and only Ring 2 sees the aftermath. This closes the
 * EXECUTION door: a bash command running an interpreter on an existing script
 * file gets that file's first 64KB run through the same two-signal applier
 * classifier. Committed script homes (scripts/, tools/) are exempt — those are
 * the reviewed version of the shape.
 */
export function detectPatchApplierExecution(
	cmd: string,
	projectRoot: string,
): { scriptPath: string; evidence: PatchApplierEvidence } | null {
	for (const m of cmd.matchAll(EXEC_INTERPRETER_RE)) {
		const raw = m[1];
		if (!raw || REVIEWED_SCRIPT_DIR_RE.test(raw)) continue;
		const abs = isAbsolute(raw) ? raw : resolve(projectRoot, raw);
		let content: string;
		try {
			if (statSync(abs).size > EXEC_SCAN_MAX_BYTES) continue;
			content = readFileSync(abs, "utf-8");
		} catch {
			continue; // no such file / unreadable — nothing to classify
		}
		const evidence = detectPatchApplier(content, abs);
		if (evidence) return { scriptPath: raw, evidence };
	}
	return null;
}

/** Block reason. Names the two matched fragments so the agent can see exactly
 *  which lines made it an applier, and points at the sanctioned channel. */
export function buildPatchApplierReason(opts: {
	target: string;
	evidence: PatchApplierEvidence;
}): string {
	return (
		`BLOCKED: ${basename(opts.target)} is a hand-rolled patch applier — a throwaway script ` +
		`that writes into repo source (\`${opts.evidence.writeCall}\` … \`${opts.evidence.repoTarget}\`). ` +
		`Landing edits this way bypasses every content gate the Write/Edit tools run ` +
		`(tsc + biome diff-overlay, pre_block registry checks, coverage/complexity ratchets, ` +
		`reservations, trajectory accounting) while still changing the code — the change lands ` +
		`unmeasured and unattributed. Use the Edit tool directly: a transiently non-compiling ` +
		`intermediate no longer blocks, it opens a transient debt you discharge with the ` +
		`counterpart edit. If this script genuinely needs to write generated output, commit it ` +
		`under scripts/ where it is reviewable. Bypass: INTERLINKED_DISABLE_PATCH_APPLIER_GUARD=1.`
	);
}
