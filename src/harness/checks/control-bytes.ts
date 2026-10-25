// ===========================================
// Raw control bytes in source
// ===========================================
// A literal control character embedded in a source file instead of its `\xNN`
// escape. The two failure modes are both SILENT, which is why this blocks
// rather than warns:
//
//   • grep classifies a file containing NUL as BINARY and skips it. The file
//     becomes invisible to code search — for humans and agents alike. An agent
//     asking "is this symbol referenced anywhere?" gets a confident, wrong
//     "no", and acts on it.
//   • the diff renders identically to the escaped form, so review cannot see
//     the difference either.
//
// Found in 14 files in this repo, almost all NUL used as a composite-key
// delimiter — `${file}<NUL>${anchor}` written as a raw byte instead of
// `${file}\x00${anchor}`. The escape produces an identical string at runtime,
// so there is never a reason to prefer the raw form: the fix is mechanical and
// lossless, which is what qualifies this for `pre_block`.

import { getExtension, type InlineMatch, isTestSourcePath, isVendoredOrFixturePath, JS_TS_EXTS } from "./shared.js";

/**
 * Control characters that must be written as escapes. Tab (09), LF (0A) and CR
 * (0D) are the legal literals; the rest of the C0 range plus DEL (7F) is a
 * mistake. Written with `\u` escapes so this detector does not contain the
 * very bytes it rejects.
 */
const RAW_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** Global twin, for rendering every offending byte in the reported line. */
const RAW_CONTROL_RE_GLOBAL = new RegExp(RAW_CONTROL_RE.source, "g");

/** Matches reported per file — enough to locate the problem without flooding. */
const MAX_MATCHES = 10;

/**
 * Text formats where a raw control character is never the only way to express
 * the intent, so flagging it stays zero-FP:
 *   - JS/TS, Python, C-family, Java, C# — an escape exists in every string form
 *   - JSON — raw control characters inside a string are INVALID per RFC 8259,
 *     so the file is already malformed; the escape is `\uXXXX`, not `\xNN`
 *   - markup / config / query text — no string-literal concept to work around;
 *     a control byte is simply wrong
 *
 * DELIBERATELY EXCLUDED, because each has a string form that cannot carry an
 * escape, so a raw byte could be the only expression and the finding would not
 * be zero-FP:
 *   - Go (backquoted raw strings), Rust (r"..."), Ruby (single-quoted)
 *   - Shell — a literal ESC for terminal output is an established idiom
 */
const TEXT_SOURCE_EXTS: ReadonlySet<string> = new Set([
	...JS_TS_EXTS,
	".py",
	".pyi",
	".json",
	".jsonc",
	".c",
	".h",
	".cc",
	".cpp",
	".cxx",
	".hpp",
	".java",
	".cs",
	".md",
	".yaml",
	".yml",
	".toml",
	".sql",
	".css",
	".scss",
	".html",
]);

/**
 * A line holding nothing but form feed(s) and horizontal whitespace: the `^L`
 * page-break convention (PEP 8 "Python accepts the control-L form feed
 * character as whitespace"; the GNU / Emacs page-delimiter idiom in C). It is
 * exempt only where the LEXER treats FF as whitespace — program source — so a
 * stray FF in JSON / YAML / TOML / markup still blocks. Neither silent failure
 * applies: ripgrep and grep classify a file as binary on NUL alone (verified
 * 2026-10-21, rg 15 / BSD grep), and there is nothing to escape — the FF IS
 * the intent, so no `\x0C` form expresses it.
 */
const PAGE_BREAK_LINE_RE = /^[ \t\r]*\u000C[ \t\r\u000C]*$/;
const PAGE_BREAK_EXTS: ReadonlySet<string> = new Set([
	...JS_TS_EXTS,
	".py",
	".pyi",
	".c",
	".h",
	".cc",
	".cpp",
	".cxx",
	".hpp",
	".java",
	".cs",
]);

/**
 * Program-source extensions. Every other `TEXT_SOURCE_EXTS` member is a DATA
 * format (JSON, YAML, TOML, markdown, SQL, CSS, HTML). Under a test tree a data
 * file is a test INPUT, and there the raw byte is the point: a JSON parser's
 * negative case needs the RFC 8259-invalid raw character (the escaped form is
 * valid JSON, so it tests nothing), and a golden file of captured CLI output
 * must hold the raw ESC it is compared against. A program source file under a
 * test tree still fires, because its escape is lossless (2026-10-21 review).
 */
const PROGRAM_SOURCE_EXTS = PAGE_BREAK_EXTS;

/** `\xNN` for a control character, uppercase and zero-padded. */
function asEscape(ch: string): string {
	return `\\x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Raw control characters in a text source file. Scoped to formats where an
 * escape (or plain removal) always expresses the same intent — see
 * `TEXT_SOURCE_EXTS` for what is excluded and why. Vendored and fixture paths
 * are exempt: binary payloads live there deliberately.
 */
export function checkRawControlBytes(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!TEXT_SOURCE_EXTS.has(ext)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];
	if (!PROGRAM_SOURCE_EXTS.has(ext) && isTestSourcePath(filePath)) return [];
	if (!RAW_CONTROL_RE.test(content)) return [];

	const pageBreaksAllowed = PAGE_BREAK_EXTS.has(ext);
	const matches: InlineMatch[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i += 1) {
		const line = lines[i];
		if (line === undefined || !RAW_CONTROL_RE.test(line)) continue;
		if (pageBreaksAllowed && PAGE_BREAK_LINE_RE.test(line)) continue;
		// Render the offending bytes as escapes so the warning itself stays
		// plain text — emitting the raw byte would make the log unsearchable
		// for the same reason the source is.
		const rendered = line.replace(RAW_CONTROL_RE_GLOBAL, asEscape).trim().slice(0, 150);
		matches.push({ line: i + 1, text: rendered });
	}
	return matches;
}
