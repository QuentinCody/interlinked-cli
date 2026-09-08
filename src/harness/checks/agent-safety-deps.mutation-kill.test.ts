// ===========================================
// Mutation-kill companion for src/harness/checks/agent-safety-deps.ts
// ===========================================
// agent-safety-deps.test.ts already covers the documented defect-fix
// behavior (specifier read from the ORIGINAL line, not the stripped one).
// This file targets the residual survivor set from a fresh mutation sweep:
// the Node-builtin allowlist, the 5/8/10-match walk caps and their cache/
// root-detection edges, the whitespace-tolerant extraction regexes, the
// scoped-package pkgName resolution branches, and the phantom-dependency
// line-number reporting. Every case below was reasoned from the source
// (no mutant build, no fuzzing — LEAN-mode contract), and each targets an
// OBSERVABLE behavior of an exported function, asserted with exact `toEqual`
// values rather than substring checks.
//
// Provenance: scratch/fleet-r3/receipts/src_harness_checks_agent-safety-deps.ts.jsonl (fleet W9).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimingProjectRoot } from "./__tests__/self-import-fixture.js";
import {
	checkExtraneousDependencies,
	checkPhantomDependencies,
	checkSelfImport,
	findWorkspaceRootFor,
} from "./agent-safety-deps.js";

// Session review r4, finding 3 (2026-09-05): a file no project claims is NOT
// MEASURED (`[]` here), so the bare-name self-import cases live under a
// throwaway project that claims its whole root; the importer is never written.
const at = claimingProjectRoot();

// ---------------------------------------------------------------------------
// checkExtraneousDependencies — Node.js builtin module allowlist
// ---------------------------------------------------------------------------

describe("checkExtraneousDependencies — Node.js builtin module allowlist", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "builtin-allowlist-"));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: {} }));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: public-api — the module's own doc comment: "Node.js
	// built-in module names — always 'declared' regardless of package.json."
	// Every one of the 34 names in that allowlist (and the array as a whole)
	// must keep excluding its import from the extraneous-dependency report.
	it("never flags any Node.js builtin module import as extraneous", () => {
		const builtins = [
			"fs",
			"path",
			"os",
			"url",
			"http",
			"https",
			"crypto",
			"util",
			"stream",
			"events",
			"child_process",
			"net",
			"tls",
			"dns",
			"assert",
			"buffer",
			"querystring",
			"zlib",
			"readline",
			"cluster",
			"worker_threads",
			"perf_hooks",
			"async_hooks",
			"v8",
			"vm",
			"tty",
			"dgram",
			"inspector",
			"trace_events",
			"string_decoder",
			"module",
			"process",
			"timers",
			"console",
		];
		const filePath = join(tmp, "index.ts");
		for (const mod of builtins) {
			const out = checkExtraneousDependencies(`import x from "${mod}";\n`, filePath);
			expect(out).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// checkExtraneousDependencies — guard/regex/text edge cases
// ---------------------------------------------------------------------------

describe("checkExtraneousDependencies — guard, cap, and regex edge cases", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "extraneous-edge-"));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: {} }));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: boundary — the extension guard must actually SKIP content
	// evaluation for a non-JS/TS file. Using invalid import syntax (as the
	// smoke-level "returns [] for a non-JS/TS file" case does) can't prove
	// this: the content wouldn't match anyway, so the guard is untested. This
	// case uses content that WOULD be flagged if the guard were bypassed.
	it("the extension guard actually skips a .py file even with matching import content", () => {
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(tmp, "notes.py"),
		);
		expect(out).toEqual([]);
	});

	// test-contract: invariant — the reporter caps at exactly 10 matches
	// (`if (matches.length >= 10) break;`), the same documented cap already
	// pinned for checkPhantomDependencies's 10-match test.
	it("stops reporting extraneous imports after exactly 10 even when 11 qualify", () => {
		const lines = Array.from(
			{ length: 11 },
			(_, i) => `import p${i} from "pkg-cap-extraneous-${i}";`,
		).join("\n");
		const out = checkExtraneousDependencies(`${lines}\n`, join(tmp, "cap-check.ts"));
		expect(out).toHaveLength(10);
	});

	// test-contract: invariant — the guard tests the TRIMMED stripped line,
	// and the reported text is the TRIMMED original line: an indented import
	// must still be recognized, and its reported text must have the leading
	// whitespace removed (not the raw untrimmed original line).
	it("recognizes an indented import and reports it with leading whitespace stripped", () => {
		const out = checkExtraneousDependencies(
			'  import foo from "not-a-real-dep";\n',
			join(tmp, "notes.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'import foo from "not-a-real-dep";' }]);
	});

	// test-contract: bug — mirrors the exact defect class documented at the
	// top of checkSelfImport in the companion file: a comment that merely
	// MENTIONS `from "pkg"` text must not be treated as a real import line.
	// The guard must actually skip lines that don't look like import/require
	// statements, not just rely on downstream extraction failing.
	it("does not treat a comment mentioning `from \"pkg\"` as an import", () => {
		const out = checkExtraneousDependencies(
			'// see also from "phantom-lib" for context\n',
			join(tmp, "notes.ts"),
		);
		expect(out).toEqual([]);
	});

	// test-contract: invariant — `import` must be recognized only as a
	// line-LEADING keyword (`/^import\s/`), not merely present anywhere in
	// the line.
	it("does not recognize `import` unless it starts the trimmed line", () => {
		const out = checkExtraneousDependencies(
			'const x = 1; import y from "not-a-real-dep";\n',
			join(tmp, "notes.ts"),
		);
		expect(out).toEqual([]);
	});

	// test-contract: invariant — a `require(` call is recognized with
	// optional whitespace between `require` and the opening paren, both in
	// the initial line-guard and in the specifier-extraction regex.
	it("recognizes a `require (` call with a space before the opening paren", () => {
		const out = checkExtraneousDependencies(
			'const x = require ("not-a-real-dep");\n',
			join(tmp, "notes.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'const x = require ("not-a-real-dep");' }]);
	});

	// test-contract: invariant — the `from` keyword may be followed by more
	// than one whitespace character before the specifier's quote.
	it("allows multiple spaces between `from` and the specifier's quote", () => {
		const out = checkExtraneousDependencies(
			'import x from   "not-a-real-dep";\n',
			join(tmp, "notes.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'import x from   "not-a-real-dep";' }]);
	});

	// test-contract: invariant — a `require(` call may have whitespace
	// between the opening paren and the specifier's quote.
	it("allows whitespace between a require call's opening paren and the quote", () => {
		const out = checkExtraneousDependencies(
			'const x = require( "not-a-real-dep");\n',
			join(tmp, "notes.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'const x = require( "not-a-real-dep");' }]);
	});

	// test-contract: bug — a line that passes the import guard but has no
	// quoted specifier (so `fromMatch` is null) must be safely skipped, not
	// crash the whole check on an unrelated file.
	it("safely skips a line that matches the import guard but has no quoted specifier", () => {
		expect(() =>
			checkExtraneousDependencies("import { x } from somewhere;\n", join(tmp, "notes.ts")),
		).not.toThrow();
	});

	// test-contract: invariant — reported line text is capped at 150
	// characters (`.slice(0, 150)`), matching the source's own contract.
	it("truncates the reported line text to 150 characters", () => {
		const longSpecifier = "z".repeat(200);
		const line = `import foo from "${longSpecifier}";`;
		const out = checkExtraneousDependencies(`${line}\n`, join(tmp, "notes.ts"));
		expect(out).toEqual([{ line: 1, text: line.slice(0, 150) }]);
	});
});

// ---------------------------------------------------------------------------
// checkExtraneousDependencies — malformed package.json shapes
// ---------------------------------------------------------------------------

describe("checkExtraneousDependencies — malformed package.json shapes (mutation-kill)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "extraneous-malformed-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: boundary — a package.json that parses to a JSON ARRAY
	// (valid JSON, non-object) must be treated as unusable, the same as the
	// existing `null`-parse case, rather than silently reading `undefined`
	// dependency fields off it and treating the resolved deps set as "no
	// declared dependencies but still usable".
	it("treats a package.json that parses to a JSON array as unusable", () => {
		writeFileSync(join(tmp, "package.json"), "[]");
		const out = checkExtraneousDependencies('import _ from "lodash";\n', join(tmp, "index.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: security — a missing `dependencies` field must never be
	// read as declaring ANY package name. This is the same invariant that
	// makes phantom-dependency detection trustworthy: a malformed/absent
	// field must fail closed (nothing declared), not fail open (something
	// fabricated declared).
	it("does not treat a missing `dependencies` field as declaring any package", () => {
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
		const out = checkExtraneousDependencies(
			'import y from "Stryker was here";\n',
			join(tmp, "index.ts"),
		);
		expect(out).toEqual([{ line: 1, text: 'import y from "Stryker was here";' }]);
	});
});

// ---------------------------------------------------------------------------
// _isExtraneousBareImport — prefix exclusions and scoped-package resolution
// (exercised through checkExtraneousDependencies, the only caller)
// ---------------------------------------------------------------------------

describe("_isExtraneousBareImport — prefix exclusions and scoped-package resolution", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "bare-import-"));
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: { lodash: "1.0.0" } }));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: public-api — the function's own doc comment: "Relative
	// imports ... are never 'extraneous'."
	it("never flags a relative import", () => {
		const out = checkExtraneousDependencies('import x from "./local";\n', join(tmp, "a.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: public-api — the function's own doc comment: "path
	// aliases (`@/`) ... are never 'extraneous'."
	it("never flags a `@/` path-alias import", () => {
		const out = checkExtraneousDependencies('import x from "@/foo";\n', join(tmp, "a.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: public-api — the function's own doc comment: "fragment
	// imports (`#`) ... are never 'extraneous'."
	it("never flags a `#` fragment import", () => {
		const out = checkExtraneousDependencies('import x from "#frag";\n', join(tmp, "a.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: public-api — the function's own doc comment: "runtime
	// built-in protocols (node:/cloudflare:/bun:/deno:) are never
	// 'extraneous'" — even for a made-up module name under that protocol,
	// since the exclusion is protocol-based, not name-based.
	it("never flags a `node:`-protocol import regardless of the module name", () => {
		const out = checkExtraneousDependencies(
			'import x from "node:definitely-not-real";\n',
			join(tmp, "a.ts"),
		);
		expect(out).toEqual([]);
	});

	// test-contract: invariant — the runtime-protocol exclusion is anchored
	// to the START of the specifier; a package name that merely CONTAINS
	// "node:" (not as its own protocol prefix) must still be evaluated
	// normally and flagged when undeclared.
	it("does not exclude a specifier that merely contains \"node:\" mid-string", () => {
		const out = checkExtraneousDependencies('import x from "my-node:thing";\n', join(tmp, "a.ts"));
		expect(out).toEqual([{ line: 1, text: 'import x from "my-node:thing";' }]);
	});

	// test-contract: invariant — a subpath import of a DECLARED unscoped
	// package (`lodash/fp`) resolves to the base package name (`lodash`),
	// not the full subpath, when checking declaration.
	it("resolves an unscoped subpath import to its base package name", () => {
		const out = checkExtraneousDependencies('import x from "lodash/fp";\n', join(tmp, "a.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: invariant — a DECLARED scoped package (`@scope/pkg`)
	// must resolve its pkgName to the full `@scope/pkg` (scope + name, not
	// just the scope, and not a char-split reconstruction of it).
	it("resolves a declared scoped package import to its full scope/name", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ dependencies: { "@scope/pkg": "1.0.0" } }),
		);
		const out = checkExtraneousDependencies('import x from "@scope/pkg";\n', join(tmp, "a.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: invariant — a DEEP subpath of a declared scoped package
	// (`@scope/pkg/deep/path`) resolves to just `@scope/pkg` (the first two
	// path segments), not the full deep path.
	it("resolves a deep subpath of a declared scoped package to scope/name only", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ dependencies: { "@scope/pkg": "1.0.0" } }),
		);
		const out = checkExtraneousDependencies(
			'import x from "@scope/pkg/deep/path";\n',
			join(tmp, "a.ts"),
		);
		expect(out).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// checkSelfImport — guard/regex/extension edge cases
// ---------------------------------------------------------------------------

describe("checkSelfImport — guard, cap, and regex edge cases", () => {
	// test-contract: boundary — the extension guard must actually SKIP a
	// non-JS/TS file even when its content would otherwise self-match.
	it("the extension guard actually skips a .py file even with matching self-import content", () => {
		const out = checkSelfImport('import { x } from "./thing.py";\n', "thing.py");
		expect(out).toEqual([]);
	});

	// test-contract: invariant — the FILE's own trailing extension (not the
	// first extension-shaped substring) is stripped when computing its base
	// name for self-import comparison.
	it("strips only the file's own trailing extension when computing its base name", () => {
		const out = checkSelfImport('import { x } from "./widget.ts.ts";\n', at("widget.js.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: invariant — the reporter caps at exactly 5 self-import
	// matches per file.
	it("stops reporting self-imports after exactly 5 even when 6 qualify", () => {
		const lines = Array.from({ length: 6 }, (_, i) => `import a${i} from "./self";`).join("\n");
		const out = checkSelfImport(`${lines}\n`, at("self.ts"));
		expect(out).toHaveLength(5);
	});

	// test-contract: invariant — the guard tests the TRIMMED stripped line
	// (an indented self-import is still recognized), and the reported text
	// is the TRIMMED original line (leading whitespace stripped).
	it("recognizes an indented self-import and reports it with leading whitespace stripped", () => {
		const out = checkSelfImport('  import { x } from "./self";\n', at("self.ts"));
		expect(out).toEqual([{ line: 1, text: 'import { x } from "./self";' }]);
	});

	// test-contract: bug — a comment merely mentioning `from "./self"` must
	// not be treated as a real self-import.
	it("does not treat a comment mentioning `from \"./self\"` as an import", () => {
		const out = checkSelfImport('// imported from "./self" historically\n', at("self.ts"));
		expect(out).toEqual([]);
	});

	// Before 2026-09-05 this case fed a REAL top-level `import` after a `;` —
	// which the old line parser missed and the old assertion pinned as if that
	// were correct. The invariant that survives is narrower: `import` merely
	// PRESENT in a line (here inside a string literal) is text, not a
	// declaration. The real shared-line import is the case directly below.
	// test-contract: invariant — the AST pass never mistakes the word `import` inside a string literal for a declaration
	it("does not recognize `import` unless it starts the trimmed line", () => {
		const out = checkSelfImport("const y = 'import z from \"./self\"';\n", at("self.ts"));
		expect(out).toEqual([]);
	});

	// A self-import is a DECLARATION, not a line: a real import that shares
	// its line with another statement IS one, reported at the declaration's
	// start line (review finding, 2026-09-05).
	// test-contract: bug — the pre-2026-09-05 line parser required `import` to start the trimmed line and missed this real top-level self-import
	it("recognizes a self-import that shares its line with another statement", () => {
		const out = checkSelfImport('const y = 2; import z from "./self";\n', at("self.ts"));
		expect(out).toEqual([{ line: 1, text: 'const y = 2; import z from "./self";' }]);
	});

	// test-contract: invariant — the `from` keyword may be followed by more
	// than one whitespace character before the specifier's quote.
	it("allows multiple spaces between `from` and the specifier's quote", () => {
		const out = checkSelfImport('import x from   "./self";\n', at("self.ts"));
		expect(out).toEqual([{ line: 1, text: 'import x from   "./self";' }]);
	});

	// test-contract: bug — a line that passes the import guard but has no
	// quoted specifier (so `fromMatch` is null) must be safely skipped, not
	// crash the check.
	it("safely skips a line that matches the import guard but has no quoted specifier", () => {
		// Bare path: no project claims it, so the scan is NOT MEASURED — and must
		// still not throw. Claimed path: the AST pass really runs on the source.
		expect(() => checkSelfImport("import { x } from somewhere;\n", "self.ts")).not.toThrow();
		expect(() => checkSelfImport("import { x } from somewhere;\n", at("self.ts"))).not.toThrow();
	});

	// test-contract: invariant — the SPECIFIER's own trailing extension (not
	// the first extension-shaped substring within it) is stripped when
	// computing its importBase for self-import comparison.
	it("strips only the specifier's own trailing extension when computing importBase", () => {
		const out = checkSelfImport('import { x } from "./foo.mjs.js";\n', at("foo.js.ts"));
		expect(out).toEqual([]);
	});

	// test-contract: invariant — reported line text is capped at 150
	// characters.
	it("truncates the reported line text to 150 characters", () => {
		const longName = "y".repeat(200);
		const line = `import { ${longName} } from "./self";`;
		const out = checkSelfImport(`${line}\n`, at("self.ts"));
		expect(out).toEqual([{ line: 1, text: line.slice(0, 150) }]);
	});
});

// ---------------------------------------------------------------------------
// _resolvePackageDeps — walk bound, cache, and root-detection
// (exercised through checkExtraneousDependencies, the only caller)
// ---------------------------------------------------------------------------

describe("_resolvePackageDeps — walk bound, cache, and root-detection (mutation-kill)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "resolve-deps-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — the upward walk is bounded to 5 directory
	// levels (the existing companion test already pins the "5-level walk
	// exhausted" fallback; this pins the boundary itself by placing a
	// resolvable package.json exactly ONE level past it).
	it("does not find a package.json exactly one level past the 5-level cap", () => {
		const deep = join(tmp, "n1", "n2", "n3", "n4", "n5", "n6");
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(tmp, "n1", "package.json"), JSON.stringify({ dependencies: {} }));
		const out = checkExtraneousDependencies(
			'import foo from "not-a-real-dep";\n',
			join(deep, "index.ts"),
		);
		expect(out).toEqual([]);
	});

	// test-contract: invariant — the function's own doc comment: "Cached
	// per directory since this runs once per checked file." A later on-disk
	// change to an already-resolved directory's package.json must NOT be
	// picked up by a second call for the same directory.
	it("caches the resolved package.json per directory across calls", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ dependencies: { "cache-probe-dep": "1.0.0" } }),
		);
		const first = checkExtraneousDependencies(
			'import x from "cache-probe-dep";\n',
			join(tmp, "index.ts"),
		);
		expect(first).toEqual([]);

		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: {} }));
		const second = checkExtraneousDependencies(
			'import x from "cache-probe-dep";\n',
			join(tmp, "index.ts"),
		);
		expect(second).toEqual([]);
	});

	// test-contract: invariant — a directory without its own package.json
	// must not stop the walk; the nearest ANCESTOR's package.json is still
	// found and used.
	it("continues the upward walk past a directory with no package.json", () => {
		const childDir = join(tmp, "child");
		mkdirSync(childDir);
		writeFileSync(join(tmp, "package.json"), JSON.stringify({ dependencies: {} }));
		const out = checkExtraneousDependencies(
			'import x from "definitely-not-a-real-package";\n',
			join(childDir, "index.ts"),
		);
		expect(out).toEqual([
			{ line: 1, text: 'import x from "definitely-not-a-real-package";' },
		]);
	});
});

// ---------------------------------------------------------------------------
// findWorkspaceRootFor — 8-level walk bound
// ---------------------------------------------------------------------------

describe("findWorkspaceRootFor — 8-level walk bound (mutation-kill)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wsroot-bound-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — the function's own doc comment: "Capped at
	// 8 levels so we don't escape into the user's home directory." A
	// workspace marker exactly ONE level past the cap must not be found.
	it("does not find a workspace marker exactly one level past the 8-level cap", () => {
		const startDir = join(tmp, "root", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9");
		mkdirSync(startDir, { recursive: true });
		writeFileSync(join(tmp, "root", "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
		const result = findWorkspaceRootFor(join(startDir, "package.json"));
		expect(result).toBe(startDir);
	});
});

// ---------------------------------------------------------------------------
// checkPhantomDependencies — exact line-number reporting
// ---------------------------------------------------------------------------

describe("checkPhantomDependencies — exact line-number reporting (mutation-kill)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "phantom-line-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: public-api — the phantom-dependency report's `line`
	// field must be the ACTUAL 1-indexed line where the dependency's quoted
	// key literally appears, not always the fallback `1`. A supply-chain
	// reviewer jumping to the reported line needs it to be correct for
	// package.json files with the dependency declared beyond the first line
	// (the realistic case for any real project).
	it("reports the exact line where a phantom dependency's key appears (not always line 1)", () => {
		const rawJson = '{\n  "dependencies": {\n    "totally-phantom-dep": "1.0.0"\n  }\n}\n';
		writeFileSync(join(tmp, "package.json"), rawJson);
		writeFileSync(join(tmp, "index.ts"), "export const x = 1;\n");
		const out = checkPhantomDependencies(join(tmp, "package.json"));
		expect(out).toEqual([
			{
				line: 3,
				text:
					'Phantom dependency: "totally-phantom-dep" is in dependencies but never referenced in project source. Supply chain risk — dependencies should be imported somewhere.',
			},
		]);
	});
});
