// Independent adversarial FP review (2026-10-21) for the pre_block check
// `child_process_exec_user_input`. Every negative below is realistic Node
// tooling that fired before the detector learned to recognise a trusted
// program expression (process.execPath / __dirname / operator env), a
// same-file constant program path, and an unproven `cp` alias.
// Probe: scratch/2026-10-21-adversarial/child_process_exec_user_input.probe.mts

import { describe, expect, it } from "vitest";
import { checkChildProcessExecUserInput } from "../../checks/ubs-language-specific/js-security-checks.js";

describe("child_process_exec_user_input — negative (must not fire)", () => {
	it("N1: spawn(process.execPath, [script]) re-invokes node itself", () => {
		const code = [
			"import cp from 'node:child_process';",
			"export function runScript(script: string) {",
			"  return cp.spawn(process.execPath, [script], { stdio: 'inherit' });",
			"}",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/runner.ts")).toEqual([]);
	});

	it("N2: execFileSync(process.execPath, ['--version']) is the fix_instruction's own shape", () => {
		const code = [
			"import * as childProcess from 'node:child_process';",
			"const out = childProcess.execFileSync(process.execPath, ['--version'], { encoding: 'utf8' });",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/build.mjs")).toEqual([]);
	});

	it("N3: program is a same-file const ternary of string literals (npm.cmd on win32)", () => {
		const code = [
			"import cp from 'node:child_process';",
			"const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';",
			"export function install(dir: string) {",
			"  return cp.spawnSync(npmCmd, ['install'], { cwd: dir, stdio: 'inherit' });",
			"}",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/install.ts")).toEqual([]);
	});

	it("N4: program is a same-file string-literal const (execFile with a hardcoded path)", () => {
		const code = [
			"import childProcess from 'node:child_process';",
			"const GIT = '/usr/bin/git';",
			"export function status(cwd: string, cb: (e: Error | null, out: string) => void) {",
			"  childProcess.execFile(GIT, ['status', '--porcelain'], { cwd }, cb);",
			"}",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/git.ts")).toEqual([]);
	});

	it("N5: template literal interpolating only process.execPath and __dirname", () => {
		const code = [
			"import cp from 'node:child_process';",
			"const out = cp.execSync(`\"${process.execPath}\" ${__dirname}/cli.js --help`, { encoding: 'utf8' });",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/smoke.ts")).toEqual([]);
	});

	it("N6: spawn(process.env.SHELL ?? '/bin/sh') is operator environment, not request input", () => {
		const code = [
			"import cp from 'node:child_process';",
			"export function openShell() {",
			"  return cp.spawn(process.env.SHELL ?? '/bin/sh', [], { stdio: 'inherit' });",
			"}",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/terminal.ts")).toEqual([]);
	});

	it("N7: `cp` is a compiled RegExp in a file that never references child_process", () => {
		const code = [
			"const cp = /^(\\w+)=(.*)$/;",
			"export function parseLine(line: string) {",
			"  const m = cp.exec(line);",
			"  return m ? { key: m[1], value: m[2] } : null;",
			"}",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/parse.ts")).toEqual([]);
	});

	it("N8: spawnSync(process.execPath, [bin]) where bin is require.resolve'd", () => {
		const code = [
			"import cp from 'node:child_process';",
			"const bin = require.resolve('typescript/bin/tsc');",
			"export function typecheck(cwd: string) {",
			"  return cp.spawnSync(process.execPath, [bin, '--noEmit'], { cwd });",
			"}",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/tsc-runner.ts")).toEqual([]);
	});

	it("N9: spawn(tsc) where tsc is a same-file require.resolve const", () => {
		const code = [
			"import cp from 'node:child_process';",
			"const tsc = require.resolve('typescript/bin/tsc');",
			"cp.execFileSync(tsc, ['--noEmit']);",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/tsc-direct.ts")).toEqual([]);
	});
});

describe("child_process_exec_user_input — positive (must fire)", () => {
	it("P1: exec(req.body.cmd) from a request handler", () => {
		const code = [
			"import cp from 'node:child_process';",
			"app.post('/run', requireAuth, (req, res) => { cp.exec(req.body.cmd); });",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/routes.ts").length).toBe(1);
	});

	it("P2: execFile(userProgram) where the program comes from the request", () => {
		const code = [
			"import childProcess from 'node:child_process';",
			"app.post('/run', requireAuth, (req, res) => { const userProgram = req.query.p; childProcess.execFile(userProgram, []); });",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/routes2.ts").length).toBe(1);
	});

	it("P3: a same-file const that resolves to a non-literal still fires", () => {
		const code = [
			"import cp from 'node:child_process';",
			"export function h(req) {",
			"  const cmd = req.query.c;",
			"  cp.execSync(cmd);",
			"}",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/h.ts").length).toBe(1);
	});

	it("P4: template literal mixing process.execPath with a request value still fires", () => {
		const code = [
			"import cp from 'node:child_process';",
			"export function h(req) { cp.exec(`${process.execPath} ${req.query.arg}`); }",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/h2.ts").length).toBe(1);
	});

	it("P5: a `cp` alias proven by a child_process import still fires on a parameter", () => {
		const code = [
			"const cp = require('child_process');",
			"module.exports = function run(cmd) { return cp.execSync(cmd); };",
		].join("\n");
		expect(checkChildProcessExecUserInput(code, "src/run.cjs").length).toBe(1);
	});

	it("P6: the unambiguous `child_process` namespace needs no import to fire", () => {
		expect(
			checkChildProcessExecUserInput("child_process.exec(userInput)", "src/a.js").length,
		).toBe(1);
	});
});
