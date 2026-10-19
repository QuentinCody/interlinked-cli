// ===========================================
// Inline-interpreter write guard (PreToolUse)
// ===========================================
// The uncovered half of `docs/design/bash-writes-through-content-gates.md`.
// Shell REDIRECTS into repo source (`> file`, `tee`, `sed -i`, `cp`) are already
// refused by `detectBashCodeFileWrite` (pre-checks-bash-write-detect.ts). An
// INLINE INTERPRETER PROGRAM is the same evasion through a different door:
//
//   python3 - <<EOF
//   open("src/harness/server/lifecycle-stop-warnings.ts", "w").write(BODY)
//   EOF
//
// That is not theory — it is the 2026-08-15 incident (finding #18 in
// scratch/fleet-r3/repair-followups.txt): with the daemon crash-looping, a build
// agent set INTERLINKED_ALLOW_NO_DAEMON=1 and landed 4 of its 7 repo files via
// python heredocs. Nothing judged them — not the line cap, not the pre_block
// registry, not the coverage or complexity ratchets — and one file came to rest
// at exactly the 500-line cap with zero headroom.
//
// Detection is TWO-SIGNAL, mirroring patch-applier-guard.ts, and both must hold:
//   1. INTERPRETER — the command feeds an inline program to python/node/perl/ruby,
//      either on stdin via a heredoc (`python - <<EOF`, `python3 <<'PY'`) or with
//      `-c` / `-e`. The interpreter must be the SEGMENT's own command word, so an
//      interpreter line QUOTED as data inside `echo`/`printf` is not a program.
//   2. REPO TARGET — that program's write call names a string-literal path which
//      resolves INSIDE the working tree, to a tracked source extension, and NOT
//      under `<repo>/scratch/` or an ephemeral temp root. Targets are resolved
//      exactly as the shell would (same-command `VAR=` assignments and `cd` hops)
//      through the sibling `resolveBashWriteTarget`, so `DEST=src/x.ts … open("$DEST","w")`
//      and `cd src/harness && … open("landed.ts","w")` both land on a real path.
// One signal alone never blocks: a read-only interpreter program is ordinary
// tooling, and a repo path mentioned by a non-interpreter command is just text.
//
// BOUND DESTINATIONS. Requiring the repo path literal AT the write call leaves
// simple variable indirection open (2026-08-16, followup #26):
//
//   python3 - <<EOF
//   p1 = 'src/harness/x.ts'          # literal here
//   open(p1, 'w').write(BODY)        # write there
//   EOF
//
// Resolve the destination's own simple binding, never another literal elsewhere
// in the program. The old program-wide pairing blocked a JSON bookkeeping write
// merely because it hashed runner/native.py (2026-10-15). Reassignments, scopes
// and computed expressions that this bounded analysis cannot resolve are not
// evidence of a source write; they belong on the advisory path.
//
// SCOPE, deliberately narrow:
//   • A command carrying a shell redirect is NOT this guard's business — the
//     redirect gate above owns `cat <<EOF > file`, and this phase is wired AFTER
//     it so the two never double-fire.
//   • A target outside the repo, in `<repo>/scratch/`, or under /tmp is allowed:
//     no content gate governs it, and blocking it would only push probe scripts
//     somewhere worse (measured FP class — see pre-checks-bash-write-detect.ts).
//   • A computed target (no string literal) is not detected. Bounding the guard
//     to what it can PROVE is what keeps it blockable at zero FP.
//
// Bypass: INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD=1 — one command, and the
// would-be block is downgraded to a loud warning rather than silently dropped.

import { join, resolve, sep } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { stripCommentsByLine, stripForBraceScan } from "../checks/shared-text-utils.js";
import { collectFlagPrograms, collectHeredocPrograms, type InlineProgram } from "../interpreter-programs.js";
import { CODE_FILE_EXT_RE, resolveBashWriteTarget } from "../pre-checks-bash-write-detect.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { isEphemeralTempPath } from "./filesystem-guards.js";
import { isBash } from "./tool-classifiers.js";

type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

/** What fired, for the block reason. Every field is evidence the agent can act
 *  on: its own interpreter, its own write call, and the path we resolved. */
interface InterpreterWriteHit {
	/** Interpreterbinary that received the program (`python3`, `node`, …). */
	interpreter: string;
	/** How the program was delivered: `heredoc (<<EOF)`, `-c`, or `-e`. */
	form: string;
	/** The matched write call, verbatim (truncated) — the agent's own line. */
	writeCall: string;
	/** Path literal as written in the program. */
	target: string;
	/** Absolute path that literal resolves to (`VAR=` + `cd` hops applied). */
	resolved: string;
	/** True when the literal and the write call are separate statements of the
	 *  same program (`p = 'src/x.ts'` … `open(p,'w')`) rather than one call. */
	indirect?: boolean;
}

/** One-command bypass, mirroring INTERLINKED_DISABLE_PATCH_APPLIER_GUARD. Kept
 *  separate from the sibling hatches so opening one channel never opens another. */
export function isInterpreterWriteGuardDisabled(): boolean {
	return process.env.INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD === "1";
}

// Interpreter recognition and inline-program extraction (interpreterOf,
// collectHeredocPrograms, collectFlagPrograms) live in ../interpreter-programs.ts,
// shared with the network-intent predicate since 2026-10-05.

/** Longest write-call fragment quoted back in the block reason. */
const EVIDENCE_MAX = 90;

/** A filesystem-write call whose destination is a string literal. `path` is the
 *  capture group holding that literal; `mode`, when set, is a group that must
 *  name a writing mode (an `open` for READING is not a write). */
interface WritePattern {
	re: RegExp;
	path: number;
	mode?: number;
}

/** Modes that create or truncate. `r` alone is a read and must not match. */
const WRITE_MODE_RE = /[wax]/;

const WRITE_PATTERNS: readonly WritePattern[] = [
	// python — open("p", "w"|"a"|"x"…). Opening for write TRUNCATES, so the mode
	// alone is the write; a trailing `.write` / `.writelines` need not be adjacent
	// (`f = open(p, "w")` on one line, `f.write(body)` on the next is the norm).
	{
		re: /\bopen\s*\(\s*(?:file\s*=\s*)?['"]([^'"]+)['"]\s*,\s*(?:mode\s*=\s*)?['"]([^'"]*)['"]/g,
		path: 1,
		mode: 2,
	},
	// python — pathlib
	{ re: /\bPath\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.write_(?:text|bytes)\s*\(/g, path: 1 },
	// node — fs.writeFileSync / appendFileSync / fs.promises.writeFile / streams
	{
		re: /\b(?:fs\s*\.\s*)?(?:promises\s*\.\s*)?(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\s*\(\s*['"`]([^'"`]+)['"`]/g,
		path: 1,
	},
	// ruby — File.write / IO.write / File.open(p, "w")
	{ re: /\b(?:File|IO)\s*\.\s*(?:write|binwrite)\s*\(?\s*['"]([^'"]+)['"]/g, path: 1 },
	{ re: /\bFile\s*\.\s*open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/g, path: 1, mode: 2 },
	// perl — three-argument open(FH, ">", "p") and two-argument open(FH, ">p")
	{ re: /\bopen\s*\([^,\n]{1,64},\s*['"]\s*>>?\s*['"]\s*,\s*['"]([^'"]+)['"]/g, path: 1 },
	{ re: /\bopen\s*\([^,\n]{1,64},\s*['"]\s*>>?\s*([^'">][^'"]*)['"]/g, path: 1 },
];

/** True when `resolved` sits under the repo's `scratch/` probe dir — the
 *  sanctioned home for throwaway scripts, deliberately outside this gate. */
function isRepoScratchPath(resolved: string, root: string): boolean {
	return resolved.startsWith(`${join(root, "scratch")}${sep}`);
}

/**
 * The write's destination, when it is a path the content gates actually own:
 * resolvable, a tracked source extension, inside the working tree, and neither
 * `<repo>/scratch/` nor an ephemeral temp root. Returns null otherwise — an
 * unresolvable target (unknown leading variable) is NOT provably in-repo, so it
 * passes, the same call the sibling redirect detector makes.
 */
function resolveGatedTarget(cmd: string, target: string, projectRoot: string): string | null {
	const resolved = resolveBashWriteTarget(cmd, target, projectRoot);
	if (resolved === null) return null;
	if (!CODE_FILE_EXT_RE.test(resolved)) return null;
	if (isEphemeralTempPath(resolved)) return null;
	const root = resolve(projectRoot);
	if (resolved !== root && !resolved.startsWith(root + sep)) return null;
	if (isRepoScratchPath(resolved, root)) return null;
	return resolved;
}

/** First write-into-repo-source call in one program, or null. */
function scanProgramForRepoWrite(
	program: InlineProgram,
	cmd: string,
	projectRoot: string,
): InterpreterWriteHit | null {
	for (const pattern of WRITE_PATTERNS) {
		for (const m of program.body.matchAll(pattern.re)) {
			const target = m[pattern.path];
			if (target === undefined) continue;
			if (pattern.mode !== undefined && !WRITE_MODE_RE.test(m[pattern.mode] ?? "")) continue;
			const resolved = resolveGatedTarget(cmd, target, projectRoot);
			if (resolved === null) continue;
			return {
				interpreter: program.interpreter,
				form: program.form,
				writeCall: m[0].trim().slice(0, EVIDENCE_MAX),
				target,
				resolved,
			};
		}
	}
	return null;
}

/**
 * A write call whose DESTINATION is a simple variable rather than a literal.
 * Capture the actual destination identifier (group 1), not
 * an arbitrary source-looking literal. Complex expressions remain advisory.
 */
interface IndirectWritePattern {
	re: RegExp;
	mode?: number;
}

const INDIRECT_WRITE_PATTERNS: readonly IndirectWritePattern[] = [
    // python — open(dest, "w"), dest not a literal
    { re: /\bopen\s*\(\s*(?:file\s*=\s*)?([A-Za-z_]\w*)\s*,\s*(?:mode\s*=\s*)?['"]([^'"]*)['"]/g, mode: 2 },
    // python — Path(dest).write_text(…) / a Path variable's .write_text(…)
    { re: /\bPath\s*\(\s*([A-Za-z_]\w*)\s*\)\s*\.\s*write_(?:text|bytes)\s*\(/g },
    { re: /\b([A-Za-z_]\w*)\s*\.\s*write_(?:text|bytes)\s*\(/g },
    // node — fs write helpers whose first argument is an identifier
    {
        re: /\b(?:fs\s*\.\s*)?(?:promises\s*\.\s*)?(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g,
    },
    // ruby — File.write(dest, …) / File.open(dest, "w"), dest not a literal
    { re: /\b(?:File|IO)\s*\.\s*(?:write|binwrite)\s*\(?\s*([A-Za-z_$][\w$]*)\s*,/g },
    { re: /\bFile\s*\.\s*open\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*['"]([^'"]*)['"]/g, mode: 2 },
    // perl — open(FH, ">", $dest)
    { re: /\bopen\s*\([^,\n]{1,64},\s*['"]\s*>>?\s*['"]\s*,\s*(\$[A-Za-z_]\w*)\s*\)/g },
];

/** Plain string/Path assignments only; no escapes, interpolation or expressions. */
const SIMPLE_PATH_BINDING_RE = /(?:^|[;\n])[ \t]*(?:(?:const|let|var|my)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:Path\s*\(\s*(['"])([^'"\\\r\n]+)\2\s*\)|(['"])([^'"\\\r\n]+)\4)[ \t]*(?=;|\r?$|#|\/\/)/gm;

/** A `with open(dest, "w") as f:` statement is straight-line code whose
 *  write call the `with` keyword merely introduces; any other `with` (an
 *  earlier block) is a scope this pass does not model. */
const WITH_BEFORE_CALL_RE = /\bwith\s+$/;

/** Resolve only a single-use binding in straight-line code before this write.
 * Extra references can be reassignment, destructuring or shadowing: abstain
 * rather than attempting language-wide dataflow. Strings/comments are inert. */
function boundWriteTarget(body: string, executable: string, name: string, writeAt: number): string | null {
    const prefix = executable.slice(0, writeAt).replace(WITH_BEFORE_CALL_RE, "");
    if (/[{}:]|\b(?:def|class|lambda|function|sub|if|for|while|do|end|try|with|eval|exec|chdir)\b/.test(prefix)) return null;
    const mentions = [...prefix.matchAll(/[A-Za-z_$][\w$]*/g)].filter(m => m[0] === name);
    if (mentions.length !== 1) return null;
    for (const binding of body.slice(0, writeAt).matchAll(SIMPLE_PATH_BINDING_RE)) {
        if (binding[1] !== name) continue;
        // The name is the last token before the `=`; a keyword prefix
        // (`const s = …`) may contain the same letters, so never `indexOf`.
        const head = binding[0].slice(0, binding[0].indexOf("="));
        const nameAt = binding.index + head.lastIndexOf(name);
        if (mentions[0]?.index !== nameAt) continue;
        const target = binding[3] ?? binding[5];
        // Perl/Ruby interpolation is not a literal destination.
        return target && !/\$|#\{/.test(target) ? target : null;
    }
    return null;
}

const TRIPLE_QUOTED_RE = /('''|""")[\s\S]*?\1/g;

/** Blank Python triple-quoted strings (delimiters included, newlines kept)
 *  so the line-oriented strippers never see their bodies as code. Returns
 *  null on an unterminated triple quote: the program's structure is unknown. */
function blankTripleQuoted(body: string): string | null {
    const blanked = body.replace(TRIPLE_QUOTED_RE, (m) => m.replace(/[^\n]/g, " "));
    return /'''|"""/.test(blanked) ? null : blanked;
}

/**
 * Follow a simple destination binding. A filename used as input, a hash key or
 * an output payload never supplies evidence about another write's destination.
 */
function scanProgramForIndirectWrite(
    program: InlineProgram,
    cmd: string,
    projectRoot: string,
): InterpreterWriteHit | null {
    // Multi-line literals are blanked before the line-oriented strippers run;
    // the brace scanner already models JS template literals.
    const flat = blankTripleQuoted(program.body);
    if (flat === null) return null;
    const executable = stripForBraceScan(stripCommentsByLine(flat));
    for (const pattern of INDIRECT_WRITE_PATTERNS) {
        for (const m of program.body.matchAll(pattern.re)) {
            if (pattern.mode !== undefined && !WRITE_MODE_RE.test(m[pattern.mode] ?? "")) continue;
            const name = m[1];
            if (!name || executable[m.index] !== program.body[m.index]) continue;
            // A property receiver is not a reference to a same-named local.
            if (/[\w$.]/.test(program.body[m.index - 1] ?? "")) continue;
            const target = boundWriteTarget(program.body, executable, name, m.index);
            if (target === null) continue;
            const resolved = resolveGatedTarget(cmd, target, projectRoot);
            if (resolved === null) continue;
            const writeCall = m[0].trim().slice(0, EVIDENCE_MAX);
            return { interpreter: program.interpreter, form: program.form, writeCall, target, resolved, indirect: true };
        }
    }
    return null;
}

/**
 * Detect an inline interpreter program that writes repo source. Returns the
 * matched evidence, or null when either signal is missing.
 *
 * Two passes, direct first: a write call naming its own repo-path literal is the
 * most specific evidence and gives the best message, so it wins when present.
 * Only when no program writes through a literal does the variable-binding pass run.
 *
 * Public API — exported for the guard wiring and for direct unit testing
 * without constructing a hook event.
 */
export function detectInterpreterWrite(cmd: string, projectRoot: string): InterpreterWriteHit | null {
	if (!cmd || !projectRoot) return null;
	const programs = [...collectHeredocPrograms(cmd), ...collectFlagPrograms(cmd)];
	for (const program of programs) {
		const hit = scanProgramForRepoWrite(program, cmd, projectRoot);
		if (hit) return hit;
	}
	for (const program of programs) {
		const hit = scanProgramForIndirectWrite(program, cmd, projectRoot);
		if (hit) return hit;
	}
	return null;
}

/** Literal write destinations one pattern finds in one program body. */
function patternWriteTargets(body: string, pattern: WritePattern): string[] {
	const found: string[] = [];
	for (const m of body.matchAll(pattern.re)) {
		const target = m[pattern.path];
		if (target === undefined) continue;
		if (pattern.mode !== undefined && !WRITE_MODE_RE.test(m[pattern.mode] ?? "")) continue;
		found.push(target);
	}
	return found;
}

/**
 * Every literal write destination of this command's inline programs, resolved
 * to an absolute path — WITHOUT the gate's own filters (tracked extension, in
 * repo, not a temp root). The gate decides what it may block; the taint-flow
 * recorder (`taint-lineage-flow.ts`) needs every file an actor wrote, whatever
 * its extension or location. One write-pattern table serves both.
 */
export function interpreterWriteTargets(cmd: string, cwd: string): string[] {
	if (!cmd) return [];
	const programs = [...collectHeredocPrograms(cmd), ...collectFlagPrograms(cmd)];
	const literals = programs.flatMap((p) => WRITE_PATTERNS.flatMap((pat) => patternWriteTargets(p.body, pat)));
	return literals
		.map((target) => resolveBashWriteTarget(cmd, target, cwd))
		.filter((resolved): resolved is string => resolved !== null);
}

/** Write tokens whose FIRST argument is computed (not a string literal) — the
 *  destination the direct/indirect passes cannot resolve. `open` is excluded:
 *  `open(f)` for reading is ubiquitous and mode-less matches would drown it. */
const COMPUTED_WRITE_RE =
	/\b(writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile|write_text|write_bytes)\s*\(\s*(?!['"`])/;

/** Gap 4 (2026-08-25 audit): an inline program with a write call whose
 *  destination is computed is UNPROVABLE pre-execution — not blockable at zero
 *  FP, but silence taught nothing. Returns the interpreter + call token for a
 *  warning; null when every write is literal (the block passes own those). */
export function detectComputedInterpreterWrite(
	cmd: string,
): { interpreter: string; call: string } | null {
	if (!cmd) return null;
	for (const program of [...collectHeredocPrograms(cmd), ...collectFlagPrograms(cmd)]) {
		const m = COMPUTED_WRITE_RE.exec(program.body);
		if (m) return { interpreter: program.interpreter, call: nonNull(m[1]) };
	}
	return null;
}

/** Block reason. Names the interpreter, the matched write call and the RESOLVED
 *  target so an indirect path (`$DEST`, a `cd` hop) is unambiguous, then points
 *  at the sanctioned channel — same voice as the redirect gate's message. */
export function buildInterpreterWriteReason(hit: InterpreterWriteHit): string {
	const how = hit.indirect
        ? `writes through \`${hit.writeCall}\`, whose destination is bound to the source file ` +
            `${hit.resolved} (\`${hit.target}\`). Routing the path through a variable does not move ` +
			`the write out of the repo. An interpreter `
		: `writes a tracked source file at ${hit.resolved} (\`${hit.writeCall}\`). An interpreter `;
	return (
		`BLOCKED: This Bash command runs an inline ${hit.interpreter} program (${hit.form}) that ` +
		how +
		`program that writes repo source lands the change with NONE of the checks the Write and ` +
		`Edit tools run — per-file line cap, pre_block registry checks, tsc and biome diff-overlay, ` +
		`coverage and complexity ratchets — so it lands unmeasured and unattributed. Use the Write ` +
		`or Edit tool for ${hit.target} so the content is judged before it lands; a transiently ` +
		`non-compiling intermediate no longer blocks, it opens a transient debt that the counterpart ` +
		`edit discharges. If you genuinely need one atomic multi-file write, PIPE the manifest on ` +
		`stdin (\`… | interlinked multi-edit --stdin\`). Generated output belongs under a committed ` +
		`script in scripts/, and throwaway probes belong in <repo>/scratch/ — both are outside this ` +
		`gate. Bypass: INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD=1.`
	);
}

/**
 * GUARD: inline-interpreter writes into repo source. Consumed by
 * evaluator/pre-tool.ts immediately AFTER the destructive-rules phase, so the
 * shell-redirect gate inside it keeps ownership of `cat <<EOF > file` and the
 * two never double-fire on one command.
 *
 * This guard PERSISTS NOTHING — no ledger, no baseline, no state — so a dry run
 * (`interlinked harness test`, `event.dry_run`) is already a pure read and needs
 * no special casing. Keep it that way: if a future revision starts writing a
 * record, thread `event.dry_run` first (the 2026-08-04 lesson in CLAUDE.md).
 */
export function evaluateInterpreterWriteGuard(
	event: HarnessEvent,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	if (!isBash(toolName) || !event.cwd) return null;
	const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
	const hit = detectInterpreterWrite(cmd, event.cwd);
	if (!hit) {
		const soft = detectComputedInterpreterWrite(cmd);
		if (soft) {
			warnings.push(
				`[interlinked:interpreter-write] [heuristic] Inline ${soft.interpreter} program calls ` +
					`${soft.call}( with a COMPUTED destination the guard cannot resolve pre-execution. ` +
					`If it targets repo source, use the Write/Edit tools so the content gates judge it; ` +
					`throwaway probes belong in <repo>/scratch/. The post-tool ChangeSet is judged either way.`,
			);
		}
		return null;
	}
	if (isInterpreterWriteGuardDisabled()) {
		// Logged, never silent: the bypass exists for documented flows, and an
		// ungated write to repo source should still leave a trace in the session.
		warnings.push(
			`[interlinked:interpreter-write] Guard bypassed via ` +
				`INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD=1 — an inline ${hit.interpreter} program ` +
				`writes ${hit.resolved} without the Write/Edit content gates.`,
		);
		return null;
	}
	return {
		decision: "block",
		reason: buildInterpreterWriteReason(hit),
		warnings,
		rule_id: "builtin-interpreter-write",
		severity: "high",
		category: "harness-integrity",
	};
}
