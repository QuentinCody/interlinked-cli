// Red-team F1 (docs/design/red-team-findings-2026-08-09.md): the
// baseline-integrity gate only ran on Write/Edit/MultiEdit, so ANY shell write
// to a ratchet water-line was allowed — measured live: redirect, sed -i, tee,
// cp, and an interpreter one-liner all returned `allow`, which defeats every
// ratchet at once.
//
// The refusal here is now scoped by REVERSIBILITY (2026-08-10). A recoverable
// shell write is no longer refused: the effect arm snapshots the water-lines
// before the call, so a loosening is undoable and inert
// (baseline-effect-guard.ts), and refusing it would also refuse the legitimate
// case this gate cannot see pre-execution — TIGHTENING a water-line from the
// shell. What still blocks here is the irreversible command, because no
// post-hoc evidence brings those bytes back.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselineBashWriteRefusal } from "./baseline-bash-guard.js";

const ROOT = "/repo";
const CAPS = "/repo/.interlinked/metric-caps.json";

describe("baselineBashWriteRefusal — positive (must refuse: irreversible)", () => {
	it("P1: a recursive delete of a baseline cannot be undone", () => {
		expect(baselineBashWriteRefusal(`rm -rf ${CAPS}`, ROOT)).toContain("metric-caps.json");
	});

	it("P2: dd over a baseline destroys the prior bytes", () => {
		expect(baselineBashWriteRefusal(`dd if=/tmp/x.json of=${CAPS}`, ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("P3: the refusal names the irreversibility, not a generic denial", () => {
		expect(baselineBashWriteRefusal(`rm -rf ${CAPS}`, ROOT)).toContain("cannot be undone");
	});
});

describe("baselineBashWriteRefusal — negative (reversible: deferred to the effect arm)", () => {
	it("N1: a shell redirect is recoverable, so it is not refused here", () => {
		expect(baselineBashWriteRefusal(`echo '{}' > ${CAPS}`, ROOT)).toBeNull();
	});

	it("N2: tee is recoverable", () => {
		expect(baselineBashWriteRefusal(`echo '{}' | tee ${CAPS}`, ROOT)).toBeNull();
	});

	it("N3: in-place sed is recoverable", () => {
		expect(baselineBashWriteRefusal(`sed -i '' s/22/999/ ${CAPS}`, ROOT)).toBeNull();
	});

	it("N4: cp is recoverable", () => {
		expect(baselineBashWriteRefusal(`cp /tmp/x.json ${CAPS}`, ROOT)).toBeNull();
	});

	it("N5: an interpreter one-liner is recoverable", () => {
		const cmd = `python3 -c "open('${CAPS}','w').write('x')"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toBeNull();
	});

	it("N6: TIGHTENING from the shell — the case a pre-execution refusal cannot distinguish", () => {
		expect(baselineBashWriteRefusal(`echo '{"max_cyclomatic":18}' > ${CAPS}`, ROOT)).toBeNull();
	});
});

describe("baselineBashWriteRefusal — negative (not this gate's business)", () => {
	it("N7: reading a baseline is untouched", () => {
		expect(baselineBashWriteRefusal(`cat ${CAPS}`, ROOT)).toBeNull();
	});

	it("N8: an irreversible command on a NON-baseline path is not this gate's business", () => {
		expect(baselineBashWriteRefusal("rm -rf /repo/.interlinked/activity.jsonl", ROOT)).toBeNull();
	});

	it("N9: an irreversible command on ordinary source is not this gate's business", () => {
		expect(baselineBashWriteRefusal("rm -rf /repo/src/foo.ts", ROOT)).toBeNull();
	});

	it("N10: a baseline path merely mentioned with no write mechanism", () => {
		expect(baselineBashWriteRefusal(`rg pattern ${CAPS}`, ROOT)).toBeNull();
	});

	it("N11: a baseline-like path outside .interlinked", () => {
		expect(baselineBashWriteRefusal("rm -rf /repo/docs/metric-caps.json", ROOT)).toBeNull();
	});

	it("N12: an empty command", () => {
		expect(baselineBashWriteRefusal("", ROOT)).toBeNull();
	});
});

describe("baselineBashWriteRefusal — bypass", () => {
	const prior = process.env.INTERLINKED_DISABLE_BASELINE_GUARD;

	beforeEach(() => {
		process.env.INTERLINKED_DISABLE_BASELINE_GUARD = "1";
	});

	afterEach(() => {
		if (prior === undefined) delete process.env.INTERLINKED_DISABLE_BASELINE_GUARD;
		else process.env.INTERLINKED_DISABLE_BASELINE_GUARD = prior;
	});

	it("N13: the documented reset env var disables even the irreversible refusal", () => {
		expect(baselineBashWriteRefusal(`rm -rf ${CAPS}`, ROOT)).toBeNull();
	});
});

// The describes below target the individual scanning helpers
// (isBaselinePath / unquoteToken / segmentWriteTargets / writeTargets) that
// are not exported on their own — every assertion goes through the public
// `baselineBashWriteRefusal` entry point, same as the rest of this file.
//
// `cp`, `mv`, `install`, and `sed` are all classified REVERSIBLE on their own
// (effectIsReversible only refuses them via the irreversible-pattern list), so
// a bare command using one of those verbs short-circuits to `null` before the
// destination-scanning logic in segmentWriteTargets ever runs. IRREVERSIBLE_DECOY
// is a standalone `rm -rf` with no operand: it satisfies effectIsReversible's
// whole-command check on its own and, because it targets nothing, never adds a
// write target of its own — so appending it lets the rest of the command
// exercise the cp/mv/install/sed-specific scanning without contaminating the
// result.
const IRREVERSIBLE_DECOY = "rm -rf &&";

describe("baselineBashWriteRefusal — path normalization and quoting", () => {
	it("P1: a backslash path separator still normalizes to a baseline match", () => {
		expect(
			baselineBashWriteRefusal("rm -rf /repo/.interlinked\\metric-caps.json", ROOT),
		).toContain("metric-caps.json");
	});

	it("P2: a project-relative rm target (no leading slash) resolves against the project root", () => {
		expect(baselineBashWriteRefusal("rm -rf .interlinked/metric-caps.json", ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("P3: a single-quoted rm target has its quotes stripped, not replaced with placeholder text", () => {
		expect(baselineBashWriteRefusal(`rm -rf '${CAPS}'`, ROOT)).toContain("metric-caps.json");
	});

	it("N1: a stray quote character inside a target is not treated as wrapping punctuation", () => {
		expect(baselineBashWriteRefusal(`rm -rf /repo/.interlinked/'metric-caps.json`, ROOT)).toBeNull();
	});
});

describe("baselineBashWriteRefusal — rm operand scanning", () => {
	it("N1: a dash-prefixed rm operand is excluded from targets, even if it spells a baseline path", () => {
		expect(baselineBashWriteRefusal("rm -rf -/.interlinked/metric-caps.json", ROOT)).toBeNull();
	});
});

describe("baselineBashWriteRefusal — cp/mv/install write to the destination only", () => {
	it("P1: cp's destination is a target", () => {
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} cp /tmp/src ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("N1: cp reading FROM a baseline and writing elsewhere is not a loosening", () => {
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} cp ${CAPS} /tmp/dest`, ROOT),
		).toBeNull();
	});

	it.each([
		["mv", `${IRREVERSIBLE_DECOY} mv /tmp/src ${CAPS}`],
		["install", `${IRREVERSIBLE_DECOY} install /tmp/src ${CAPS}`],
	])("P2: %s's destination is a target too", (_verb, cmd) => {
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P3: a trailing dash-prefixed operand is excluded, so it cannot mask the real destination", () => {
		expect(baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} cp ${CAPS} -x`, ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("N2: a copy-family verb with no positional operand does not crash the scan", () => {
		const cmd = `${IRREVERSIBLE_DECOY} cp -v -n`;
		expect(() => baselineBashWriteRefusal(cmd, ROOT)).not.toThrow();
		expect(baselineBashWriteRefusal(cmd, ROOT)).toBeNull();
	});
});

describe("baselineBashWriteRefusal — sed in-place editing requires the -i flag", () => {
	it("P1: sed -i writing to a baseline is a target", () => {
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} sed -i s/a/b/ ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("N1: sed WITHOUT -i only edits its own stdout stream, not the file", () => {
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} sed s/a/b/ ${CAPS}`, ROOT),
		).toBeNull();
	});
});

describe("baselineBashWriteRefusal — only write-capable verbs are scanned past the flags", () => {
	it("N1: naming a baseline path as a plain argument to an untracked verb is not a write", () => {
		expect(baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} echo x ${CAPS}`, ROOT)).toBeNull();
	});

	it("N2: an -i-shaped token does not turn an unrelated verb into an in-place editor", () => {
		expect(baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} echo -i x ${CAPS}`, ROOT)).toBeNull();
	});
});

describe("baselineBashWriteRefusal — WRITE_MECHANISMS regex precision", () => {
	it("P1: a single `>` redirect with one space is a target", () => {
		expect(baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} echo x > ${CAPS}`, ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("P2: a `>` redirect tolerates extra spaces around a quoted path", () => {
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} echo x >  '${CAPS}'`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P3: tee with one space before the path is a target", () => {
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} echo x | tee ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P4: tee tolerates extra spaces before the path", () => {
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} echo x | tee  ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P5: tee -a tolerates extra spaces after the append flag", () => {
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} echo x | tee -a  ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P6: tee --append tolerates extra spaces after the long append flag", () => {
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} echo x | tee --append  ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P7: tee -- tolerates extra spaces after the end-of-options marker", () => {
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} echo x | tee --  ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P8: a Python open() one-liner in write mode is a target", () => {
		const cmd = `${IRREVERSIBLE_DECOY} python3 -c "open('${CAPS}','w').write(x)"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P9: open() tolerates extra spaces inside the argument list", () => {
		const cmd = `${IRREVERSIBLE_DECOY} python3 -c "open(  '${CAPS}'  ,  'w').write(x)"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P10: open() tolerates a space before the opening paren", () => {
		const cmd = `${IRREVERSIBLE_DECOY} python3 -c "open ('${CAPS}','w').write(x)"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P11: a writeFileSync() one-liner is a target", () => {
		const cmd = `${IRREVERSIBLE_DECOY} node -e "require('fs').writeFileSync('${CAPS}',x)"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P12: writeFileSync() tolerates a space before the opening paren", () => {
		const cmd = `${IRREVERSIBLE_DECOY} node -e "writeFileSync ('${CAPS}',x)"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P13: a bare newline between two tokens is normalized to a separator, not deleted", () => {
		// If the newline were dropped instead of replaced with a space, "cp" and
		// the path glue into one token and the verb no longer parses as "cp".
		expect(
			baselineBashWriteRefusal(`${IRREVERSIBLE_DECOY} cp\n${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});
});

describe("baselineBashWriteRefusal — refusal message content", () => {
	it("P1: the message shows the bare filename, not the full resolved path", () => {
		const result = baselineBashWriteRefusal(`rm -rf ${CAPS}`, ROOT);
		expect(result).toContain("metric-caps.json");
		expect(result).not.toContain("/repo/.interlinked/metric-caps.json");
	});

	it("P2: the message documents the tightening-only rule and the escape hatch", () => {
		const result = baselineBashWriteRefusal(`rm -rf ${CAPS}`, ROOT) ?? "";
		expect(result).toContain("Water-lines may only move in the tightening direction");
		expect(result).toContain("gate inspects the proposed content");
		expect(result).toContain("raise the line itself by meeting the bar");
		expect(result).toContain("for an intentional reset");
	});
});

describe("baselineBashWriteRefusal — every water-line basename is protected", () => {
	it.each([
		"coverage-baseline.json",
		"coverage-edit-baseline.json",
		"mutation-baseline.json",
		"mutation-manifest.json",
		"large-files-baseline.json",
		"untested-files-baseline.json",
		"skipped-tests-baseline.json",
		"check-evidence-baseline.json",
		"function-complexity-baseline.json",
	])("P: rm -rf against %s is refused", (basename) => {
		expect(baselineBashWriteRefusal(`rm -rf /repo/.interlinked/${basename}`, ROOT)).toContain(
			basename,
		);
	});
});
