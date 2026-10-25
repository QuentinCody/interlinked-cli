// Red-team F1 (docs/design/red-team-findings-2026-08-09.md): the
// baseline-integrity gate only ran on Write/Edit/MultiEdit, so ANY shell write
// to a ratchet water-line was allowed — measured live: redirect, sed -i, tee,
// cp, and an interpreter one-liner all returned `allow`, which defeats every
// ratchet at once.
//
// 2026-08-10 scoped the refusal by REVERSIBILITY: a recoverable shell write was
// deferred to the effect arm on the claim that a loosening was "undoable and
// inert". The 2026-10-21 red team (scratch/2026-10-21-red-team/result.json,
// "Reversible-shell-write to a water-line (bash-arm fail-open)") measured that
// `cp /tmp/loosened.json .interlinked/metric-caps.json` landed a live 999 cap:
// the effect arm only warns, and the ratchets read the file on disk. The
// former N1–N6 "reversible" negatives WERE the hole, so they are positives now.
// Reversibility only tiers the wording ("cannot be undone" versus "cannot be
// inspected before it runs").

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselineBashWriteRefusal } from "./baseline-bash-guard.js";

const ROOT = "/repo";
const CAPS = "/repo/.interlinked/metric-caps.json";

describe("shell write examples remain data", () => {
	it("does not refuse a printed redirect or interpreter-write example", () => {
		expect(baselineBashWriteRefusal(`echo "example: echo x > ${CAPS}"`, ROOT)).toBeNull();
		expect(baselineBashWriteRefusal(`printf '%s' "writeFileSync('${CAPS}', 'x')"`, ROOT)).toBeNull();
	});

	it("still refuses real redirection and example text routed to a shell", () => {
		expect(baselineBashWriteRefusal(`echo "example" > ${CAPS}`, ROOT)).toContain("metric-caps.json");
		expect(baselineBashWriteRefusal(`echo "echo x > ${CAPS}" | sh`, ROOT)).toContain("metric-caps.json");
	});
});

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

// Converted from negatives by the 2026-10-21 red-team review: each of these
// was an allowed loosening path against the live daemon.
describe("baselineBashWriteRefusal — positive (reversible writes are refused too)", () => {
	it("P4: a shell redirect is refused — the ratchets read the resulting bytes from disk", () => {
		expect(baselineBashWriteRefusal(`echo '{}' > ${CAPS}`, ROOT)).toContain("metric-caps.json");
	});

	it("P5: tee is refused", () => {
		expect(baselineBashWriteRefusal(`echo '{}' | tee ${CAPS}`, ROOT)).toContain("metric-caps.json");
	});

	it("P6: in-place sed is refused", () => {
		expect(baselineBashWriteRefusal(`sed -i '' s/22/999/ ${CAPS}`, ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("P7: cp is refused (the confirmed bypass verb)", () => {
		expect(baselineBashWriteRefusal(`cp /tmp/x.json ${CAPS}`, ROOT)).toContain("metric-caps.json");
	});

	it("P8: an interpreter one-liner is refused", () => {
		const cmd = `python3 -c "open('${CAPS}','w').write('x')"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P9: TIGHTENING from the shell is refused too — pre-execution the bytes are unknowable; the Edit tool adjudicates it", () => {
		expect(baselineBashWriteRefusal(`echo '{"max_cyclomatic":18}' > ${CAPS}`, ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("P10: a reversible refusal says the bytes cannot be inspected, not that they cannot be undone", () => {
		const reason = baselineBashWriteRefusal(`cp /tmp/x.json ${CAPS}`, ROOT) ?? "";
		expect(reason).toContain("cannot be inspected before it runs");
		expect(reason).not.toContain("cannot be undone");
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
// (isBaselinePath / unquoteToken / segmentWriteTargets / shellWriteTargets)
// that are not exported on their own — every assertion goes through the public
// `baselineBashWriteRefusal` entry point, same as the rest of this file.
//
// Until 2026-10-21 these commands needed an `rm -rf &&` decoy prefix to get
// past the reversibility short-circuit; the red-team review removed that
// short-circuit, so the bare verbs now reach the scanner on their own.

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

	// Operands are tokenized by the canonical shell scan (commit-parse-shell.ts)
	// since 2026-10-22. The old `unquoteToken` only trimmed a quote at either
	// END of a token, so a quote inside the word hid a real deletion of the
	// water-line: `rm -rf /repo/.interlinked/'metric-caps'.json` was allowed.
	it("P4: a quote inside a word concatenates, as in the shell, so the water-line is still named", () => {
		expect(baselineBashWriteRefusal(`rm -rf /repo/.interlinked/'metric-caps'.json`, ROOT)).toContain(
			"metric-caps.json",
		);
		expect(baselineBashWriteRefusal(`rm -rf /repo/.interlinked/"metric-caps".json`, ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("P5: an unterminated quote runs to the end of the command and is refused (fail-closed)", () => {
		// The shell rejects the line; refusing it costs nothing. The pre-2026-10-22
		// expectation was null, because the old trimmer left the stray quote in
		// the path.
		expect(baselineBashWriteRefusal(`rm -rf /repo/.interlinked/'metric-caps.json`, ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("N1: a quoted SIBLING of a water-line is not the water-line", () => {
		expect(baselineBashWriteRefusal(`rm -rf '/repo/.interlinked/metric-caps.json.bak'`, ROOT)).toBeNull();
		expect(baselineBashWriteRefusal(`rm -rf "/repo/.interlinked/metric-caps"`, ROOT)).toBeNull();
	});

	it("P6: a backslash separator inside quotes still normalizes to a baseline match", () => {
		expect(baselineBashWriteRefusal(`rm -rf '/repo/.interlinked\\metric-caps.json'`, ROOT)).toContain(
			"metric-caps.json",
		);
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
			baselineBashWriteRefusal(`cp /tmp/src ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("N1: cp reading FROM a baseline and writing elsewhere is not a loosening", () => {
		expect(
			baselineBashWriteRefusal(`cp ${CAPS} /tmp/dest`, ROOT),
		).toBeNull();
	});

	it.each([
		["mv", `mv /tmp/src ${CAPS}`],
		["install", `install /tmp/src ${CAPS}`],
	])("P2: %s's destination is a target too", (_verb, cmd) => {
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P3: a trailing dash-prefixed operand is excluded, so it cannot mask the real destination", () => {
		expect(baselineBashWriteRefusal(`cp ${CAPS} -x`, ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("N2: a copy-family verb with no positional operand does not crash the scan", () => {
		const cmd = `cp -v -n`;
		expect(() => baselineBashWriteRefusal(cmd, ROOT)).not.toThrow();
		expect(baselineBashWriteRefusal(cmd, ROOT)).toBeNull();
	});
});

describe("baselineBashWriteRefusal — sed in-place editing requires the -i flag", () => {
	it("P1: sed -i writing to a baseline is a target", () => {
		expect(
			baselineBashWriteRefusal(`sed -i s/a/b/ ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("N1: sed WITHOUT -i only edits its own stdout stream, not the file", () => {
		expect(
			baselineBashWriteRefusal(`sed s/a/b/ ${CAPS}`, ROOT),
		).toBeNull();
	});
});

describe("baselineBashWriteRefusal — only write-capable verbs are scanned past the flags", () => {
	it("N1: naming a baseline path as a plain argument to an untracked verb is not a write", () => {
		expect(baselineBashWriteRefusal(`echo x ${CAPS}`, ROOT)).toBeNull();
	});

	it("N2: an -i-shaped token does not turn an unrelated verb into an in-place editor", () => {
		expect(baselineBashWriteRefusal(`echo -i x ${CAPS}`, ROOT)).toBeNull();
	});
});

describe("baselineBashWriteRefusal — WRITE_MECHANISMS regex precision", () => {
	it("P1: a single `>` redirect with one space is a target", () => {
		expect(baselineBashWriteRefusal(`echo x > ${CAPS}`, ROOT)).toContain(
			"metric-caps.json",
		);
	});

	it("P2: a `>` redirect tolerates extra spaces around a quoted path", () => {
		expect(
			baselineBashWriteRefusal(`echo x >  '${CAPS}'`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P3: tee with one space before the path is a target", () => {
		expect(
			baselineBashWriteRefusal(`echo x | tee ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P4: tee tolerates extra spaces before the path", () => {
		expect(
			baselineBashWriteRefusal(`echo x | tee  ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P5: tee -a tolerates extra spaces after the append flag", () => {
		expect(
			baselineBashWriteRefusal(`echo x | tee -a  ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P6: tee --append tolerates extra spaces after the long append flag", () => {
		expect(
			baselineBashWriteRefusal(`echo x | tee --append  ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P7: tee -- tolerates extra spaces after the end-of-options marker", () => {
		expect(
			baselineBashWriteRefusal(`echo x | tee --  ${CAPS}`, ROOT),
		).toContain("metric-caps.json");
	});

	it("P8: a Python open() one-liner in write mode is a target", () => {
		const cmd = `python3 -c "open('${CAPS}','w').write(x)"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P9: open() tolerates extra spaces inside the argument list", () => {
		const cmd = `python3 -c "open(  '${CAPS}'  ,  'w').write(x)"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P10: open() tolerates a space before the opening paren", () => {
		const cmd = `python3 -c "open ('${CAPS}','w').write(x)"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P11: a writeFileSync() one-liner is a target", () => {
		const cmd = `node -e "require('fs').writeFileSync('${CAPS}',x)"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("P12: writeFileSync() tolerates a space before the opening paren", () => {
		const cmd = `node -e "writeFileSync ('${CAPS}',x)"`;
		expect(baselineBashWriteRefusal(cmd, ROOT)).toContain("metric-caps.json");
	});

	it("N13: a newline SEPARATES commands — `cp\\n<water-line>` runs a bare `cp` that writes nothing", () => {
		// Pre-2026-10-22 the newline was joined into a space, so this read as
		// `cp <water-line>` and was refused (P13). The shell runs `cp` with no
		// operands and then tries to execute the water-line file; nothing writes it.
		expect(baselineBashWriteRefusal(`cp\n${CAPS}`, ROOT)).toBeNull();
	});

	it("P13: a newline separates commands, so a write on the SECOND line is a target", () => {
		expect(baselineBashWriteRefusal(`true\ncp /tmp/x ${CAPS}`, ROOT)).toContain("metric-caps.json");
		expect(baselineBashWriteRefusal(`# note\ncp /tmp/x ${CAPS}`, ROOT)).toContain("metric-caps.json");
	});

	it("P14: a subshell, a wrapper with options, a `bash -c` program and a trailing redirect do not hide the destination", () => {
		for (const cmd of [
			`(cp /tmp/x ${CAPS})`,
			`{ cp /tmp/x ${CAPS}; }`,
			`sudo -u root cp /tmp/x ${CAPS}`,
			`bash -c 'cp /tmp/x ${CAPS}'`,
			`cp /tmp/x ${CAPS} 2>/dev/null`,
			`for f in a; do cp /tmp/x ${CAPS}; done`,
		]) {
			expect(baselineBashWriteRefusal(cmd, ROOT), cmd).toContain("metric-caps.json");
		}
	});

	it("N14: a quoted separator or a heredoc body is data, not a write", () => {
		expect(baselineBashWriteRefusal(`echo "true; cp /tmp/x ${CAPS}"`, ROOT)).toBeNull();
		expect(baselineBashWriteRefusal(`cat <<'EOF'\ncp /tmp/x ${CAPS}\nEOF`, ROOT)).toBeNull();
		expect(baselineBashWriteRefusal(`cp ${CAPS} /tmp/backup.json`, ROOT)).toBeNull();
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
