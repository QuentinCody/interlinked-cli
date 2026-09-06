import { describe, expect, it } from "vitest";
import { type DoctestExec, extractDoctestBlocks, runDocExamples } from "./doctest.js";

const DOC = [
	"# Title",
	"",
	"Illustrative (must NOT run):",
	"```bash",
	"rm -rf /",
	"```",
	"",
	"Runnable:",
	"```bash doctest",
	"interlinked --version",
	"echo ok",
	"```",
	"",
	"Another runnable:",
	"```sh doctest",
	"npm run typecheck",
	"```",
].join("\n");

describe("extractDoctestBlocks", () => {
	it("extracts only doctest-tagged fences, not illustrative ones", () => {
		const blocks = extractDoctestBlocks(DOC);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.lang).toBe("bash");
		expect(blocks[0]?.code).toBe("interlinked --version\necho ok");
		expect(blocks[1]?.lang).toBe("sh");
		expect(blocks[1]?.code).toBe("npm run typecheck");
	});

	it("does NOT extract the untagged rm -rf block", () => {
		const codes = extractDoctestBlocks(DOC).map((b) => b.code);
		expect(codes.some((c) => c.includes("rm -rf"))).toBe(false);
	});

	it("returns [] when there are no doctest blocks", () => {
		expect(extractDoctestBlocks("```bash\nls\n```\n")).toEqual([]);
	});

	it("closes an open doctest block when the next fence carries its own info string", () => {
		// Exercises `advanceOpenDoctestBlock`'s second branch: a fence line with
		// a non-empty info string (here "python") is not a BARE closing fence
		// (that's the first branch), but it is still a fence, so it closes the
		// currently open block as a body-end guard rather than being folded
		// into the block's code. The new fence itself does not open a block on
		// the same pass (the caller `continue`s past it).
		const doc = ["```bash doctest", "echo hi", "```python", "noop"].join("\n");
		const blocks = extractDoctestBlocks(doc);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.lang).toBe("bash");
		expect(blocks[0]?.code).toBe("echo hi");
	});
});

describe("runDocExamples", () => {
	it("marks a block ok on exit 0 and failed otherwise", () => {
		const blocks = extractDoctestBlocks(DOC);
		const exec: DoctestExec = (code) =>
			code.includes("typecheck") ? { exitCode: 1, output: "type error" } : { exitCode: 0 };
		const summary = runDocExamples(blocks, exec);
		expect(summary.total).toBe(2);
		expect(summary.failed).toBe(1);
		expect(summary.results[0]?.ok).toBe(true);
		expect(summary.results[1]?.ok).toBe(false);
		expect(summary.results[1]?.output).toBe("type error");
	});

	it("passes when every block exits 0", () => {
		const summary = runDocExamples(extractDoctestBlocks(DOC), () => ({ exitCode: 0 }));
		expect(summary.failed).toBe(0);
	});
});
