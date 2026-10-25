// Foreign-repository false positives of the `empty_catch` pre_block check
// (cross-repo falsification, 2026-10-21: 17 read, 17 confirmed false
// positives, 0 true positives; scratch/2026-10-21-cross-repo/falsify-result.json).
// Every N case below is the real code from the named repository and file, cut
// to the enclosing function or test. A pre_block check refuses the edit, so
// each one was a legitimate edit the gate refused.
//
// The classes the detector now accepts as handling for an empty catch:
//   - fallback guard: the try assigns a value and the next statement tests it
//   - default return: the try returns and the code after the try returns or throws
//   - rejection silencer: the whole try body attaches a `.catch(handler)`
//   - rationale: a comment in the catch body or directly above the try says why
//   - assertion after the try: in test code, the next statement is an assertion
//   - benchmark throw case: in a benchmark file, the try is the whole callback body
// The P cases keep the class: a catch that drops a real error with no
// handling after it and no rationale still blocks.

import { describe, expect, it } from "vitest";
import { checkEmptyCatch } from "../../taste-checks-checks-2.js";

const src = (lines: string[]): string => `${lines.join("\n")}\n`;

interface ForeignCase {
	id: string;
	file: string;
	code: string;
}

const ZUSTAND_DEVTOOLS: ForeignCase = {
	id: "N1: zustand src/middleware/devtools.ts:204 — feature probe, the next statement handles the unset value",
	file: "src/middleware/devtools.ts",
	code: src([
		"const devtoolsImpl = (fn, devtoolsOptions = {}) => (set, get, api) => {",
		"\tconst { enabled } = devtoolsOptions",
		"\tlet extensionConnector:",
		"\t\t(typeof window)['__REDUX_DEVTOOLS_EXTENSION__'] | false",
		"\ttry {",
		"\t\textensionConnector =",
		"\t\t\t(enabled ?? import.meta.env?.MODE !== 'production') &&",
		"\t\t\twindow.__REDUX_DEVTOOLS_EXTENSION__",
		"\t} catch {",
		"\t\t// ignored",
		"\t}",
		"",
		"\tif (!extensionConnector) {",
		"\t\treturn fn(set, get, api)",
		"\t}",
		"\treturn extensionConnector.connect(devtoolsOptions)",
		"}",
	]),
};

const TINYBENCH_ASYNC: ForeignCase = {
	id: "N2: tinybench src/async.ts:53 — the whole try body silences a promise rejection",
	file: "src/async.ts",
	code: src([
		"export const isFnAsyncResource = (fn: Fn | null | undefined): boolean => {",
		"  if (fn == null) {",
		"    return false",
		"  }",
		"  if (isAsyncFunction(fn)) {",
		"    return true",
		"  }",
		"  try {",
		"    const fnCall = fn()",
		"    const promiseLike = isPromiseLike(fnCall)",
		"    if (promiseLike) {",
		"      // silence promise rejection",
		"      try {",
		"        (fnCall.then(emptyFunction) as Promise<unknown>).catch(emptyFunction)",
		"      } catch {",
		"        // ignore",
		"      }",
		"    }",
		"    return promiseLike",
		"  } catch {",
		"    return false",
		"  }",
		"}",
	]),
};

const KY_TEXT_DECODER: ForeignCase = {
	id: "N3: ky source/core/Ky.ts:107 — try-return with the UTF-8 default returned after the block",
	file: "source/core/Ky.ts",
	code: src([
		"const createTextDecoder = (contentType: string): TextDecoder => {",
		'\tconst match = /;\\s*charset\\s*=\\s*(?:"([^"]+)"|([^;,\\s]+))/i.exec(contentType);',
		"\tconst charset = match?.[1] ?? match?.[2];",
		"\tif (charset) {",
		"\t\ttry {",
		"\t\t\treturn new TextDecoder(charset);",
		"\t\t} catch {}",
		"\t}",
		"",
		"\treturn new TextDecoder();",
		"};",
	]),
};

const KY_NON_ERROR: ForeignCase = {
	id: "N4: ky source/errors/NonError.ts:29 — the catch body states the fallback (default message)",
	file: "source/errors/NonError.ts",
	code: src([
		"export class NonError extends Error {",
		"\tconstructor(value: unknown) {",
		"\t\tlet message = 'Non-error value was thrown';",
		"",
		"\t\ttry {",
		"\t\t\tif (typeof value === 'string') {",
		"\t\t\t\tmessage = value;",
		"\t\t\t} else if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {",
		"\t\t\t\tmessage = value.message;",
		"\t\t\t}",
		"\t\t} catch {",
		"\t\t\t// Use default message if accessing properties throws",
		"\t\t}",
		"",
		"\t\tsuper(message);",
		"",
		"\t\tthis.value = value;",
		"\t}",
		"}",
	]),
};

const KY_HOOKS_TEST: ForeignCase = {
	id: "N5: ky test/hooks.ts:7701 — the comment above the try says the outcome is not asserted",
	file: "test/hooks.ts",
	code: src([
		"\t]) {",
		"\t\tlet cancelled = false;",
		"\t\tlet fetchCalled = false;",
		"\t\tconst body = new ReadableStream<Uint8Array>({",
		"\t\t\tcancel() {",
		"\t\t\t\tcancelled = true;",
		"\t\t\t},",
		"\t\t});",
		"",
		"\t\t// Some of these throw and some resolve, for example a hook that answers the request itself, so the outcome is not asserted here. What matters is that fetch never ran and the caller's body survived.",
		"\t\ttry {",
		"\t\t\t// eslint-disable-next-line no-await-in-loop",
		"\t\t\tawait ky('https://example.com', {",
		"\t\t\t\tmethod: 'POST',",
		"\t\t\t\tbody,",
		"\t\t\t\tretry: 0,",
		"\t\t\t\t...options,",
		"\t\t\t\tasync fetch() {",
		"\t\t\t\t\tfetchCalled = true;",
		"\t\t\t\t\treturn new Response('ok');",
		"\t\t\t\t},",
		"\t\t\t}).text();",
		"\t\t} catch {}",
		"",
		"\t\tfailedFetches.push(fetchCalled);",
		"\t\tcancelledBodies.push(cancelled);",
		"\t}",
	]),
};

/** date-fns pkgs/core/src/format/test.ts: each `console.warn` test swallows the
 *  token's throw and asserts the warning right after the try. Only the D and DD
 *  throws are also pinned by a sibling test (lines 815 and 826); the DDD,
 *  DDDD, DDDDD and Y throws are not, so the shared shape is the assertion
 *  after the try, not the sibling pin. */
const dateFnsWarnCase = (line: number, token: string, pattern: string): ForeignCase => ({
	id: `N: date-fns pkgs/core/src/format/test.ts:${line} — "${token}" warning asserted after the swallowed throw`,
	file: "pkgs/core/src/format/test.ts",
	code: src([
		`      it('warns if "${token}" token is used', () => {`,
		"        try {",
		`          format(date, "${pattern}");`,
		"        } catch (_) {",
		"          // Ignore the error",
		"        }",
		"        expect(warn).toBeCalledWith(",
		`          "Use \`${token.toLowerCase()}\` instead of \`${token}\` (in \`${pattern}\`) for formatting to the input \`" +`,
		"            date +",
		'            "`; see: https://github.com/date-fns/date-fns/blob/master/docs/unicodeTokens.md",',
		"        );",
		"      });",
	]),
});

const DATE_FNS_CASES: ForeignCase[] = [
	dateFnsWarnCase(878, "D", "yyyy-MM-D"),
	dateFnsWarnCase(891, "DD", "yyyy-MM-DD"),
	dateFnsWarnCase(904, "DDD", "yyyy-MM-DDD"),
	dateFnsWarnCase(917, "DDDD", "yyyy-MM-DDDD"),
	dateFnsWarnCase(930, "DDDDD", "yyyy-MM-DDDDD"),
	dateFnsWarnCase(943, "Y", "Y-MM-dd"),
];

/** zod packages/zod/src/v3/benchmarks/*.ts: a Benchmark.js case that times
 *  the failure path of `parse`; the throw is the measured outcome. */
const zodBenchCase = (file: string, line: number, suite: string, schema: string, arg: string): ForeignCase => ({
	id: `N: zod packages/zod/src/v3/benchmarks/${file}:${line} — benchmark case times the parse failure`,
	file: `packages/zod/src/v3/benchmarks/${file}`,
	code: src([
		`${suite}`,
		'  .add("valid", () => {',
		`    ${schema}.parse({});`,
		"  })",
		`  .add("invalid: ${arg === "null" ? "null" : "wrong shape"}", () => {`,
		"    try {",
		`      ${schema}.parse(${arg});`,
		"    } catch (_err) {}",
		"  })",
		'  .on("cycle", (e: Benchmark.Event) => {',
		`    console.log(\`\${(${suite} as any).name}: \${e.target}\`);`,
		"  });",
	]),
});

const ZOD_CASES: ForeignCase[] = [
	zodBenchCase("discriminatedUnion.ts", 46, "doubleSuite", "double", "null"),
	zodBenchCase("discriminatedUnion.ts", 51, "doubleSuite", "double", "objC"),
	zodBenchCase("discriminatedUnion.ts", 67, "manySuite", "many", "null"),
	zodBenchCase("discriminatedUnion.ts", 72, "manySuite", "many", '{ type: "unknown" }'),
	zodBenchCase("object.ts", 29, "emptySuite", "empty", "null"),
	zodBenchCase("object.ts", 45, "shortSuite", "short", "null"),
];

const FOREIGN_CASES: ForeignCase[] = [
	ZUSTAND_DEVTOOLS,
	TINYBENCH_ASYNC,
	KY_TEXT_DECODER,
	KY_NON_ERROR,
	KY_HOOKS_TEST,
	...DATE_FNS_CASES,
	...ZOD_CASES,
];

/** Round-2 adversarial probe (scratch/2026-10-21-adversarial/empty_catch.round2.probe.mts):
 *  a method or JSX text named `catch` that follows no try block. */
const ROUND2_CASES: ForeignCase[] = [
	{
		id: "N: round 2 R1 — a thenable class method `catch() {}`",
		file: "src/testing/fake-promise.ts",
		code: "export class FakeThenable {\n\tthen(res: (v: number) => void) {\n\t\tres(1);\n\t}\n\tcatch() {}\n\tfinally() {}\n}\n",
	},
	{
		id: "N: round 2 R2 — an object-literal PromiseLike stub method `catch() {},`",
		file: "src/testing/stubs.ts",
		code: "const stub = {\n\tthen() {\n\t\treturn stub;\n\t},\n\tcatch() {},\n};\n",
	},
	{
		id: "N: round 2 R3 — JSX prose `<code>catch (e) {}</code>` in a .tsx docs component",
		file: "src/docs/Lint.tsx",
		code: "export function Lint() {\n\treturn <p>Never leave <code>catch (e) {}</code> empty.</p>;\n}\n",
	},
	{
		id: "N: round 2 R11 — a one-parameter class method `catch(onRejected) {}`",
		file: "src/testing/fake-promise.ts",
		code: "class P {\n\tcatch(onRejected) {}\n}\n",
	},
];

describe("empty_catch foreign false positives — negative (must not fire)", () => {
	for (const c of [...FOREIGN_CASES, ...ROUND2_CASES]) {
		it(c.id, () => {
			expect(checkEmptyCatch(c.code, c.file)).toEqual([]);
		});
	}

	it("N: class generalization — a probe loop whose fallback is returned after the loop", () => {
		const code = src([
			"function decode(buf: Uint8Array): string {",
			"\tfor (const enc of ENCODINGS) {",
			"\t\ttry {",
			"\t\t\treturn new TextDecoder(enc, { fatal: true }).decode(buf);",
			"\t\t} catch {}",
			"\t}",
			"\treturn latin1(buf);",
			"}",
		]);
		expect(checkEmptyCatch(code, "src/decode.ts")).toEqual([]);
	});

	it("N: class generalization — a try-return followed by a throw of a domain error", () => {
		const code = src([
			"function parseConfig(text: string, path: string): Config {",
			"\ttry {",
			"\t\treturn JSON.parse(text) as Config;",
			"\t} catch {}",
			"\tthrow new ConfigError(path);",
			"}",
		]);
		expect(checkEmptyCatch(code, "src/config.ts")).toEqual([]);
	});

	it("N: class generalization — the marker vocabulary above the try also counts", () => {
		const code = src(["// Best-effort: the lock file may already be gone.", "try {", "\tunlinkSync(lock);", "} catch {}"]);
		expect(checkEmptyCatch(code, "src/lock.ts")).toEqual([]);
	});
});

describe("empty_catch foreign refinement — positive (must fire)", () => {
	const fires = (code: string, file = "src/x.ts"): number => checkEmptyCatch(code, file).length;

	it("P1: a probe whose value is used with no guard after the try", () => {
		expect(fires(src(["let cfg;", "try {", "\tcfg = loadConfig(path);", "} catch {}", "start(cfg);"]))).toBe(1);
	});

	it("P2: a swallowed save followed by a success return (the try body does not return)", () => {
		const code = src([
			"async function persist(record: Row) {",
			"\ttry {",
			"\t\tawait db.save(record);",
			"\t} catch {}",
			"\treturn { ok: true };",
			"}",
		]);
		expect(fires(code)).toBe(1);
	});

	it("P3: a bare `// ignore` comment with nothing after the try", () => {
		expect(fires(src(["try {", "\tsendMetrics(batch);", "} catch {", "\t// ignore", "}"]))).toBe(1);
	});

	it("P4: a comment above the try that describes the work but not the failure", () => {
		const code = src([
			"// Persist the record to the database before we reply to the caller.",
			"try {",
			"\tdb.save(record);",
			"} catch {}",
			"reply(res);",
		]);
		expect(fires(code)).toBe(1);
	});

	it("P5: a TODO comment is a deferral, not a rationale", () => {
		const code = src(["try {", "\twrite(file);", "} catch {", "\t// TODO: handle the error properly if the write fails here", "}"]);
		expect(fires(code)).toBe(1);
	});

	it("P6: an interlinked-ignore directive above the try is not read as a rationale (the suppression system owns it)", () => {
		const code = src([
			"// interlinked-ignore: empty_catch — best-effort tmp-dir cleanup, nothing actionable",
			"try {",
			"\trmSync(dir);",
			"} catch {}",
		]);
		expect(fires(code)).toBe(1);
	});

	it("P7: test code whose next statement after the try is not an assertion", () => {
		const code = src(['it("saves", async () => {', "\ttry {", "\t\tawait save();", "\t} catch {}", "\tdone();", "});"]);
		expect(fires(code, "src/save.test.ts")).toBe(1);
	});

	it("P8: an assertion after the try outside test code is not an excuse", () => {
		expect(fires(src(["try {", "\tflush();", "} catch {}", "expect(state).toBe(READY);"]))).toBe(1);
	});

	it("P9: a benchmark file where the try is not the whole callback body", () => {
		const code = src(['bench.add("parse", () => {', "\ttry {", "\t\tparse(null);", "\t} catch {}", "\trecord();", "});"]);
		expect(fires(code, "bench/parse.bench.ts")).toBe(1);
	});

	it("P10: a whole-callback-body try outside a benchmark file", () => {
		const code = src(['router.add("invalid", () => {', "\ttry {", "\t\thandle(null);", "\t} catch {}", "});"]);
		expect(fires(code, "src/routes.ts")).toBe(1);
	});

	it("P11: a `.catch(handler)` attachment followed by more work in the same try body", () => {
		expect(fires(src(["try {", "\tp.catch(noop);", "\tcommit();", "} catch {}"]))).toBe(1);
	});

	it("P12: a return inside a nested callback is not a try-return", () => {
		const code = src([
			"function first(items: Item[]) {",
			"\ttry {",
			"\t\titems.forEach((i) => {",
			"\t\t\treturn i;",
			"\t\t});",
			"\t} catch {}",
			"\treturn null;",
			"}",
		]);
		expect(fires(code)).toBe(1);
	});

	it("P13: a guard on a different variable than the one the try assigns", () => {
		expect(fires(src(["let x;", "try {", "\tx = parse(s);", "} catch {}", "if (!other) return;", "use(x);"]))).toBe(1);
	});

	it("P14: a short non-marker comment stays a block (ENOENT: already gone, the C7 policy case)", () => {
		expect(fires(src(["try {", "\trmSync(p);", "} catch {", "\t// ENOENT: already gone", "}"]))).toBe(1);
	});
});
