// Mutation-directed companion for wrapper-normalization.ts (kill-proof census
// 2026-11-05). Fault: the sudo/doas long-flag alternation loses its optional
// `=value` (`(?:=\S+)?` → `(?:=\S+)`), so a value-less long flag such as
// `--login` is no longer stripped and anchored destructive patterns miss.
import { describe, expect, it } from "vitest";
import { normalizeCommandWrappers } from "./wrapper-normalization.js";

describe("normalizeCommandWrappers — value-less long flags", () => {
	// test-contract: public-api - `sudo --login rm -rf /` must normalize to the bare destructive command, exactly like `sudo -E rm -rf /`
	it("strips sudo with a value-less long flag", () => {
		expect(normalizeCommandWrappers("sudo --login rm -rf /")).toBe("rm -rf /");
	});

	// test-contract: boundary - a mix of short, value-less long and valued long flags is stripped as one prefix
	it("strips sudo with mixed short, value-less long and valued long flags", () => {
		expect(normalizeCommandWrappers("sudo -n --non-interactive --user=root git push --force")).toBe("git push --force");
	});
});
