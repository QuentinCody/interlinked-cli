// Parse package-install shell commands into a structured form so the
// supply-chain guard can apply the allowlist.
//
// Pure function — no fs, no env, no module-scope deps. The same parser is
// used by the daemon (PreToolUse evaluator) and the inline cold-fallback
// (`Function.toString()` splice in package-install-inline-guard).
//
// Coverage: npm/pnpm/yarn/bun + pip/pip3/pipx/poetry/uv + cargo + gem/bundle
// + go. Recognizes registry installs (named packages), git+url installs,
// tarball-url installs, local-path installs, and file: installs separately
// — they have different risk profiles.
//
// Split layout:
//   package-install-parser-shared.ts    — types + envRegistryFor + dropPreVerbFlags
//   package-install-parser-ecosystems.ts — per-ecosystem parsers (npm/pip/etc.)
//   package-install-parser.ts (this file) — shell splitting + dispatcher + public API


// Re-export ecosystem parsers so callers that import the named parsers
// directly (tests, guard code) still resolve from this module.
export {
	classifyPipSpec,
	isNpmVerb,
	parseBundle,
	parseCargo,
	parseComposer,
	parseGem,
	parseGo,
	parseMaven,
	parseNpmLike,
	parseNuget,
	parsePip,
	parsePoetry,
	parseUv,
} from "./package-install-parser-ecosystems.js";
// ---------------------------------------------------------------------------
// Re-export types from shared so external callers see them from this module.
// ---------------------------------------------------------------------------
export type {
	Ecosystem,
	InstallCommand,
	PackageSpec,
} from "./package-install-parser-shared.js";
export {
	dropPreVerbFlags,
	ENV_REGISTRY_KEYS,
	envRegistryFor,
	isExactPinnedVersion,
	pinnedVersionViolation,
} from "./package-install-parser-shared.js";

import { nonNull } from "../lib/non-null.js";

import {
	parseBundle,
	parseCargo,
	parseComposer,
	parseGem,
	parseGo,
	parseMaven,
	parseNpmLike,
	parseNuget,
	parsePip,
	parsePoetry,
	parseUv,
} from "./package-install-parser-ecosystems.js";
// ---------------------------------------------------------------------------
// Local imports (shared helpers used in the shell-parsing core below)
// ---------------------------------------------------------------------------
import type { InstallCommand } from "./package-install-parser-shared.js";

const NPM_LIKE = new Set(["npm", "pnpm", "yarn", "bun"]);

export function parseInstallCommands(rawCommand: string): InstallCommand[] {
	if (!rawCommand || typeof rawCommand !== "string") return [];
	const segments = splitShellSegments(rawCommand);
	const results: InstallCommand[] = [];
	// Track cwd shifts from preceding `cd <path>` segments in the same
	// compound shell line. Path-joining is purely lexical here — we don't
	// resolve symlinks or `..` because we don't know the script's actual
	// cwd at parse time; the guard layer applies the join against the
	// event's cwd.
	let cwdShift: string | undefined;
	for (const seg of segments) {
		const cdTarget = parseCdSegment(seg);
		if (cdTarget !== null) {
			cwdShift = composeCwd(cwdShift, cdTarget);
			continue;
		}
		const parsed = parseOneSegment(seg);
		if (parsed) {
			if (cwdShift) parsed.effectiveCwd = cwdShift;
			results.push(parsed);
		}
	}
	return results;
}

/** Detect a bare `cd <path>` segment. Returns the path argument, or null
 *  if the segment isn't a cd. We deliberately don't honor `cd -` or `cd`
 *  with no argument (those go HOME / OLDPWD — the script's cwd is the
 *  baseline we can't statically know). */
function parseCdSegment(seg: string): string | null {
	const t = stripRedirections(tokenize(seg));
	const stripped = stripWrappers(t).tokens;
	if (stripped.length < 2) return null;
	if (stripped[0] !== "cd") return null;
	let i = 1;
	while (i < stripped.length && nonNull(stripped[i]).startsWith("-")) i++;
	const target = stripped[i];
	if (!target) return null;
	return target;
}

/** Lexical cwd composition. Absolute `next` resets; relative joins. */
function composeCwd(prev: string | undefined, next: string): string {
	if (next.startsWith("/") || next.startsWith("~")) return next;
	if (!prev) return next;
	return `${prev}/${next}`;
}

/** Mutable scan state threaded through {@link consumeShellSplitChar}: the
 *  segment text accumulated so far and the active quote char (or null). */
interface ShellSplitState {
	buf: string;
	q: string | null;
}

/** Handle one character of `splitShellSegments`'s scan, mutating `state`
 *  and pushing a completed segment onto `out` at a boundary. Returns true
 *  when `nextCh` was consumed as the second half of a two-char operator
 *  (`&&`, `||`) — the caller must then skip that character. */
function consumeShellSplitChar(
	ch: string | undefined,
	nextCh: string | undefined,
	prevCh: string | undefined,
	state: ShellSplitState,
	out: string[],
): boolean {
	if (ch === undefined) return false;
	if (state.q) {
		state.buf += ch;
		if (ch === state.q && prevCh !== "\\") state.q = null;
		return false;
	}
	if (ch === '"' || ch === "'") {
		state.q = ch;
		state.buf += ch;
		return false;
	}
	if (ch === ";") {
		out.push(state.buf);
		state.buf = "";
		return false;
	}
	if (ch === "&" && nextCh === "&") {
		out.push(state.buf);
		state.buf = "";
		return true;
	}
	if (ch === "|" && nextCh === "|") {
		out.push(state.buf);
		state.buf = "";
		return true;
	}
	if (ch === "|" || ch === "&") {
		out.push(state.buf);
		state.buf = "";
		return false;
	}
	state.buf += ch;
	return false;
}

export function splitShellSegments(s: string): string[] {
	const out: string[] = [];
	const state: ShellSplitState = { buf: "", q: null };
	for (let i = 0; i < s.length; i++) {
		const consumedNext = consumeShellSplitChar(s[i], s[i + 1], s[i - 1], state, out);
		if (consumedNext) i++;
	}
	if (state.buf) out.push(state.buf);
	return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Strip shell-redirection tokens. Bash treats `2>&1`, `>file`, `<<EOF`, etc.
 *  as redirection metadata, not command arguments — but our tokenizer only
 *  splits on whitespace, so they appear in the token list and get mistaken
 *  for positional package specs (bug: `npm install pkg 2>&1 | tail` parsed
 *  `2>&1` as a package, blocking the install).
 *
 *  Forms handled:
 *  - Pure operators (`>`, `>>`, `<`, `<<`, `<<<`, `<>`, `&>`, `&>>`, `2>`,
 *    etc.) — drop the operator AND the following filename token.
 *  - Operator + FD dup (`2>&1`, `1>&2`) — drop only the token (no separate
 *    filename follows).
 *  - Operator + embedded file (`>file`, `2>file`, `&>file`) — drop only the
 *    token (filename is baked in).
 *  - Process substitution (`<(cmd)`, `>(cmd)`) is NOT stripped here — that
 *    runs a subshell which can matter for guard analysis; left as a future
 *    refinement.
 */
const PURE_REDIR_RE = /^(?:&|\d+)?(?:>>?|<<?<?|<>)$/;
const COMPOUND_REDIR_RE = /^(?:&|\d+)?(?:>>?|<<?<?|<>)\S+$/;

export function stripRedirections(tokens: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = nonNull(tokens[i]);
		if (PURE_REDIR_RE.test(t)) {
			i++;
			continue;
		}
		if (COMPOUND_REDIR_RE.test(t)) continue;
		out.push(t);
	}
	return out;
}

/** Mutable scan state threaded through {@link consumeTokenChar}: the token
 *  text accumulated so far and the active quote char (or null). */
interface TokenizeState {
	buf: string;
	q: string | null;
}

/** Handle one character of `tokenize`'s scan, mutating `state` and pushing a
 *  completed token onto `out` at a whitespace boundary. Quote characters are
 *  consumed (not kept), and a quote preceded by a backslash does not close
 *  the quoted run. */
function consumeTokenChar(
	ch: string,
	prevCh: string | undefined,
	state: TokenizeState,
	out: string[],
): void {
	if (state.q) {
		if (ch === state.q && prevCh !== "\\") {
			state.q = null;
			return;
		}
		state.buf += ch;
		return;
	}
	if (ch === '"' || ch === "'") {
		state.q = ch;
		return;
	}
	if (/\s/.test(ch)) {
		if (state.buf) {
			out.push(state.buf);
			state.buf = "";
		}
		return;
	}
	state.buf += ch;
}

function tokenize(seg: string): string[] {
	const out: string[] = [];
	const state: TokenizeState = { buf: "", q: null };
	for (let i = 0; i < seg.length; i++) {
		consumeTokenChar(nonNull(seg[i]), seg[i - 1], state, out);
	}
	if (state.buf) out.push(state.buf);
	return out;
}

interface StripResult {
	tokens: string[];
	/** Env vars passed inline before the binary (NPM_CONFIG_REGISTRY=URL, etc.). */
	envVars: Record<string, string>;
}

/** Record one `NAME=value` assignment into `envVars`. An assignment with an
 *  empty name (leading `=`) is ignored. */
function consumeEnvVar(assignment: string, envVars: Record<string, string>): void {
	const eq = assignment.indexOf("=");
	if (eq <= 0) return;
	envVars[assignment.slice(0, eq)] = assignment.slice(eq + 1);
}

/** Consume a leading `env` binary and every `NAME=value` assignment that
 *  follows it, shifting them off `out` and recording them in `envVars`. */
function consumeEnvPrefix(out: string[], envVars: Record<string, string>): void {
	out.shift();
	while (out[0] && /^[A-Za-z_]\w*=/.test(out[0])) {
		const next = out.shift();
		if (next) consumeEnvVar(next, envVars);
	}
}

function stripWrappers(tokens: string[]): StripResult {
	const out = tokens.slice();
	const envVars: Record<string, string> = {};
	while (out.length) {
		const t = nonNull(out[0]);
		if (
			t === "sudo" ||
			t === "exec" ||
			t === "nohup" ||
			t === "command" ||
			t === "time"
		) {
			out.shift();
			continue;
		}
		if (t === "env") {
			consumeEnvPrefix(out, envVars);
			continue;
		}
		if (/^[A-Za-z_]\w*=/.test(t)) {
			out.shift();
			consumeEnvVar(t, envVars);
			continue;
		}
		break;
	}
	return { tokens: out, envVars };
}

function parseOneSegment(seg: string): InstallCommand | null {
	const tokens0 = stripRedirections(tokenize(seg));
	if (tokens0.length === 0) return null;
	const { tokens, envVars } = stripWrappers(tokens0);
	if (tokens.length === 0) return null;
	const bin = basenameNoExt(nonNull(tokens[0]));

	if (NPM_LIKE.has(bin)) return parseNpmLike(bin, tokens, envVars);
	if (bin === "pip" || bin === "pip3" || bin === "pipx")
		return parsePip(bin, tokens, envVars);
	if (bin === "poetry") return parsePoetry(tokens, envVars);
	if (bin === "uv") return parseUv(tokens, envVars);
	if (bin === "cargo") return parseCargo(tokens, envVars);
	if (bin === "gem") return parseGem(tokens, envVars);
	if (bin === "bundle" || bin === "bundler") return parseBundle(tokens, envVars);
	if (bin === "go") return parseGo(tokens, envVars);
	return parseExtendedEcosystem(bin, tokens, envVars);
}

/** Newer ecosystems split out so `parseOneSegment` keeps its cyclomatic
 *  count flat. Gradle has no CLI install verb (deps live in build.gradle),
 *  so it is covered via the manifest/allowlist path only, not here. */
function parseExtendedEcosystem(
	bin: string,
	tokens: string[],
	envVars: Record<string, string>,
): InstallCommand | null {
	if (bin === "composer") return parseComposer(tokens, envVars);
	if (bin === "dotnet" || bin === "nuget") return parseNuget(bin, tokens, envVars);
	if (bin === "mvn") return parseMaven(tokens, envVars);
	return null;
}

function basenameNoExt(s: string): string {
	const slash = s.lastIndexOf("/");
	const b = slash >= 0 ? s.slice(slash + 1) : s;
	const dot = b.lastIndexOf(".");
	return dot > 0 ? b.slice(0, dot) : b;
}
