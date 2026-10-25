// Helpers for `ubs_yaml_unsafe_load` (python-checks.ts), split out so the
// detector's precision work does not push python-checks.ts over the line cap.
//
// Added by the 2026-10-21 adversarial review, which found six legitimate
// PyYAML / ruamel.yaml shapes the 200-char same-line window wrongly blocked:
//   - a black-formatted call with `Loader=yaml.SafeLoader` on its own line
//   - a nested-paren argument before the kwarg (`yaml.load(open(p), Loader=…)`)
//   - the PyYAML README alias (`from yaml import CSafeLoader as Loader`)
//   - `yaml.BaseLoader` (resolves no tags at all — the most restrictive loader)
//   - a ruamel.yaml `YAML(typ="safe")` / `YAML()` instance bound to `yaml`
//   - an attribute receiver (`self.yaml.load(f)`) that is not the module
// plus a multi-line docstring that merely mentions `yaml.load(` (the shared
// stripper blanks single-line docstrings only).

import { stripCommentsPreservingStrings } from "./_shared.js";

/** Loader class names that construct no Python objects. No leading `\b` on `Safe`: `CSafeLoader`. */
const SAFE_LOADER_RE = /Safe|\bBaseLoader\b/;

/** ruamel.yaml `typ` values whose loader constructs no arbitrary Python objects. */
const SAFE_RUAMEL_TYPS = new Set(["safe", "rt", "base"]);

/** Fallback window when a call's parens never balance (the pre-review behavior). */
const UNBALANCED_WINDOW = 200;

/** Longest call body the balanced scan walks before giving up. */
const MAX_CALL_SCAN = 4000;

/** Blank the interior of Python triple-quoted strings, preserving line count. */
export function blankPythonTripleQuoted(content: string): string {
	return content.replace(/("""|''')[\s\S]*?\1/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Offset just past the `)` balancing the `(` at `open`, or -1 when unbalanced within the scan cap. */
function balancedCloseOffset(text: string, open: number): number {
	let depth = 0;
	const end = Math.min(text.length, open + MAX_CALL_SCAN);
	for (let k = open; k < end; k++) {
		const ch = text.charAt(k);
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return k + 1;
		}
	}
	return -1;
}

/** Argument text of the call whose `(` sits at `open`; a 200-char window when the parens never balance. */
export function callBodyAt(text: string, open: number): string {
	const close = balancedCloseOffset(text, open);
	if (close === -1) return text.slice(open + 1, open + 1 + UNBALANCED_WINDOW);
	return text.slice(open + 1, close - 1);
}

/** Who owns the `yaml` before `.load(` at `idx`. */
export type YamlReceiver = "module" | "ruamel-module" | "attribute";

/**
 * `yaml.load` → the PyYAML module (or a module-level ruamel instance bound to
 * `yaml`); `ruamel.yaml.load` → the legacy ruamel module API (unsafe default
 * loader, still a finding); `self.yaml.load` / `cfg.yaml.load` → an attribute
 * of an object, which is a ruamel instance in practice, never the module.
 */
export function yamlReceiverAt(stripped: string, idx: number): YamlReceiver {
	if (stripped.charAt(idx - 1) !== ".") return "module";
	const before = stripped.slice(Math.max(0, idx - 20), idx - 1);
	return /\bruamel\s*$/.test(before) ? "ruamel-module" : "attribute";
}

/** Split a call body at depth-0 commas. */
function topLevelArgs(body: string): string[] {
	const args: string[] = [];
	let depth = 0;
	let start = 0;
	for (let k = 0; k < body.length; k++) {
		const ch = body.charAt(k);
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) {
			args.push(body.slice(start, k));
			start = k + 1;
		}
	}
	args.push(body.slice(start));
	return args.map((a) => a.trim());
}

/** The bare identifier passed as the Loader (`Loader=X` or second positional), or null. */
function loaderIdentifier(body: string): string | null {
	const args = topLevelArgs(body);
	const kw = args.find((a) => /^Loader\s*=/.test(a));
	const expr = kw === undefined ? (args[1] ?? "") : kw.replace(/^Loader\s*=\s*/, "");
	return /^[A-Za-z_]\w*$/.test(expr) ? expr : null;
}

/** Hops followed through `class B(A)` → `class A(yaml.SafeLoader)` subclass chains. */
const MAX_ALIAS_DEPTH = 4;

/**
 * True when the file binds `id` at least once and EVERY binding is a
 * Safe-class loader: `from yaml import CSafeLoader as <id>` (both arms of
 * the README's try/except), `<id> = …Safe…` / `<id>: T = …Safe…` /
 * `<id> = yaml.BaseLoader`, or a subclass `class <id>(yaml.SafeLoader):`
 * whose EVERY base is itself safe (the add_constructor idiom; a base named
 * by a bare identifier resolves through the same rule, bounded). An unbound
 * or partly-unsafe alias, or a class with an unresolvable mixin base, stays
 * a finding.
 */
function aliasIsSafeLoader(stripped: string, id: string, depth = 0): boolean {
	if (depth > MAX_ALIAS_DEPTH) return false;
	const bindings: string[] = [];
	for (const m of stripped.matchAll(new RegExp(`\\bimport\\s+([A-Za-z_]\\w*)\\s+as\\s+${id}\\b`, "g"))) {
		bindings.push(m[1] ?? "");
	}
	for (const m of stripped.matchAll(new RegExp(`^[ \\t]*${id}\\s*(?::[^=\\n]+)?=(?!=)\\s*(.+)$`, "gm"))) {
		bindings.push(m[1] ?? "");
	}
	const bases: string[] = [];
	for (const m of stripped.matchAll(new RegExp(`^[ \\t]*class\\s+${id}\\s*\\(([^)]*)\\)\\s*:`, "gm"))) {
		bases.push(...topLevelArgs(m[1] ?? "").filter((b) => b.length > 0));
	}
	if (bindings.length === 0 && bases.length === 0) return false;
	const baseIsSafe = (b: string): boolean =>
		SAFE_LOADER_RE.test(b) || (/^[A-Za-z_]\w*$/.test(b) && b !== id && aliasIsSafeLoader(stripped, b, depth + 1));
	return bindings.every((b) => SAFE_LOADER_RE.test(b)) && bases.every(baseIsSafe);
}

/** True when the `yaml.load(...)` call body names a Safe-class loader, directly or through a resolvable alias. */
export function yamlLoadBodyIsSafe(stripped: string, body: string): boolean {
	if (SAFE_LOADER_RE.test(body)) return true;
	const id = loaderIdentifier(body);
	return id !== null && aliasIsSafeLoader(stripped, id);
}

/**
 * True when the file binds `yaml` to a ruamel.yaml `YAML(...)` instance whose
 * `typ` is a safe loader (absent ⇒ round-trip, which is safe) and never
 * imports PyYAML, so a bare `yaml.load(f)` is the instance method. A `typ`
 * that is not a string literal, or `"unsafe"`, keeps the finding. Reads the
 * comment-stripped ORIGINAL so the `typ` literal is still visible.
 */
export function yamlIsSafeRuamelInstance(content: string, stripped: string): boolean {
	if (/^[ \t]*(?:import\s+yaml\b|from\s+yaml\s+import\b)/m.test(stripped)) return false;
	const withStrings = stripCommentsPreservingStrings(content);
	const m = /^[ \t]*yaml\s*=\s*(?:ruamel\.yaml\.)?YAML\s*\(/m.exec(withStrings);
	if (!m) return false;
	const body = callBodyAt(withStrings, m.index + m[0].length - 1);
	if (!/\btyp\s*=/.test(body)) return true;
	const lit = /\btyp\s*=\s*['"](\w+)['"]/.exec(body);
	return lit !== null && SAFE_RUAMEL_TYPS.has(lit[1] ?? "");
}
