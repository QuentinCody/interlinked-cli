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
// PROGRAM-SCOPE INDIRECTION (2026-08-16, followup #26). Requiring the repo path
// literal AT the write call left one line of indirection open, and it was walked
// twice in one day:
//
//   python3 - <<EOF
//   p1 = 'src/harness/x.ts'          # literal here
//   open(p1, 'w').write(BODY)        # write there
//   EOF
//
// So signal 2 is now scoped to the PROGRAM, not the call: any gated repo-source
// literal anywhere in one inline program plus any write call anywhere in that
// same program is both signals. The two-signal shape is unchanged — a read-only
// program still never fires, and a program with no repo literal still never
// fires. One refinement keeps the obvious FP out: a write call whose OWN
// destination is a resolvable literal was already judged by the direct pass, so
// `read src/x.ts → write /tmp/out.ts` is proven-safe and is not an indirect
// write signal.
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

/** An inline program plus how it reached the interpreter. */
interface InlineProgram {
	interpreter: string;
	form: string;
	body: string;
}

/** One-command bypass, mirroring INTERLINKED_DISABLE_PATCH_APPLIER_GUARD. Kept
 *  separate from the sibling hatches so opening one channel never opens another. */
export function isInterpreterWriteGuardDisabled(): boolean {
	return process.env.INTERLINKED_DISABLE_INTERPRETER_WRITE_GUARD === "1";
}

/** Interpreters whose inline programs can write files. `sh`/`bash` are absent on
 *  purpose: a shell heredoc's writes are redirects, which the sibling gate owns. */
const INTERPRETER_WORD_RE = /^(?:[\w.\-/]*\/)?(python3(?:\.\d+)?|python|node|perl|ruby)$/;

/** Command words that precede the real verb without replacing it. */
const TRANSPARENT_PREFIXES = new Set(["env", "command", "exec", "nohup", "time"]);

/** `VAR=value` prefix assignment (bash evaluates these before the verb). */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Characters that end one command segment and start the next. */
const SEGMENT_BREAKS = ["\n", ";", "&", "|", "("] as const;

/** How far past a segment start we need to look to find its command word. */
const COMMAND_WORD_LOOKAHEAD = 80;

/** Longest write-call fragment quoted back in the block reason. */
const EVIDENCE_MAX = 90;

/**
 * The interpreter a command SEGMENT invokes, or null for every other verb.
 * Only the segment's own command word counts — skipping `VAR=` assignments and
 * transparent prefixes — so `cat <<EOF` is not a program and neither is a
 * `python3 -c …` line quoted inside an `echo` argument.
 */
function interpreterOf(segment: string): string | null {
	for (const word of segment.trim().split(/\s+/)) {
		if (word === "") continue;
		if (ASSIGNMENT_RE.test(word)) continue;
		if (TRANSPARENT_PREFIXES.has(word)) continue;
		const m = INTERPRETER_WORD_RE.exec(word);
		return m ? nonNull(m[1]) : null; // the first real word decides, either way
	}
	return null;
}

/** The interpreter of the segment containing `atIdx`, or null. `atIdx` points at
 *  the heredoc operator (whose segment head precedes it) or at the interpreter
 *  word itself; a bounded look-ahead covers both without scanning a whole body. */
function segmentInterpreter(cmd: string, atIdx: number): string | null {
	const head = cmd.slice(0, atIdx);
	let segStart = -1;
	for (const ch of SEGMENT_BREAKS) segStart = Math.max(segStart, head.lastIndexOf(ch));
	return interpreterOf(cmd.slice(segStart + 1, atIdx + COMMAND_WORD_LOOKAHEAD));
}

/** Heredoc operator + delimiter: `<<EOF`, `<<-EOF`, `<<'PY'`, `<< "SH"`. */
const HEREDOC_RE = /<<-?\s*(?:"([A-Za-z_][\w.-]*)"|'([A-Za-z_][\w.-]*)'|([A-Za-z_][\w.-]*))/g;

/** Body of a heredoc: the lines after the operator up to the line whose trimmed
 *  text is the delimiter. A missing terminator yields the rest of the command —
 *  a truncated payload still carries the write. */
function heredocBody(cmd: string, afterOp: number, delimiter: string): string {
	const nl = cmd.indexOf("\n", afterOp);
	if (nl === -1) return "";
	const lines = cmd.slice(nl + 1).split("\n");
	const end = lines.findIndex((line) => line.trim() === delimiter);
	return (end === -1 ? lines : lines.slice(0, end)).join("\n");
}

/** Programs fed to an interpreter on stdin via a heredoc. */
function collectHeredocPrograms(cmd: string): InlineProgram[] {
	const programs: InlineProgram[] = [];
	for (const m of cmd.matchAll(HEREDOC_RE)) {
		const delimiter = m[1] ?? m[2] ?? m[3];
		if (delimiter === undefined) continue;
		const idx = m.index;
		const interpreter = segmentInterpreter(cmd, idx);
		if (!interpreter) continue;
		programs.push({
			interpreter,
			form: `heredoc (<<${delimiter})`,
			body: heredocBody(cmd, idx + m[0].length, delimiter),
		});
	}
	return programs;
}

/** `python3 -c "…"` / `node -e '…'`, with optional flags before the script. */
const INLINE_FLAG_RE =
	/(?:[\w.\-/]*\/)?(python3(?:\.\d+)?|python|node|perl|ruby)\s+(?:-[A-Za-z-]\S*\s+){0,6}?-([ce])\s+("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/g;

/** Programs passed inline with `-c` / `-e`. */
function collectFlagPrograms(cmd: string): InlineProgram[] {
	const programs: InlineProgram[] = [];
	for (const m of cmd.matchAll(INLINE_FLAG_RE)) {
		const quoted = m[3];
		if (quoted === undefined) continue;
		// The interpreter must be the segment's command word, not a word inside
		// another command's quoted argument (`echo "python3 -c …"` is data).
		const interpreterIdx = m.index + m[0].indexOf(nonNull(m[1]));
		if (!segmentInterpreter(cmd, interpreterIdx)) continue;
		programs.push({
			interpreter: nonNull(m[1]),
			form: `-${nonNull(m[2])}`,
			body: quoted.slice(1, -1),
		});
	}
	return programs;
}

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
 * A write call whose DESTINATION is not a string literal — a variable, an
 * attribute, a call result. `mode`, when set, is a group that must name a
 * writing mode. These are exactly the calls the direct pass cannot judge, which
 * is why they only count as a signal alongside a repo literal elsewhere in the
 * same program.
 */
interface IndirectWritePattern {
	re: RegExp;
	mode?: number;
}

const INDIRECT_WRITE_PATTERNS: readonly IndirectWritePattern[] = [
	// python — open(dest, "w"), dest not a literal
	{ re: /\bopen\s*\(\s*(?:file\s*=\s*)?(?!['"])[^,()]{1,80},\s*(?:mode\s*=\s*)?['"]([^'"]*)['"]/g, mode: 1 },
	// python — Path(dest).write_text(…) / a Path variable's .write_text(…)
	{ re: /\bPath\s*\(\s*(?!['"])[^)]{1,80}\)\s*\.\s*write_(?:text|bytes)\s*\(/g },
	{ re: /\b[A-Za-z_$][\w$]*\s*\.\s*write_(?:text|bytes)\s*\(/g },
	// node — fs write helpers whose first argument is an identifier or a call
	{
		re: /\b(?:fs\s*\.\s*)?(?:promises\s*\.\s*)?(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\s*\(\s*(?!['"`])[A-Za-z_$(]/g,
	},
	// ruby — File.write(dest, …) / File.open(dest, "w"), dest not a literal
	{ re: /\b(?:File|IO)\s*\.\s*(?:write|binwrite)\s*\(?\s*(?!['"])[A-Za-z_@$]/g },
	{ re: /\bFile\s*\.\s*open\s*\(\s*(?!['"])[^,)]{1,80},\s*['"]([^'"]*)['"]/g, mode: 1 },
	// perl — open(FH, ">", $dest)
	{ re: /\bopen\s*\([^,\n]{1,64},\s*['"]\s*>>?\s*['"]\s*,\s*(?!['"])[^)\n]{1,64}\)/g },
];

/** Every string literal in the program, in source order. */
const STRING_LITERAL_RE = /['"`]([^'"`\n]{1,200})['"`]/g;

/** First write call with a non-literal destination, or null. */
function findIndirectWriteCall(body: string): string | null {
	for (const pattern of INDIRECT_WRITE_PATTERNS) {
		for (const m of body.matchAll(pattern.re)) {
			if (pattern.mode !== undefined && !WRITE_MODE_RE.test(m[pattern.mode] ?? "")) continue;
			return m[0].trim().slice(0, EVIDENCE_MAX);
		}
	}
	return null;
}

/**
 * Program-scope fallback: a gated repo-source literal anywhere in the program
 * plus a write call anywhere in it whose destination the direct pass could not
 * read. Signal 1 (the interpreter) already held to get here.
 */
function scanProgramForIndirectWrite(
	program: InlineProgram,
	cmd: string,
	projectRoot: string,
): InterpreterWriteHit | null {
	const writeCall = findIndirectWriteCall(program.body);
	if (writeCall === null) return null;
	for (const m of program.body.matchAll(STRING_LITERAL_RE)) {
		const target = m[1];
		if (target === undefined) continue;
		const resolved = resolveGatedTarget(cmd, target, projectRoot);
		if (resolved === null) continue;
		return { interpreter: program.interpreter, form: program.form, writeCall, target, resolved, indirect: true };
	}
	return null;
}

/**
 * Detect an inline interpreter program that writes repo source. Returns the
 * matched evidence, or null when either signal is missing.
 *
 * Two passes, direct first: a write call naming its own repo-path literal is the
 * most specific evidence and gives the best message, so it wins when present.
 * Only when no program writes through a literal does the program-scope pass run.
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
		? `writes through \`${hit.writeCall}\`, and the same program names the tracked source file ` +
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
