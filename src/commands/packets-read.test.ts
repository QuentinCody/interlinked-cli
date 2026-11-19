import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PACKET_LEDGER } from "../harness/packets/evaluator.js";
import { sampleFile, samplePacket } from "../harness/packets/fixtures.js";
import { loadPacketFileOrNull, packetPath, readLedger } from "./packets-read.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "packet-read-"));
	mkdirSync(join(root, ".interlinked"));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

it("loads the configured packet set and rejects missing or invalid content", () => {
	expect(loadPacketFileOrNull(root)).toBeNull();
	writeFileSync(packetPath(root), "{");
	expect(loadPacketFileOrNull(root)).toBeNull();
	const file = sampleFile([samplePacket()]);
	writeFileSync(packetPath(root), JSON.stringify(file));
	expect(loadPacketFileOrNull(root)).toEqual(file);
});

it("distinguishes a missing ledger from an empty ledger and retains rows around a torn line", () => {
	const ledger = join(root, ".interlinked", PACKET_LEDGER);
	expect(readLedger(root)).toBeNull();
	writeFileSync(ledger, "");
	expect(readLedger(root)).toEqual([]);
	const warning = vi.spyOn(console, "error").mockImplementation(() => {});
	writeFileSync(ledger, '{"session_id":"first"}\n{"session_id":\n{"session_id":"second"}\n');
	expect(readLedger(root)).toEqual([{ session_id: "first" }, { session_id: "second" }]);
	expect(warning).toHaveBeenCalledWith(`packets: 1 unreadable line(s) in ${PACKET_LEDGER} skipped`);
});
