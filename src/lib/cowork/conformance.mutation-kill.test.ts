import { expect, it } from "vitest";
import { analyzeCoworkConformance } from "./conformance.js";

const receipt = (control: string) =>
	JSON.stringify({
		schema: 1,
		provider: "cowork",
		sessionHash: "synthetic",
		event: "PreToolUse",
		tool: "Write",
		verdict: { decision: "allow", probeControl: control },
	});

// test-contract: public-api — a PRESENT timeout effect proves fail-open and an ABSENT one does not
it("reports fail_open_observed only when the timeout effect file is PRESENT", () => {
	const present = "PRESENT interlinked-probe-allow.txt\nPRESENT interlinked-probe-timeout.txt";
	const absent = "PRESENT interlinked-probe-allow.txt\nABSENT interlinked-probe-timeout.txt";
	expect(analyzeCoworkConformance(receipt("timeout"), present).conclusions.timeout).toBe(
		"fail_open_observed",
	);
	expect(analyzeCoworkConformance(receipt("timeout"), absent).conclusions.timeout).toBe(
		"unmeasured",
	);
});
