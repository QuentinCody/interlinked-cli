// ===========================================
// Tests — Sanitizer Registry (Phase A1)
// ===========================================
// ≥3 positive + ≥3 negative cases per sink class (sql, html, shell, url,
// identity) + local-override merge + watch / load behaviour. The defaults
// for `identity` mirror the inline VALIDATOR_PATTERNS that previously
// lived in `src/harness/checks/tainted-sink.ts`; the parity-with-prior-
// behaviour suite at the bottom of this file pins that contract.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";

// Captures every `watchFile` listener the module under test registers,
// without ever actually polling the real filesystem — lets the hot-reload
// test below invoke the listener directly (deterministic, no 2s poll wait)
// instead of racing node:fs's real poll interval.
const capturedWatchListeners = vi.hoisted((): Array<() => void> => []);
// Records every path the cleanup function actually unwatches, so the
// "returns a cleanup function" test can prove cleanup() does real work
// instead of asserting only its (near-universal) function type.
const capturedUnwatchPaths = vi.hoisted((): string[] => []);
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		watchFile: (_path: string, _options: unknown, listener: () => void) => {
			capturedWatchListeners.push(listener);
		},
		unwatchFile: (path: string, listener?: (...args: unknown[]) => void) => {
			capturedUnwatchPaths.push(path);
			return actual.unwatchFile(path, listener);
		},
	};
});
import {
	isSanitized,
	load,
	localSanitizersPath,
	SANITIZER_KIND_FUNCTION,
	SANITIZER_KIND_METHOD,
	SANITIZER_KIND_REGEX,
	type SanitizerRegistry,
	SCOPE_GLOBAL,
	SINK_CLASSES,
	teamSanitizersPath,
	validate,
	watchSanitizerFiles,
} from "../sanitizer-registry.js";

// ---------- Test scaffolding ----------

let tmpRoot: string;

/** Write a sanitizers config inside a fresh tmp `.interlinked/` dir. */
function writeRegistryFile(name: "sanitizers.json" | "sanitizers.local.json", body: unknown): void {
	mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
	writeFileSync(join(tmpRoot, ".interlinked", name), JSON.stringify(body, null, 2));
}

/** Construct a registry from a literal config (validate-only, no I/O). */
function makeRegistry(config: unknown): SanitizerRegistry {
	return validate(config);
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "sanitizer-registry-test-"));
	// Block the user's `.interlinked/sanitizers.local.json` from leaking into
	// `load()` calls that pass an explicit cwd. The test only reads files
	// under `tmpRoot`, so this is belt-and-suspenders.
	delete process.env.INTERLINKED_SKIP_SANITIZER_OVERRIDES;
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- Public-API constants ----------
//
// The named string constants are part of the module's public API — Phase
// B detectors (endpoint-security pack) will import them when constructing
// registry entries programmatically. Pin their literal values so cold
// readers can't accidentally rename them without seeing a test diff.

describe("public-API constants", () => {
	it('SANITIZER_KIND_FUNCTION equals the literal "function"', () => {
		expect(SANITIZER_KIND_FUNCTION).toBe("function");
	});
	it('SANITIZER_KIND_METHOD equals the literal "method"', () => {
		expect(SANITIZER_KIND_METHOD).toBe("method");
	});
	it('SANITIZER_KIND_REGEX equals the literal "regex"', () => {
		expect(SANITIZER_KIND_REGEX).toBe("regex");
	});
	it('SCOPE_GLOBAL equals the literal "global"', () => {
		expect(SCOPE_GLOBAL).toBe("global");
	});
	it("SINK_CLASSES enumerates all five sink classes in declaration order", () => {
		expect([...SINK_CLASSES]).toEqual(["sql", "html", "shell", "url", "identity"]);
	});
});

// ---------- watchSanitizerFiles ----------
//
// Hot-reload watcher mirrors `rules-loader::watchRulesFiles`. The watcher
// uses node:fs.watchFile poll-mode. The reload path (including its
// swallow-on-throw try/catch) is driven directly through a captured
// node:fs.watchFile listener below; only the real 2s poll tick itself is
// left to the daemon integration tests.

describe("watchSanitizerFiles", () => {
	it("returns a cleanup function and registers a watcher without throwing", () => {
		mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
		writeFileSync(join(tmpRoot, ".interlinked", "sanitizers.json"), "{}");
		capturedUnwatchPaths.length = 0;
		const cleanup = watchSanitizerFiles(tmpRoot, () => undefined);
		expect(typeof cleanup).toBe("function");
		cleanup();
		// A no-op cleanup (e.g. a stub `() => {}`) would leave this empty —
		// prove it actually unwatches both files at their real paths.
		expect(capturedUnwatchPaths).toEqual([
			teamSanitizersPath(tmpRoot),
			localSanitizersPath(tmpRoot),
		]);
	});

	it("swallows an onReload callback that throws, so a bad reload never crashes the watcher", () => {
		// The internal `reload` closure wraps `onReload(load(cwd))` in a
		// try/catch that intentionally swallows any error (best-effort
		// hot-reload). Invoke the captured node:fs.watchFile listener
		// directly (rather than waiting up to 2s for a real poll tick): if
		// the catch were removed, the FIRST call below would throw straight
		// out of this test instead of reaching the assertions.
		mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmpRoot, ".interlinked", "sanitizers.json"),
			JSON.stringify({ version: 5, sanitizers: {} }),
		);
		const before = capturedWatchListeners.length;
		const receivedVersions: number[] = [];
		const cleanup = watchSanitizerFiles(tmpRoot, (registry) => {
			receivedVersions.push(registry.version);
			throw new Error("onReload boom");
		});
		const listener = capturedWatchListeners[before];
		if (!listener) throw new Error("watchFile listener was not captured");

		listener();
		listener();

		expect(receivedVersions).toEqual([5, 5]);
		cleanup();
	});
});

// ---------- Schema / validate ----------

describe("validate — schema coercion and compilation", () => {
	it("returns empty registry on null / undefined / non-object input", () => {
		expect(validate(null).sanitizers.sql).toEqual([]);
		expect(validate(undefined).sanitizers.html).toEqual([]);
		expect(validate("not an object").sanitizers.shell).toEqual([]);
		expect(validate(42).sanitizers.url).toEqual([]);
	});

	it("preserves the explicit version number", () => {
		const reg = validate({ version: 7, sanitizers: { sql: [] } });
		expect(reg.version).toBe(7);
	});

	it("drops entries with invalid kind / missing name / missing pattern", () => {
		const reg = validate({
			version: 1,
			sanitizers: {
				identity: [
					{ name: "ok", kind: "regex", pattern: "\\.parse\\(" },
					{ name: "bad-kind", kind: "voodoo", pattern: "x" },
					{ kind: "regex", pattern: "x" }, // no name
					{ name: "no-pattern", kind: "regex" },
					"not-an-object",
				],
			},
		});
		expect(reg.sanitizers.identity).toHaveLength(1);
		expect(nonNull(reg.sanitizers.identity[0]).name).toBe("ok");
	});

	const compileFixture = (): SanitizerRegistry =>
		validate({
			version: 1,
			sanitizers: {
				html: [
					{ name: "escape", kind: "function", pattern: "escape" },
					{ name: "purify", kind: "function", pattern: "DOMPurify.sanitize" },
					{ name: "Schema-validate", kind: "method", pattern: "validate" },
					{ name: "custom", kind: "regex", pattern: "myAllowList\\.contains\\(" },
				],
			},
		});

	it("compiles `function` (unqualified) — matches bare call", () => {
		expect(isSanitized(compileFixture(), "html", "escape(input)")).toBe(true);
	});
	it("compiles `function` (unqualified) — refuses dotted prefix `obj.escape(`", () => {
		expect(isSanitized(compileFixture(), "html", "obj.escape(input)")).toBe(false);
	});
	it("compiles `function` (unqualified) — refuses identifier prefix `someEscape(`", () => {
		expect(isSanitized(compileFixture(), "html", "someEscape(input)")).toBe(false);
	});
	it("compiles `function` (qualified) — matches exact segments", () => {
		expect(isSanitized(compileFixture(), "html", "DOMPurify.sanitize(input)")).toBe(true);
	});
	it("compiles `function` (qualified) — distinguishes sibling identifier", () => {
		expect(isSanitized(compileFixture(), "html", "DOMPurify.sanitizer(input)")).toBe(false);
	});
	it("compiles `method` — matches dotted call shape", () => {
		expect(isSanitized(compileFixture(), "html", "Schema.validate(input)")).toBe(true);
	});
	it("compiles `method` — refuses bare-name call `validate(`", () => {
		expect(isSanitized(compileFixture(), "html", "validate(input)")).toBe(false);
	});
	it("compiles `regex` — matches verbatim source", () => {
		expect(isSanitized(compileFixture(), "html", "myAllowList.contains(input)")).toBe(true);
	});

	it("drops entries whose regex pattern is syntactically invalid", () => {
		const reg = validate({
			version: 1,
			sanitizers: {
				url: [{ name: "broken", kind: "regex", pattern: "[unterminated" }],
			},
		});
		expect(reg.sanitizers.url).toHaveLength(0);
	});

	it("defaults `scope` to global when omitted", () => {
		const reg = validate({
			version: 1,
			sanitizers: {
				html: [{ name: "escape", kind: "function", pattern: "escape" }],
			},
		});
		expect(nonNull(reg.sanitizers.html[0]).scope).toBe("global");
	});
});

// ---------- Per-sink-class positive + negative behaviour ----------

describe("isSanitized — per sink class", () => {
	const registry = makeRegistry({
		version: 1,
		sanitizers: {
			sql: [
				{ name: "pg-identifier", kind: "function", pattern: "pg.Identifier" },
				{ name: "escapeLiteral", kind: "method", pattern: "escapeLiteral" },
				{ name: "param-placeholder", kind: "regex", pattern: "\\$\\d+" },
			],
			html: [
				{ name: "DOMPurify-sanitize", kind: "function", pattern: "DOMPurify.sanitize" },
				{ name: "escape", kind: "function", pattern: "escape" },
				{ name: "Schema-validate", kind: "method", pattern: "validate" },
			],
			shell: [
				{ name: "shlex-quote", kind: "function", pattern: "shlex.quote" },
				{ name: "exec-array", kind: "regex", pattern: "exec\\(\\s*\\[" },
				{ name: "spawn-array", kind: "regex", pattern: "spawn\\(\\s*[\"']" },
			],
			url: [
				{ name: "url-host-allowlist", kind: "regex", pattern: "new URL\\([^)]*\\)\\.host" },
				{ name: "url-parse", kind: "function", pattern: "URL.parse" },
				{ name: "allowed-host-set", kind: "regex", pattern: "ALLOWED_HOSTS\\.has\\(" },
			],
			identity: [
				{ name: "schema-parse", kind: "method", pattern: "parse" },
				{ name: "typeof-guard", kind: "regex", pattern: "\\btypeof\\s+\\w+\\s*[!=]==?" },
				{ name: "array-isarray", kind: "function", pattern: "Array.isArray" },
			],
		},
	});

	describe("sql", () => {
		// Positive (≥3)
		it("flags pg.Identifier(name) as sanitized for sql", () => {
			expect(isSanitized(registry, "sql", "pg.Identifier(tableName)")).toBe(true);
		});
		it("flags client.escapeLiteral(input) as sanitized for sql", () => {
			expect(isSanitized(registry, "sql", "client.escapeLiteral(input)")).toBe(true);
		});
		it("flags $1 placeholder usage as sanitized for sql", () => {
			expect(isSanitized(registry, "sql", "WHERE id = $1")).toBe(true);
		});
		// Negative (≥3)
		it("does not flag a string-concatenated SQL literal", () => {
			expect(isSanitized(registry, "sql", "'SELECT * FROM t WHERE id = ' + id")).toBe(false);
		});
		it("does not flag a template-string SQL literal with interpolation", () => {
			expect(isSanitized(registry, "sql", "`SELECT * FROM ${tableName}`")).toBe(false);
		});
		it("does not flag a sanitizer from a different sink class", () => {
			// `DOMPurify.sanitize` is an html sanitizer; sql class shouldn't treat
			// it as sanitized.
			expect(isSanitized(registry, "sql", "DOMPurify.sanitize(input)")).toBe(false);
		});
	});

	describe("html", () => {
		// Positive
		it("flags DOMPurify.sanitize(input) as sanitized for html", () => {
			expect(isSanitized(registry, "html", "DOMPurify.sanitize(userHtml)")).toBe(true);
		});
		it("flags bare escape(input) as sanitized for html", () => {
			expect(isSanitized(registry, "html", "escape(userInput)")).toBe(true);
		});
		it("flags Schema.validate(input) as sanitized for html", () => {
			expect(isSanitized(registry, "html", "ProfileSchema.validate(req.body)")).toBe(true);
		});
		// Negative
		it("does not flag innerHTML assignment of raw input", () => {
			expect(isSanitized(registry, "html", "el.innerHTML = req.body.raw")).toBe(false);
		});
		it("does not flag dangerouslySetInnerHTML with raw input", () => {
			expect(isSanitized(registry, "html", "dangerouslySetInnerHTML={{ __html: x }}")).toBe(
				false,
			);
		});
		it("does not flag obj.escape(input) when `escape` is unqualified", () => {
			// `escape` (kind: function, no dot) refuses dotted prefixes.
			expect(isSanitized(registry, "html", "obj.escape(x)")).toBe(false);
		});
	});

	describe("shell", () => {
		// Positive
		it("flags shlex.quote(input) as sanitized for shell", () => {
			expect(isSanitized(registry, "shell", "shlex.quote(arg)")).toBe(true);
		});
		it("flags exec(['ls', '-l']) array form as sanitized for shell", () => {
			expect(isSanitized(registry, "shell", "exec(['ls', userArg])")).toBe(true);
		});
		it("flags spawn('git', args) as sanitized for shell (string-anchored array form)", () => {
			expect(isSanitized(registry, "shell", "spawn('git', ['status'])")).toBe(true);
		});
		// Negative
		it("does not flag exec(`rm -rf ${userPath}`) interpolated string form", () => {
			expect(isSanitized(registry, "shell", "exec(`rm -rf ${userPath}`)")).toBe(false);
		});
		it("does not flag exec('ls ' + userInput) concatenated form", () => {
			expect(isSanitized(registry, "shell", "exec('ls ' + userInput)")).toBe(false);
		});
		it("does not flag bare shell-out via `sh -c <input>`", () => {
			expect(isSanitized(registry, "shell", "exec('sh -c ' + cmd)")).toBe(false);
		});
	});

	describe("url", () => {
		// Positive
		it("flags new URL(input).host pattern as sanitized for url", () => {
			expect(
				isSanitized(registry, "url", "if (!ALLOWED.includes(new URL(input).host)) return;"),
			).toBe(true);
		});
		it("flags URL.parse(input) as sanitized for url", () => {
			expect(isSanitized(registry, "url", "URL.parse(req.body.target)")).toBe(true);
		});
		it("flags ALLOWED_HOSTS.has(host) allowlist as sanitized for url", () => {
			expect(isSanitized(registry, "url", "ALLOWED_HOSTS.has(parsed.host)")).toBe(true);
		});
		// Negative
		it("does not flag fetch(req.body.url) raw", () => {
			expect(isSanitized(registry, "url", "fetch(req.body.url)")).toBe(false);
		});
		it("does not flag axios.get(redirectTarget)", () => {
			expect(isSanitized(registry, "url", "axios.get(redirectTarget)")).toBe(false);
		});
		it("does not flag string-concat of URL parts", () => {
			expect(isSanitized(registry, "url", "'https://' + req.body.host + '/api'")).toBe(false);
		});
	});

	describe("identity", () => {
		// Positive
		it("flags Schema.parse(input) as sanitized for identity", () => {
			expect(isSanitized(registry, "identity", "Cmd.parse(req.body.cmd)")).toBe(true);
		});
		it("flags typeof x === 'string' guard as sanitized for identity", () => {
			expect(isSanitized(registry, "identity", "if (typeof name === 'string') {")).toBe(true);
		});
		it("flags Array.isArray(input) as sanitized for identity", () => {
			expect(isSanitized(registry, "identity", "if (Array.isArray(items)) {")).toBe(true);
		});
		// Negative
		it("does not flag bare assignment of req.body.x", () => {
			expect(isSanitized(registry, "identity", "const x = req.body.x")).toBe(false);
		});
		it("does not flag console.log(req.body.x)", () => {
			expect(isSanitized(registry, "identity", "console.log(req.body.foo)")).toBe(false);
		});
		it("does not flag a JSON.stringify(req.body) call", () => {
			expect(isSanitized(registry, "identity", "JSON.stringify(req.body)")).toBe(false);
		});
	});
});

// ---------- Scope filtering ----------

describe("isSanitized — scope filtering", () => {
	const registry = makeRegistry({
		version: 1,
		sanitizers: {
			html: [
				{ name: "marked-safe", kind: "function", pattern: "marked", scope: "marked" },
				{ name: "DOMPurify-sanitize", kind: "function", pattern: "DOMPurify.sanitize" },
			],
		},
	});

	it("applies global entries regardless of currentModule", () => {
		expect(
			isSanitized(registry, "html", "DOMPurify.sanitize(x)", { currentModule: "any-module" }),
		).toBe(true);
		expect(isSanitized(registry, "html", "DOMPurify.sanitize(x)")).toBe(true);
	});

	it("applies module-scoped entries — fires when currentModule matches", () => {
		expect(
			isSanitized(registry, "html", "marked(input)", { currentModule: "marked" }),
		).toBe(true);
	});

	it("applies module-scoped entries — refuses when currentModule differs", () => {
		expect(
			isSanitized(registry, "html", "marked(input)", { currentModule: "different-module" }),
		).toBe(false);
	});

	it("treats absent currentModule as 'all entries apply' (scope filtering off)", () => {
		expect(isSanitized(registry, "html", "marked(input)")).toBe(true);
	});
});

// ---------- load() — team + local merge ----------

describe("load — team + local override merge", () => {
	it("returns empty registry when neither file exists", () => {
		const reg = load(tmpRoot);
		for (const cls of SINK_CLASSES) {
			expect(reg.sanitizers[cls]).toEqual([]);
		}
	});

	it("loads team file when only team is present", () => {
		writeRegistryFile("sanitizers.json", {
			version: 1,
			sanitizers: {
				html: [{ name: "escape", kind: "function", pattern: "escape" }],
			},
		});
		const reg = load(tmpRoot);
		expect(isSanitized(reg, "html", "escape(x)")).toBe(true);
	});

	it("deep-merges local override on top of team file", () => {
		writeRegistryFile("sanitizers.json", {
			version: 1,
			sanitizers: {
				html: [{ name: "escape", kind: "function", pattern: "escape" }],
			},
		});
		writeRegistryFile("sanitizers.local.json", {
			version: 1,
			sanitizers: {
				html: [{ name: "custom-team", kind: "function", pattern: "myCo.sanitize" }],
				sql: [{ name: "pg-id", kind: "function", pattern: "pg.Identifier" }],
			},
		});
		const reg = load(tmpRoot);
		// Both team and local entries present in html.
		expect(isSanitized(reg, "html", "escape(x)")).toBe(true);
		expect(isSanitized(reg, "html", "myCo.sanitize(x)")).toBe(true);
		// Local-only entry in sql.
		expect(isSanitized(reg, "sql", "pg.Identifier(t)")).toBe(true);
	});

	it("local entry with same name+scope replaces team entry", () => {
		writeRegistryFile("sanitizers.json", {
			version: 1,
			sanitizers: {
				html: [{ name: "escape", kind: "function", pattern: "escape" }],
			},
		});
		writeRegistryFile("sanitizers.local.json", {
			version: 1,
			sanitizers: {
				// Same name `escape` — override with a different pattern so we can
				// observe the swap.
				html: [{ name: "escape", kind: "function", pattern: "htmlEntities" }],
			},
		});
		const reg = load(tmpRoot);
		// New pattern fires.
		expect(isSanitized(reg, "html", "htmlEntities(x)")).toBe(true);
		// Old pattern no longer fires (replaced).
		expect(isSanitized(reg, "html", "escape(x)")).toBe(false);
	});

	it("skips local override when INTERLINKED_SKIP_SANITIZER_OVERRIDES=1", () => {
		writeRegistryFile("sanitizers.json", {
			version: 1,
			sanitizers: {
				html: [{ name: "escape", kind: "function", pattern: "escape" }],
			},
		});
		writeRegistryFile("sanitizers.local.json", {
			version: 1,
			sanitizers: {
				html: [{ name: "custom", kind: "function", pattern: "myCo.sanitize" }],
			},
		});
		// `afterEach` restores the env var by `delete`-ing it (set on line 53),
		// so this single assignment + assertion sequence is safe without a
		// local try/finally and reads as one branch through the test.
		process.env.INTERLINKED_SKIP_SANITIZER_OVERRIDES = "1";
		const reg = load(tmpRoot);
		expect(isSanitized(reg, "html", "escape(x)")).toBe(true);
		expect(isSanitized(reg, "html", "myCo.sanitize(x)")).toBe(false);
	});

	it("falls back to empty registry on malformed JSON, but a valid local override still merges", () => {
		mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
		writeFileSync(join(tmpRoot, ".interlinked", "sanitizers.json"), "{not valid json");
		writeRegistryFile("sanitizers.local.json", {
			version: 1,
			sanitizers: {
				sql: [{ name: "pg-id", kind: "function", pattern: "pg.Identifier" }],
			},
		});
		const reg = load(tmpRoot);
		for (const cls of SINK_CLASSES) {
			if (cls === "sql") continue;
			expect(reg.sanitizers[cls]).toEqual([]);
		}
		// The malformed team file is treated as absent rather than aborting
		// the whole load — a mutant that short-circuits on any parse error
		// would drop this local-only entry too.
		expect(isSanitized(reg, "sql", "pg.Identifier(t)")).toBe(true);
	});

	it("teamSanitizersPath / localSanitizersPath return expected paths", () => {
		expect(teamSanitizersPath("/r")).toBe("/r/.interlinked/sanitizers.json");
		expect(localSanitizersPath("/r")).toBe("/r/.interlinked/sanitizers.local.json");
	});
});

// ---------- Parity with prior tainted-sink.ts behaviour ----------
//
// The defaults shipped at `.interlinked/sanitizers.json` must produce the
// same `isSanitized("identity", expression)` answers as the previous
// `VALIDATOR_PATTERNS` array from `src/harness/checks/tainted-sink.ts`
// for every existing test fixture. These cases pin that contract.

describe("identity defaults — parity with prior tainted-sink VALIDATOR_PATTERNS", () => {
	// Mirror the shipped defaults from .interlinked/sanitizers.json so this
	// test fails if the JSON drifts away from the prior inline list.
	const registry = makeRegistry({
		version: 1,
		sanitizers: {
			identity: [
				{ name: "schema-parse", kind: "regex", pattern: "\\.parse\\s*\\(" },
				{ name: "schema-safeparse", kind: "regex", pattern: "\\.safeParse\\s*\\(" },
				{ name: "schema-validate", kind: "regex", pattern: "\\.validate\\s*\\(" },
				{ name: "typeof-guard", kind: "regex", pattern: "\\btypeof\\s+\\w+\\s*[!=]==?" },
				{ name: "array-isarray", kind: "regex", pattern: "\\bArray\\.isArray\\s*\\(" },
				{ name: "instanceof", kind: "regex", pattern: "\\binstanceof\\b" },
				{ name: "set-map-has", kind: "regex", pattern: "\\.has\\s*\\(" },
			],
		},
	});

	it("matches Cmd.parse(req.body.cmd) — zod / valibot / arktype", () => {
		expect(isSanitized(registry, "identity", "Cmd.parse(req.body.cmd)")).toBe(true);
	});
	it("matches Cmd.safeParse(req.body.cmd) — zod safeParse", () => {
		expect(isSanitized(registry, "identity", "Cmd.safeParse(req.body.cmd)")).toBe(true);
	});
	it("matches Schema.validate(input) — joi / ajv / yup", () => {
		expect(isSanitized(registry, "identity", "Schema.validate(input)")).toBe(true);
	});
	it("matches typeof name === 'string' runtime guard", () => {
		expect(isSanitized(registry, "identity", "if (typeof name === 'string') {")).toBe(true);
	});
	it("matches typeof cmd !== 'string' inverted runtime guard", () => {
		expect(isSanitized(registry, "identity", "if (typeof cmd !== 'string') return;")).toBe(true);
	});
	it("matches Array.isArray(items) guard", () => {
		expect(isSanitized(registry, "identity", "if (Array.isArray(items)) {")).toBe(true);
	});
	it("matches `name instanceof X` guard", () => {
		expect(isSanitized(registry, "identity", "if (name instanceof URL) {")).toBe(true);
	});
	it("matches allowList.has(name) allow-list", () => {
		expect(isSanitized(registry, "identity", "if (allowList.has(cmd)) {")).toBe(true);
	});

	it("does not match bare external-input assignment", () => {
		expect(isSanitized(registry, "identity", "const cmd = req.body.cmd")).toBe(false);
	});
	it("does not match a sink call with no guard / parse", () => {
		expect(isSanitized(registry, "identity", "exec(req.body.cmd)")).toBe(false);
	});
	it("does not match console.log of external input", () => {
		expect(isSanitized(registry, "identity", "console.log(req.body.foo)")).toBe(false);
	});
});
