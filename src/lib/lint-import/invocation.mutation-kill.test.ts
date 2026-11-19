import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importedLintInvocation } from "./invocation.js";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "lint-invocation-kill-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("lint-import invocation mutation kills", () => {
	// test-contract: public-api — importedLintInvocation caps clippy lints to warnings after the "--" separator
	it("passes --cap-lints=warn to clippy after the separator", () => {
		const { args } = importedLintInvocation(root, { tool: "clippy", scope: ".", sources: ["config"] });
		expect(args.slice(-2)).toEqual(["--", "--cap-lints=warn"]);
	});
});
