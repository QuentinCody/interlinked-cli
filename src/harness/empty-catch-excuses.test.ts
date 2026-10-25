// Unit tests for the empty_catch excuse rules. The behavior suite with the
// real foreign snippets is src/harness/__tests__/adversarial/empty_catch.foreign.test.ts.
import { describe, expect, it } from "vitest";
import {
	type EmptyCatchSite,
	emptyCatchExcuse,
	isRationale,
	statementAfterTry,
	tryBlockBefore,
} from "./empty-catch-excuses.js";
import { stripAllLiterals } from "./strip-helpers.js";

/** Builds the site of the first catch CLAUSE (`} catch`) in `content`. */
function siteOf(content: string, filePath = "src/x.ts"): EmptyCatchSite {
	const scan = stripAllLiterals(content);
	const at = scan.indexOf("catch", scan.search(/\}\s*catch\b/));
	const block = tryBlockBefore(scan, at);
	if (!block) throw new Error("fixture has no try block before its catch");
	const bodyOpen = scan.indexOf("{", at);
	const bodyClose = scan.indexOf("}", bodyOpen);
	return {
		content,
		scan,
		filePath,
		tryOpen: block.open,
		tryClose: block.close,
		catchEnd: bodyClose + 1,
		body: content.slice(bodyOpen + 1, bodyClose),
	};
}

describe("isRationale — positive (must fire)", () => {
	it("P1: a sentence that names the failure and a condition", () => {
		expect(isRationale("// Use default message if accessing properties throws")).toBe(true);
	});

	it("P2: the narrow marker vocabulary on its own", () => {
		expect(isRationale("/* non-critical: cache warmup */")).toBe(true);
	});
});

describe("isRationale — negative (must not fire)", () => {
	it("N1: a short tag is not a rationale", () => {
		expect(isRationale("// ENOENT: already gone")).toBe(false);
		expect(isRationale("// Ignore the error")).toBe(false);
	});

	it("N2: a TODO with failure and condition words is a deferral", () => {
		expect(isRationale("// TODO: handle the error properly if the write fails here")).toBe(false);
	});

	it("N3: an interlinked-ignore directive is removed before the marker test", () => {
		expect(isRationale("// interlinked-ignore: empty_catch — best-effort cleanup")).toBe(false);
	});
});

describe("tryBlockBefore / statementAfterTry — positive (must fire)", () => {
	it("P1: finds the try block and the return after an enclosing if block", () => {
		const content = "if (c) {\n\ttry {\n\t\treturn a();\n\t} catch {}\n}\nreturn b();\n";
		const site = siteOf(content);
		expect(content.slice(site.tryOpen, site.tryClose + 1)).toBe("{\n\t\treturn a();\n\t}");
		expect(content.slice(statementAfterTry(site.scan, site.catchEnd))).toBe("return b();\n");
	});

	it("P2: skips a finally block", () => {
		const site = siteOf("try {\n\ta();\n} catch {} finally {\n\tb();\n}\nc();\n");
		expect(site.content.slice(statementAfterTry(site.scan, site.catchEnd))).toBe("c();\n");
	});
});

describe("tryBlockBefore / statementAfterTry — negative (must not fire)", () => {
	it("N1: a method named catch follows no try block", () => {
		const scan = "class P {\n\tcatch(onRejected) {}\n}\n";
		expect(tryBlockBefore(scan, scan.indexOf("catch"))).toBeNull();
	});

	it("N2: the end of a function body is not a following statement", () => {
		const site = siteOf("function f() {\n\ttry {\n\t\ta();\n\t} catch {}\n}\nother();\n");
		expect(statementAfterTry(site.scan, site.catchEnd)).toBe(-1);
	});

	it("N3: an else branch after the enclosing if gives no single next statement", () => {
		const site = siteOf("if (c) {\n\ttry {\n\t\treturn a();\n\t} catch {}\n} else {\n\tb();\n}\n");
		expect(statementAfterTry(site.scan, site.catchEnd)).toBe(-1);
	});
});

describe("emptyCatchExcuse — positive (must fire)", () => {
	it("P1: names each excuse", () => {
		expect(emptyCatchExcuse(siteOf("let x;\ntry {\n\tx = probe();\n} catch {}\nif (!x) return;\n"))).toBe(
			"fallback-guard",
		);
		expect(emptyCatchExcuse(siteOf("try {\n\treturn a();\n} catch {}\nreturn b();\n"))).toBe("default-return");
		expect(emptyCatchExcuse(siteOf("try {\n\tp.catch(noop);\n} catch {}\n"))).toBe("rejection-silencer");
		expect(emptyCatchExcuse(siteOf("try {\n\tf();\n} catch {}\nexpect(spy).toBeCalled();\n", "src/f.test.ts"))).toBe(
			"assertion-after-try",
		);
		expect(emptyCatchExcuse(siteOf('suite.add("x", () => {\n\ttry {\n\t\tp(null);\n\t} catch {}\n});\n', "bench/p.ts"))).toBe(
			"benchmark-throw-case",
		);
	});

	it("P3: a member-path assignment tested by the next statement (zod v4 schemas.ts:407 string coercion)", () => {
		const code =
			"if (def.coerce)\n\ttry {\n\t\tpayload.value = String(payload.value);\n\t} catch (_) {}\n\nif (typeof payload.value === \"string\") return payload;\n";
		expect(emptyCatchExcuse(siteOf(code))).toBe("fallback-guard");
	});

	it("P2: a `x ?? fallback` use counts as a guard", () => {
		expect(emptyCatchExcuse(siteOf("let x;\ntry {\n\tx = probe();\n} catch {}\nuse(x ?? DEFAULT);\n"))).toBe(
			"fallback-guard",
		);
	});
});

describe("emptyCatchExcuse — negative (must not fire)", () => {
	it("N1: a swallowed call with no handling after it", () => {
		expect(emptyCatchExcuse(siteOf("try {\n\tsave();\n} catch {}\nreply();\n"))).toBeNull();
	});

	it("N3: a member-path assignment read with no guard (zod v4 schemas.ts:1804 date coercion)", () => {
		const code =
			"if (def.coerce) {\n\ttry {\n\t\tpayload.value = new Date(payload.value);\n\t} catch (_err: any) {}\n}\nconst input = payload.value;\n";
		expect(emptyCatchExcuse(siteOf(code))).toBeNull();
	});

	it("N2: a variable declared inside the try is not an assigned probe value", () => {
		expect(emptyCatchExcuse(siteOf("try {\n\tconst x = probe();\n} catch {}\nif (!x) return;\n"))).toBeNull();
	});
});
