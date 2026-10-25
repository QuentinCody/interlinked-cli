// Baseline-integrity gate, Bash arm — and the config-loosening gate's Bash arm.
//
// Red-team finding F1 (2026-08-09, docs/design/red-team-findings-2026-08-09.md):
// `evaluateBaselineIntegrityGate` was gated on `isFileWrite(toolName)`, so the
// anti-gaming detector never saw a shell command. Measured against the live
// daemon, ALL of these were allowed:
//
//   echo '<lowered>' > .interlinked/metric-caps.json
//   sed -i '' s/22/999/ .interlinked/metric-caps.json
//   echo '<lowered>' | tee .interlinked/metric-caps.json
//   python3 -c "open('…/metric-caps.json','w').write(…)"
//   cp /tmp/x.json .interlinked/metric-caps.json
//
// One shell line therefore defeated every ratchet at once (coverage, mutation,
// cyclomatic/CRAP, line cap, untested-file floor). The commit-gate backstop
// covers only the 3 git-tracked baselines at a real `git commit`; the
// gitignored ones had no backstop at all, and a fleet agent never commits.
//
// Stance: FAIL-CLOSED on the unverifiable path. The Write/Edit arm compares
// before/after content and permits a tightening edit. A shell command's
// resulting bytes are not knowable pre-execution, so this arm refuses ANY
// shell write to a water-line and points at the tools that can be checked.
// Loosening is the move this gate exists to stop; the harness's own ratchet
// raises go through internal `fs` writes, never Bash.
//
// 2026-08-10 narrowed this arm to IRREVERSIBLE commands, on the theory that
// the effect arm (baseline-effect-guard.ts) made a reversible loosening
// "undoable AND inert". The 2026-10-21 red team
// (scratch/2026-10-21-red-team/result.json, "Reversible-shell-write to a
// water-line (bash-arm fail-open)") measured that claim false: the effect arm
// only WARNS and writes an undo record, while every ratchet consumer
// (`loadMetricCaps`, the coverage ratchet, …) reads the file on disk, so
// `cp /tmp/loosened.json .interlinked/metric-caps.json` landed a live 999
// cap with one stderr line as the only consequence. The reversibility
// carve-out is retracted: EVERY shell write to a water-line is refused before
// it runs, and reversibility only tiers the wording of the refusal.
//
// The same red team confirmed a second hole ("Shell-write bypass — the gate is
// wired for file-write tools only"): `sed -i '' 's/"strict": true/"strict":
// false/' tsconfig.json` was allowed because the config-loosening gate had no
// Bash arm. `configBashWriteRefusal` closes it with the same scanner, scoped
// to the config files whose Edit arm BLOCKS (tsconfig strictness, the vitest
// coverage denominator).

import { isAbsolute, resolve } from "node:path";
import { resolveBashWriteTarget } from "../pre-checks-bash-write-detect.js";
import { effectIsReversible } from "./baseline-effect-guard.js";
import { shellUnits } from "./commit-parse-shell.js";
import { maskLiteralContext } from "./literal-context.js";
import { isVitestConfigFile } from "./vitest-coverage-water-line.js";
import { isWaterLinePath } from "./water-line-files.js";

/** True when `candidate` (absolute, any separator) lies under `root`. */
function isInsideRoot(candidate: string, root: string): boolean {
	const normalized = candidate.replace(/\\/g, "/");
	return normalized.startsWith(`${root.replace(/\\/g, "/").replace(/\/+$/, "")}/`);
}

/**
 * Roots whose water-lines a shell command could loosen: the event's cwd and the
 * daemon's own project root (`process.cwd()`, the project it serves). A session
 * whose cwd is a subdirectory still protects the repository's `.interlinked/`;
 * a water-line-SHAPED path outside both — a disposable fixture under the OS temp
 * dir, another repository — is not this project's water-line (2026-10-21 smoke
 * test: fixture setup with `printf … > /tmp/x/.interlinked/metric-caps.json`
 * was refused once the reversible-write carve-out was retracted).
 */
function isUnderGuardedRoot(candidate: string, projectRoot: string): boolean {
	return isInsideRoot(candidate, projectRoot) || isInsideRoot(candidate, process.cwd());
}

/** True when a resolved path is one of this project's `.interlinked/` water-line
 *  files. The list itself lives in water-line-files.ts — one source of truth for
 *  every baseline guard (see its OPEN QUESTION note on the guard set's width). */
function isBaselinePath(candidate: string, projectRoot: string): boolean {
	return isUnderGuardedRoot(candidate, projectRoot) && isWaterLinePath(candidate);
}

/** tsconfig.json and its variants (`tsconfig.build.json`, …) — mirrors the
 *  blocking predicate in config-loosening-gate.ts. */
const TSCONFIG_RE = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/;

/**
 * Config files whose Edit arm BLOCKS rather than asks: tsconfig strictness
 * (2026-09-01) and the vitest/vite coverage denominator (2026-09-04).
 *
 * Scoped to the project root: the Edit arm judges against git HEAD, so a
 * tsconfig-shaped path OUTSIDE the repository (`cp tsconfig.json
 * /tmp/tsconfig.backup.json`) is no water-line of this project.
 *
 * package.json / biome / eslintrc stay ask-mode on Edit and are NOT refused
 * from the shell: `npm install` rewrites package.json legitimately on every
 * run, and the supply-chain gate owns that path.
 */
export function isBlockingConfigWaterLine(candidate: string, projectRoot: string): boolean {
	const normalized = candidate.replace(/\\/g, "/");
	if (!isUnderGuardedRoot(normalized, projectRoot)) return false;
	return TSCONFIG_RE.test(normalized) || isVitestConfigFile(normalized);
}

/**
 * Shell fragments that WRITE their target. The path is the LAST defined
 * capture group of each pattern. Deliberately broad: this arm refuses rather
 * than adjudicates, so a generous match costs an agent one redirect through
 * the Edit tool, while a miss costs the whole ratchet system. Every pattern is
 * linear (no nested quantifiers) — it parses agent-supplied text on the hook
 * path.
 */
const WRITE_MECHANISMS: RegExp[] = [
	// shell redirect / append / clobber-override on ANY descriptor: `2>` and
	// `&>` truncate the target exactly like `>`; `>&1` names no path and never
	// matches because `&` is excluded from the path class.
	/(?:\d|&)?>>?\|?\s*(['"]?)([^\s'"|&;<>]+)\1/g,
	// tee (with or without append flags)
	/\btee\s+(?:-a\s+|--append\s+)?(?:--\s+)?(['"]?)([^\s'"|&;]+)\1/g,
	// dd destination
	/\bdd\b[^|;]*\bof=(['"]?)([^\s'"|&;]+)\1/g,
	// interpreter one-liners that open a path in any WRITABLE mode
	// (w / a / x / r+), positional or `mode=`; a plain 'r' / 'rb' never matches.
	/open\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:mode\s*=\s*)?['"`][rbt]*[wax+]/g,
	// pathlib: Path('…').write_text / write_bytes
	/\bPath\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.\s*write_(?:text|bytes)/g,
	// shutil / os copies and moves name the DESTINATION second
	/\b(?:shutil\.(?:copy2?|copyfile|move)|os\.(?:rename|replace))\s*\(\s*['"`][^'"`]*['"`]\s*,\s*['"`]([^'"`]+)['"`]/g,
	// node fs: writeFile / writeFileSync / appendFile / appendFileSync name the target first
	/\b(?:write|append)File(?:Sync)?\s*\(\s*['"`]([^'"`]+)['"`]/g,
	// node fs: copyFile / cpSync / rename name the target SECOND
	/\b(?:copyFile(?:Sync)?|cpSync|rename(?:Sync)?)\s*\(\s*['"`][^'"`]*['"`]\s*,\s*['"`]([^'"`]+)['"`]/g,
];

/** Verbs whose LAST positional operand is the file they write. */
const DEST_LAST_VERBS = new Set(["cp", "mv", "install", "rsync", "ln", "truncate", "sponge"]);

/** Verbs that write (or destroy) EVERY positional operand. */
const ALL_OPERAND_VERBS = new Set(["rm", "shred", "unlink", "tee"]);

/** Editors whose `-i` flag rewrites every file operand in place. The script
 *  operand is scanned too: it never resolves to a water-line, so the extra
 *  candidate is free and multi-file forms (`sed -i … A B`) stay covered. */
const IN_PLACE_EDITORS = new Set(["sed", "perl", "ruby"]);

/** git subcommands that rewrite the NAMED working-tree paths from a ref. A
 *  water-line the harness raised since HEAD is loosened by a checkout of
 *  HEAD. Un-named rewrites (`stash`, `merge`, `rebase`) carry no path to scan;
 *  the commit-gate backstop covers the tracked baselines there. */
const GIT_PATH_REWRITERS = new Set(["checkout", "restore"]);

/** Positional operands: every non-flag token after the verb. */
function positionalArgs(tokens: readonly string[], from: number): string[] {
	return tokens.slice(from).filter((t) => !t.startsWith("-"));
}

function gitWriteTargets(tokens: readonly string[]): string[] {
	const sub = tokens[1];
	if (!sub || !GIT_PATH_REWRITERS.has(sub)) return [];
	return positionalArgs(tokens, 2);
}

/** Write targets of ONE simple command: its argv with quotes removed,
 *  redirections dropped and wrappers (`VAR=`, `sudo`, `env`, …) stripped. */
function unitWriteTargets(tokens: readonly string[]): string[] {
	const verb = tokens[0];
	if (!verb) return [];
	if (verb === "git") return gitWriteTargets(tokens);
	const args = positionalArgs(tokens, 1);
	if (ALL_OPERAND_VERBS.has(verb)) return args;
	const inPlace = IN_PLACE_EDITORS.has(verb) && tokens.some((t) => /^-[a-zA-Z]*i/.test(t));
	if (inPlace) return args;
	const last = args[args.length - 1];
	return last !== undefined && DEST_LAST_VERBS.has(verb) ? [last] : [];
}

/**
 * Positional write targets of every simple command `cmd` runs, segmented by
 * the canonical shell scan (commit-parse-shell.ts). The old
 * `split(/[|;&]+/)` over newline-joined text disagreed with it: a newline
 * did not separate (`true\ncp x <water-line>` read as `true`'s operands), a
 * subshell kept its parens on the verb and the destination (`(cp x y)`), and
 * a trailing `2>/dev/null` was taken as the destination. The shell-effect
 * arm restores a loosened water-line after the call either way; this is the
 * early refusal with the better message.
 *
 * A backslash before a name character is read as the path separator the
 * root and water-line checks normalize it to, not as a POSIX escape the scan
 * would drop: `cp x .interlinked\metric-caps.json` (a Windows-shell path)
 * stays refused, as before.
 */
function positionalWriteTargets(cmd: string): string[] {
	const units = shellUnits(cmd.replace(/\\(?=[\w.-])/g, "/"));
	return units.flatMap((unit) => unitWriteTargets(unit.argv));
}

/** Absolute path of one raw target: same-command `VAR=` expansion and `cd`
 *  hops through the shared resolver, else a plain join on the project root.
 *  An unresolvable target (unknown leading variable) keeps the plain join —
 *  the pre-2026-10-21 behavior, so coverage only widens. */
function resolveTarget(normalized: string, raw: string, projectRoot: string): string {
	return (
		resolveBashWriteTarget(normalized, raw, projectRoot) ??
		(isAbsolute(raw) ? raw : resolve(projectRoot, raw))
	);
}

/** Every candidate write target in a command, resolved against the project root. */
export function shellWriteTargets(cmd: string, projectRoot: string): string[] {
	// A redirect or write call printed as data has no filesystem effect.
	// The shared classifier keeps real operands and executable pipelines.
	const executable = maskLiteralContext(cmd);
	const normalized = executable.replace(/[\r\n]+/g, " ");
	const raws: string[] = [];
	for (const re of WRITE_MECHANISMS) {
		re.lastIndex = 0;
		for (const m of normalized.matchAll(re)) {
			// Path is the last defined capture group (patterns use either
			// (quote)(path) or a single (path) group).
			const raw = m[2] ?? m[1];
			if (raw) raws.push(raw);
		}
	}
	raws.push(...positionalWriteTargets(executable));
	return raws.map((raw) => resolveTarget(normalized, raw, projectRoot));
}

/** Basename of the first write target satisfying `isGuarded`, else null. */
function firstGuardedWriteTarget(
	cmd: string,
	projectRoot: string,
	isGuarded: (resolved: string) => boolean,
): string | null {
	if (!cmd) return null;
	// The same documented escape hatch the Write/Edit arms use for an
	// intentional reset (both the baseline gate and the tsconfig block).
	if (process.env.INTERLINKED_DISABLE_BASELINE_GUARD === "1") return null;
	for (const target of shellWriteTargets(cmd, projectRoot)) {
		if (isGuarded(target)) return target.split("/").pop() ?? target;
	}
	return null;
}

/**
 * Refusal reason when a shell command writes a ratchet water-line, else null.
 *
 * Honors `INTERLINKED_DISABLE_BASELINE_GUARD=1` — the same documented escape
 * hatch the Write/Edit arm uses for an intentional reset.
 */
export function baselineBashWriteRefusal(cmd: string, projectRoot: string): string | null {
	const shown = firstGuardedWriteTarget(cmd, projectRoot, (t) => isBaselinePath(t, projectRoot));
	if (!shown) return null;
	// Reversibility tiers the WORDING only (2026-10-21): a recoverable write
	// is refused too, because the ratchets decide from the bytes on disk and
	// the effect arm can only warn after the loosened value is already live.
	const effect = effectIsReversible("Bash", cmd)
		? "its resulting bytes cannot be inspected before it runs"
		: "its effect cannot be undone afterwards";
	return (
		`BLOCKED: shell command writing the ratchet water-line ${shown}. ` +
		`Water-lines may only move in the tightening direction, and ${effect}, ` +
		"so it is refused before it runs. Use the Edit tool (the " +
		"gate inspects the proposed content and allows a tightening change), let the harness " +
		"raise the line itself by meeting the bar, or set INTERLINKED_DISABLE_BASELINE_GUARD=1 " +
		"for an intentional reset."
	);
}

/**
 * Refusal reason when a shell command writes a BLOCKING config water-line
 * (tsconfig*.json, vitest/vite config), else null. The config-loosening
 * gate's Bash arm (red team 2026-10-21): the Edit arm compares the proposed
 * content with git HEAD, which a shell command's output never offers.
 */
export function configBashWriteRefusal(cmd: string, projectRoot: string): string | null {
	const shown = firstGuardedWriteTarget(cmd, projectRoot, (t) =>
		isBlockingConfigWaterLine(t, projectRoot),
	);
	if (!shown) return null;
	return (
		`BLOCKED: shell command writing ${shown}, a config water-line (TypeScript strictness / ` +
		"vitest coverage denominator). Those files may only tighten, and a shell command's " +
		"resulting bytes cannot be inspected before it runs, so it is refused. Use the Edit or " +
		"Write tool (the config-loosening gate compares the proposed content against git HEAD " +
		"and allows a tightening change), or set INTERLINKED_DISABLE_BASELINE_GUARD=1 for an " +
		"intentional reset."
	);
}
