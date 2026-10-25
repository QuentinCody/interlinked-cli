// Adversarial (independent) false-positive review of `logger_format_user_input`
// (pre_block). Each N case is legitimate code the detector fired on before the
// 2026-10-21 refinement; the P cases pin that the refinement did not weaken
// the gate. Probe: scratch/2026-10-21-adversarial/logger_format_user_input.probe.mts.

import { describe, expect, it } from "vitest";
import { checkLoggerFormatUserInput } from "../../checks/ubs-language-specific/js-security-checks.js";

describe("logger_format_user_input — negative (must not fire)", () => {
	it("N1: JSX text in a .tsx docs page quoting the bad shape as prose", () => {
		const content = [
			"export function LogInjectionPage() {",
			"  return (",
			"    <section>",
			"      <h2>Do not pass request values as the format string</h2>",
			"      <pre><code>logger.info(req.body)</code></pre>",
			"    </section>",
			"  );",
			"}",
		].join("\n");
		expect(checkLoggerFormatUserInput(content, "src/docs/LogInjectionPage.tsx")).toEqual([]);
	});

	it("N2: JSX text in a .jsx file", () => {
		const content = "export const P = () => <p>Bad: console.error(user)</p>;\n";
		expect(checkLoggerFormatUserInput(content, "src/docs/Page.jsx")).toEqual([]);
	});

	it("N3: vendored third-party source under vendor/", () => {
		const content = "module.exports = function (req, res, next) {\n  log.debug(req);\n  next();\n};\n";
		expect(checkLoggerFormatUserInput(content, "vendor/express-pino/index.js")).toEqual([]);
	});

	it("N4: committed build output under dist/", () => {
		const content = "function h(req){logger.warn(req.headers)}\n";
		expect(checkLoggerFormatUserInput(content, "dist/server.js")).toEqual([]);
	});

	it("N5: a __mocks__ / __fixtures__ sample holding the pattern as data", () => {
		const content = "export const logRequest = (req) => console.error(req);\n";
		expect(checkLoggerFormatUserInput(content, "src/__mocks__/request-logger.js")).toEqual([]);
		expect(checkLoggerFormatUserInput(content, "test/__fixtures__/log-injection.js")).toEqual([]);
	});

	it("N6: pino merge-object idiom, template interpolation, and a multi-line structured call", () => {
		expect(checkLoggerFormatUserInput('logger.info({ req }, "incoming");\n', "src/app.ts")).toEqual([]);
		expect(checkLoggerFormatUserInput("logger.info(`${req.method} ${req.url}`);\n", "src/app.ts")).toEqual([]);
		expect(checkLoggerFormatUserInput("logger.info(\n  { user },\n  'created'\n);\n", "src/app.ts")).toEqual([]);
	});

	it("N7: a ternary on a source value whose branches are both literals (round 2)", () => {
		expect(
			checkLoggerFormatUserInput('logger.info(user ? "authenticated request" : "anonymous request");\n', "src/auth.ts"),
		).toEqual([]);
		expect(
			checkLoggerFormatUserInput("logger.warn(input === undefined ? `no input` : `input present`);\n", "src/auth.ts"),
		).toEqual([]);
	});

	it("N8: a bare comparison on a source value logs a boolean (round 2)", () => {
		expect(checkLoggerFormatUserInput("console.info(query === null);\n", "src/upload.ts")).toEqual([]);
		expect(checkLoggerFormatUserInput("logger.debug(user instanceof Admin, 'admin?');\n", "src/upload.ts")).toEqual([]);
	});
});

describe("logger_format_user_input — positive (must fire)", () => {
	it("P1: a real call in a .tsx component body still fires (JSX blanking is text-only)", () => {
		const content = [
			"export function Page({ req }: { req: Request }) {",
			"  logger.info(req);",
			"  return <p>ok</p>;",
			"}",
		].join("\n");
		expect(checkLoggerFormatUserInput(content, "src/docs/Page.tsx")).toEqual([
			{ line: 2, text: "logger.info(req);" },
		]);
	});

	it("P2: a JSX expression container with a real call still fires", () => {
		const content = "export const P = () => <div>{logger.error(user)}</div>;\n";
		expect(checkLoggerFormatUserInput(content, "src/docs/Page.tsx")).toHaveLength(1);
	});

	it("P3: ordinary source paths are not exempt (a directory merely named like one is)", () => {
		expect(checkLoggerFormatUserInput("logger.info(req);", "src/myvendor/app.js")).toHaveLength(1);
		expect(checkLoggerFormatUserInput("logger.info(req);", "src/distribution/app.js")).toHaveLength(1);
	});

	it("P4: a ternary with a source-derived branch still fires (round 2)", () => {
		expect(checkLoggerFormatUserInput('logger.info(user ? user.name : "anon");', "src/users.ts")).toHaveLength(1);
		expect(checkLoggerFormatUserInput('logger.info(user ? "known" : input);', "src/users.ts")).toHaveLength(1);
	});

	it("P5: a comparison that short-circuits to the source value still fires (round 2)", () => {
		expect(checkLoggerFormatUserInput("logger.info(user !== null && user.name);", "src/users.ts")).toHaveLength(1);
		expect(checkLoggerFormatUserInput('logger.info(user?.name ?? "anon");', "src/users.ts")).toHaveLength(1);
	});

	it("P6: a safe call does not hide a risky second call on the same line (round 2)", () => {
		expect(
			checkLoggerFormatUserInput('logger.info(user ? "a" : "b"); logger.info(req.body.message);', "src/users.ts"),
		).toEqual([{ line: 1, text: 'logger.info(user ? "a" : "b"); logger.info(req.body.message);' }]);
	});
});
