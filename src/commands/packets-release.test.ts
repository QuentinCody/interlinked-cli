import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleFile, samplePacket, warnPacket } from "../harness/packets/fixtures.js";
import { pointerLine } from "../harness/packets/release.js";
import { parsePacketFile } from "../harness/packets/schema.js";
import type { Packet, PacketFile } from "../harness/packets/types.js";
import { packetsBudgetCommand, packetsReleaseCommand, packetsRestoreCommand, readPass1Rules } from "./packets-release.js";

const CLAUDE = ["# rules", "", "- Never full-read `collection.jsonl` …", "- Prefer `rg` when searching the sample project for test fixtures under the examples directory.", "- Quote every glob passed to a command that expands it itself (`rg -g '*.ts'`, `find . -name '*.test.ts'`).", ""].join("\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const live = warnPacket({ id: "prefer-rg", source: { file: "CLAUDE.md", span: null, quote: "Prefer `rg` when searching the sample project for test fixtures under the examples directory." } });

let tmp: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
const printed = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
const errors = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
const packetPath = () => join(tmp, ".interlinked", "instruction-packets.json");
const writePackets = (packets: Packet[], sources: Record<string, string> = { "CLAUDE.md": sha(CLAUDE) }): PacketFile => {
	const file = sampleFile(packets, { sources });
	writeFileSync(packetPath(), JSON.stringify(file));
	return file;
};
const readPackets = (): PacketFile => {
	const parsed = parsePacketFile(readFileSync(packetPath(), "utf8"));
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.value;
};

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-packets-release-"));
	mkdirSync(join(tmp, ".interlinked"));
	writeFileSync(join(tmp, "CLAUDE.md"), CLAUDE);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	logSpy.mockRestore();
	errSpy.mockRestore();
});

describe("packets release / restore — one transaction over both files", () => {
	it("P1: release rewrites the source with the pointer, records the verbatim text and the new source hash; restore is byte-identical", () => {
		writePackets([samplePacket(), live]);
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		const after = readFileSync(join(tmp, "CLAUDE.md"), "utf8");
		expect(after).toBe(CLAUDE.replace("Prefer `rg` when searching the sample project for test fixtures under the examples directory.", pointerLine("prefer-rg", "CLAUDE.md")));
		const file = readPackets();
		expect(file.packets[1]?.release?.text).toBe("Prefer `rg` when searching the sample project for test fixtures under the examples directory.");
		expect(file.sources["CLAUDE.md"]).toBe(sha(after));
		expect(printed()).toMatch(/released prefer-rg from CLAUDE\.md/);

		expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		expect(readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toBe(CLAUDE);
		const restored = readPackets();
		expect(restored.packets[1]?.release).toBeNull();
		expect(restored.sources["CLAUDE.md"]).toBe(sha(CLAUDE));
	});
	it("P2: --dry prints the plan and writes neither file", () => {
		writePackets([live]);
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp, dry: true })).toBe(0);
		expect(readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toBe(CLAUDE);
		expect(readPackets().packets[0]?.release).toBeNull();
		expect(printed()).toMatch(/would release prefer-rg/);
	});
	it("P3: --only releases the named packets; --json reports ids and the chars removed", () => {
		const second = warnPacket({ id: "quote-globs", source: { file: "CLAUDE.md", span: null, quote: "Quote every glob passed to a command that expands it itself (`rg -g '*.ts'`, `find . -name '*.test.ts'`)." } });
		writePackets([live, second]);
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp, only: ["quote-globs"], json: true })).toBe(0);
		expect(JSON.parse(printed())).toEqual({ file: "CLAUDE.md", released: ["quote-globs"], chars_removed: "Quote every glob passed to a command that expands it itself (`rg -g '*.ts'`, `find . -name '*.test.ts'`).".length - pointerLine("quote-globs", "CLAUDE.md").length });
		expect(readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toContain("Prefer `rg`");
	});
	it("N1: a stale packet set (another source changed since compile) refuses the release", () => {
		writePackets([live], { "CLAUDE.md": sha(CLAUDE), "AGENTS.md": sha("old") });
		writeFileSync(join(tmp, "AGENTS.md"), "new");
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(1);
		expect(errors()).toMatch(/AGENTS\.md changed since compile/);
		expect(readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toBe(CLAUDE);
	});
	it("N2: nothing live to release exits 2 and names why", () => {
		writePackets([samplePacket()]);
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(2);
		expect(errors()).toMatch(/bounded-log-read is at shadow/);
	});
	it("N3: a missing packet file or a missing source file exits 1", () => {
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(1);
		writePackets([live]);
		expect(packetsReleaseCommand({ file: "NOPE.md", cwd: tmp })).toBe(1);
		expect(packetsRestoreCommand({ file: "NOPE.md", cwd: tmp })).toBe(1);
	});
	it("N4: restore works on a stale packet set (hash check skipped) and refuses when nothing is released", () => {
		writePackets([live]);
		packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp });
		writeFileSync(join(tmp, "AGENTS.md"), "x");
		const file = readPackets();
		writeFileSync(packetPath(), JSON.stringify({ ...file, sources: { ...file.sources, "AGENTS.md": sha("stale") } }));
		expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		expect(readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toBe(CLAUDE);
		expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(2);
	});
	it("N4b (review-100): restore refuses an instruction file that became invalid UTF-8 after the release and changes neither file", () => {
		writePackets([live]);
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		const bytes = Buffer.concat([readFileSync(join(tmp, "CLAUDE.md")), Buffer.from([0xff, 0xfe, 0x0a])]);
		writeFileSync(join(tmp, "CLAUDE.md"), bytes);
		const packetBytes = readFileSync(packetPath());
		expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(1);
		expect(errors()).toMatch(/not valid UTF-8/);
		expect(readFileSync(join(tmp, "CLAUDE.md")).equals(bytes)).toBe(true);
		expect(readFileSync(packetPath()).equals(packetBytes)).toBe(true);
	});
});

describe("interrupted release (R37)", () => {
	it("P6: packet file landed, source did not — the words are still delivered (stale set) and restore recovers without touching the source", async () => {
		const { releaseEdit } = await import("../harness/packets/release.js");
		const { startFallbackLines } = await import("../harness/packets/fallback-start.js");
		const file = writePackets([live]);
		const edit = releaseEdit(file, "CLAUDE.md", CLAUDE, "2026-11-05T20:00:00.000Z");
		if (!edit.ok) throw new Error(edit.error);
		writeFileSync(packetPath(), JSON.stringify(edit.file)); // first rename done; the process died before the second
		const rules = { jev: { enabled: true }, packets: { enabled: true, evidence_consent: { kinds: ["command"], paths: [] } } } as never;
		const lines = startFallbackLines(tmp, rules, "claude-code", () => "k");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("(instruction files changed since compile)");
		expect(lines[0]).toContain("Prefer `rg` when searching");
		expect(packetsRestoreCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		expect(readFileSync(join(tmp, "CLAUDE.md"), "utf8")).toBe(CLAUDE);
		expect(readPackets().packets[0]?.release).toBeNull();
		expect(readPackets().sources["CLAUDE.md"]).toBe(sha(CLAUDE));
	});
});

describe("packets budget", () => {
	it("P4: reports per source file with pass-1 rules read from distilled-rules.json", () => {
		writePackets([samplePacket({ source: { file: "CLAUDE.md", span: null, quote: "Never full-read `collection.jsonl` …" } }), live]);
		writeFileSync(join(tmp, ".interlinked", "distilled-rules.json"), JSON.stringify({ version: 1, rules: [{ id: "r1", enabled: true, source: { file: "CLAUDE.md", quote: "Quote every glob passed to a command that expands it itself (`rg -g '*.ts'`, `find . -name '*.test.ts'`)." } }, { id: "off", enabled: false, source: { file: "CLAUDE.md", quote: "# rules" } }, null, { id: "noprov" }] }));
		expect(packetsBudgetCommand({ cwd: tmp, json: true })).toBe(0);
		const rows = JSON.parse(printed()) as { file: string; pass1: { rules: number }; live: { packets: number }; shadow: { packets: number } }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ file: "CLAUDE.md", pass1: { rules: 1 }, live: { packets: 1 }, shadow: { packets: 1 } });
	});
	it("P6: a released packet that the fallback oracle says is not live here (packets disabled) is reported as no saving", () => {
		const text = "Prefer `rg` when searching the sample project for test fixtures under the examples directory.";
		writePackets([live]);
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(0);
		logSpy.mockClear();
		expect(packetsBudgetCommand({ cwd: tmp, json: true })).toBe(0);
		const rows = JSON.parse(printed()) as { released: { packets: number }; released_fallback: { packets: number; chars: number } }[];
		expect(rows[0]?.released.packets).toBe(0);
		expect(rows[0]?.released_fallback).toEqual({ packets: 1, chars: text.length });
	});
	it("P5: the human table names the file and the releasable line", () => {
		writePackets([live]);
		expect(packetsBudgetCommand({ cwd: tmp })).toBe(0);
		expect(printed()).toMatch(/CLAUDE\.md: \d+ chars/);
		expect(printed()).toMatch(/releasable now: 1 packet/);
	});
	it("R6-W1 P3: release refuses an instruction file that is not valid UTF-8 and leaves it byte-identical", () => {
		writePackets([live]);
		const bytes = Buffer.concat([Buffer.from(CLAUDE), Buffer.from([0xff, 0xfe, 0x0a])]);
		writeFileSync(join(tmp, "CLAUDE.md"), bytes);
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(1);
		expect(errors()).toMatch(/not valid UTF-8/);
		expect(readFileSync(join(tmp, "CLAUDE.md")).equals(bytes)).toBe(true);
	});
	it("R6-W1 P3: a live-holder refusal names the lock file", () => {
		writePackets([live]);
		writeFileSync(`${packetPath()}.lock`, String(process.pid));
		expect(packetsReleaseCommand({ file: "CLAUDE.md", cwd: tmp })).toBe(1);
		expect(errors()).toContain(`${packetPath()}.lock`);
	});
	it("N5: no packet file exits 1; a `~` source path is expanded to the home directory", () => {
		expect(packetsBudgetCommand({ cwd: tmp })).toBe(1);
		writeFileSync(join(tmp, ".interlinked", "distilled-rules.json"), JSON.stringify({ rules: [{ id: "g", source: { file: "~/does-not-exist-interlinked.md", quote: "x" } }] }));
		expect(readPass1Rules(tmp)).toEqual([{ id: "g", file: "~/does-not-exist-interlinked.md", quote: "x" }]);
	});
});
