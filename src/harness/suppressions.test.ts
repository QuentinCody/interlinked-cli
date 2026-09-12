// Behavioral coverage for `suppressions.ts` — inline suppression/deferral
// markers, JSON-file load + glob matching, the suppression check, and the
// CLI add path. Real-fs functions are exercised against a per-test tmpdir
// (deterministic, matches the sibling `behavioral-checks-tdd.test.ts`
// convention); the pure parsers run on string fixtures.
//
// The `scanInlineDeferrals` block (PR2 defer marker) is kept and extended.

import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	addSuppressions,
	type FileSuppressions,
	type InlineSuppressions,
	isSuppressed,
	loadFileSuppressions,
	loadSuppressionFile,
	parseSuppressionEntry,
	scanInlineDeferrals,
	scanInlineSuppressions,
} from "./suppressions.js";

// ---------------------------------------------------------------------------
// scanInlineSuppressions — `// interlinked-ignore: <check>` parsing
// ---------------------------------------------------------------------------

describe("scanInlineSuppressions", () => {
	it("attaches a single check to the next non-comment line", () => {
		const map = scanInlineSuppressions("// interlinked-ignore: sql-injection\nquery(x)\n");
		expect(map.get(2)?.has("sql-injection")).toBe(true);
		expect(map.size).toBe(1);
	});

	it("lowercases check ids", () => {
		const map = scanInlineSuppressions("// interlinked-ignore: SQL-Injection\nquery(x)\n");
		expect(map.get(2)?.has("sql-injection")).toBe(true);
	});

	it("strips a reason after an em-dash and keeps the check only", () => {
		const map = scanInlineSuppressions(
			"// interlinked-ignore: sql-injection — trusted input\nquery(x)\n",
		);
		const checks = map.get(2);
		expect(checks?.has("sql-injection")).toBe(true);
		expect(checks?.size).toBe(1);
	});

	it("strips a reason after a `--` separator", () => {
		const map = scanInlineSuppressions(
			"// interlinked-ignore: silent-catch -- logged elsewhere\ntry {} catch {}\n",
		);
		expect(map.get(2)?.has("silent-catch")).toBe(true);
		expect(map.get(2)?.size).toBe(1);
	});

	it("strips a reason after an en-dash separator", () => {
		const map = scanInlineSuppressions("// interlinked-ignore: foo – reason\nbar()\n");
		expect(map.get(2)?.has("foo")).toBe(true);
		expect(map.get(2)?.size).toBe(1);
	});

	it("requires whitespace on both sides of a reason separator", () => {
		const leftCompact = scanInlineSuppressions("// interlinked-ignore: foo--reason\nbar()\n");
		const rightCompact = scanInlineSuppressions("// interlinked-ignore: foo --reason\nbar()\n");
		expect([...leftCompact.get(2) ?? []]).toEqual(["foo--reason"]);
		expect([...rightCompact.get(2) ?? []]).toEqual(["foo --reason"]);
	});

	it("splits comma-separated checks into the same target line", () => {
		const map = scanInlineSuppressions(
			"// interlinked-ignore: sql-injection, silent-catch\nrun()\n",
		);
		const checks = map.get(2);
		expect(checks?.has("sql-injection")).toBe(true);
		expect(checks?.has("silent-catch")).toBe(true);
		expect(checks?.size).toBe(2);
	});

	it("skips intervening blank and comment lines to find the target", () => {
		const code = ["// interlinked-ignore: foo", "", "// noise", "real()", ""].join("\n");
		expect(scanInlineSuppressions(code).get(4)?.has("foo")).toBe(true);
	});

	it("skips whitespace-only and indented comment lines before the target", () => {
		const code = [
			"// interlinked-ignore: foo",
			"   ",
			"   // noise",
			"  real()",
		].join("\n");
		expect(scanInlineSuppressions(code).get(4)?.has("foo")).toBe(true);
	});

	it("accepts compact marker spacing but only at the start of a comment line", () => {
		expect(scanInlineSuppressions("//interlinked-ignore:foo\nrun()\n").get(2)?.has("foo")).toBe(
			true,
		);
		expect(
			scanInlineSuppressions('const text = "// interlinked-ignore: foo";\nrun()\n').size,
		).toBe(0);
	});

	it("falls back to the default next line (i+2) when no following code line exists", () => {
		// Marker on the last meaningful line, only blank/comment after → default targetLine.
		const code = ["// interlinked-ignore: foo", "", "// trailing comment"].join("\n");
		const map = scanInlineSuppressions(code);
		// Default targetLine = i + 2 = 0 + 2 = 2 (no non-comment line is found).
		expect(map.get(2)?.has("foo")).toBe(true);
	});

	it("merges two markers targeting the same line into one Set", () => {
		const code = [
			"// interlinked-ignore: foo",
			"// interlinked-ignore: bar",
			"target()",
		].join("\n");
		const checks = scanInlineSuppressions(code).get(3);
		expect(checks?.has("foo")).toBe(true);
		expect(checks?.has("bar")).toBe(true);
		expect(checks?.size).toBe(2);
	});

	it("ignores a marker that yields no check ids after splitting", () => {
		// Comma-only payload → every split piece is empty → filtered to [] (the
		// `checks.length === 0` early-continue). A leading em-dash would NOT do
		// this: the dash-split needs whitespace before the dash, so a capture
		// that *starts* with the dash is kept verbatim as a (garbage) check.
		const map = scanInlineSuppressions("// interlinked-ignore: , ,\ncode()\n");
		expect(map.size).toBe(0);
	});

	it("returns an empty map when no markers are present", () => {
		expect(scanInlineSuppressions("const x = 1\nconst y = 2\n").size).toBe(0);
	});

	it("does not match `interlinked: defer` (handled by the deferral scanner)", () => {
		expect(scanInlineSuppressions("// interlinked: defer foo\nrun()\n").size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// scanInlineDeferrals — `interlinked: defer` markers (// and # shapes)
// ---------------------------------------------------------------------------

describe("scanInlineDeferrals — above-line marker (// shape)", () => {
	it("attaches the marker to the next non-comment line", () => {
		const map = scanInlineDeferrals("// interlinked: defer pickle_load\nobj = something()\n");
		expect(map.get(2)?.has("pickle_load")).toBe(true);
	});

	it("captures the reason after an em-dash", () => {
		const code = "// interlinked: defer eval_usage — sandboxed by callers\neval(x);\n";
		expect(scanInlineDeferrals(code).get(2)?.get("eval_usage")).toBe("sandboxed by callers");
	});

	it("captures the reason after a `--` separator", () => {
		const code = "// interlinked: defer eval_usage -- only fixture data\neval(x);\n";
		expect(scanInlineDeferrals(code).get(2)?.get("eval_usage")).toBe("only fixture data");
	});

	it("skips empty / pure-comment lines when locating the target", () => {
		const code = [
			"// interlinked: defer ubs_marshal_load",
			"",
			"// another comment",
			"obj = marshal.load(f)",
			"",
		].join("\n");
		expect(scanInlineDeferrals(code).get(4)?.has("ubs_marshal_load")).toBe(true);
	});

	it("skips whitespace-only and indented comment lines when locating the target", () => {
		const code = [
			"// interlinked: defer eval_usage",
			"   ",
			"   // another comment",
			"run()",
		].join("\n");
		expect(scanInlineDeferrals(code).get(4)?.has("eval_usage")).toBe(true);
	});

	it("recognises indented comment-only markers as above-line markers", () => {
		const code = "  // interlinked: defer eval_usage\nrun()\n";
		expect(scanInlineDeferrals(code).get(2)?.has("eval_usage")).toBe(true);
		expect(scanInlineDeferrals(code).get(1)).toBeUndefined();
	});

	it("does not accept a marker embedded after another comment prefix", () => {
		const code = "// note // interlinked: defer eval_usage\nrun()\n";
		expect(scanInlineDeferrals(code).size).toBe(0);
	});

	it("accepts compact marker spacing but keeps defer as a separate word", () => {
		expect(
			scanInlineDeferrals("//interlinked:defer eval_usage\nrun()\n").get(2)?.has("eval_usage"),
		).toBe(true);
		expect(scanInlineDeferrals("// interlinked: deferfoo\nrun()\n").size).toBe(0);
	});

	it("supports comma-separated multiple check ids on one marker", () => {
		const code = "// interlinked: defer eval_usage, inner_html\nrun()\n";
		const entry = scanInlineDeferrals(code).get(2);
		expect(entry?.has("eval_usage")).toBe(true);
		expect(entry?.has("inner_html")).toBe(true);
	});

	it("falls back to default target line when no following code line exists", () => {
		// Only comments/blank after the marker → recordDeferral uses targetLine = i + 2.
		const code = ["// interlinked: defer eval_usage", "// trailing only"].join("\n");
		expect(scanInlineDeferrals(code).get(2)?.has("eval_usage")).toBe(true);
	});

	it("keeps the last-written reason on a duplicate (check, line) pair", () => {
		// Two above-markers resolve to the SAME target line; later reason wins.
		const code = [
			"// interlinked: defer eval_usage -- first",
			"// interlinked: defer eval_usage -- second",
			"run()",
		].join("\n");
		expect(scanInlineDeferrals(code).get(3)?.get("eval_usage")).toBe("second");
	});

	it("merges different checks when duplicate markers target one line", () => {
		const code = [
			"// interlinked: defer eval_usage -- first",
			"// interlinked: defer inner_html -- second",
			"run()",
		].join("\n");
		const entries = scanInlineDeferrals(code).get(3);
		expect(entries?.get("eval_usage")).toBe("first");
		expect(entries?.get("inner_html")).toBe("second");
	});

	it("trims trailing whitespace from a deferral reason", () => {
		const code = "// interlinked: defer eval_usage -- trusted input   \nrun()\n";
		expect(scanInlineDeferrals(code).get(2)?.get("eval_usage")).toBe("trusted input");
	});

	it("requires whitespace on both sides of a deferral reason separator", () => {
		const leftCompact = scanInlineDeferrals("// interlinked: defer foo--reason\nrun()\n");
		const rightCompact = scanInlineDeferrals("// interlinked: defer foo --reason\nrun()\n");
		expect([...leftCompact.get(2)?.keys() ?? []]).toEqual(["foo--reason"]);
		expect([...rightCompact.get(2)?.keys() ?? []]).toEqual(["foo --reason"]);
	});

	it("ignores a marker whose check list is empty (comma-only payload)", () => {
		// `recordDeferral` filters empty pieces; a comma-only capture → [] → return.
		const code = "// interlinked: defer , ,\nrun()\n";
		expect(scanInlineDeferrals(code).size).toBe(0);
	});
});

describe("scanInlineDeferrals — # shape (Python / Ruby / shell)", () => {
	it("recognises a Python defer marker above the offending line", () => {
		const code =
			"# interlinked: defer ubs_pickle_untrusted_load -- legacy trusted\nobj = pickle.load(f)\n";
		expect(scanInlineDeferrals(code).get(2)?.get("ubs_pickle_untrusted_load")).toBe(
			"legacy trusted",
		);
	});

	it("does not mistake a hash comment for code when finding the next line", () => {
		const code = "// interlinked: defer eval_usage\n# explanatory comment\nrun()\n";
		expect(scanInlineDeferrals(code).get(3)?.has("eval_usage")).toBe(true);
	});
});

describe("scanInlineDeferrals — trailing-comment marker", () => {
	it("attaches a trailing `// interlinked: defer` to the same line", () => {
		const code = "eval(x); // interlinked: defer eval_usage\n";
		expect(scanInlineDeferrals(code).get(1)?.has("eval_usage")).toBe(true);
	});

	it("attaches a trailing `# interlinked: defer` to the same line", () => {
		const code =
			"obj = pickle.load(f)  # interlinked: defer ubs_pickle_untrusted_load -- trusted\n";
		expect(scanInlineDeferrals(code).get(1)?.get("ubs_pickle_untrusted_load")).toBe("trusted");
	});

	it("accepts compact trailing marker spacing but rejects defer prefixes", () => {
		expect(
			scanInlineDeferrals("eval(x); //interlinked:defer eval_usage\n").get(1)?.has("eval_usage"),
		).toBe(true);
		expect(scanInlineDeferrals("eval(x); // interlinked: deferfoo\n").size).toBe(0);
	});

	it("does NOT treat a pure-comment line as a trailing marker (above-form takes over)", () => {
		const code = "// interlinked: defer eval_usage\nrun()\n";
		expect(scanInlineDeferrals(code).get(1)).toBeUndefined();
		expect(scanInlineDeferrals(code).get(2)?.has("eval_usage")).toBe(true);
	});

	it("ignores a non-comment line with no trailing defer marker", () => {
		expect(scanInlineDeferrals("const x = doThing()\n").size).toBe(0);
	});
});

describe("scanInlineDeferrals — negative cases", () => {
	it("ignores `interlinked-ignore` (the suppression marker, not defer)", () => {
		expect(scanInlineDeferrals("// interlinked-ignore: eval_usage\neval(x);\n").size).toBe(0);
	});

	it("ignores a marker missing the `defer` verb", () => {
		expect(scanInlineDeferrals("// interlinked: skip eval_usage\neval(x);\n").size).toBe(0);
	});

	it("returns an empty map for content with no markers", () => {
		expect(scanInlineDeferrals("const x = 1\n").size).toBe(0);
	});

	it("returns null reason when the marker has no `—` / `--` separator", () => {
		expect(scanInlineDeferrals("// interlinked: defer eval_usage\nrun()\n").get(2)?.get("eval_usage")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// isSuppressed — file-level + inline (±1 line tolerance)
// ---------------------------------------------------------------------------

describe("isSuppressed", () => {
	const emptyInline: InlineSuppressions = new Map();
	const emptyFile: FileSuppressions = new Set();

	it("is suppressed when the check is in the file-level set", () => {
		expect(isSuppressed("sql-injection", 10, emptyInline, new Set(["sql-injection"]))).toBe(true);
	});

	it("is suppressed on an exact inline-line match", () => {
		const inline: InlineSuppressions = new Map([[5, new Set(["foo"])]]);
		expect(isSuppressed("foo", 5, inline, emptyFile)).toBe(true);
	});

	it("is suppressed when the marker is one line above the finding (offset -1)", () => {
		const inline: InlineSuppressions = new Map([[4, new Set(["foo"])]]);
		expect(isSuppressed("foo", 5, inline, emptyFile)).toBe(true);
	});

	it("is suppressed when the marker is one line below the finding (offset +1)", () => {
		const inline: InlineSuppressions = new Map([[6, new Set(["foo"])]]);
		expect(isSuppressed("foo", 5, inline, emptyFile)).toBe(true);
	});

	it("is NOT suppressed when the marker is two lines away", () => {
		const inline: InlineSuppressions = new Map([[7, new Set(["foo"])]]);
		expect(isSuppressed("foo", 5, inline, emptyFile)).toBe(false);
	});

	it("is NOT suppressed for a different check id on the line", () => {
		const inline: InlineSuppressions = new Map([[5, new Set(["bar"])]]);
		expect(isSuppressed("foo", 5, inline, emptyFile)).toBe(false);
	});

	it("is NOT suppressed with no inline and no file suppressions", () => {
		expect(isSuppressed("foo", 5, emptyInline, emptyFile)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// parseSuppressionEntry — "file:check[:reason]"
// ---------------------------------------------------------------------------

describe("parseSuppressionEntry", () => {
	it("parses file:check with an empty reason", () => {
		expect(parseSuppressionEntry("src/a.ts:sql-injection")).toEqual({
			file: "src/a.ts",
			check: "sql-injection",
			reason: "",
		});
	});

	it("parses file:check:reason", () => {
		expect(parseSuppressionEntry("src/a.ts:foo:trusted input")).toEqual({
			file: "src/a.ts",
			check: "foo",
			reason: "trusted input",
		});
	});

	it("rejoins extra colons into the reason (reason containing a colon)", () => {
		expect(parseSuppressionEntry("a.ts:foo:see http://x")).toEqual({
			file: "a.ts",
			check: "foo",
			reason: "see http://x",
		});
	});

	it("trims surrounding whitespace from the reason", () => {
		expect(parseSuppressionEntry("a.ts:foo:  padded  ")?.reason).toBe("padded");
	});

	it("returns null when there are fewer than two colon-parts", () => {
		expect(parseSuppressionEntry("noColonHere")).toBeNull();
	});

	it("returns null when the file part is empty", () => {
		expect(parseSuppressionEntry(":foo")).toBeNull();
	});

	it("returns null when the check part is empty", () => {
		expect(parseSuppressionEntry("a.ts:")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// JSON-file load + glob matching + CLI add (real fs in a tmpdir)
// ---------------------------------------------------------------------------

describe("loadFileSuppressions / loadSuppressionFile / addSuppressions / glob", () => {
	let dir: string;
	const jsonPath = () => join(dir, "verify-suppressions.json");
	const write = (data: unknown) =>
		writeFileSync(jsonPath(), JSON.stringify(data, null, 2), "utf-8");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "suppressions-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("loadFileSuppressions", () => {
		it("returns an empty set when the file does not exist", () => {
			expect(loadFileSuppressions(dir, "src/a.ts").size).toBe(0);
		});

		it("returns checks for an exact file-path key", () => {
			write({ "src/a.ts": { "sql-injection": { reason: "x", by: "cli", at: "now" } } });
			const checks = loadFileSuppressions(dir, "src/a.ts");
			expect(checks.has("sql-injection")).toBe(true);
		});

		it("collects every check id under a matching key", () => {
			write({
				"src/a.ts": {
					"sql-injection": { reason: "x", by: "cli", at: "n" },
					"silent-catch": { reason: "y", by: "cli", at: "n" },
				},
			});
			const checks = loadFileSuppressions(dir, "src/a.ts");
			expect([...checks].sort()).toEqual(["silent-catch", "sql-injection"]);
		});

		it("does not match a different exact path", () => {
			write({ "src/a.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
			expect(loadFileSuppressions(dir, "src/b.ts").size).toBe(0);
		});

		it("matches a single-segment `*` glob", () => {
			write({ "src/*.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
			expect(loadFileSuppressions(dir, "src/a.ts").has("foo")).toBe(true);
			// `*` does not cross a path separator.
			expect(loadFileSuppressions(dir, "src/sub/a.ts").has("foo")).toBe(false);
		});

		it("matches a `**` glob across path segments", () => {
			write({ "src/**/a.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
			expect(loadFileSuppressions(dir, "src/deep/nested/a.ts").has("foo")).toBe(true);
		});

		it("matches a `?` single-character glob", () => {
			write({ "src/?.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
			expect(loadFileSuppressions(dir, "src/a.ts").has("foo")).toBe(true);
			expect(loadFileSuppressions(dir, "src/ab.ts").has("foo")).toBe(false);
		});

		it("escapes regex metacharacters in a glob (the `.` is literal)", () => {
			write({ "src/a.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
			// If `.` were treated as regex-any, "srcXats" would match — assert it does not.
			expect(loadFileSuppressions(dir, "srcXats").has("foo")).toBe(false);
			// And a glob with a literal `+` only matches the literal text.
			write({ "a+b.ts": { bar: { reason: "x", by: "cli", at: "n" } } });
			expect(loadFileSuppressions(dir, "a+b.ts").has("bar")).toBe(true);
			expect(loadFileSuppressions(dir, "aXb.ts").has("bar")).toBe(false);
		});

		it("matches a `**/` prefix glob (trailing-slash skip branch)", () => {
			write({ "**/a.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
			expect(loadFileSuppressions(dir, "deep/path/a.ts").has("foo")).toBe(true);
			expect(loadFileSuppressions(dir, "a.ts").has("foo")).toBe(true);
		});

		it("normalizes Windows separators in glob patterns and paths", () => {
			write({ "src\\*.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
			expect(loadFileSuppressions(dir, "src\\a.ts").has("foo")).toBe(true);
			expect(loadFileSuppressions(dir, "other\\a.ts").has("foo")).toBe(false);
		});

		it("keeps glob matches anchored and escapes regex anchors", () => {
			write({ "src/$a.ts": { foo: { reason: "x", by: "cli", at: "n" } } });
			expect(loadFileSuppressions(dir, "src/$a.ts").has("foo")).toBe(true);
			expect(loadFileSuppressions(dir, "prefix/src/$a.ts").has("foo")).toBe(false);
			expect(loadFileSuppressions(dir, "src/$a.ts/extra").has("foo")).toBe(false);
		});

		it("skips a falsy entry value for a key", () => {
			write({ "src/a.ts": null });
			expect(loadFileSuppressions(dir, "src/a.ts").size).toBe(0);
		});

		it("returns an empty set on invalid JSON (parse error caught)", () => {
			writeFileSync(jsonPath(), "{ not valid json", "utf-8");
			expect(loadFileSuppressions(dir, "src/a.ts").size).toBe(0);
		});

		it("re-parses when the file mtime changes (cache miss then hit)", () => {
			write({ "src/a.ts": { first: { reason: "x", by: "cli", at: "n" } } });
			expect(loadFileSuppressions(dir, "src/a.ts").has("first")).toBe(true);
			// Second call (same mtime) hits the cache and returns the same data.
			expect(loadFileSuppressions(dir, "src/a.ts").has("first")).toBe(true);
			// Rewrite with a strictly newer mtime → cache miss → fresh parse.
			write({ "src/a.ts": { second: { reason: "x", by: "cli", at: "n" } } });
			const future = Date.now() / 1000 + 5;
			utimesSync(jsonPath(), future, future);
			const checks = loadFileSuppressions(dir, "src/a.ts");
			expect(checks.has("second")).toBe(true);
			expect(checks.has("first")).toBe(false);
		});

		it("does not reuse cached data from a different suppression-file path", () => {
			const otherDir = mkdtempSync(join(tmpdir(), "suppressions-other-"));
			try {
				write({ "src/a.ts": { first: { reason: "x", by: "cli", at: "n" } } });
				const otherPath = join(otherDir, "verify-suppressions.json");
				writeFileSync(
					otherPath,
					JSON.stringify({ "src/a.ts": { second: { reason: "x", by: "cli", at: "n" } } }),
					"utf-8",
				);
				const sameTime = Date.now() / 1000 + 10;
				utimesSync(jsonPath(), sameTime, sameTime);
				utimesSync(otherPath, sameTime, sameTime);
				expect(loadFileSuppressions(dir, "src/a.ts").has("first")).toBe(true);
				expect(loadFileSuppressions(otherDir, "src/a.ts").has("second")).toBe(true);
				expect(loadFileSuppressions(otherDir, "src/a.ts").has("first")).toBe(false);
			} finally {
				rmSync(otherDir, { recursive: true, force: true });
			}
		});

		it("reports no match when the glob's compiled regex is rejected by the regex engine", () => {
			const width = 40_000;
			const target = "a".repeat(width);
			write({
				[`${"?".repeat(width)}`]: { toobig: { reason: "x", by: "cli", at: "n" } },
				[target]: { exact: { reason: "x", by: "cli", at: "n" } },
			});
			const checks = loadFileSuppressions(dir, target);
			// `^[^/]…[^/]$` at this width WOULD match a 40k-char slash-free path
			// if the regex engine accepted it; irregexp instead rejects it at
			// `.test()` time ("Regular expression too large"), so the catch at
			// line 301 must answer false — the only way `toobig` stays absent.
			expect(checks.has("toobig")).toBe(false);
			// The co-located exact-match key must still come back, proving the
			// throw was caught locally and did not escape to the outer catch
			// (which would have dropped `exact` too).
			expect(checks.has("exact")).toBe(true);
		});
	});

	describe("loadSuppressionFile", () => {
		it("returns {} when the file does not exist", () => {
			expect(loadSuppressionFile(dir)).toEqual({});
		});

		it("returns the full parsed object", () => {
			const data = { "src/a.ts": { foo: { reason: "r", by: "cli", at: "t" } } };
			write(data);
			expect(loadSuppressionFile(dir)).toEqual(data);
		});

		it("returns {} on invalid JSON (parse error caught)", () => {
			writeFileSync(jsonPath(), "}}}not json", "utf-8");
			expect(loadSuppressionFile(dir)).toEqual({});
		});

		it.each([null, [], 42])("ignores non-object suppression documents: %j", (value) => {
			writeFileSync(jsonPath(), JSON.stringify(value), "utf8");
			expect(loadSuppressionFile(dir)).toEqual({});
		});
	});

	describe("addSuppressions", () => {
		it("creates a fresh file and records entries with default reason", () => {
			const added = addSuppressions(dir, [{ file: "src/a.ts", check: "foo", reason: "" }]);
			expect(added).toEqual([{ file: "src/a.ts", check: "foo", reason: "" }]);
			const written = JSON.parse(readFileSync(jsonPath(), "utf-8"));
			expect(written["src/a.ts"].foo.reason).toBe("suppressed via CLI");
			expect(written["src/a.ts"].foo.by).toBe("cli");
			expect(typeof written["src/a.ts"].foo.at).toBe("string");
		});

		it("uses the provided reason when non-empty", () => {
			addSuppressions(dir, [{ file: "src/a.ts", check: "foo", reason: "trusted" }]);
			const written = JSON.parse(readFileSync(jsonPath(), "utf-8"));
			expect(written["src/a.ts"].foo.reason).toBe("trusted");
		});

		it("round-trips non-ASCII suppression metadata as UTF-8", () => {
			addSuppressions(dir, [{ file: "src/a.ts", check: "foo", reason: "confié — café" }]);
			const written = JSON.parse(readFileSync(jsonPath(), "utf-8"));
			expect(written["src/a.ts"].foo.reason).toBe("confié — café");
		});

		it("merges into an existing file and skips already-present checks", () => {
			write({ "src/a.ts": { foo: { reason: "old", by: "human", at: "earlier" } } });
			const added = addSuppressions(dir, [
				{ file: "src/a.ts", check: "foo", reason: "dup" }, // already present → skipped
				{ file: "src/a.ts", check: "bar", reason: "new" }, // added
			]);
			expect(added).toEqual([{ file: "src/a.ts", check: "bar", reason: "new" }]);
			const written = JSON.parse(readFileSync(jsonPath(), "utf-8"));
			// Existing entry untouched.
			expect(written["src/a.ts"].foo.reason).toBe("old");
			expect(written["src/a.ts"].bar.reason).toBe("new");
		});

		it("recovers from a corrupt existing file by starting fresh", () => {
			writeFileSync(jsonPath(), "not json at all", "utf-8");
			const added = addSuppressions(dir, [{ file: "src/a.ts", check: "foo", reason: "r" }]);
			expect(added).toHaveLength(1);
			const written = JSON.parse(readFileSync(jsonPath(), "utf-8"));
			expect(written["src/a.ts"].foo.reason).toBe("r");
		});

		it("creates the interlinked directory when it is missing", () => {
			const nested = join(dir, "deep", "nested", ".interlinked");
			const added = addSuppressions(nested, [{ file: "src/a.ts", check: "foo", reason: "r" }]);
			expect(added).toHaveLength(1);
			const written = JSON.parse(
				readFileSync(join(nested, "verify-suppressions.json"), "utf-8"),
			);
			expect(written["src/a.ts"].foo.reason).toBe("r");
		});

		it("appends a trailing newline to the written file", () => {
			addSuppressions(dir, [{ file: "src/a.ts", check: "foo", reason: "r" }]);
			expect(readFileSync(jsonPath(), "utf-8").endsWith("}\n")).toBe(true);
		});

		it("round-trips with loadFileSuppressions", () => {
			addSuppressions(dir, [{ file: "src/a.ts", check: "foo", reason: "r" }]);
			expect(loadFileSuppressions(dir, "src/a.ts").has("foo")).toBe(true);
		});
	});
});
