/** Read a command's binary stdin to EOF, decoding UTF-8 across chunk boundaries. */
export function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		stream.on("error", reject);
	});
}
