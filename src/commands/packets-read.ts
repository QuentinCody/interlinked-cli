import { safeReadFile as readOrNull } from "../harness/evaluator/safe-read-file.js";
import { join } from "node:path";
import { PACKET_LEDGER, type PacketJudgmentRow } from "../harness/packets/evaluator.js";
import { parsePacketFile } from "../harness/packets/schema.js";
import { PACKET_FILE_BASENAME, type PacketFile } from "../harness/packets/types.js";

export { readOrNull };

export const DEFAULT_TAIL_MB = 256;

export function packetPath(cwd: string): string {
	return join(cwd, ".interlinked", PACKET_FILE_BASENAME);
}

export function readLedger(cwd: string): PacketJudgmentRow[] | null {
	const text = readOrNull(join(cwd, ".interlinked", PACKET_LEDGER));
	if (text === null) return null;
	const rows: PacketJudgmentRow[] = [];
	let torn = 0;
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			rows.push(JSON.parse(line) as PacketJudgmentRow);
		} catch {
			torn++;
		}
	}
	if (torn > 0) console.error(`packets: ${torn} unreadable line(s) in ${PACKET_LEDGER} skipped`);
	return rows;
}

export function loadPacketFileOrNull(cwd: string): PacketFile | null {
	const text = readOrNull(packetPath(cwd));
	if (text === null) return null;
	const parsed = parsePacketFile(text);
	return parsed.ok ? parsed.value : null;
}
