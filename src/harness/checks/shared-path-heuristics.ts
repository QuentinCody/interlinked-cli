// Function-signature/parameter-count helpers and path-classification
// heuristics extracted from shared.ts (no behavior change). Re-exported by
// shared.ts so existing importers keep resolving these from "./shared.js".

/**
 * Collect a full function signature starting at the given line index.
 * Reads up to 20 lines or until we see `{` or `=>`, whichever comes first.
 * Used by missing-return-type, complexity, and taste-level checks.
 */
export function collectFunctionSignature(lines: string[], startIdx: number): string {
	let sig = "";
	for (let i = startIdx; i < Math.min(startIdx + 20, lines.length); i++) {
		const line = lines[i];
		if (line === undefined) break;
		sig += ` ${line}`;
		if (line.includes("{") || line.includes("=>")) break;
	}
	return sig;
}

/**
 * Count top-level parameter items, respecting nested angle brackets, parens,
 * brackets, and braces. Returns the number of comma-separated items at the
 * top level. (Despite the name, this returns the COUNT of items, not the
 * count of commas — an empty string still returns 1. Kept as-is for
 * backwards-compatibility with callers like `checkFunctionArity`.)
 */
export function countTopLevelCommas(paramStr: string): number {
	let depth = 0;
	let count = 1;
	for (const ch of paramStr) {
		if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "," && depth === 0) count++;
	}
	return count;
}

/**
 * Check if a file path lives in a vendored, generated, or test-fixture
 * tree where security-style detectors produce only false positives.
 *
 * Origin: a 139-repo FP audit found that the bulk of the noise from
 * checks like `ubs_sql_string_concat`, `ubs_eval_input_tainted`, and
 * `ubs_subprocess_shell_true` came from `node_modules/`, `vendor/`,
 * `examples/`, `dist/`, minified bundles, and similar trees that the
 * agent does not author. These directories carry SQL, `eval`, and
 * shell calls as DATA — they're snapshots of upstream code, not new
 * code we want to vet.
 *
 * Distinct from `isTestFile`: a project's own test sources DO get
 * checked (legit auth tests can hide real bugs); only vendored /
 * generated / fixture trees are exempted here. Security checks call
 * BOTH `isTestFile` and this helper at their gate.
 *
 * Returns true when the normalized path matches any of:
 * - dependency / vendored: `node_modules/`, `vendor/`, `third_party/`
 * - example / fixture trees: `examples/`, `environments/`, `fixtures/`,
 *   `seed-data/`, `seeds/`, `mocks/`, `__mocks__/`, `test-data/`,
 *   `testdata/`
 * - generated / build output: `dist/`, `build/`, `.next/`, `coverage/`
 * - bundled / minified asset filenames: `*.min.{js,css,mjs,cjs}`,
 *   `*.bundle.{js,css,mjs,cjs}`
 */
export function isVendoredOrFixturePath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");

	// Directory-segment matches. Each pattern is "(start-of-string OR
	// preceding slash) followed by `<dir>/`" — so `vendor/x` and
	// `pkg/vendor/x` both match, but `myvendor/x` (no slash boundary
	// before `vendor`) does not.
	// `__fixtures__` sits alongside the bare `fixtures` form for the same reason
	// `__mocks__` sits alongside `mocks`: both dunder spellings are the
	// convention this repo actually uses (src/harness/checks/__fixtures__/), and
	// omitting one meant ~16 consumers scanned those dirs as if they held
	// ordinary source. Fixture payloads are deliberately malformed — that is
	// what makes them fixtures — so scanning them is pure noise.
	const dirRe =
		/(^|\/)(?:vendor|third_party|node_modules|environments|examples|fixtures|__fixtures__|seed-data|seeds|mocks|__mocks__|test-data|testdata|dist|build|\.next|coverage)\//;
	if (dirRe.test(normalized)) return true;

	// Bundled / minified asset filenames. These are generated artifacts;
	// scanning them is pure noise.
	if (/\.min\.(?:js|css|mjs|cjs)$/.test(normalized)) return true;
	if (/\.bundle\.(?:js|css|mjs|cjs)$/.test(normalized)) return true;

	return false;
}

/**
 * Detect script/CLI/tool/tutorial paths where `print()` and
 * `console.log()` are the legitimate output channel — not a debug
 * leak. Used to suppress `ubs_print_debug_leak` and `console_debug` on
 * files where stdout is the product.
 *
 * Origin: 139-repo FP audit. mcpbr's `scripts/sync_version.py` had 194
 * print() hits — all CLI output, all FP. Supermodel's
 * `cli/internal/setup/wizard.go` had 13 fmt.Println — interactive setup
 * wizard, also FP. The path-segment match is OR'd with `tutorial[s]/`
 * because tutorial fixtures intentionally print example output.
 *
 * Path segments anchored by leading slash or string-start so a directory
 * named `myscripts` (no slash boundary before `scripts`) does NOT match.
 * The regex form mirrors `isVendoredOrFixturePath`'s anchoring contract.
 */
export function isScriptOrCliPath(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	// `scripts/`, `script/`, `bin/`, `cli/`, `tools/`, `tool/`, `tutorial/`,
	// `tutorials/`, `examples/`, `example/`, `demos/`, `demo/`, `samples/`,
	// `sample/` as a path segment — anchored start-of-string OR slash.
	// `examples/` added 2026-05 after Helicone audit found 99 console.log
	// FPs in `ai-sdk-provider/examples/*.ts` — example code is print-by-design.
	return (
		/(^|\/)(?:scripts?|bin|cli|tools?)\//.test(norm) ||
		/(^|\/)tutorials?\//.test(norm) ||
		/(^|\/)examples?\//.test(norm) ||
		/(^|\/)demos?\//.test(norm) ||
		/(^|\/)samples?\//.test(norm)
	);
}
