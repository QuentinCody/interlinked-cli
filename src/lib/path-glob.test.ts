import { beforeEach, describe, expect, it } from "vitest";
import {
	_globCacheSize,
	_resetGlobCache,
	compileGlob,
	matchesAnyGlob,
	matchesGlob,
} from "./path-glob.js";

beforeEach(() => {
	_resetGlobCache();
});

describe("matchesGlob — literal characters", () => {
	it("matches an exact literal path", () => {
		expect(matchesGlob("foo/bar.ts", "foo/bar.ts")).toBe(true);
	});

	it("rejects a non-matching literal path", () => {
		expect(matchesGlob("foo/bar.ts", "foo/baz.ts")).toBe(false);
	});

	it("matches a literal trailing slash exactly (no implicit slash insertion)", () => {
		expect(matchesGlob("foo/", "foo/")).toBe(true);
		expect(matchesGlob("foo", "foo/")).toBe(false);
	});

	it("treats '.' as a literal dot, not a regex wildcard", () => {
		expect(matchesGlob("foox", "foo.")).toBe(false);
		expect(matchesGlob("foo.", "foo.")).toBe(true);
	});
});

describe("matchesGlob — single-star (*)", () => {
	it("matches characters within a path segment", () => {
		expect(matchesGlob("file.ts", "*.ts")).toBe(true);
		expect(matchesGlob("file.tsx", "*.ts")).toBe(false);
	});

	it("does not cross / boundaries", () => {
		expect(matchesGlob("foo/bar.ts", "*.ts")).toBe(false);
		expect(matchesGlob("foo/bar.ts", "*/bar.ts")).toBe(true);
	});

	it("matches an empty span", () => {
		expect(matchesGlob("foo.ts", "foo*.ts")).toBe(true);
	});
});

describe("matchesGlob — double-star (**)", () => {
	it("matches across path separators", () => {
		expect(matchesGlob("a/b/c/d.ts", "**/d.ts")).toBe(true);
		expect(matchesGlob("a/b/c/d.ts", "a/**/d.ts")).toBe(true);
	});

	it("matches at the root with no segments before", () => {
		expect(matchesGlob("d.ts", "**/d.ts")).toBe(true);
	});

	it("**/* matches subtrees", () => {
		expect(matchesGlob("dist/foo.js", "dist/**")).toBe(true);
		expect(matchesGlob("dist/a/b/foo.js", "dist/**")).toBe(true);
		expect(matchesGlob("other/foo.js", "dist/**")).toBe(false);
	});

	it("matches the typical generated-files default", () => {
		expect(matchesGlob("src/foo.generated.ts", "**/*.generated.{ts,js,py,rs,go}")).toBe(true);
		expect(matchesGlob("a/b/foo.generated.go", "**/*.generated.{ts,js,py,rs,go}")).toBe(true);
		expect(matchesGlob("foo.generated.swift", "**/*.generated.{ts,js,py,rs,go}")).toBe(false);
	});
});

describe("matchesGlob — ? wildcard", () => {
	it("matches exactly one non-slash char", () => {
		expect(matchesGlob("foo1.ts", "foo?.ts")).toBe(true);
		expect(matchesGlob("foo12.ts", "foo?.ts")).toBe(false);
		expect(matchesGlob("foo.ts", "foo?.ts")).toBe(false);
	});

	it("does not match across /", () => {
		expect(matchesGlob("a/b", "a?b")).toBe(false);
	});
});

describe("matchesGlob — character classes", () => {
	it("matches any single char in [abc]", () => {
		expect(matchesGlob("a", "[abc]")).toBe(true);
		expect(matchesGlob("c", "[abc]")).toBe(true);
		expect(matchesGlob("d", "[abc]")).toBe(false);
	});

	it("rejects character ranges by compiling to a no-match pattern", () => {
		// Per spec: ranges with `-` are explicitly not supported. Caller's
		// compileGlob falls back to a never-match regex; matchesGlob → false.
		expect(matchesGlob("b", "[a-c]")).toBe(false);
		expect(matchesGlob("a", "[a-c]")).toBe(false);
	});
});

describe("matchesGlob — brace alternation", () => {
	it("matches any branch of {a,b}", () => {
		expect(matchesGlob("foo.ts", "foo.{ts,js}")).toBe(true);
		expect(matchesGlob("foo.js", "foo.{ts,js}")).toBe(true);
		expect(matchesGlob("foo.go", "foo.{ts,js}")).toBe(false);
	});

	it("supports the *.min.{js,css} default", () => {
		expect(matchesGlob("a/b.min.js", "**/*.min.{js,css}")).toBe(true);
		expect(matchesGlob("a/b.min.css", "**/*.min.{js,css}")).toBe(true);
		expect(matchesGlob("a/b.min.html", "**/*.min.{js,css}")).toBe(false);
	});
});

describe("matchesGlob — edge cases", () => {
	it("empty glob matches nothing", () => {
		expect(matchesGlob("", "")).toBe(false);
		expect(matchesGlob("foo", "")).toBe(false);
	});

	it("empty path against a non-empty glob", () => {
		expect(matchesGlob("", "*")).toBe(true);
		expect(matchesGlob("", "**")).toBe(true);
		expect(matchesGlob("", "foo")).toBe(false);
	});

	it("trailing slash in path does not implicitly match a non-slash glob", () => {
		expect(matchesGlob("foo/", "foo")).toBe(false);
	});

	it("invalid syntax (unterminated [) compiles to a no-match pattern", () => {
		expect(matchesGlob("foo", "[abc")).toBe(false);
	});

	it("invalid syntax (unterminated {) compiles to a no-match pattern", () => {
		// Per spec: an unclosed brace alternation has no matching `}`, so
		// findMatchingBrace can't locate a close and processBraceToken throws;
		// compileGlob falls back to the never-match regex, same as `[abc`.
		expect(matchesGlob("foo.ts", "foo.{ts,js")).toBe(false);
		expect(matchesGlob("foo.{ts,js", "foo.{ts,js")).toBe(false);
	});
});

describe("matchesAnyGlob", () => {
	it("returns true on any matching glob", () => {
		expect(matchesAnyGlob("dist/foo.js", ["src/**", "dist/**"])).toBe(true);
	});

	it("returns false when nothing matches", () => {
		expect(matchesAnyGlob("README.md", ["src/**", "dist/**"])).toBe(false);
	});

	it("returns false on empty list", () => {
		expect(matchesAnyGlob("anything", [])).toBe(false);
	});

});

describe("matchesAnyGlob — opinionated default list", () => {
	const DEFAULTS = [
		"dist/**",
		"build/**",
		"out/**",
		"node_modules/**",
		"vendor/**",
		".next/**",
		".nuxt/**",
		".astro/**",
		"target/**",
		".svelte-kit/**",
		"**/generated/**",
		"**/*.generated.{ts,js,py,rs,go}",
		"**/*.min.{js,css}",
		"**/*.bundle.{js,css}",
		"*.lock",
		"**/package-lock.json",
		"**/yarn.lock",
		"**/Cargo.lock",
		"**/uv.lock",
		".git/**",
		".idea/**",
		".vscode/**",
	];

	it("matches a dist/ build artifact", () => {
		expect(matchesAnyGlob("dist/index.js", DEFAULTS)).toBe(true);
	});

	it("matches a node_modules/ file", () => {
		expect(matchesAnyGlob("node_modules/foo/bar.js", DEFAULTS)).toBe(true);
	});

	it("matches a *.generated.ts file via brace alternation", () => {
		expect(matchesAnyGlob("src/feature/foo.generated.ts", DEFAULTS)).toBe(true);
	});

	it("matches *.min.css under a nested path", () => {
		expect(matchesAnyGlob("a/b/style.min.css", DEFAULTS)).toBe(true);
	});

	it("matches a top-level Cargo.lock", () => {
		expect(matchesAnyGlob("Cargo.lock", DEFAULTS)).toBe(true);
	});

	it("matches a nested Cargo.lock via **/", () => {
		expect(matchesAnyGlob("subproject/Cargo.lock", DEFAULTS)).toBe(true);
	});

	it("matches a top-level package-lock.json via **/", () => {
		expect(matchesAnyGlob("package-lock.json", DEFAULTS)).toBe(true);
	});

	it("matches a file inside the .git/ directory", () => {
		expect(matchesAnyGlob(".git/HEAD", DEFAULTS)).toBe(true);
	});

	it("does not match an ordinary source file", () => {
		expect(matchesAnyGlob("src/lib/foo.ts", DEFAULTS)).toBe(false);
	});

	it("does not match a top-level README", () => {
		expect(matchesAnyGlob("README.md", DEFAULTS)).toBe(false);
	});
});

describe("compileGlob caching", () => {
	it("caches compiled regexps keyed on the glob string", () => {
		expect(_globCacheSize()).toBe(0);
		const a = compileGlob("dist/**");
		const b = compileGlob("dist/**");
		expect(a).toBe(b);
		expect(_globCacheSize()).toBe(1);
	});

	it("distinct globs produce distinct cache entries", () => {
		compileGlob("dist/**");
		compileGlob("build/**");
		expect(_globCacheSize()).toBe(2);
	});

	it("_resetGlobCache clears the cache", () => {
		compileGlob("dist/**");
		expect(_globCacheSize()).toBe(1);
		_resetGlobCache();
		expect(_globCacheSize()).toBe(0);
	});

	it("matchesGlob populates the cache transparently", () => {
		expect(_globCacheSize()).toBe(0);
		matchesGlob("dist/foo.js", "dist/**");
		expect(_globCacheSize()).toBe(1);
		matchesGlob("dist/bar.js", "dist/**");
		expect(_globCacheSize()).toBe(1);
	});
});
