import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { asJsonObject } from "../../lib/json-types.js";

/** Read one bounded regular file. A size change during the read makes this observation unavailable. */
function readTextFile(path: string, byteLimit: number): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > byteLimit) return null;
		const buffer = Buffer.allocUnsafe(stat.size + 1);
		let total = 0;
		while (total < buffer.length) {
			const bytes = readSync(fd, buffer, total, buffer.length - total, total);
			if (bytes === 0) break;
			total += bytes;
		}
		return total === stat.size ? buffer.toString("utf8", 0, total) : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function discoveryInputs(byteLimit: number) {
	const readText = (path: string) => readTextFile(path, byteLimit);
	const readJson = (path: string): Record<string, unknown> | null => {
		const text = readText(path);
		if (text === null) return null;
		try { return asJsonObject(JSON.parse(text)); }
		catch { return null; }
	};
	return { readText, readJson };
}
