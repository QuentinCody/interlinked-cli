// `cd` hops are POSITIONAL: a `cd` that comes AFTER a write target in the same
// command does not move the directory that target resolves against.
//
// Bombadil trial 2026-10-03 (bombadil-trial.md §6): one compound command
// edited `scratch/bombadil-trial/wizard.spec.ts` in the repo with `sed -i`,
// then set `W=<session scratchpad>/bombadil-trial` and `cd $W/tb-cwd` to
// stage an unrelated fixture. `resolveCdBase` applied the LAST `cd` to every
// target, so the sed operand resolved into the scratchpad and
// `builtin-scratchpad-code-write` blocked an in-repo edit.

import { describe, expect, it } from "vitest";
import { detectBashCodeFileWrite, resolveBashWriteTarget } from "../pre-checks-bash-write-detect.js";

const ROOT = "/repo";
const SCRATCHPAD = "/private/tmp/claude-501/-repo/session-1/scratchpad";

/** The trial command, with the repo path replaced by ROOT. */
const TRIAL_CMD =
	`cd ${ROOT}/scratch/bombadil-trial; ` +
	`sed -i '' 's|{ TypeText: { CharSet: "abc" } }|{ TypeText: { Regexp: "[a-z]" } }|' wizard.spec.ts; ` +
	`rg -n 'Regexp' wizard.spec.ts; ` +
	`W=${SCRATCHPAD}/bombadil-trial; mkdir -p $W/tb-home $W/tb-cwd; cd $W/tb-cwd; ls -la; ` +
	`echo '{"name":"wizard-target"}' > package.json`;

describe("cd ordering — negative (a later cd must not move an earlier write)", () => {
	it("N1: REPRODUCTION — the trial's sed operand resolves into the repo, not the scratchpad", () => {
		expect(resolveBashWriteTarget(TRIAL_CMD, "wizard.spec.ts", ROOT)).toBe(
			`${ROOT}/scratch/bombadil-trial/wizard.spec.ts`,
		);
	});

	it("N2: the trial command is an IN-REPO write for the content gate, so the scratch steer stays silent", () => {
		const hit = detectBashCodeFileWrite(TRIAL_CMD, ROOT);
		expect(hit?.target).toBe("wizard.spec.ts");
		expect(hit?.mechanism).toContain("sed -i");
	});

	it("N3: a variable assigned to a scratchpad path, unused by the write, does not relocate a literal operand", () => {
		const cmd = `W=${SCRATCHPAD}; echo x > probe.ts; cd $W`;
		expect(resolveBashWriteTarget(cmd, "probe.ts", ROOT)).toBe(`${ROOT}/probe.ts`);
		expect(detectBashCodeFileWrite(cmd, ROOT)?.target).toBe("probe.ts");
	});

	it("N4: a cd AFTER a redirect leaves the redirect at the project root", () => {
		const cmd = `echo x > probe.ts && cd ${SCRATCHPAD}`;
		expect(resolveBashWriteTarget(cmd, "probe.ts", ROOT)).toBe(`${ROOT}/probe.ts`);
	});
});

describe("cd ordering — positive (an earlier cd still moves the write)", () => {
	it("P1: cd into the scratchpad before the write resolves there (redirect)", () => {
		const cmd = `cd ${SCRATCHPAD} && echo x > probe.ts`;
		expect(resolveBashWriteTarget(cmd, "probe.ts", ROOT)).toBe(`${SCRATCHPAD}/probe.ts`);
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("P2: `$W/x.ts` as the operand follows the variable wherever the cd is", () => {
		const cmd = `W=${SCRATCHPAD}; echo x > $W/x.ts; cd /elsewhere`;
		expect(resolveBashWriteTarget(cmd, "$W/x.ts", ROOT)).toBe(`${SCRATCHPAD}/x.ts`);
		expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
	});

	it("P3: the LAST cd before the write wins; a cd after it is ignored", () => {
		const cmd = `cd /a; cd ${SCRATCHPAD}; echo x > probe.ts; cd ${ROOT}/src`;
		expect(resolveBashWriteTarget(cmd, "probe.ts", ROOT)).toBe(`${SCRATCHPAD}/probe.ts`);
	});

	it("P4: cd into an in-repo subdirectory before a relative write is still a tracked-file hit", () => {
		const hit = detectBashCodeFileWrite("cd src && echo bad > util.ts; cd /tmp", ROOT);
		expect(hit?.target).toBe("util.ts");
	});

	it("P5: a synthesized target the command does not contain keeps the whole-command base", () => {
		// `(files named inside the diff)` is not a substring of the command, so
		// the resolver falls back to the pre-fix last-cd-wins behavior.
		expect(
			resolveBashWriteTarget(`cd ${SCRATCHPAD} && patch -p1 < x.diff`, "(files named inside the diff)", ROOT),
		).toBe(`${SCRATCHPAD}/(files named inside the diff)`);
	});
});
