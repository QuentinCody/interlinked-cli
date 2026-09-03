import { describe, expect, it } from "vitest";
import { tallySequence } from "./pattern-detector-sequence-tally.js";

describe("tallySequence", () => {
	it("returns a zeroed tally for an empty sequence", () => {
		expect(tallySequence([])).toEqual({
			editCount: 0,
			readCount: 0,
			bashCount: 0,
			testCount: 0,
			lastEditFile: "",
			consecutiveEditsToSameFile: 0,
			maxConsecutiveEdits: 0,
			editsSinceLastTest: 0,
		});
	});

	it("counts each tool family separately", () => {
		const tally = tallySequence(["Edit:a.ts", "Read:a.ts", "Bash:ls", "Glob:*.ts"]);
		expect(tally.editCount).toBe(1);
		expect(tally.readCount).toBe(2);
		expect(tally.bashCount).toBe(1);
	});

	it("ignores tools outside the three families", () => {
		const tally = tallySequence(["Task:sub", "WebFetch:https://example.com"]);
		expect(tally.editCount).toBe(0);
		expect(tally.readCount).toBe(0);
		expect(tally.bashCount).toBe(0);
	});

	it("tracks the longest run of edits to the same file", () => {
		const tally = tallySequence([
			"Edit:a.ts",
			"Edit:a.ts",
			"Edit:a.ts",
			"Edit:b.ts",
			"Edit:a.ts",
		]);
		expect(tally.maxConsecutiveEdits).toBe(3);
		expect(tally.lastEditFile).toBe("a.ts");
		expect(tally.consecutiveEditsToSameFile).toBe(1);
	});

	it("does not treat a run broken by a read as consecutive-file evidence", () => {
		const tally = tallySequence(["Edit:a.ts", "Read:a.ts", "Edit:a.ts"]);
		// A read does not reset the edit run — only a different target does.
		expect(tally.maxConsecutiveEdits).toBe(2);
	});

	it("resets editsSinceLastTest when a bash entry is a test command", () => {
		const tally = tallySequence([
			"Edit:a.ts",
			"Edit:a.ts",
			"Bash:npx vitest run",
			"Edit:a.ts",
		]);
		expect(tally.testCount).toBe(1);
		expect(tally.editsSinceLastTest).toBe(1);
	});

	it("does not reset editsSinceLastTest for a non-test bash command", () => {
		const tally = tallySequence(["Edit:a.ts", "Bash:ls -la", "Edit:a.ts"]);
		expect(tally.testCount).toBe(0);
		expect(tally.editsSinceLastTest).toBe(2);
	});

	it("treats an edit entry with no target as the empty file name", () => {
		const tally = tallySequence(["Edit", "Edit"]);
		expect(tally.lastEditFile).toBe("");
		expect(tally.maxConsecutiveEdits).toBe(0);
		expect(tally.editCount).toBe(2);
	});

	it("recognizes every documented tool alias", () => {
		const edits = [
			"Write",
			"Edit",
			"WriteFile",
			"EditFile",
			"write_file",
			"edit_file",
			"NotebookEdit",
		];
		expect(tallySequence(edits).editCount).toBe(edits.length);
		const reads = ["Read", "ReadFile", "read_file", "Glob", "Grep"];
		expect(tallySequence(reads).readCount).toBe(reads.length);
		const bash = ["Bash", "Shell", "shell", "run_command"];
		expect(tallySequence(bash).bashCount).toBe(bash.length);
	});

	it("keeps only the first colon-delimited segment as the target", () => {
		const tally = tallySequence(["Bash:npm run test:unit"]);
		expect(tally.testCount).toBe(1);
	});
});
