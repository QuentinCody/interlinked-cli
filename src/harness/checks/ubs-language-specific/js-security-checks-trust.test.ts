import { describe, expect, it } from "vitest";
import {
	aliasesBoundToRegExp,
	cookieOptionsVerdict,
	cookiesBoundToCollection,
	expressionAt,
	isTrustedProgramExpr,
	resolveOptionsText,
	sameFileConstInit,
	setHeaderValueVerdict,
	sourceView,
	splitTopLevelArgs,
	templateInterpolationsTrusted,
} from "./js-security-checks-trust.js";

describe("sameFileConstInit", () => {
	it("P1: returns the initializer up to a depth-0 semicolon, strings intact", () => {
		const view = sourceView("const GIT = '/usr/bin/git';\nconst x = 1;");
		expect(sameFileConstInit(view, "GIT")).toBe("'/usr/bin/git'");
	});

	it("P2: spans a multi-line object initializer with a type annotation", () => {
		const view = sourceView(
			"export const OPTS: CookieOptions = {\n  httpOnly: true,\n  secure: true,\n};\nnext();",
		);
		expect(sameFileConstInit(view, "OPTS")).toBe("{\n  httpOnly: true,\n  secure: true,\n}");
	});

	it("N1: returns null for a `let` binding and for a name only inside a string", () => {
		expect(sameFileConstInit(sourceView("let cmd = 'x';"), "cmd")).toBeNull();
		expect(sameFileConstInit(sourceView("const s = 'const cmd = 1';"), "cmd")).toBeNull();
	});
	it.each([
		"const options = {}; function send(options) { return options; }",
		"const options = {}; function send() { const options = trusted; return options; }",
		"const options = {}; function send({ options }) { return options; }",
	])("does not borrow a same-named binding from another scope: %s", (code) => {
		const view = sourceView(code);
		expect(sameFileConstInit(view, "options")).toBeNull();
		expect(resolveOptionsText("options", view)).toBeNull();
	});
});

describe("splitTopLevelArgs / expressionAt", () => {
	it("P1: splits on depth-0 commas only", () => {
		const args = "'sid', token, { a: f(1, 2), b: [1, 2] }";
		const view = sourceView(args);
		expect(splitTopLevelArgs(args, view.blanked)).toEqual([
			"'sid'",
			"token",
			"{ a: f(1, 2), b: [1, 2] }",
		]);
	});

	it("P2: expressionAt stops at the first depth-0 comma or close paren", () => {
		const view = sourceView("spawn(process.env.SHELL ?? '/bin/sh', [], {})");
		expect(expressionAt(view, 6)).toBe("process.env.SHELL ?? '/bin/sh'");
	});
});

describe("isTrustedProgramExpr", () => {
	const view = sourceView(
		[
			"const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';",
			"const tsc = require.resolve('typescript/bin/tsc');",
			"const alias = npmCmd;",
			"const tainted = req.query.c;",
		].join("\n"),
	);

	it("P1: trusts process.execPath, __dirname, operator env, and literals", () => {
		expect(isTrustedProgramExpr("process.execPath", view)).toBe(true);
		expect(isTrustedProgramExpr("__dirname", view)).toBe(true);
		expect(isTrustedProgramExpr("process.env.SHELL ?? '/bin/sh'", view)).toBe(true);
		expect(isTrustedProgramExpr("'git'", view)).toBe(true);
	});

	it("P2: resolves same-file consts through one alias hop", () => {
		expect(isTrustedProgramExpr("npmCmd", view)).toBe(true);
		expect(isTrustedProgramExpr("tsc", view)).toBe(true);
		expect(isTrustedProgramExpr("alias", view)).toBe(true);
	});

	it("N1: a request-derived const, an unknown identifier, and process.argv are untrusted", () => {
		expect(isTrustedProgramExpr("tainted", view)).toBe(false);
		expect(isTrustedProgramExpr("userInput", view)).toBe(false);
		expect(isTrustedProgramExpr("process.argv[2]", view)).toBe(false);
		expect(isTrustedProgramExpr("", view)).toBe(false);
	});
	it("does not use an outer trusted constant to exempt a shadowing command parameter", () => {
		const shadowed = sourceView("const command = 'git'; function run(command) { cp.exec(command); }");
		expect(isTrustedProgramExpr("command", shadowed)).toBe(false);
	});
	it.each([
		"process.execPath + req.body",
		"process.env.BIN ?? req.body",
		"require.resolve(req.body)",
		"path.join(__dirname, req.body)",
		"fileURLToPath(req.body)",
	])("does not trust the complete expression merely because its prefix is trusted: %s", (expression) => {
		expect(isTrustedProgramExpr(expression, view)).toBe(false);
	});
});

describe("aliasesBoundToRegExp", () => {
	it("P1: a regex-literal or new RegExp binding of cp / childProcess is recorded", () => {
		expect([...aliasesBoundToRegExp(sourceView("const cp = /^a=(.*)$/;"))]).toEqual(["cp"]);
		expect([...aliasesBoundToRegExp(sourceView("let childProcess = new RegExp(src);"))]).toEqual([
			"childProcess",
		]);
	});
	it("N1: an import, a require, or no binding at all records nothing", () => {
		expect(aliasesBoundToRegExp(sourceView("const cp = require('child_process');")).size).toBe(0);
		expect(aliasesBoundToRegExp(sourceView("cp.exec(userInput)")).size).toBe(0);
		expect(aliasesBoundToRegExp(sourceView("const s = 'const cp = /x/';")).size).toBe(0);
	});
});

describe("templateInterpolationsTrusted", () => {
	const view = sourceView("");
	it("P1: every interpolation trusted", () => {
		expect(templateInterpolationsTrusted("`${process.execPath} ${__dirname}/cli.js`", view)).toBe(true);
	});
	it("N1: one untrusted interpolation, or none at all, is not trusted", () => {
		expect(templateInterpolationsTrusted("`${process.execPath} ${req.query.a}`", view)).toBe(false);
		expect(templateInterpolationsTrusted("`echo hi`", view)).toBe(false);
		expect(templateInterpolationsTrusted("`${fn({ a: 1 })}`", view)).toBe(false);
	});
});

describe("cookie options resolution", () => {
	const view = sourceView(
		[
			"const base = { httpOnly: true, secure: true };",
			"const weak = { httpOnly: true, sameSite: 'lax' };",
			"const viaBase = { ...base, maxAge: 1 };",
			"const off = { httpOnly: true, secure: false };",
		].join("\n"),
	);

	it("P1: object literal, identifier, and spread all resolve to their property text", () => {
		expect(resolveOptionsText("{ a: 1 }", view)).toBe(" a: 1 ");
		expect(resolveOptionsText("base", view)).toContain("secure: true");
		expect(resolveOptionsText("viaBase", view)).toContain("secure: true");
	});

	it("P2: cookieOptionsVerdict distinguishes ok / missing / undecidable", () => {
		const verdict = (args: string) => cookieOptionsVerdict(args, sourceView(args).blanked, view);
		expect(verdict("'sid', t, base")).toBe("ok");
		expect(verdict("'sid', t, { ...base, maxAge: 1 }")).toBe("ok");
		expect(verdict("'sid', t, { httpOnly: true, secure: isProd }")).toBe("ok");
		expect(verdict("'sid', t, weak")).toBe("missing");
		expect(verdict("'sid', t, off")).toBe("missing");
		expect(verdict("'sid', t")).toBe("missing");
		expect(verdict("{ name: 'sid', value: t, httpOnly: true, secure: true }")).toBe("ok");
		expect(verdict("{ httpOnly: true, secure: true")).toBe("ok");
		expect(verdict("'sid', t, { path: '/' }, 'httpOnly: true; secure: true'")).toBe("missing");
		expect(verdict("'sid', t, opts")).toBe("undecidable");
		expect(verdict("'sid', t, { ...opts }")).toBe("undecidable");
		expect(verdict("'sid', t, this.opts")).toBe("undecidable");
	});

	it("P3: cookiesBoundToCollection sees a Map / Set binding outside strings", () => {
		expect(cookiesBoundToCollection(sourceView("const cookies = new Map<string, string>();"))).toBe(true);
		expect(cookiesBoundToCollection(sourceView("const s = 'cookies = new Map()';"))).toBe(false);
		expect(cookiesBoundToCollection(sourceView("cookies.set('a', b);"))).toBe(false);
	});
});

describe("setHeaderValueVerdict", () => {
	const view = sourceView(
		[
			"const good = serialize('a', v, { httpOnly: true, secure: true });",
			"const bad = serialize('a', v, { path: '/' });",
		].join("\n"),
	);

	it("P1: literal text is judged as written", () => {
		expect(setHeaderValueVerdict("`sid=${t}; HttpOnly; Secure`", view)).toBe("ok");
		expect(setHeaderValueVerdict("`sid=${t}`", view)).toBe("missing");
	});

	it("P2: identifiers and identifier arrays resolve through same-file consts", () => {
		expect(setHeaderValueVerdict("good", view)).toBe("ok");
		expect(setHeaderValueVerdict("[good, good]", view)).toBe("ok");
		expect(setHeaderValueVerdict("bad", view)).toBe("missing");
		expect(setHeaderValueVerdict("[good, bad]", view)).toBe("missing");
	});

	it("N1: an unknown identifier or a quote-free call expression is undecidable", () => {
		expect(setHeaderValueVerdict("value", view)).toBe("undecidable");
		expect(setHeaderValueVerdict("buildCookie(t)", view)).toBe("undecidable");
		expect(setHeaderValueVerdict("cookie.serialize(name, t, opts", view)).toBe("undecidable");
		expect(setHeaderValueVerdict("", view)).toBe("undecidable");
	});

	it("P3: text that is neither an identifier list nor a call is judged as written", () => {
		expect(setHeaderValueVerdict("a=b; Path=/", view)).toBe("missing");
		expect(setHeaderValueVerdict("a=b; HttpOnly; Secure", view)).toBe("ok");
	});
});
