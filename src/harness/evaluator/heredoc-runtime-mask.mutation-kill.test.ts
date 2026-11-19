import { describe, expect, it } from "vitest";
import { strictRuntimeWord } from "./heredoc-runtime-mask.js";

describe("heredoc-runtime-mask mutation-kill", () => {
	// test-contract: public-api — deno is a non-shell runtime, so `deno run -` is recognized as the literal runtime word
	it("recognizes deno as a non-shell runtime command word", () => {
		expect(strictRuntimeWord(["deno", "run", "-"])).toBe("deno");
	});

	// test-contract: public-api — a path-qualified deno binary behind env assignments is still the runtime word
	it("recognizes /usr/local/bin/deno after an env assignment", () => {
		expect(strictRuntimeWord(["FOO=1", "/usr/local/bin/deno", "run", "-"])).toBe("deno");
	});
});
