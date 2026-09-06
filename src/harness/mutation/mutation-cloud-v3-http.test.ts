// test-contract: untrusted cloud responses are bounded before allocation,
// diagnostics never echo credentials, and every declared-length / decode /
// parse failure path returns the specific error or fallback text it exists
// to produce — including the arrayBuffer() fallback a bodyless response
// takes when no ReadableStream is available.

import { describe, expect, it } from "vitest";
import {
	boundedErrorBody,
	readBoundedBytes,
	readBoundedJson,
	readExactBytes,
} from "./mutation-cloud-v3-http.js";

/** A `BoundedHttpResponse` fixture whose `body` is `null` — the shape a
 * bodyless environment reports, exercising the `arrayBuffer()` fallback path
 * that a real `Response`'s always-present stream never takes. */
function bodylessResponse(options: {
	arrayBufferBytes: Uint8Array;
	contentLength?: string;
}) {
	return {
		headers: {
			get: (name: string) => (name === "content-length" ? (options.contentLength ?? null) : null),
		},
		body: null,
		// SAFETY: every fixture below builds `arrayBufferBytes` from `new
		// Uint8Array(n)`, whose `.buffer` is always a real, non-shared ArrayBuffer.
		arrayBuffer: async () => options.arrayBufferBytes.buffer as ArrayBuffer,
	};
}

describe("bounded mutation-cloud HTTP bodies", () => {
	it("rejects an oversized declared body before pulling its stream", async () => {
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls += 1;
					controller.enqueue(new Uint8Array(1));
					controller.close();
				},
			},
			// Prevent the stream constructor from prefetching before production
			// code has a chance to reject the declared Content-Length.
			{ highWaterMark: 0 },
		);
		const response = new Response(body, { headers: { "content-length": "10" } });
		await expect(readBoundedBytes(response, 5, "fixture body")).rejects.toThrow("5-byte");
		expect(pulls).toBe(0);
	});

	it("cancels a chunked body when it crosses the limit", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.enqueue(new Uint8Array([4, 5, 6]));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(readBoundedBytes(new Response(body), 5, "fixture body")).rejects.toThrow("5-byte");
		expect(cancelled).toBe(true);
	});

	it("parses bounded JSON without using Response.json", async () => {
		await expect(readBoundedJson(new Response('{"ok":true}'), "fixture JSON", 32)).resolves.toEqual({ ok: true });
	});

	it("redacts exact and generic credentials from bounded error text", async () => {
		const body = JSON.stringify({
			token: "server-echo",
			detail: "Bearer other-secret exact-secret",
		});
		const message = await boundedErrorBody(new Response(body), ["exact-secret"]);
		expect(message).not.toContain("exact-secret");
		expect(message).not.toContain("other-secret");
		expect(message).not.toContain("server-echo");
		expect(message).toContain("[REDACTED]");
	});

	it("reads via arrayBuffer() when the response reports no readable body stream", async () => {
		const fixture = bodylessResponse({ arrayBufferBytes: new TextEncoder().encode("ok") });
		const bytes = await readBoundedBytes(fixture, 10, "fixture body");
		expect(new TextDecoder().decode(bytes)).toBe("ok");
	});

	it("rejects a bodyless response whose buffered length exceeds the limit", async () => {
		const fixture = bodylessResponse({ arrayBufferBytes: new Uint8Array(20) });
		await expect(readBoundedBytes(fixture, 5, "fixture body")).rejects.toThrow(
			"fixture body exceeds the 5-byte response limit",
		);
	});

	it("rejects a bodyless response whose buffered length disagrees with its declared content-length", async () => {
		const fixture = bodylessResponse({ arrayBufferBytes: new Uint8Array(3), contentLength: "5" });
		await expect(readBoundedBytes(fixture, 10, "fixture body")).rejects.toThrow(
			"fixture body content-length is incorrect",
		);
	});

	it("rejects an invalid expected byte length before touching the response", async () => {
		const fixture = bodylessResponse({ arrayBufferBytes: new Uint8Array(0) });
		await expect(
			readExactBytes({ response: fixture, expected: -1, limit: 100, label: "fixture body" }),
		).rejects.toThrow("fixture body declares an invalid byte length");
	});

	it("rejects a response body that is not valid UTF-8", async () => {
		const body = new Uint8Array([0xff, 0xfe, 0xfd]);
		await expect(readBoundedJson(new Response(body), "fixture JSON")).rejects.toThrow(
			"fixture JSON is not valid UTF-8",
		);
	});

	it("rejects a response body that decodes but is not valid JSON", async () => {
		await expect(readBoundedJson(new Response("not json"), "fixture JSON")).rejects.toThrow(
			"fixture JSON is not valid JSON",
		);
	});

	it("falls back to a generic message when the error body cannot be bounded-read", async () => {
		const response = new Response("ignored", { headers: { "content-length": "not-a-number" } });
		await expect(boundedErrorBody(response)).resolves.toBe("unreadable or oversized response");
	});
});
