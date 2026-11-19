import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { readStdin } from "./read-stdin.js";

it("decodes a UTF-8 character split between chunks", async () => {
	const stream = new PassThrough();
	const text = readStdin(stream);
	const bytes = Buffer.from("a🌱b");
	stream.write(bytes.subarray(0, 3));
	stream.end(bytes.subarray(3));
	await expect(text).resolves.toBe("a🌱b");
});

it("preserves the input error", async () => {
	const stream = new PassThrough();
	const text = readStdin(stream);
	const error = new Error("stdin closed");
	stream.destroy(error);
	await expect(text).rejects.toBe(error);
});
