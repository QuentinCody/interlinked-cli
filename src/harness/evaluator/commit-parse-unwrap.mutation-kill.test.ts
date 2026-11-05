// Mutation-directed companion for commit-parse-unwrap.ts (kill-proof census
// 2026-11-05). Fault: `zsh` dropped from SHELLS, so `zsh -c 'git commit …'`
// is returned as the command itself (program null) and every commit gate
// stops seeing a git commit launched through zsh.
import { describe, expect, it } from "vitest";
import { isShellName, unwrapCommand } from "./commit-parse-unwrap.js";

describe("unwrapCommand — zsh is a shell interpreter", () => {
	// test-contract: public-api - `zsh -c <program>` returns the inline program for the caller to recurse into, exactly like bash and sh
	it("returns the inline program of zsh -c", () => {
		expect(unwrapCommand(["zsh", "-c", "git commit -m x"])).toEqual({ argv: [], cwd: null, program: "git commit -m x" });
		expect(unwrapCommand(["/bin/zsh", "-lc", "git commit"])?.program).toBe("git commit");
	});

	// test-contract: public-api - isShellName recognizes zsh by basename
	it("recognizes zsh as a shell name", () => {
		expect(isShellName("zsh")).toBe(true);
		expect(isShellName("/usr/bin/zsh")).toBe(true);
	});
});
