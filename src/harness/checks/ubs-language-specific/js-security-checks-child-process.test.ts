import { describe, expect, it } from "vitest";
import { checkChildProcessExecUserInput } from "./js-security-checks-child-process.js";

describe("checkChildProcessExecUserInput — positive (must fire)", () => {
	it("P1: an identifier first argument with no same-file trusted binding", () => {
		expect(checkChildProcessExecUserInput("cp.exec(userInput)", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec(userInput)" },
		]);
	});

	it("P2: a template whose interpolation is not process-controlled", () => {
		expect(checkChildProcessExecUserInput("cp.exec(`ls ${dir}`)", "src/app.js")).toEqual([
			{ line: 1, text: "cp.exec(`ls ${dir}`)" },
		]);
	});

	it("P3: one finding per line when the identifier and template forms share it", () => {
		expect(checkChildProcessExecUserInput("cp.exec(cmd); cp.exec(`ls ${d}`);", "src/app.js")).toHaveLength(1);
	});
});

describe("checkChildProcessExecUserInput — negative (must not fire)", () => {
	it("N1: a process-controlled first argument", () => {
		expect(checkChildProcessExecUserInput("cp.spawn(process.execPath, [s])", "src/app.js")).toEqual([]);
	});

	it("N2: a same-file const string program", () => {
		expect(
			checkChildProcessExecUserInput("const GIT = 'git';\ncp.execFile(GIT, ['status'])", "src/app.js"),
		).toEqual([]);
	});

	it("N3: a `cp` bound to a RegExp, a hardcoded string, a test file, a non-JS file", () => {
		expect(checkChildProcessExecUserInput("const cp = /a/;\ncp.exec(line)", "src/app.js")).toEqual([]);
		expect(checkChildProcessExecUserInput("cp.exec('ls')", "src/app.js")).toEqual([]);
		expect(checkChildProcessExecUserInput("cp.exec(userInput)", "src/app.test.js")).toEqual([]);
		expect(checkChildProcessExecUserInput("cp.exec(userInput)", "src/app.py")).toEqual([]);
	});
});
