import { expect, it } from "vitest";
import { checkThrowLiteral } from "./agent-safety-advanced-style.js";
import { withForegroundCheckScan } from "./check-scan-policy.js";
import { withProjectCheckEvidence } from "./project-check-evidence.js";

const source = Array.from({ length: 20 }, (_, index) => `function fail${index}() {\nthrow "failure";\n}`).join("\n");
const scan = () => checkThrowLiteral(source, "/repo/source.ts");

it("preserves bounded edit behavior before and after a complete foreground scan", () => {
	expect(scan()).toHaveLength(10);
	expect(withForegroundCheckScan(scan)).toHaveLength(20);
	expect(scan()).toHaveLength(10);
});

it("restores edit behavior after a failed foreground scan", () => {
	expect(() => withForegroundCheckScan(() => { throw new Error("scan failed"); })).toThrow("scan failed");
	expect(scan()).toHaveLength(10);
});

it("keeps asynchronous foreground work isolated from an unrelated edit", async () => {
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	const pending = withForegroundCheckScan(async () => { await held; return scan(); });
	expect(scan()).toHaveLength(10);
	release();
	expect(await pending).toHaveLength(20);
	expect(scan()).toHaveLength(10);
});

it("retains the full population in the foreground project context used by verify", async () => {
	const matches = await withProjectCheckEvidence("/repo", ["source.ts"], async () => {
		await Promise.resolve();
		return scan();
	});
	expect(matches).toHaveLength(20);
	expect(scan()).toHaveLength(10);
});
