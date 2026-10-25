import { describe, expect, it } from "vitest";
import { memberChainStart } from "./member-chain-scan.js";

/** Chain head text for the `.forEach` in `src`. */
function headOf(src: string): string {
	const dot = src.indexOf(".forEach");
	return src.slice(memberChainStart(src, dot), dot);
}

describe("memberChainStart", () => {
	it("returns the receiver identifier of a one-link chain", () => {
		expect(headOf("await xs.forEach(f)")).toBe("xs");
	});

	it("walks back over member links and closed calls", () => {
		expect(headOf("await this.src.map((x) => g(x)).forEach(f)")).toBe("this.src.map((x) => g(x))");
	});

	it("walks back over a multi-line chain", () => {
		expect(headOf("await readable\n  .filter((c) => c)\n  .forEach(f)")).toBe(
			"readable\n  .filter((c) => c)\n  ",
		);
	});

	it("walks back over optional and non-null links and index access", () => {
		expect(headOf("x = a?.b!.c[0].forEach(f)")).toBe("a?.b!.c[0]");
	});

	it("stops at an enclosing call's open paren", () => {
		expect(headOf("await Promise.all(xs.forEach(f))")).toBe("xs");
	});

	it("yields an empty head at an unbalanced close bracket", () => {
		expect(headOf(") ) .forEach(f)")).toBe("");
	});
});
