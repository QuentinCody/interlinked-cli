// ============================================================================
// Grep-accelerator differential verification
// ============================================================================
// The never-worse-than-native contract, checked empirically: for every query
// shape, `checkGrepAcceleration` must EITHER
//   (a) decline (return null) so the real rg/ugrep runs, OR
//   (b) substitute a result whose MATCH SET is identical to native `rg`.
//
// We build a real trigram index over real files on disk, force the freshness +
// size gates open (indexFresh:true, minFilesForAccel:1), and compare the
// accelerator's answer against ripgrep run over the same tree. The previously
// broken cases (-v, -l, -w, pipelines) must now decline.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { _resetRgPathCache, checkGrepAcceleration, findRipgrep } from "../grep-accelerator.js";
import { TrigramIndex } from "../trigram-index.js";
import type { HarnessEvent } from "../types.js";

_resetRgPathCache();
const RG = findRipgrep();
const HAVE_RG = RG !== null;

// Force the freshness + size gates open so we exercise the matching path; the
// gates themselves are unit-tested in trigram-accelerator.test.ts.
const CFG = { indexFresh: true, minFilesForAccel: 1 } as const;

const SELECTIVE = "ZephyrQuasarNebula"; // appears in exactly 3 files
const LITERAL_DOTS = "config.parse.value"; // dots: must be matched literally under -F

let dir: string;
let index: TrigramIndex;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "grepaccel-diff-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	for (let i = 0; i < 30; i++) {
		const extra =
			i === 3 || i === 7 || i === 15 ? `  // ${SELECTIVE} marker\n` : "";
		const dots = i === 2 || i === 9 ? `const v = "${LITERAL_DOTS}";\n` : "";
		writeFileSync(
			join(dir, "src", `mod${i}.ts`),
			`// module ${i}\nexport function handle${i}() {\n${extra}${dots}\treturn ${i};\n}\n`,
		);
	}
	// A committed git tree makes index.build's base-commit resolution realistic
	// (and mirrors a real repo). Match-set comparison ignores .git regardless.
	const git = (args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "ignore" });
	try {
		git(["init", "-q"]);
		git(["config", "user.email", "t@t"]);
		git(["config", "user.name", "t"]);
		git(["add", "-A"]);
		git(["commit", "-qm", "fixture"]);
	} catch (e) {
		void e; // git optional — index.build falls back to a filesystem walk
	}
	index = TrigramIndex.build({ cwd: dir });
});

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function grepEvent(pattern: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "diff",
		agent_source: "claude",
		tool_name: "Grep",
		tool_input: { pattern, path: "." },
		timestamp: "2026-05-29T00:00:00Z",
	};
}
function bashEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "diff",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-05-29T00:00:00Z",
	};
}

/** Parse `path:line:content` (native rg) into a normalized Set of "path:line". */
function parsePathLine(out: string): Set<string> {
	const set = new Set<string>();
	for (const line of out.split("\n")) {
		if (!line) continue;
		const m = line.match(/^(.+?):(\d+):/);
		if (m) set.add(`${nonNull(m[1]).replace(/^\.\//, "")}:${m[2]}`);
	}
	return set;
}

/** Parse the accelerator's file-grouped block reason into the same Set shape. */
function parseGroupedReason(reason: string): Set<string> {
	const set = new Set<string>();
	let current = "";
	for (const line of reason.split("\n")) {
		if (!line.trim()) continue;
		const m = line.match(/^(\d+):/);
		if (m && current) {
			set.add(`${current}:${m[1]}`);
		} else if (!/^\d+:/.test(line)) {
			current = line.replace(/^\.\//, "");
		}
	}
	return set;
}

/** Match set produced by native ripgrep over the whole tree. */
function nativeSet(extraArgs: string[], pattern: string): Set<string> {
	const res = spawnSync(
		nonNull(RG),
		[...extraArgs, "--no-heading", "--with-filename", "--line-number", "--color=never", "--", pattern, "."],
		{ cwd: dir, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
	);
	return parsePathLine(res.stdout || "");
}

describe.skipIf(!HAVE_RG)("grep accelerator — differential vs native rg", () => {
	it("Grep tool, selective literal: substituted match set == native", () => {
		const result = checkGrepAcceleration(grepEvent(SELECTIVE), index, CFG);
		expect(result?.decision).toBe("block");
		expect(parseGroupedReason(nonNull(result!.reason))).toEqual(nativeSet([], SELECTIVE));
	});

	it("Bash rg, selective literal: substituted match set == native", () => {
		const result = checkGrepAcceleration(bashEvent(`rg '${SELECTIVE}'`), index, CFG);
		expect(result?.decision).toBe("block");
		expect(parseGroupedReason(nonNull(result!.reason))).toEqual(nativeSet([], SELECTIVE));
	});

	it("Bash rg -F, literal with regex metachars: match set == native -F", () => {
		const result = checkGrepAcceleration(bashEvent(`rg -F '${LITERAL_DOTS}'`), index, CFG);
		expect(result?.decision).toBe("block");
		expect(parseGroupedReason(nonNull(result!.reason))).toEqual(
			nativeSet(["--fixed-strings"], LITERAL_DOTS),
		);
	});

	it("Bash rg, regex pattern: match set == native", () => {
		const result = checkGrepAcceleration(bashEvent(`rg '${SELECTIVE}\\s+marker'`), index, CFG);
		// Either declines (broad/stop-gram) or, if it substitutes, matches native.
		if (result?.decision === "block") {
			expect(parseGroupedReason(nonNull(result.reason))).toEqual(
				nativeSet([], `${SELECTIVE}\\s+marker`),
			);
		}
	});

	it("broad pattern is never substituted", () => {
		const result = checkGrepAcceleration(grepEvent("function"), index, CFG);
		expect(result?.decision).not.toBe("block");
	});

	// --- Previously-broken cases: must now decline (→ native runs) ---
	it("declines -v (invert) — never returns inverted-wrong results", () => {
		expect(checkGrepAcceleration(bashEvent(`rg -v '${SELECTIVE}'`), index, CFG)).toBeNull();
	});
	it("declines -l (files-with-matches)", () => {
		expect(checkGrepAcceleration(bashEvent(`rg -l '${SELECTIVE}'`), index, CFG)).toBeNull();
	});
	it("declines -w (word boundary)", () => {
		expect(checkGrepAcceleration(bashEvent(`rg -w 'handle'`), index, CFG)).toBeNull();
	});
	it("declines -A/-B/-C (context)", () => {
		expect(checkGrepAcceleration(bashEvent(`rg -A2 '${SELECTIVE}'`), index, CFG)).toBeNull();
	});
	it("declines pipelines / compound commands", () => {
		expect(checkGrepAcceleration(bashEvent(`rg '${SELECTIVE}' | head -3`), index, CFG)).toBeNull();
		expect(checkGrepAcceleration(bashEvent(`rg '${SELECTIVE}' && echo hi`), index, CFG)).toBeNull();
	});

	it("declines when the result would be truncated (completeness)", () => {
		// 'handle' matches all 30 files; with a tiny output budget the result
		// would truncate, so the accelerator must decline rather than return a
		// partial answer. (maxCandidateRatio raised so it isn't filtered as broad.)
		const result = checkGrepAcceleration(grepEvent("handle"), index, {
			...CFG,
			maxOutputLines: 2,
			maxCandidates: 10_000,
			maxCandidateRatio: 1,
		});
		expect(result).toBeNull();
	});

	it("declines when index is not fresh (staleness gate)", () => {
		expect(
			checkGrepAcceleration(grepEvent(SELECTIVE), index, { indexFresh: false, minFilesForAccel: 1 }),
		).toBeNull();
	});
});
