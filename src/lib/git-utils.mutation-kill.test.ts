import { nonNull } from "./non-null.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execFileSync: vi.fn<(file: string, args: readonly string[], options: object) => string>(),
}));

vi.mock("node:child_process", () => ({
	execFileSync: mocks.execFileSync,
}));

import {
	deriveProjectIdentity,
	getCommitMessage,
	getCurrentBranch,
	getGitToplevel,
	getHeadSha,
	getStagedFiles,
	isGitRepo,
	parseInterlinkedTrailers,
} from "./git-utils.js";

const CWD = "/repo";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("git() subprocess contract", () => {
	// test-contract: boundary — argv tokens for a plain unquoted subcommand must be exact
	it("sends exact argv tokens for a simple subcommand", () => {
		mocks.execFileSync.mockReturnValueOnce("abc\n");
		expect(isGitRepo(CWD)).toBe(true);
		expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
		const [cmd, args, options] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(cmd).toBe("git");
		expect(args).toEqual(["rev-parse", "--git-dir"]);
		expect(options).toEqual({
			cwd: CWD,
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	// test-contract: boundary — the output is trimmed of surrounding whitespace before use
	it("trims leading and trailing whitespace from subprocess output", () => {
		mocks.execFileSync.mockReturnValueOnce("  padded-branch  \n");
		expect(getCurrentBranch(CWD)).toBe("padded-branch");
	});

	// test-contract: boundary — getGitToplevel sends the exact subcommand tokens
	it("sends exact argv tokens for getGitToplevel", () => {
		mocks.execFileSync.mockReturnValueOnce("/repo\n");
		expect(getGitToplevel(CWD)).toBe("/repo");
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["rev-parse", "--show-toplevel"]);
	});

	// test-contract: boundary — a fully double-quoted argument token is stripped of its quotes
	it("strips a fully double-quoted argument", () => {
		mocks.execFileSync.mockReturnValueOnce("msg");
		getCommitMessage('"hello"', CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["log", "-1", "--format=%B", "hello"]);
	});

	// test-contract: boundary — a fully single-quoted argument token is stripped of its quotes
	it("strips a fully single-quoted argument", () => {
		mocks.execFileSync.mockReturnValueOnce("msg");
		getCommitMessage("'hello'", CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["log", "-1", "--format=%B", "hello"]);
	});

	// test-contract: boundary — an unquoted argument token passes through unchanged
	it("leaves an unquoted argument unchanged", () => {
		mocks.execFileSync.mockReturnValueOnce("msg");
		getCommitMessage("hello", CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["log", "-1", "--format=%B", "hello"]);
	});

	// test-contract: boundary — a token opening (but not closing) with a double quote is left untouched
	it("does not strip a token that only opens with a double quote", () => {
		mocks.execFileSync.mockReturnValueOnce("msg");
		getCommitMessage('"hello', CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["log", "-1", "--format=%B", '"hello']);
	});

	// test-contract: boundary — a token closing (but not opening) with a double quote is left untouched
	it("does not strip a token that only closes with a double quote", () => {
		mocks.execFileSync.mockReturnValueOnce("msg");
		getCommitMessage('hello"', CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["log", "-1", "--format=%B", 'hello"']);
	});

	// test-contract: boundary — a token opening (but not closing) with a single quote is left untouched
	it("does not strip a token that only opens with a single quote", () => {
		mocks.execFileSync.mockReturnValueOnce("msg");
		getCommitMessage("'hello", CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["log", "-1", "--format=%B", "'hello"]);
	});

	// test-contract: boundary — a token closing (but not opening) with a single quote is left untouched
	it("does not strip a token that only closes with a single quote", () => {
		mocks.execFileSync.mockReturnValueOnce("msg");
		getCommitMessage("hello'", CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["log", "-1", "--format=%B", "hello'"]);
	});

	// test-contract: boundary — a space embedded inside a double-quoted argument stays in one preserved token
	it("preserves an embedded space inside a double-quoted argument", () => {
		mocks.execFileSync.mockReturnValueOnce("msg");
		getCommitMessage('"a b"', CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["log", "-1", "--format=%B", "a b"]);
	});

	// test-contract: boundary — a space embedded inside a single-quoted argument stays in one preserved token
	it("preserves an embedded space inside a single-quoted argument", () => {
		mocks.execFileSync.mockReturnValueOnce("msg");
		getCommitMessage("'a b'", CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["log", "-1", "--format=%B", "a b"]);
	});
});

describe("getHeadSha", () => {
	// test-contract: boundary — the default short parameter requests the short SHA form
	it("defaults to short form when no argument is passed", () => {
		mocks.execFileSync.mockReturnValueOnce("abc1234");
		getHeadSha(CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["rev-parse", "--short", "HEAD"]);
	});

	// test-contract: boundary — passing false requests the full-length SHA with no --short flag
	it("requests the full SHA when short is false", () => {
		mocks.execFileSync.mockReturnValueOnce("abc1234567890");
		getHeadSha(CWD, false);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["rev-parse", "HEAD"]);
	});
});

describe("getCommitMessage", () => {
	// test-contract: boundary — the log command is built from the exact ref argument
	it("builds the exact command for a ref", () => {
		mocks.execFileSync.mockReturnValueOnce("commit body");
		getCommitMessage("HEAD", CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["log", "-1", "--format=%B", "HEAD"]);
	});
});

describe("getStagedFiles", () => {
	// test-contract: boundary — blank lines produced by a trailing newline are filtered out
	it("filters blank lines out of the staged file list", () => {
		mocks.execFileSync.mockReturnValueOnce("a.ts\n\nb.ts\n");
		expect(getStagedFiles(CWD)).toEqual(["a.ts", "b.ts"]);
	});

	// test-contract: boundary — the diff subcommand tokens are exact
	it("sends exact argv tokens", () => {
		mocks.execFileSync.mockReturnValueOnce("a.ts\n");
		getStagedFiles(CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["diff", "--cached", "--name-only"]);
	});
});

describe("parseInterlinkedTrailers", () => {
	// test-contract: boundary — a trailer-shaped substring must start the line to be recognized
	it("does not match an Interlinked trailer that is not at the start of the line", () => {
		expect(parseInterlinkedTrailers("prefix Interlinked-Checkpoint: 42")).toEqual({});
	});

	// test-contract: boundary — zero whitespace after the colon is still a valid separator
	it("parses a trailer with no space after the colon", () => {
		expect(parseInterlinkedTrailers("Interlinked-Checkpoint:42")).toEqual({
			"Interlinked-Checkpoint": "42",
		});
	});

	// test-contract: boundary — surrounding whitespace on the value is trimmed
	it("trims whitespace surrounding a trailer's value", () => {
		expect(parseInterlinkedTrailers("Interlinked-Checkpoint:  42  ")).toEqual({
			"Interlinked-Checkpoint": "42",
		});
	});

	// test-contract: boundary — an internal space in the value must not be swallowed by the separator match
	it("captures a value with an internal space and no separating whitespace after the colon", () => {
		expect(parseInterlinkedTrailers("Interlinked-Checkpoint:xyz 42")).toEqual({
			"Interlinked-Checkpoint": "xyz 42",
		});
	});
});

describe("deriveProjectIdentity", () => {
	// test-contract: boundary — the remote-url lookup sends exact argv tokens
	it("sends exact argv tokens for the remote lookup", () => {
		mocks.execFileSync.mockReturnValueOnce("git@github.com:user/my-project.git");
		deriveProjectIdentity(CWD);
		const [, args] = nonNull(mocks.execFileSync.mock.calls[0]);
		expect(args).toEqual(["remote", "get-url", "origin"]);
	});

	// test-contract: boundary — an SSH remote URL yields a sanitized workspace key
	it("derives workspaceKey from an SSH remote URL", () => {
		mocks.execFileSync.mockReturnValueOnce("git@github.com:user/my-project.git");
		expect(deriveProjectIdentity(CWD)).toEqual({
			workspaceKey: "my-project",
			projectKey: "main",
		});
	});

	// test-contract: boundary — once the remote URL yields a repo name, the toplevel fallback must not run or override it
	it("does not fall back to git toplevel once the remote URL already yielded a repo name", () => {
		mocks.execFileSync.mockReturnValueOnce("git@github.com:user/my-project.git");
		expect(deriveProjectIdentity(CWD)).toEqual({
			workspaceKey: "my-project",
			projectKey: "main",
		});
		expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
	});

	// test-contract: boundary — runs of sanitized-out characters collapse to a single hyphen in the slug
	it("collapses runs of sanitized characters into a single hyphen", () => {
		mocks.execFileSync
			.mockReturnValueOnce("") // no remote configured
			.mockReturnValueOnce("/repos/My  Project!!");
		expect(deriveProjectIdentity(CWD)).toEqual({
			workspaceKey: "my-project",
			projectKey: "main",
		});
	});
});
