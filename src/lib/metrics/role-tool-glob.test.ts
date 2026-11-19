import { describe, expect, it } from "vitest";
import { compileGlob, matchesRules, type GlobRule } from "./role-tool-glob.js";

function rule(pattern: string, mode: "any-depth" | "anchored" = "any-depth"): GlobRule {
	const compiled = compileGlob(pattern, mode);
	if ("unsupported" in compiled) throw new Error(compiled.unsupported);
	return compiled;
}

describe("MUST-FIRE: glob subset", () => {
	it("P1: a directory name with a slash is anchored at the config directory and covers its subtree", () => {
		const r = rule("src/_api");
		expect(matchesRules([r], "src/_api/client.py")).toBe(r);
		expect(matchesRules([r], "src/_api/deep/x.py")).toBe(r);
	});
	it("P2: a pattern without a slash matches a path component at any depth (any-depth mode)", () => {
		const r = rule("*.egg-info");
		expect(matchesRules([r], "pkg/foo.egg-info/PKG.py")).toBe(r);
		expect(matchesRules([rule("generated")], "a/b/generated/x.ts")).not.toBeNull();
	});
	it("P3: ** crosses directories, * does not", () => {
		expect(matchesRules([rule("src/**/gen.ts", "anchored")], "src/a/b/gen.ts")).not.toBeNull();
		expect(matchesRules([rule("src/*.ts", "anchored")], "src/a/b.ts")).toBeNull();
		expect(matchesRules([rule("src/*.ts", "anchored")], "src/b.ts")).not.toBeNull();
	});
	it("P4: braces and character classes expand", () => {
		expect(matchesRules([rule("**/*.{gen,auto}.ts", "anchored")], "a/x.auto.ts")).not.toBeNull();
		expect(matchesRules([rule("file[0-9].py")], "d/file3.py")).not.toBeNull();
	});
	it("P5: a trailing slash matches directories only, a negation re-includes in order", () => {
		expect(matchesRules([rule("out/", "anchored")], "out")).toBeNull();
		expect(matchesRules([rule("out/", "anchored")], "out/a.js")).not.toBeNull();
		const rules = [rule("lib", "anchored"), rule("!lib/keep.js", "anchored")];
		expect(matchesRules(rules, "lib/gone.js")).not.toBeNull();
		expect(matchesRules(rules, "lib/keep.js")).toBeNull();
	});
});

describe("MUST-NOT-FIRE: glob subset", () => {
	it("N1: an anchored pattern does not match the same name deeper in the tree", () => {
		expect(matchesRules([rule("build", "anchored")], "pkg/build/x.js")).toBeNull();
		expect(matchesRules([rule("src/api")], "other/src/api/x.py")).toBeNull();
	});
	it("N2: a name prefix is not a component match", () => {
		expect(matchesRules([rule("src/api")], "src/api2/x.py")).toBeNull();
		expect(matchesRules([rule("dist")], "distant/x.py")).toBeNull();
	});
	it("N3: unsupported syntax is reported, never guessed", () => {
		expect(compileGlob("src/@(a|b)/x", "anchored")).toEqual({ unsupported: "extglob" });
		expect(compileGlob("src/{a,{b,c}}", "anchored")).toEqual({ unsupported: "nested-braces" });
		expect(compileGlob("", "anchored")).toEqual({ unsupported: "empty" });
	});
	it("N4: a leading ./ is ignored and a leading / anchors", () => {
		expect(matchesRules([rule("./gen")], "gen/a.py")).not.toBeNull();
		expect(matchesRules([rule("/gen")], "x/gen/a.py")).toBeNull();
	});
});
