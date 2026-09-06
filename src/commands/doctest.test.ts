import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctestExec } from "../harness/doctest.js";
import { doctestCommand, findMarkdownFiles, registerDoctestCommand, runDoctestSuite } from "./doctest.js";

const DOC = ["```bash doctest", "cmd-a", "```", "```bash", "rm -rf /", "```", "```sh doctest", "cmd-b", "```"].join(
	"\n",
);

describe("runDoctestSuite", () => {
	const readFile = (p: string): string => (p === "doc.md" ? DOC : "");

	it("runs only doctest blocks and reports failures with file+line", () => {
		const exec: DoctestExec = (code) => (code === "cmd-b" ? { exitCode: 2 } : { exitCode: 0 });
		const r = runDoctestSuite(["doc.md"], readFile, exec);
		expect(r.total).toBe(2);
		expect(r.failed).toBe(1);
		expect(r.failures).toEqual([{ file: "doc.md", line: 7, exitCode: 2 }]);
	});

	it("never runs an untagged (illustrative) block", () => {
		const ran: string[] = [];
		runDoctestSuite(["doc.md"], readFile, (code) => {
			ran.push(code);
			return { exitCode: 0 };
		});
		expect(ran).toEqual(["cmd-a", "cmd-b"]);
		expect(ran).not.toContain("rm -rf /");
	});

	it("skips a file that can't be read", () => {
		const r = runDoctestSuite(["missing.md"], () => {
			throw new Error("ENOENT");
		}, () => ({ exitCode: 0 }));
		expect(r.total).toBe(0);
	});

	it("skips a file whose blocks are all untagged (continue on empty extraction)", () => {
		const ran: string[] = [];
		const r = runDoctestSuite(
			["plain.md"],
			() => "# just prose\n\n```bash\necho hi\n```\n",
			(code) => {
				ran.push(code);
				return { exitCode: 0 };
			},
		);
		expect(r).toEqual({ total: 0, failed: 0, failures: [] });
		expect(ran).toEqual([]);
	});
});

describe("findMarkdownFiles", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "doctest-find-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("finds .md files recursively and skips node_modules", () => {
		mkdirSync(join(cwd, "docs"), { recursive: true });
		mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(cwd, "README.md"), "#");
		writeFileSync(join(cwd, "docs", "guide.md"), "#");
		writeFileSync(join(cwd, "node_modules", "pkg", "readme.md"), "#");
		writeFileSync(join(cwd, "notes.txt"), "x");
		const found = findMarkdownFiles(cwd).map((f) => f.replace(`${cwd}/`, "")).sort();
		expect(found).toEqual(["README.md", "docs/guide.md"]);
	});

	// The two `catch → null` guards below are what make the walk survive a real
	// tree: a directory it may not list, and an entry it may not stat. Both are
	// provoked with permission bits rather than mocks, the same way
	// `manual-debt-markers.test.ts` provokes them, and both assert that the walk
	// KEEPS GOING — swallowing the error is only correct if the siblings still
	// land in the result.
	it("keeps collecting siblings when a subdirectory cannot be listed", () => {
		writeFileSync(join(cwd, "README.md"), "#");
		const blocked = join(cwd, "blocked");
		mkdirSync(blocked, { recursive: true });
		writeFileSync(join(blocked, "hidden.md"), "#");
		chmodSync(blocked, 0o000);
		try {
			const found = findMarkdownFiles(cwd).map((f) => f.replace(`${cwd}/`, ""));
			expect(found).toEqual(["README.md"]);
		} finally {
			// Restore before afterEach: rmSync cannot recurse into a 0o000 dir.
			chmodSync(blocked, 0o755);
		}
	});

	it("skips an entry it cannot stat instead of collecting it as markdown", () => {
		writeFileSync(join(cwd, "README.md"), "#");
		// Readable but not traversable: readdirSync lists `unstattable.md`,
		// statSync on it raises EACCES, so the walk must drop that ONE entry.
		const listable = join(cwd, "listable");
		mkdirSync(listable, { recursive: true });
		writeFileSync(join(listable, "unstattable.md"), "#");
		chmodSync(listable, 0o600);
		try {
			const found = findMarkdownFiles(cwd).map((f) => f.replace(`${cwd}/`, ""));
			expect(found).toEqual(["README.md"]);
		} finally {
			chmodSync(listable, 0o755);
		}
	});

	it("also skips .git and dist directories", () => {
		mkdirSync(join(cwd, ".git", "refs"), { recursive: true });
		mkdirSync(join(cwd, "dist", "sub"), { recursive: true });
		writeFileSync(join(cwd, "README.md"), "#");
		writeFileSync(join(cwd, ".git", "refs", "COMMIT_EDITMSG.md"), "#");
		writeFileSync(join(cwd, "dist", "sub", "bundled.md"), "#");
		const found = findMarkdownFiles(cwd).map((f) => f.replace(`${cwd}/`, "")).sort();
		expect(found).toEqual(["README.md"]);
	});
});

// ===========================================
// doctestCommand — the real entry point, real bash
// ===========================================
// These drive the actual production path (bashExec spawns real `bash`) against
// tmpdir fixtures, and assert on rendered console output / process.exitCode —
// the observable surface a caller (CI) actually depends on.
describe("doctestCommand", () => {
	let cwd: string;
	let logs: string[];
	let logSpy: ReturnType<typeof vi.spyOn>;
	let origExitCode: string | number | undefined;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "doctest-cmd-"));
		logs = [];
		origExitCode = process.exitCode;
		process.exitCode = undefined;
		logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(" "));
		});
	});

	afterEach(() => {
		logSpy.mockRestore();
		process.exitCode = origExitCode;
		rmSync(cwd, { recursive: true, force: true });
	});

	it("runs real bash for each tagged block, prints the failing one + summary, and sets exitCode 1", () => {
		const file = join(cwd, "guide.md");
		writeFileSync(file, ["```bash doctest", "true", "```", "```bash doctest", "exit 3", "```"].join("\n"));

		doctestCommand({ path: cwd });

		expect(logs).toEqual([`✗ ${file}:4 — exit 3`, "doctest: 1/2 block(s) passed"]);
		expect(process.exitCode).toBe(1);
	});

	it("prints machine-readable JSON and leaves exitCode untouched when every block passes", () => {
		writeFileSync(join(cwd, "guide.md"), ["```sh doctest", "true", "```"].join("\n"));

		doctestCommand({ path: cwd, json: true });

		expect(logs).toHaveLength(1);
		expect(JSON.parse(logs[0] as string)).toEqual({ total: 1, failed: 0, failures: [] });
		expect(process.exitCode).toBeUndefined();
	});

	it("accepts a direct file path (non-directory branch) instead of a directory root", () => {
		const file = join(cwd, "single.md");
		writeFileSync(file, ["```bash doctest", "false", "```"].join("\n"));

		doctestCommand({ path: file, json: true });

		expect(JSON.parse(logs[0] as string)).toEqual({
			total: 1,
			failed: 1,
			failures: [{ file, line: 1, exitCode: 1 }],
		});
		expect(process.exitCode).toBe(1);
	});

	it("defaults to process.cwd() when --path is omitted", () => {
		// Mock process.cwd() rather than actually chdir()-ing: a real chdir
		// mutates process-wide ambient state for the whole test worker, which
		// can leak into unrelated concurrently-running code. Mocking the
		// return value exercises the same `opts.path ?? process.cwd()`
		// branch with none of that risk, and is restored before this test
		// returns.
		writeFileSync(join(cwd, "cwd.md"), ["```bash doctest", "true", "```"].join("\n"));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		try {
			doctestCommand({ json: true });
		} finally {
			cwdSpy.mockRestore();
		}

		expect(JSON.parse(logs[0] as string)).toEqual({ total: 1, failed: 0, failures: [] });
	});

	it("treats a nonexistent path as zero files found (statSync throws -> catch -> [])", () => {
		doctestCommand({ path: join(cwd, "does-not-exist"), json: true });

		expect(JSON.parse(logs[0] as string)).toEqual({ total: 0, failed: 0, failures: [] });
		expect(process.exitCode).toBeUndefined();
	});
});

describe("registerDoctestCommand", () => {
	let cwd: string;
	let logs: string[];
	let logSpy: ReturnType<typeof vi.spyOn>;
	let origExitCode: string | number | undefined;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "doctest-register-"));
		logs = [];
		origExitCode = process.exitCode;
		process.exitCode = undefined;
		logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(" "));
		});
	});

	afterEach(() => {
		logSpy.mockRestore();
		process.exitCode = origExitCode;
		rmSync(cwd, { recursive: true, force: true });
	});

	it("wires a `doctest` subcommand with --path/--json options through to doctestCommand", async () => {
		writeFileSync(join(cwd, "guide.md"), ["```bash doctest", "true", "```"].join("\n"));
		const program = new Command();
		program.exitOverride();
		registerDoctestCommand(program);

		const sub = program.commands.find((c) => c.name() === "doctest");
		expect(sub).toBeDefined();
		expect(sub?.description()).toContain("doctest");
		const pathOpt = sub?.options.find((o) => o.long === "--path");
		const jsonOpt = sub?.options.find((o) => o.long === "--json");
		expect(pathOpt?.description).toBe("File or directory to scan (default: cwd)");
		expect(jsonOpt?.description).toBe("Machine-readable output");

		await program.parseAsync(["doctest", "--path", cwd, "--json"], { from: "user" });

		expect(JSON.parse(logs[0] as string)).toEqual({ total: 1, failed: 0, failures: [] });
	});
});
