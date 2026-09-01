// Shared strict HTTP response primitives for protocol-v3 cloud clients.

const MAX_ERROR_BODY_BYTES = 4 * 1024;
const MAX_ERROR_BODY_CHARS = 500;
const MAX_CLOUD_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface BoundedHttpResponse {
	readonly headers: { get(name: string): string | null };
	readonly body: ReadableStream<Uint8Array> | null;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export function hasExactJsonKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function declaredLength(response: BoundedHttpResponse, limit: number, label: string): number | null {
	const raw = response.headers.get("content-length");
	if (raw === null) return null;
	if (!/^\d+$/.test(raw)) throw new Error(`${label} has a malformed content-length`);
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value > limit) {
		throw new Error(`${label} exceeds the ${limit}-byte response limit`);
	}
	return value;
}

/** Read at most `limit` bytes. A missing or dishonest Content-Length cannot
 * bypass the limit: the stream is cancelled as soon as the next chunk would
 * cross it. The fixed allocation also avoids a growing chain of concatenated
 * buffers under adversarial chunking. */
export async function readBoundedBytes(
	response: BoundedHttpResponse,
	limit: number,
	label: string,
): Promise<Uint8Array> {
	const length = declaredLength(response, limit, label);
	if (response.body === null) {
		const fallback = new Uint8Array(await response.arrayBuffer());
		if (fallback.byteLength > limit) throw new Error(`${label} exceeds the ${limit}-byte response limit`);
		if (length !== null && fallback.byteLength !== length) throw new Error(`${label} content-length is incorrect`);
		return fallback;
	}
	const bytes = new Uint8Array(length ?? limit);
	const reader = response.body.getReader();
	let offset = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			if (offset + next.value.byteLength > bytes.byteLength) {
				await reader.cancel(`${label} exceeded its response limit`);
				throw new Error(`${label} exceeds the ${limit}-byte response limit`);
			}
			bytes.set(next.value, offset);
			offset += next.value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	if (length !== null && offset !== length) throw new Error(`${label} content-length is incorrect`);
	return bytes.subarray(0, offset);
}

export async function readExactBytes(options: {
	response: BoundedHttpResponse;
	expected: number;
	limit: number;
	label: string;
}): Promise<Uint8Array> {
	const { response, expected, limit, label } = options;
	if (!Number.isSafeInteger(expected) || expected < 0 || expected > limit) {
		throw new Error(`${label} declares an invalid byte length`);
	}
	const bytes = await readBoundedBytes(response, expected, label);
	if (bytes.byteLength !== expected) {
		throw new Error(`${label} bytes disagree with its authenticated pointer (length)`);
	}
	return bytes;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`${label} is not valid UTF-8`);
	}
}

export async function readBoundedJson(
	response: BoundedHttpResponse,
	label: string,
	limit = MAX_CLOUD_JSON_RESPONSE_BYTES,
): Promise<unknown> {
	const text = decodeUtf8(await readBoundedBytes(response, limit, label), label);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
}

function redactSecrets(text: string, secrets: readonly string[]): string {
	let redacted = text;
	for (const secret of secrets) {
		if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
	}
	return redacted
		.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
		.replace(/("(?:access_token|refresh_token|token|authorization)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
}

export async function boundedErrorBody(
	response: BoundedHttpResponse,
	secrets: readonly string[] = [],
): Promise<string> {
	try {
		const text = decodeUtf8(
			await readBoundedBytes(response, MAX_ERROR_BODY_BYTES, "mutation cloud error response"),
			"mutation cloud error response",
		);
		return redactSecrets(text, secrets).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_BODY_CHARS);
	} catch {
		return "unreadable or oversized response";
	}
}
