import { nonNull } from "../../lib/non-null.js";
import { describe, expect, it } from "vitest";
import {
	checkAesEcbMode,
	checkRecursiveWalkerLstat,
	checkTlsVerifyDisabled,
	checkWeakHash,
	checkWeakRandom,
} from "./agent-safety-crypto.js";

// Smoke-test coverage for the agent-safety crypto / TLS / filesystem-safety
// check family. Deeper coverage lives in `src/harness/__tests__/`
// (`ubs-weak-hash.test.ts`, `ubs-tls-verify-disabled.test.ts`) and
// `__fixtures__/weak-hash.fixtures.test.ts` — this file satisfies the
// harness's per-source-file test rule and guards the shape of the exports.

describe("checkAesEcbMode", () => {
	it("flags AES.MODE_ECB in Python", () => {
		expect(checkAesEcbMode("c = AES.new(k, AES.MODE_ECB)", "a.py").length).toBeGreaterThan(0);
	});

	it("does NOT fire on AES-GCM strings", () => {
		expect(checkAesEcbMode('createCipheriv("aes-256-gcm", k, iv)', "a.ts")).toEqual([]);
	});

	it("does NOT run on test files", () => {
		expect(checkAesEcbMode("c = AES.new(k, AES.MODE_ECB)", "a.test.ts")).toEqual([]);
	});

	it("flags the Node algorithm-string form on its own (stringRe, not codeRe)", () => {
		const out = checkAesEcbMode('createCipheriv("aes-128-ecb", k, iv)', "a.ts");
		expect(out).toHaveLength(1);
	});

	it("caps at 10 matches even when more than 10 lines fire (matches.length >= 10 break)", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `c${i} = AES.new(k, AES.MODE_ECB)`);
		const out = checkAesEcbMode(lines.join("\n"), "a.py");
		expect(out).toHaveLength(10);
	});

	it("pins the exact 1-indexed line, trimmed text, and 150-char slice cap on a non-first-line match", () => {
		const filler1 = "x = 1";
		const raw = "   c = AES.new(k, AES.MODE_ECB)" + "z".repeat(200) + "   ";
		const filler2 = "y = 2";
		const content = [filler1, raw, filler2].join("\n");
		const out = checkAesEcbMode(content, "a.py");
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(2);
		expect(out[0]?.text).toBe(raw.trim().slice(0, 150));
		expect(out[0]?.text).toHaveLength(150);
	});

	it("pins the exact line for the Node algorithm-string form on a non-first line", () => {
		const content = ["x = 1", 'createCipheriv("aes-128-ecb", k, iv)', "y = 2"].join("\n");
		const out = checkAesEcbMode(content, "a.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(2);
	});

	it("flags modes.ECB( with no space before the paren (kills the \\s*->\\s bare-quantifier mutant)", () => {
		expect(checkAesEcbMode("cipher = modes.ECB(iv)", "a.py")).toHaveLength(1);
	});

	it("flags modes.ECB ( with a space before the paren (kills the \\s*->\\S* mutant)", () => {
		expect(checkAesEcbMode("cipher = modes.ECB (iv)", "a.py")).toHaveLength(1);
	});
});

describe("checkTlsVerifyDisabled", () => {
	it("flags Python verify=False", () => {
		expect(checkTlsVerifyDisabled("requests.get(url, verify=False)", "a.py").length).toBeGreaterThan(
			0,
		);
	});

	it("flags Node rejectUnauthorized: false", () => {
		const out = checkTlsVerifyDisabled("https.request({ rejectUnauthorized: false })", "a.ts");
		expect(out.length).toBeGreaterThan(0);
	});

	it("flags the NODE_TLS_REJECT_UNAUTHORIZED=0 env-var form on its own (envRe, not codeRe)", () => {
		const out = checkTlsVerifyDisabled('process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";', "a.ts");
		expect(out).toHaveLength(1);
	});

	it("does NOT fire on the shape inside a string literal", () => {
		const out = checkTlsVerifyDisabled('const msg = "verify=False is unsafe";', "a.ts");
		expect(out).toEqual([]);
	});

	it("caps at 10 matches even when more than 10 lines fire (matches.length >= 10 break)", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `req${i}(url, verify=False)`);
		const out = checkTlsVerifyDisabled(lines.join("\n"), "a.py");
		expect(out).toHaveLength(10);
	});

	it("pins the exact 1-indexed line, trimmed text, and 150-char slice cap on a non-first-line match", () => {
		const filler1 = "x = 1";
		const raw = "   requests.get(url, verify=False)" + "z".repeat(200) + "   ";
		const filler2 = "y = 2";
		const content = [filler1, raw, filler2].join("\n");
		const out = checkTlsVerifyDisabled(content, "a.py");
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(2);
		expect(out[0]?.text).toBe(raw.trim().slice(0, 150));
		expect(out[0]?.text).toHaveLength(150);
	});

	it("flags 'verify = False' with spaces both sides (kills both verify\\S* quantifier mutants)", () => {
		expect(checkTlsVerifyDisabled("requests.get(url, verify = False)", "a.py")).toHaveLength(1);
	});

	it("flags InsecureSkipVerify:true with no spaces (kills the two bare-\\s InsecureSkipVerify mutants)", () => {
		expect(checkTlsVerifyDisabled("tls.Config{InsecureSkipVerify:true}", "a.go")).toHaveLength(1);
	});

	it("flags InsecureSkipVerify : true with spaces both sides (kills the two \\S* InsecureSkipVerify mutants)", () => {
		expect(checkTlsVerifyDisabled("tls.Config{InsecureSkipVerify : true}", "a.go")).toHaveLength(1);
	});

	it("flags rejectUnauthorized:false with no space (kills the bare-\\s rejectUnauthorized mutant)", () => {
		expect(checkTlsVerifyDisabled("https.request({rejectUnauthorized:false})", "a.ts")).toHaveLength(1);
	});

	it("flags rejectUnauthorized : false with a space before ':' (kills the \\S* rejectUnauthorized mutant)", () => {
		expect(checkTlsVerifyDisabled("https.request({rejectUnauthorized : false})", "a.ts")).toHaveLength(1);
	});

	it("flags check_hostname=False with no spaces (kills the two bare-\\s check_hostname mutants)", () => {
		expect(checkTlsVerifyDisabled("ctx.check_hostname=False", "a.py")).toHaveLength(1);
	});

	it("flags check_hostname = False with spaces both sides (kills the two \\S* check_hostname mutants)", () => {
		expect(checkTlsVerifyDisabled("ctx.check_hostname = False", "a.py")).toHaveLength(1);
	});

	it("flags a zero-gap NODE_TLS_REJECT_UNAUTHORIZED=\"0\" (kills the exact-1-char-gap and bare-\\s env mutants)", () => {
		expect(checkTlsVerifyDisabled('NODE_TLS_REJECT_UNAUTHORIZED="0"', "a.ts")).toHaveLength(1);
	});

	it("flags NODE_TLS_REJECT_UNAUTHORIZED with non-whitespace filler before '=' (kills the [\\s\\S]->[\\s\\s] mutant)", () => {
		expect(checkTlsVerifyDisabled('NODE_TLS_REJECT_UNAUTHORIZED,,="0"', "a.ts")).toHaveLength(1);
	});

	it("flags NODE_TLS_REJECT_UNAUTHORIZED=0 with an unquoted zero (kills the quote-required mutant)", () => {
		expect(checkTlsVerifyDisabled("NODE_TLS_REJECT_UNAUTHORIZED=0", "a.ts")).toHaveLength(1);
	});
});

describe("checkWeakHash", () => {
	it("flags hashlib.md5(...)", () => {
		expect(checkWeakHash("h = hashlib.md5(data)", "a.py").length).toBeGreaterThan(0);
	});

	it("flags Node createHash(\"sha1\")", () => {
		expect(checkWeakHash('crypto.createHash("sha1")', "a.ts").length).toBeGreaterThan(0);
	});

	it("does NOT run on test files", () => {
		expect(checkWeakHash("h = hashlib.md5(data)", "a.test.ts")).toEqual([]);
	});

	it("does NOT fire on code with no md5/sha1 anywhere", () => {
		expect(checkWeakHash("h = hashlib.sha256(data)", "a.py")).toEqual([]);
	});

	it("caps at 10 matches even when more than 10 lines fire (matches.length >= 10 break)", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `h${i} = hashlib.md5(data)`);
		const out = checkWeakHash(lines.join("\n"), "a.py");
		expect(out).toHaveLength(10);
	});

	it("pins the exact 1-indexed line, trimmed text, and 150-char slice cap on a non-first-line match", () => {
		const filler1 = "x = 1";
		const raw = "   h = hashlib.md5(data)" + "z".repeat(200) + "   ";
		const filler2 = "y = 2";
		const content = [filler1, raw, filler2].join("\n");
		const out = checkWeakHash(content, "a.py");
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(2);
		expect(out[0]?.text).toBe(raw.trim().slice(0, 150));
		expect(out[0]?.text).toHaveLength(150);
	});

	it("flags hashlib.md5 ( with a space before the paren (kills the direct-form \\s*->\\S* mutant)", () => {
		expect(checkWeakHash("hashlib.md5 (data)", "a.py")).toHaveLength(1);
	});

	it("flags createHash (\"md5\") with a space before the paren (kills the first createHash \\s*->\\S* mutant)", () => {
		expect(checkWeakHash('crypto.createHash ("md5")', "a.ts")).toHaveLength(1);
	});

	it("flags createHash( \"md5\") with a space after the paren (kills the second createHash \\s*->\\S* mutant)", () => {
		expect(checkWeakHash('crypto.createHash( "md5")', "a.ts")).toHaveLength(1);
	});
});

describe("checkRecursiveWalkerLstat", () => {
	const recursiveWalkerStatSync = [
		'import { readdirSync, statSync } from "node:fs";',
		"function walk(dir) {",
		"  for (const e of readdirSync(dir)) {",
		"    const p = dir + '/' + e;",
		"    const st = statSync(p);",
		"    if (st.isDirectory()) walk(p);",
		"  }",
		"}",
	].join("\n");

	it("flags a self-recursive walker that uses statSync to gate dir-recursion", () => {
		const out = checkRecursiveWalkerLstat(recursiveWalkerStatSync, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag the same walker once it switches to lstatSync", () => {
		const safe = recursiveWalkerStatSync.replace(/statSync/g, "lstatSync");
		const out = checkRecursiveWalkerLstat(safe, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("flags a class-method walker that recurses via this.<name>(...)", () => {
		const src = [
			'import { readdirSync, statSync } from "node:fs";',
			"class Walker {",
			"  walk(dir) {",
			"    for (const e of readdirSync(dir)) {",
			"      const p = dir + '/' + e;",
			"      if (statSync(p).isDirectory()) this.walk(p);",
			"    }",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT recognize a method-shaped line preceded by stray non-whitespace text as a class-method declaration (kills the declRe3 ^-anchor-removal mutant)", () => {
		const src = [
			"xx  walk(dir) {",
			"    for (const e of readdirSync(dir)) {",
			"      if (statSync(e).isDirectory()) walk(e);",
			"    }",
			"  }",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("does NOT recognize a method-shaped line followed by stray non-whitespace text on the same line as a class-method declaration (kills the declRe3 $-anchor-removal mutant)", () => {
		const src = [
			"  walk(dir) {x",
			"    for (const e of readdirSync(dir)) {",
			"      if (statSync(e).isDirectory()) walk(e);",
			"    }",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("recognizes a class-method walker with two spaces after the `public` modifier (kills the declRe3 modifier \\s+->\\s single-char mutant)", () => {
		const src = [
			"  public  walk(dir) {",
			"    for (const e of readdirSync(dir)) {",
			"      if (statSync(e).isDirectory()) walk(e);",
			"    }",
			"  }",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("recognizes a class-method walker with one space after the `public` modifier (kills the declRe3 modifier \\s+->\\S+ mutant)", () => {
		const src = [
			"  public walk(dir) {",
			"    for (const e of readdirSync(dir)) {",
			"      if (statSync(e).isDirectory()) walk(e);",
			"    }",
			"  }",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("recognizes a class-method walker with a space between the method name and its parameter-list paren (kills the declRe3 name\\s*(->name\\S*( mutant)", () => {
		const src = [
			"  walk (dir) {",
			"    for (const e of readdirSync(dir)) {",
			"      if (statSync(e).isDirectory()) walk(e);",
			"    }",
			"  }",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag a non-recursive function that uses readdirSync + statSync", () => {
		const src = [
			'import { readdirSync, statSync } from "node:fs";',
			"function listOne(dir) {",
			"  return readdirSync(dir).filter((e) => statSync(dir + '/' + e).isFile());",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag a recursive function that doesn't read directories", () => {
		const src = [
			"function recurse(n) {",
			"  if (n <= 0) return;",
			"  recurse(n - 1);",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/x.ts");
		expect(out).toEqual([]);
	});

	it("does NOT run on test files", () => {
		const out = checkRecursiveWalkerLstat(recursiveWalkerStatSync, "src/walker.test.ts");
		expect(out).toEqual([]);
	});

	it("does NOT run on non-JS/TS files", () => {
		const out = checkRecursiveWalkerLstat(recursiveWalkerStatSync, "src/walker.py");
		expect(out).toEqual([]);
	});

	it("does NOT flag a file that calls statSync but never readdirSync (early-return content guard)", () => {
		const src = ["function walk(dir) {", "  walk(dir);", "  statSync(dir);", "}"].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag a brace-less arrow declaration (declRe2 match, no `{` anywhere -> unterminated body)", () => {
		// Matches the `const name = (...)` declRe2 shape but has an expression
		// body with no block `{`, so findWalkerBodyOpen scans to EOF and
		// returns -1.
		const src = "const walk = (dir) => readdirSync(dir) && statSync(dir);";
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag a declaration whose body brace is never closed (unbalanced braces)", () => {
		const src = ["function walk(dir) {", "  readdirSync(dir);", "  statSync(dir);"].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag a self-recursive, statSync-using function whose body never calls readdirSync", () => {
		// readdirSync appears elsewhere in the file (satisfies the file-level
		// guard) but not inside this function's own body.
		const src = [
			'readdirSync(".");',
			"function walk(dir) {",
			"  walk(dir);",
			"  statSync(dir);",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag a walker whose body calls both statSync and lstatSync (already symlink-aware)", () => {
		const src = [
			"function walk(dir) {",
			"  for (const e of readdirSync(dir)) {",
			"    if (lstatSync(e).isSymbolicLink()) continue;",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag a self-recursive readdirSync walker whose body never calls statSync", () => {
		const src = [
			"function walk(dir) {",
			"  readdirSync(dir).forEach((e) => walk(e));",
			"}",
			"statSync(dir);",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("caps at 10 matches even when more than 10 walkers fire (matches.length >= 10 break)", () => {
		const fns = Array.from(
			{ length: 12 },
			(_, i) =>
				`function walk${i}(dir) {\n  for (const e of readdirSync(dir)) {\n    if (statSync(dir + e).isDirectory()) walk${i}(dir + e);\n  }\n}`,
		);
		const out = checkRecursiveWalkerLstat(fns.join("\n"), "src/walker.ts");
		expect(out).toHaveLength(10);
	});

	it("pins the exact 1-indexed line, trimmed text, and 150-char slice cap for the statSync call", () => {
		const src = [
			'import { readdirSync, statSync } from "node:fs";',
			"function walk(dir) {",
			"  for (const e of readdirSync(dir)) {",
			"    const p = dir + '/' + e;",
			"    const st =    statSync(p)" + "z".repeat(200) + "    ;   ",
			"    if (st.isDirectory()) walk(p);",
			"  }",
			"}",
		];
		const matchLine = nonNull(src[4]);
		const out = checkRecursiveWalkerLstat(src.join("\n"), "src/walker.ts");
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(5);
		expect(out[0]?.text).toBe(matchLine.trim().slice(0, 150));
		expect(out[0]?.text).toHaveLength(150);
	});

	it("flags a walker declared with two spaces after `function` (kills the declRe1 \\s+->\\s single-char mutant)", () => {
		const src = [
			"function  walk(dir) {",
			"  for (const e of readdirSync(dir)) {",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags a walker declared with a space between the name and the parameter-list paren (kills the declRe1 trailing \\s*(->\\S*( mutant)", () => {
		const src = [
			"function walk (dir) {",
			"  for (const e of readdirSync(dir)) {",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags a recursive walker declared as `const walk = (dir) => { ... }` (declRe2/m2 branch)", () => {
		const src = [
			'import { readdirSync, statSync } from "node:fs";',
			"const walk = (dir) => {",
			"  for (const e of readdirSync(dir)) {",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"};",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags an arrow walker declared with two spaces after `const` (kills the declRe2 first \\s+->\\s single-char mutant)", () => {
		const src = [
			"const  walk = (dir) => {",
			"  for (const e of readdirSync(dir)) {",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"};",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags an arrow walker declared with zero incidental whitespace around the `=` (kills 2 \\s*->\\s single-char-required mutants on declRe2)", () => {
		const src = [
			"const walk=(dir)=>{",
			"  for (const e of readdirSync(dir)) {",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"};",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags an arrow walker declared with two spaces after `async` (kills the declRe2 async\\s+->async\\s single-char mutant)", () => {
		const src = [
			"const walk = async  (dir) => {",
			"  for (const e of readdirSync(dir)) {",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"};",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags an arrow walker declared with one space after `async` (kills the declRe2 async\\s+->async\\S+ mutant)", () => {
		const src = [
			"const walk = async (dir) => {",
			"  for (const e of readdirSync(dir)) {",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"};",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("still detects readdirSync with a space before its paren (kills the readdirSync \\s*->\\S* mutants)", () => {
		const src = [
			"function walk(dir) {",
			"  for (const e of readdirSync (dir)) {",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("still detects statSync with a space before its paren (kills the statSync \\s*->\\S* mutants)", () => {
		const src = [
			"function walk(dir) {",
			"  for (const e of readdirSync(dir)) {",
			"    if (statSync (e).isDirectory()) walk(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag a walker whose lstatSync call has a space before its paren (kills the lstatSync \\s*->\\S* mutant)", () => {
		const src = [
			"function walk(dir) {",
			"  for (const e of readdirSync(dir)) {",
			"    if (lstatSync (e).isSymbolicLink()) continue;",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("locates the function's own opening brace even when it sits at column index 1 of its line, not just column 0 (kills the idx!==-1 -> idx!==1 unary-literal-flip and the always-return ConditionalExpression mutants in findWalkerBodyOpen)", () => {
		const src = [
			"function walk(dir)",
			" {",
			"  for (const e of readdirSync(dir)) {",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does not fabricate a walker body for a declaration whose own opening brace is never found (kills the return -1 -> return 1 unary-literal-flip mutant in findWalkerBodyOpen)", () => {
		const src = " { readdirSync(d); walk(d); statSync(d); }\nfunction walk(dir)";
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});

	it("finds the TRUE matching close brace (depth back to zero), not just the first `}` encountered, when the body contains a nested block before the real content (kills the depth===0 -> always-true / depth!==0 mutants in findWalkerBodyClose)", () => {
		const src = [
			"function walk(dir) {",
			"  if (true) {",
			"  }",
			"  for (const e of readdirSync(dir)) {",
			"    if (statSync(e).isDirectory()) walk(e);",
			"  }",
			"}",
		].join("\n");
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does not fabricate a body for an unbalanced (never-closed) declaration even when the trailing content would otherwise look like a real recursive walker (kills the bodyClose<0 guard-disabled ConditionalExpression mutant)", () => {
		const src = "function walk(dir) {\n  readdirSync(dir);\n  walk(dir);\n  statSync(dir);";
		const out = checkRecursiveWalkerLstat(src, "src/walker.ts");
		expect(out).toEqual([]);
	});
});

describe("checkWeakRandom (ubs_weak_random_security) — Python scope", () => {
	it("fires on Python random.<fn> generating a security value (camelCase/snake aware)", () => {
		expect(checkWeakRandom("otp = random.randint(100000, 999999)  # user otp", "src/a.py")).toHaveLength(1);
		expect(checkWeakRandom("password = ''.join(random.choice(alphabet) for _ in range(16))", "src/a.py")).toHaveLength(1);
		expect(checkWeakRandom("resetToken = random.random()", "src/a.py")).toHaveLength(1);
	});

	it("does NOT fire on non-security random (sampling, indices)", () => {
		expect(checkWeakRandom("idx = random.randint(0, len(items) - 1)", "src/a.py")).toEqual([]);
		expect(checkWeakRandom("pick = random.choice(variants)  # a/b bucketing", "src/a.py")).toEqual([]);
	});

	it("does NOT fire on SECURE Python forms even in a security context", () => {
		expect(checkWeakRandom("secret = secrets.token_hex(16)", "src/a.py")).toEqual([]);
		expect(checkWeakRandom("nonce = random.SystemRandom().randint(0, 1_000_000)", "src/a.py")).toEqual([]);
	});

	it("does NOT run on JS/TS — the A3 content-quality write-guard owns Math.random()", () => {
		expect(checkWeakRandom("const resetToken = Math.random().toString(36).slice(2);", "src/a.ts")).toEqual([]);
		expect(checkWeakRandom("const nonce = Math.random();", "src/a.js")).toEqual([]);
	});

	it("does NOT fire inside test files or comments/strings", () => {
		expect(checkWeakRandom("token = random.random()", "tests/test_a.py")).toEqual([]);
		expect(checkWeakRandom("# legacy: token = random.random() was unsafe", "src/a.py")).toEqual([]);
		expect(checkWeakRandom('doc = "use random.random for the token"', "src/a.py")).toEqual([]);
	});

	it("does NOT fire when the line has no random.* call at all", () => {
		expect(checkWeakRandom("token = secrets.token_hex(16)", "src/a.py")).toEqual([]);
	});

	it("caps at 10 matches even when more than 10 lines fire (matches.length >= 10 break)", () => {
		const lines = Array.from(
			{ length: 12 },
			(_, i) => `secretToken${i} = random.random()`,
		);
		const out = checkWeakRandom(lines.join("\n"), "src/a.py");
		expect(out).toHaveLength(10);
	});

	it("pins the exact 1-indexed line, trimmed text, and 150-char slice cap on a non-first-line match", () => {
		const filler1 = "idx = 1";
		const raw = "   nonceValue = random.random()" + "z".repeat(200) + "   ";
		const filler2 = "idx2 = 2";
		const content = [filler1, raw, filler2].join("\n");
		const out = checkWeakRandom(content, "src/a.py");
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(2);
		expect(out[0]?.text).toBe(raw.trim().slice(0, 150));
		expect(out[0]?.text).toHaveLength(150);
	});

	it("does NOT fire on a .ts extension even when content would match the weak-random + security-context shape (kills the .py-guard-removed mutant)", () => {
		// If the `getExtension(filePath) !== ".py"` guard were disabled, this
		// content (a real random.<fn> call plus a security-context identifier)
		// would produce a match on ANY extension — so a non-.py result of []
		// proves the guard is still active.
		expect(checkWeakRandom("nonceValue = random.randint(0, 100)", "src/a.ts")).toEqual([]);
	});

	it("flags random.random ( with a space before the paren (kills the \\s*->\\S* mutant)", () => {
		expect(checkWeakRandom("nonceValue = random.random ()", "src/a.py")).toHaveLength(1);
	});

	it("recognizes `session__id` (a doubled separator) as the same security context as a single-separated `session_id` (kills the [_-]+ -> [_-] quantifier-drop mutant)", () => {
		expect(checkWeakRandom("session__id = random.random()", "src/a.py")).toHaveLength(1);
	});

	it("recognizes a security term that only exists in its space-separated form, e.g. `private_key`, not its glued form (kills the underscore-replacement space -> empty-string mutant)", () => {
		expect(checkWeakRandom("private_key = random.random()", "src/a.py")).toHaveLength(1);
	});
});
