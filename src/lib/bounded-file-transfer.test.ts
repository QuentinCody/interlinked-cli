/**
 * Behavior tests for bounded-file-transfer: the destination-claim races
 * (EEXIST / rethrow, at both the small in-memory tier and the large
 * streamed tier) and the best-effort cleanup unlink that runs when a
 * claimed destination is never completed. `unlinkSync` is wrapped as a
 * call-through mock so one test can force that cleanup unlink itself to
 * fail — a real disk cannot be talked into that failure on demand. Plain
 * `vi.spyOn(fs, ...)` throws "Module namespace is not configurable in ESM"
 * for node:fs, so the module factory is the seam (prior art:
 * src/lib/gated-file-transaction.test.ts).
 */
import {
	mkdirSync,
	mkdtempSync,
	openSync,
	fstatSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MATERIALIZED_RANGE_BYTES } from "./bounded-file-core.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync: vi.fn(actual.openSync),
		unlinkSync: vi.fn(actual.unlinkSync),
	};
});

import { copyFileRange, gzipFileRange } from "./bounded-file-transfer.js";

describe("bounded file transfer — gzipFileRange destination claims", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "bounded-transfer-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	// test-contract: bug — every acquired descriptor must close when a later acquisition fails.
	it("closes the large-copy source when the destination cannot be opened", () => {
		const source = join(tmp, "source.txt");
		writeFileSync(source, "tiny");
		expect(() => copyFileRange(source, join(tmp, "missing", "dest"), 0, MAX_MATERIALIZED_RANGE_BYTES + 1)).toThrow(/ENOENT/);
		const acquired = vi.mocked(openSync).mock.results.filter(result => result.type === "return");
		expect(acquired.length).toBeGreaterThan(0);
		for (const result of acquired) expect(() => fstatSync(result.value)).toThrow(/EBADF/);
	});

	// test-contract: bug — an invalid allocation size must not leave an acquired source open.
	it.each([copyFileRange, gzipFileRange])("does not leak handles when buffer allocation fails", (operation) => {
		const source = join(tmp, "source.txt");
		writeFileSync(source, "tiny");
		const invoke = operation === copyFileRange
			? () => copyFileRange(source, join(tmp, "copy"), 0, MAX_MATERIALIZED_RANGE_BYTES + 1, NaN)
			: () => gzipFileRange(source, 0, MAX_MATERIALIZED_RANGE_BYTES + 1, undefined, NaN);
		expect(invoke).toThrow();
		for (const result of vi.mocked(openSync).mock.results) {
			if (result.type === "return") expect(() => fstatSync(result.value)).toThrow(/EBADF/);
		}
	});

	it("reports an unclaimed small-range destination without touching its contents", () => {
		const source = join(tmp, "source.txt");
		const destination = join(tmp, "dest.gz");
		writeFileSync(source, "small payload");
		writeFileSync(destination, "already here");

		const result = gzipFileRange(source, 0, 13, destination);

		expect(result).toEqual({ claimed: false, gzipBytes: 0 });
		expect(readFileSync(destination, "utf8")).toBe("already here");
	});

	it("rethrows a non-EEXIST failure claiming a small-range destination", () => {
		const source = join(tmp, "source.txt");
		writeFileSync(source, "small payload");
		const destination = join(tmp, "missing-dir", "dest.gz");

		expect(() => gzipFileRange(source, 0, 13, destination)).toThrow(/ENOENT/);
	});

	it("reports an unclaimed large-range destination without reading the source", () => {
		const source = join(tmp, "source.txt");
		const destination = join(tmp, "dest.gz");
		writeFileSync(source, "tiny");
		writeFileSync(destination, "already here");

		const result = gzipFileRange(source, 0, MAX_MATERIALIZED_RANGE_BYTES + 1, destination);

		expect(result).toEqual({ claimed: false, gzipBytes: 0 });
		expect(readFileSync(destination, "utf8")).toBe("already here");
	});

	it("rethrows a non-EEXIST failure claiming a large-range destination", () => {
		const source = join(tmp, "source.txt");
		writeFileSync(source, "tiny");
		const destination = join(tmp, "missing-dir", "dest.gz");

		expect(() =>
			gzipFileRange(source, 0, MAX_MATERIALIZED_RANGE_BYTES + 1, destination),
		).toThrow(/ENOENT/);
	});

	it("surfaces a cleanup-unlink failure instead of the read error that aborted the transfer", () => {
		const unreadableSource = join(tmp, "source-dir");
		const destination = join(tmp, "dest.gz");
		mkdirSync(unreadableSource);
		const cleanupFailure = Object.assign(new Error("simulated: device busy"), {
			code: "EBUSY",
		});
		vi.mocked(unlinkSync).mockImplementationOnce(() => {
			throw cleanupFailure;
		});

		expect(() =>
			gzipFileRange(unreadableSource, 0, MAX_MATERIALIZED_RANGE_BYTES + 1, destination, 1024),
		).toThrow("simulated: device busy");
	});
});
