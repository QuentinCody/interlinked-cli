// A KILLED release or restore (design §9, R37 and the seventh review): a child process runs the real command and
// exits at the Nth rename, so no catch/rollback runs — exactly a SIGKILL between the two renames. The parent then
// checks, from outside, that the words still exist somewhere, that the fallback hands them to the agent, and that
// re-running `restore` converges. Helper-only tests cannot show this; only a killed process can.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPacketFile } from "../harness/packets/evaluator.js";
import { startFallbackLines } from "../harness/packets/fallback-start.js";
import { sampleFile, warnPacket } from "../harness/packets/fixtures.js";
import { parsePacketFile } from "../harness/packets/schema.js";
import type { GuardRulesConfig } from "../harness/types.js";
import { packetsReleaseCommand, packetsRestoreCommand } from "./packets-release.js";
import { acquirePacketLock, sweepStaleTemps } from "./packets-release-io.js";

const WORDS = "Never full-read `collection.jsonl`, `activity.jsonl`, or `timeline.jsonl` (hundreds of MB); use `interlinked query` or `tail -n`.";
const SOURCE = `# rules\n\n- ${WORDS}\n- Keep cwd at the repo root.\n`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const COMMAND_MODULE = fileURLToPath(new URL("./packets-release.ts", import.meta.url));
const RULES = { jev: { enabled: true }, packets: { enabled: true, evidence_consent: { kinds: ["command"], paths: [] } } } as unknown as GuardRulesConfig;

let tmp: string;
const packetPath = () => join(tmp, ".interlinked", "instruction-packets.json");
const source = () => readFileSync(join(tmp, "CLAUDE.md"), "utf8");
const released = () => {
	const parsed = parsePacketFile(readFileSync(packetPath(), "utf8"));
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.value.packets[0]?.release ?? null;
};
const temps = () => [...readdirSync(tmp), ...readdirSync(join(tmp, ".interlinked"))].filter((n) => n.endsWith(".tmp"));

/** Run `action` in a child that exits 95 at the `killAt`-th renameSync — no rollback, no finally. With `throwAt`,
 *  that rename THROWS first (the rollback path runs), and `killAt` can then land inside the rollback. */
function killed(action: "release" | "restore", killAt: number, throwAt = 0): void {
	const child = [
		'import fs from "node:fs";',
		'import { syncBuiltinESMExports } from "node:module";',
		"const rename = fs.renameSync; let n = 0;",
		`fs.renameSync = (a, b) => { ++n; if (n === ${killAt}) process.exit(95); if (n === ${throwAt}) throw new Error("EIO: injected"); return rename(a, b); };`,
		"syncBuiltinESMExports();",
		`const m = await import(${JSON.stringify(COMMAND_MODULE)});`,
		"console.log = () => {}; console.error = () => {};",
		`let code; try { code = m.${action === "release" ? "packetsReleaseCommand" : "packetsRestoreCommand"}({ cwd: ${JSON.stringify(tmp)}, file: "CLAUDE.md" }); } catch { process.exit(96); }`,
		"process.exit(10 + code);",
	].join("\n");
	const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child], { encoding: "utf8", timeout: 60_000 });
	// A kill exits 95; an injected write error must surface as the command's clean exit 1 (10 + 1), never a throw.
	expect(run.status, run.stderr).toBe(killAt > 0 ? 95 : 11);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "packets-release-kill-"));
	mkdirSync(join(tmp, ".interlinked"));
	writeFileSync(join(tmp, "CLAUDE.md"), SOURCE);
	const live = warnPacket({ source: { file: "CLAUDE.md", span: null, quote: WORDS } });
	writeFileSync(packetPath(), JSON.stringify(sampleFile([live], { sources: { "CLAUDE.md": sha(SOURCE) } })));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(tmp, { recursive: true, force: true });
});

describe("a restore killed between its two renames keeps the words (seventh review, P1)", () => {
	it("P1: the source got the words back first; the fallback still delivers them; a retried restore converges byte-identically", () => {
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		expect(source()).not.toContain(WORDS);
		killed("restore", 2);
		// Words are back in the instruction file AND still in release.text: no instant without them.
		expect(source()).toContain(WORDS);
		expect(released()?.text).toBe(WORDS);
		expect(loadPacketFile(tmp, packetPath()).ok).toBe(false); // stale: the recorded hash names the pointer file
		expect(startFallbackLines(tmp, RULES, "claude-code", () => "k").join("\n")).toContain(WORDS);
		expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		expect(source()).toBe(SOURCE);
		expect(released()).toBeNull();
		expect(loadPacketFile(tmp, packetPath()).ok).toBe(true);
		expect(temps()).toEqual([]);
	});
});

describe("recovery guidance after an interruption", () => {
	it("P5: release on the stale set an interrupted restore left names `restore` as the recovery, not `compile`", () => {
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		killed("restore", 2);
		const errors: string[] = [];
		vi.mocked(console.error).mockImplementation((m: unknown) => {
			errors.push(String(m));
		});
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(1);
		expect(errors.join("\n")).toMatch(/run `interlinked packets restore CLAUDE\.md` first/);
	});
	it("N2: a stale set with nothing released in that file gives no restore hint", () => {
		writeFileSync(join(tmp, "CLAUDE.md"), `${SOURCE}edited\n`);
		const errors: string[] = [];
		vi.mocked(console.error).mockImplementation((m: unknown) => {
			errors.push(String(m));
		});
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(1);
		expect(errors.join("\n")).toMatch(/changed since compile/);
		expect(errors.join("\n")).not.toMatch(/packets restore/);
	});
});

describe("a release killed at each rename", () => {
	it("P2: killed between the renames — words in both places, fallback delivers, restore converges", () => {
		killed("release", 2);
		expect(source()).toBe(SOURCE);
		expect(released()?.text).toBe(WORDS);
		expect(startFallbackLines(tmp, RULES, "claude-code", () => "k").join("\n")).toContain(WORDS);
		expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		expect(source()).toBe(SOURCE);
		expect(released()).toBeNull();
		expect(loadPacketFile(tmp, packetPath()).ok).toBe(true);
	});
	it("P3: killed before the first rename — nothing changed but two dead temps; the next run sweeps them and succeeds", () => {
		killed("release", 1);
		expect(source()).toBe(SOURCE);
		expect(released()).toBeNull();
		expect(temps()).toHaveLength(2);
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		expect(temps()).toEqual([]);
		expect(source()).not.toContain(WORDS);
		expect(released()?.text).toBe(WORDS);
	});
});

describe("one release/restore at a time (break R2, P1)", () => {
	it("P9: while another run holds the project's packet lock, release and restore refuse with exit 1 and change nothing", () => {
		const lock = acquirePacketLock(packetPath());
		expect(lock.ok).toBe(true);
		const packetBefore = readFileSync(packetPath(), "utf8");
		try {
			expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(1);
			expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(1);
			expect(source()).toBe(SOURCE);
			expect(readFileSync(packetPath(), "utf8")).toBe(packetBefore);
		} finally {
			if (lock.ok) lock.release();
		}
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		expect(existsSync(`${packetPath()}.lock`)).toBe(false);
	});
	it("N3: restore refuses a global (`~/`) source outright — a repo command never writes the home directory", () => {
		expect(packetsRestoreCommand({ file: "~/.claude/CLAUDE.md", cwd: tmp })).toBe(2);
	});
});

describe("rollback and early exits (audit A, P3)", () => {
	it("P6: the second rename throws — the first file is rolled back byte-identically and no temp remains after the next run", () => {
		const packetBefore = readFileSync(packetPath(), "utf8");
		killed("release", 0, 2);
		expect(source()).toBe(SOURCE);
		expect(readFileSync(packetPath(), "utf8")).toBe(packetBefore);
		expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(2); // nothing released: an early exit…
		expect(temps()).toEqual([]); // …still sweeps the dead temps
	});
	it("P7: killed DURING the rollback — no torn file: the packet file is either old or new, and restore converges", () => {
		killed("release", 3, 2);
		expect(parsePacketFile(readFileSync(packetPath(), "utf8")).ok).toBe(true);
		expect(source()).toBe(SOURCE);
		expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		expect(source()).toBe(SOURCE);
		expect(released()).toBeNull();
		expect(loadPacketFile(tmp, packetPath()).ok).toBe(true);
		expect(temps()).toEqual([]);
	});
	it("P8: a crashed release followed by a restore that has nothing to do still removes the temps", () => {
		killed("release", 1);
		expect(temps()).toHaveLength(2);
		expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(2);
		expect(temps()).toEqual([]);
	});
});

describe("sweepStaleTemps", () => {
	it("N1: a temp named for a LIVE process (this one) is another run in flight and is left alone; a non-numeric suffix is not ours", () => {
		const target = join(tmp, "CLAUDE.md");
		writeFileSync(`${target}.${process.pid}.tmp`, "x");
		writeFileSync(`${target}.backup.tmp`, "x");
		expect(sweepStaleTemps(target)).toEqual([]);
		expect(existsSync(`${target}.${process.pid}.tmp`)).toBe(true);
		expect(existsSync(`${target}.backup.tmp`)).toBe(true);
	});
	it("P4: a dead pid's temp is removed; a missing directory sweeps nothing", () => {
		const target = join(tmp, "CLAUDE.md");
		writeFileSync(`${target}.999999999.tmp`, "x");
		expect(sweepStaleTemps(target)).toEqual(["CLAUDE.md.999999999.tmp"]);
		expect(sweepStaleTemps(join(tmp, "no-such-dir", "x.md"))).toEqual([]);
	});
});
