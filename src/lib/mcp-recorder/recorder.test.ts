import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as collectionBuilder from "../collection/builder.js";
import type { CollectionRecord } from "../collection/types.js";
import { nonNull } from "../non-null.js";
import { extractJsonRpcResponsePayload, McpProtocolRecorder } from "./recorder.js";
import type { McpEventRecord } from "./types.js";
import { getMcpEventsPath } from "./writer.js";

function makeRecorder(records: McpEventRecord[], clock: { ms: number }): McpProtocolRecorder {
    return new McpProtocolRecorder({
        serverName: "context7",
        transport: "stdio",
        sessionId: "sess-1",
        now: () => new Date("2026-06-18T12:00:00.000Z"),
        clockMs: () => clock.ms,
        append: (record) => {
            records.push(record);
        },
    });
}

describe("McpProtocolRecorder", () => {
    it("records client requests and server responses with latency correlation", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1000 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
        );
        clock.ms = 1042;
        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
        );

        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
            kind: "mcp_message",
            direction: "client_to_server",
            stream: "stdin",
            message_type: "request",
            method: "tools/list",
            jsonrpc_id: 1,
            server_name: "context7",
            session_id: "sess-1",
        });
        expect(records[1]).toMatchObject({
            direction: "server_to_client",
            message_type: "response",
            request_method: "tools/list",
            latency_ms: 42,
            jsonrpc_id: 1,
            stream: "stdout",
        });
        expect(nonNull(records[0]).schema).toBe("mcp-events.v1");
        expect(nonNull(records[0]).fidelity).toEqual({
            source: "mcp_proxy",
            completeness: "complete",
            inline: true,
        });
        expect(nonNull(records[0]).privacy).toEqual({
            redaction_status: "unscanned",
            sensitivity: "unknown",
            contains_sensitive: "unknown",
            allowed_for_training: false,
            allowed_for_cloud_upload: false,
        });
    });

    it("dual-writes proxied tools/call requests and responses into collection.jsonl shape", () => {
        const records: McpEventRecord[] = [];
        const collection: CollectionRecord[] = [];
        const clock = { ms: 1000 };
        const recorder = new McpProtocolRecorder({
            serverName: "context7",
            transport: "stdio",
            sessionId: "sess-1",
            now: () => new Date("2026-06-18T12:00:00.000Z"),
            clockMs: () => clock.ms,
            append: (record) => {
                records.push(record);
            },
            appendCollectionRecord: (record) => {
                collection.push(record);
            },
        });

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"call-1","method":"tools/call","params":{"name":"resolve-library-id","arguments":{"libraryName":"react"}}}',
        );
        clock.ms = 1018;
        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","id":"call-1","result":{"content":[{"type":"text","text":"react docs"}]}}',
        );

        expect(collection).toHaveLength(2);
        expect(collection[0]).toMatchObject({
            schema: "collection.v1",
            provider: "mcp-proxy",
            phase: "pre",
            tool_class: "mcp_call",
            provider_tool: "mcp__context7__resolve-library-id",
            session_id: "sess-1",
            tool_use_id: "mcp:context7:string:call-1",
            action: {
                server: "context7",
                tool: "resolve-library-id",
                params: { libraryName: "react" },
            },
        });
        expect(collection[1]).toMatchObject({
            provider: "mcp-proxy",
            phase: "post",
            outcome: "ok",
            tool_class: "mcp_call",
            observation: {
                result: { content: [{ type: "text", text: "react docs" }] },
                result_ref: null,
            },
        });
        expect(records[1]).toMatchObject({
            request_method: "tools/call",
            latency_ms: 18,
        });
    });

    it("correlates server-initiated client feature requests", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 2000 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","id":"sample-1","method":"sampling/createMessage","params":{"messages":[]}}',
        );
        clock.ms = 2033;
        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"sample-1","result":{"role":"assistant","content":{"type":"text","text":"ok"}}}',
        );

        expect(records[0]).toMatchObject({
            direction: "server_to_client",
            message_type: "request",
            method: "sampling/createMessage",
            jsonrpc_id: "sample-1",
            stream: "stdout",
        });
        expect(records[1]).toMatchObject({
            direction: "client_to_server",
            message_type: "response",
            request_method: "sampling/createMessage",
            latency_ms: 33,
        });
    });

    it("records notifications without requiring an id", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"ready"}}',
        );

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            message_type: "notification",
            method: "notifications/message",
        });
        expect(nonNull(records[0]).jsonrpc_id).toBeUndefined();
    });

    it("records malformed JSON lines as parse-error events", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine("client_to_server", '{"jsonrpc":');

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            kind: "mcp_parse_error",
            direction: "client_to_server",
            message_type: "parse_error",
            stream: "stdin",
        });
        expect(nonNull(records[0]).payload).toMatchObject({ line: '{"jsonrpc":' });
    });

    it("splits JSON-RPC batches into per-message records", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine(
            "client_to_server",
            '[{"jsonrpc":"2.0","id":1,"method":"resources/list"},{"jsonrpc":"2.0","method":"notifications/initialized"}]',
        );

        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
            method: "resources/list",
            batch_index: 0,
            batch_size: 2,
        });
        expect(records[1]).toMatchObject({
            method: "notifications/initialized",
            batch_index: 1,
            batch_size: 2,
        });
    });

    it("uses constructor defaults (cwd, sessionId, inlineLimitBytes, now, clockMs) when omitted", () => {
        const records: McpEventRecord[] = [];
        const collection: CollectionRecord[] = [];
        const recorder = new McpProtocolRecorder({
            serverName: "context7",
            transport: "stdio",
            append: (record) => {
                records.push(record);
            },
            appendCollectionRecord: (record) => {
                collection.push(record);
            },
        });

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"d1","method":"tools/call","params":{"name":"lookup","arguments":{}}}',
        );
        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","id":"d1","result":{"content":[]}}',
        );

        expect(records).toHaveLength(2);
        expect(nonNull(records[0]).session_id).toBeNull();
        expect(nonNull(records[0]).ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        // The default clockMs (Date.now) must produce a real, finite, non-negative
        // elapsed-time measurement for the correlated response — not NaN, which is
        // what a broken "always undefined" clock fallback would silently produce.
        expect(nonNull(records[1]).latency_ms).not.toBeNaN();
        expect(nonNull(records[1]).latency_ms).toBeGreaterThanOrEqual(0);
        expect(collection).toHaveLength(2);
        expect(collection[0]).toMatchObject({ session_id: null, phase: "pre" });
        expect(collection[1]).toMatchObject({ phase: "post", outcome: "ok" });
    });

    it("skips a blank/whitespace-only JSON line without recording anything", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine("client_to_server", "   ");

        expect(records).toEqual([]);
    });

    it("records a non-blank stderr line as a transport_stderr event", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordStderrLine("connection refused\r");

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            kind: "mcp_transport",
            direction: "server_to_client",
            stream: "stderr",
            message_type: "transport_stderr",
            payload: "connection refused",
        });
    });

    it("skips a blank stderr line without recording anything", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordStderrLine("");

        expect(records).toEqual([]);
    });

    it("records a transport error event with no direction/stream", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordTransportError("spawn ENOENT");

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            kind: "mcp_transport",
            message_type: "transport_error",
            payload: { message: "spawn ENOENT" },
        });
        expect(nonNull(records[0]).direction).toBeUndefined();
        expect(nonNull(records[0]).stream).toBeUndefined();
        // Exact key set: every optional field (direction, stream, method,
        // request_method, jsonrpc_id, batch_index, batch_size, latency_ms,
        // payload_ref, payload_preview) that this call never supplies a value
        // for must be genuinely ABSENT, not present-with-value-undefined.
        expect(Object.keys(nonNull(records[0])).sort()).toEqual(
            [
                "schema",
                "kind",
                "ts",
                "server_name",
                "transport",
                "session_id",
                "message_type",
                "payload_bytes",
                "payload_sha256",
                "payload",
                "fidelity",
                "privacy",
            ].sort(),
        );
    });

    it("records a transport close event with exit code and signal", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordTransportClose(1, "SIGTERM");

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            kind: "mcp_transport",
            message_type: "transport_close",
            payload: { exit_code: 1, signal: "SIGTERM" },
        });
    });

    it("splits an empty JSON-RPC batch into a single unknown-typed placeholder message", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine("client_to_server", "[]");

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            message_type: "unknown",
            batch_index: 0,
            batch_size: 0,
        });
        expect(nonNull(records[0]).payload).toEqual([]);
    });

    it("treats a non-object top-level JSON value as an unknown message", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine("client_to_server", "42");

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            message_type: "unknown",
            payload: 42,
        });
        expect(nonNull(records[0]).method).toBeUndefined();
        expect(nonNull(records[0]).jsonrpc_id).toBeUndefined();
    });

    it("does not attach latency/request_method for a response with no matching pending request", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine("server_to_client", '{"jsonrpc":"2.0","id":99,"result":{}}');

        expect(records).toHaveLength(1);
        expect(nonNull(records[0]).latency_ms).toBeUndefined();
        expect(nonNull(records[0]).request_method).toBeUndefined();
        // Must be genuinely ABSENT (not a present key holding `undefined`) — a
        // present-but-undefined key would still serialize away in JSON but signals
        // the optional-field guard was bypassed.
        expect(Object.prototype.hasOwnProperty.call(nonNull(records[0]), "latency_ms")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(nonNull(records[0]), "request_method")).toBe(false);
    });

    it("classifies a JSON-RPC message with an id and neither method/result/error as unknown", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine("server_to_client", '{"jsonrpc":"2.0","id":7,"foo":"bar"}');

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            message_type: "unknown",
            jsonrpc_id: 7,
        });
    });

    it("does not create a pending tool call for a tools/call request with no params", () => {
        const records: McpEventRecord[] = [];
        const collection: CollectionRecord[] = [];
        const clock = { ms: 1 };
        const recorder = new McpProtocolRecorder({
            serverName: "context7",
            transport: "stdio",
            sessionId: "sess-1",
            now: () => new Date("2026-06-18T12:00:00.000Z"),
            clockMs: () => clock.ms,
            append: (record) => {
                records.push(record);
            },
            appendCollectionRecord: (record) => {
                collection.push(record);
            },
        });

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"n1","method":"tools/call"}',
        );

        expect(records).toHaveLength(1);
        expect(collection).toEqual([]);
    });

    it("defaults the tool name to 'unknown' when params.name is missing", () => {
        const records: McpEventRecord[] = [];
        const collection: CollectionRecord[] = [];
        const clock = { ms: 1 };
        const recorder = new McpProtocolRecorder({
            serverName: "context7",
            transport: "stdio",
            sessionId: "sess-1",
            now: () => new Date("2026-06-18T12:00:00.000Z"),
            clockMs: () => clock.ms,
            append: (record) => {
                records.push(record);
            },
            appendCollectionRecord: (record) => {
                collection.push(record);
            },
        });

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"n2","method":"tools/call","params":{"arguments":{}}}',
        );

        expect(collection).toHaveLength(1);
        expect(collection[0]).toMatchObject({
            provider_tool: "mcp__context7__unknown",
        });
    });

    it("falls back to the raw params object when arguments is not a JSON object", () => {
        const records: McpEventRecord[] = [];
        const collection: CollectionRecord[] = [];
        const clock = { ms: 1 };
        const recorder = new McpProtocolRecorder({
            serverName: "context7",
            transport: "stdio",
            sessionId: "sess-1",
            now: () => new Date("2026-06-18T12:00:00.000Z"),
            clockMs: () => clock.ms,
            append: (record) => {
                records.push(record);
            },
            appendCollectionRecord: (record) => {
                collection.push(record);
            },
        });

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"n3","method":"tools/call","params":{"name":"foo","arguments":"not-an-object"}}',
        );

        expect(collection).toHaveLength(1);
        expect(collection[0]).toMatchObject({
            action: { server: "context7", tool: "foo", params: { name: "foo", arguments: "not-an-object" } },
        });
    });

    it("records tool_use_error when the server responds with a JSON-RPC error object", () => {
        const records: McpEventRecord[] = [];
        const collection: CollectionRecord[] = [];
        const clock = { ms: 1000 };
        const recorder = new McpProtocolRecorder({
            serverName: "context7",
            transport: "stdio",
            sessionId: "sess-1",
            now: () => new Date("2026-06-18T12:00:00.000Z"),
            clockMs: () => clock.ms,
            append: (record) => {
                records.push(record);
            },
            appendCollectionRecord: (record) => {
                collection.push(record);
            },
        });

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"e1","method":"tools/call","params":{"name":"doThing","arguments":{}}}',
        );
        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","id":"e1","error":{"code":-32000,"message":"boom"}}',
        );

        expect(records[1]).toMatchObject({ message_type: "error" });
        expect(collection).toHaveLength(2);
        expect(collection[1]).toMatchObject({
            outcome: "error",
            observation: { result: { code: -32000, message: "boom" } },
        });
    });

    it("records tool_use_error when a successful-looking response carries result.isError === true", () => {
        const records: McpEventRecord[] = [];
        const collection: CollectionRecord[] = [];
        const clock = { ms: 1000 };
        const recorder = new McpProtocolRecorder({
            serverName: "context7",
            transport: "stdio",
            sessionId: "sess-1",
            now: () => new Date("2026-06-18T12:00:00.000Z"),
            clockMs: () => clock.ms,
            append: (record) => {
                records.push(record);
            },
            appendCollectionRecord: (record) => {
                collection.push(record);
            },
        });

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"ie1","method":"tools/call","params":{"name":"doThing","arguments":{}}}',
        );
        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","id":"ie1","result":{"isError":true,"content":[]}}',
        );

        expect(collection).toHaveLength(2);
        expect(collection[1]).toMatchObject({ outcome: "error" });
    });

    it("does not treat a response whose result is not a JSON object as an error", () => {
        const records: McpEventRecord[] = [];
        const collection: CollectionRecord[] = [];
        const clock = { ms: 1000 };
        const recorder = new McpProtocolRecorder({
            serverName: "context7",
            transport: "stdio",
            sessionId: "sess-1",
            now: () => new Date("2026-06-18T12:00:00.000Z"),
            clockMs: () => clock.ms,
            append: (record) => {
                records.push(record);
            },
            appendCollectionRecord: (record) => {
                collection.push(record);
            },
        });

        recorder.recordJsonLine(
            "client_to_server",
            '{"jsonrpc":"2.0","id":"se1","method":"tools/call","params":{"name":"doThing","arguments":{}}}',
        );
        recorder.recordJsonLine(
            "server_to_client",
            '{"jsonrpc":"2.0","id":"se1","result":"just a string"}',
        );

        expect(collection).toHaveLength(2);
        expect(collection[1]).toMatchObject({
            outcome: "ok",
            observation: { result: "just a string" },
        });
    });

    it("records a parse error on the server_to_client direction with a 'stdout' stream", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine("server_to_client", "not json at all");

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            kind: "mcp_parse_error",
            direction: "server_to_client",
            stream: "stdout",
        });
    });

    it("assigns the default appendCollectionRecord function when omitted, without invoking it", () => {
        const records: McpEventRecord[] = [];
        const recorder = new McpProtocolRecorder({
            serverName: "context7",
            transport: "stdio",
            append: (record) => {
                records.push(record);
            },
        });

        recorder.recordStderrLine("no collection path exercised here");

        expect(records).toHaveLength(1);
    });

    it("classifies a null jsonrpc id via normalizeJsonRpcId's null branch", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine("server_to_client", '{"jsonrpc":"2.0","id":null,"result":{}}');

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ message_type: "response", jsonrpc_id: null });
    });

    it("normalizes a non-string/number/null jsonrpc id to null", () => {
        const records: McpEventRecord[] = [];
        const clock = { ms: 1 };
        const recorder = makeRecorder(records, clock);

        recorder.recordJsonLine("server_to_client", '{"jsonrpc":"2.0","id":true,"result":{}}');

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ message_type: "response", jsonrpc_id: null });
    });

    describe("oversized payload capture", () => {
        let tmp: string;

        beforeEach(() => {
            tmp = mkdtempSync(join(tmpdir(), "interlinked-mcp-recorder-"));
        });

        afterEach(() => {
            rmSync(tmp, { recursive: true, force: true });
        });

        it("writes a payload_ref + preview (not inline payload) when the message exceeds inlineLimitBytes", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 1 };
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                cwd: tmp,
                inlineLimitBytes: 8,
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
            });

            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","method":"notifications/large","params":{"data":"this payload is definitely over eight bytes"}}',
            );

            expect(records).toHaveLength(1);
            expect(nonNull(records[0]).payload).toBeUndefined();
            expect(Object.prototype.hasOwnProperty.call(nonNull(records[0]), "payload")).toBe(false);
            expect(nonNull(records[0]).payload_ref).toBeDefined();
            expect(nonNull(records[0]).payload_preview).toBeDefined();
            expect(nonNull(records[0]).fidelity.inline).toBe(false);
            expect(nonNull(records[0]).payload_ref?.content_type).toBe("application/json");
        });

        it("captures an oversized stderr line's blob with content_type text/plain", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 1 };
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                cwd: tmp,
                inlineLimitBytes: 8,
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
            });

            recorder.recordStderrLine("this stderr line is definitely over eight bytes long");

            expect(records).toHaveLength(1);
            expect(nonNull(records[0]).payload_ref?.content_type).toBe("text/plain");
            expect(nonNull(records[0]).payload_ref?.path.endsWith(".txt")).toBe(true);
        });

        it("captures an oversized transport-error blob with content_type application/json", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 1 };
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                cwd: tmp,
                inlineLimitBytes: 8,
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
            });

            recorder.recordTransportError("this transport error message is definitely over eight bytes");

            expect(records).toHaveLength(1);
            expect(nonNull(records[0]).payload_ref?.content_type).toBe("application/json");
            expect(nonNull(records[0]).payload_ref?.path.endsWith(".json")).toBe(true);
        });

        it("captures an oversized transport-close blob with content_type application/json", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 1 };
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                cwd: tmp,
                inlineLimitBytes: 4,
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
            });

            recorder.recordTransportClose(1, "SIGTERM");

            expect(records).toHaveLength(1);
            expect(nonNull(records[0]).payload_ref?.content_type).toBe("application/json");
        });

        it("captures an oversized parse-error blob with content_type application/json", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 1 };
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                cwd: tmp,
                inlineLimitBytes: 4,
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
            });

            recorder.recordJsonLine("client_to_server", "not valid json at all, definitely");

            expect(records).toHaveLength(1);
            expect(nonNull(records[0]).kind).toBe("mcp_parse_error");
            expect(nonNull(records[0]).payload_ref?.content_type).toBe("application/json");
        });

        it("uses the default append (appendMcpEvent) function when omitted, writing to the mcp-events.jsonl file", () => {
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                cwd: tmp,
            });

            recorder.recordStderrLine("default-append path");

            const written = readFileSync(getMcpEventsPath(tmp), "utf-8").trim();
            const parsed: unknown = JSON.parse(written);
            expect(parsed).toHaveProperty("message_type", "transport_stderr");
            expect(parsed).toHaveProperty("payload", "default-append path");
        });
    });

    describe("mutation-hardening: cross-cutting correlation and classification behaviors", () => {
        it("does not let a response-shaped-but-non-response message consume a pending request's correlation", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 5000 };
            const recorder = makeRecorder(records, clock);

            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}',
            );

            clock.ms = 5010;
            recorder.recordJsonLine("server_to_client", '{"jsonrpc":"2.0","id":7,"foo":"bar"}');
            expect(nonNull(records[1]).message_type).toBe("unknown");
            expect(nonNull(records[1]).latency_ms).toBeUndefined();
            expect(nonNull(records[1]).request_method).toBeUndefined();

            clock.ms = 5042;
            recorder.recordJsonLine(
                "server_to_client",
                '{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}',
            );
            expect(records[2]).toMatchObject({
                message_type: "response",
                latency_ms: 42,
                request_method: "tools/list",
            });
        });

        it("treats a top-level JSON null value as an unknown message without throwing", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 1 };
            const recorder = makeRecorder(records, clock);

            expect(() => recorder.recordJsonLine("client_to_server", "null")).not.toThrow();

            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({ message_type: "unknown", payload: null });
            expect(nonNull(records[0]).method).toBeUndefined();
            expect(nonNull(records[0]).jsonrpc_id).toBeUndefined();
        });

        it("does not treat a non-string method value as a request (method must be a string)", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 1 };
            const recorder = makeRecorder(records, clock);

            recorder.recordJsonLine("client_to_server", '{"jsonrpc":"2.0","id":1,"method":42}');

            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({ message_type: "unknown" });
            expect(nonNull(records[0]).method).toBeUndefined();
        });

        it("does not crash and treats a null result as a non-error tool response", () => {
            const records: McpEventRecord[] = [];
            const collection: CollectionRecord[] = [];
            const clock = { ms: 1000 };
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
                appendCollectionRecord: (record) => {
                    collection.push(record);
                },
            });

            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","id":"rn1","method":"tools/call","params":{"name":"doThing","arguments":{}}}',
            );

            expect(() =>
                recorder.recordJsonLine("server_to_client", '{"jsonrpc":"2.0","id":"rn1","result":null}'),
            ).not.toThrow();

            expect(collection).toHaveLength(2);
            expect(collection[1]).toMatchObject({ outcome: "ok" });
        });

        it("keeps two concurrent pending requests correlated independently (distinct pending keys)", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 100 };
            const recorder = makeRecorder(records, clock);

            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","id":"a","method":"tools/list","params":{}}',
            );
            clock.ms = 110;
            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","id":"b","method":"resources/list","params":{}}',
            );
            clock.ms = 150;
            recorder.recordJsonLine("server_to_client", '{"jsonrpc":"2.0","id":"b","result":{}}');
            clock.ms = 200;
            recorder.recordJsonLine("server_to_client", '{"jsonrpc":"2.0","id":"a","result":{}}');

            expect(records[3]).toMatchObject({ request_method: "tools/list", latency_ms: 100 });
            expect(records[2]).toMatchObject({ request_method: "resources/list", latency_ms: 40 });
        });

        it("preserves a numeric jsonrpc id exactly via normalizeJsonRpcId's number branch", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 1 };
            const recorder = makeRecorder(records, clock);

            recorder.recordJsonLine("server_to_client", '{"jsonrpc":"2.0","id":55,"result":{}}');

            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({ jsonrpc_id: 55 });
        });

        it("correlates an unsupported request id after normalizing it to null", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 100 };
            const recorder = makeRecorder(records, clock);

            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","id":true,"method":"tools/list","params":{}}',
            );
            clock.ms = 125;
            recorder.recordJsonLine(
                "server_to_client",
                '{"jsonrpc":"2.0","id":null,"result":{"tools":[]}}',
            );

            expect(records[0]).toMatchObject({
                message_type: "request",
                jsonrpc_id: null,
            });
            expect(records[1]).toMatchObject({
                message_type: "response",
                jsonrpc_id: null,
                request_method: "tools/list",
                latency_ms: 25,
            });
        });

        it("does not register a pending tool call for a server-initiated tools/call-shaped request", () => {
            const records: McpEventRecord[] = [];
            const collection: CollectionRecord[] = [];
            const clock = { ms: 1 };
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
                appendCollectionRecord: (record) => {
                    collection.push(record);
                },
            });

            recorder.recordJsonLine(
                "server_to_client",
                '{"jsonrpc":"2.0","id":"srv1","method":"tools/call","params":{"name":"x"}}',
            );

            expect(records).toHaveLength(1);
            expect(collection).toEqual([]);
        });

        it("does not register a pending tool call for a non-tools/call client request", () => {
            const records: McpEventRecord[] = [];
            const collection: CollectionRecord[] = [];
            const clock = { ms: 1 };
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
                appendCollectionRecord: (record) => {
                    collection.push(record);
                },
            });

            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","id":"list1","method":"tools/list","params":{}}',
            );

            expect(records).toHaveLength(1);
            expect(collection).toEqual([]);
        });

        it("does not register a pending tool call for a tools/call-named notification (no id to correlate)", () => {
            const records: McpEventRecord[] = [];
            const collection: CollectionRecord[] = [];
            const clock = { ms: 1 };
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
                appendCollectionRecord: (record) => {
                    collection.push(record);
                },
            });

            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"x"}}',
            );

            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({ message_type: "notification" });
            expect(collection).toEqual([]);
        });

        it("tags a pre-phase (tool_use_start) derived event with hook_event PreToolUse and omits tool_response", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 1 };
            const spy = vi.spyOn(collectionBuilder, "buildCollectionRecord");
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
                // The derived collection event is observed through the builder spy;
                // swallow the write so the test never touches the real
                // .interlinked/ data directory (capture-isolation refuses that).
                appendCollectionRecord: () => {},
            });

            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","id":"h1","method":"tools/call","params":{"name":"lookup","arguments":{}}}',
            );

            expect(spy).toHaveBeenCalled();
            const input = nonNull(spy.mock.calls[0])[0];
            expect(input.hook_event).toBe("PreToolUse");
            expect(input.event_type).toBe("tool_use_start");
            expect(Object.prototype.hasOwnProperty.call(input, "tool_response")).toBe(false);
            spy.mockRestore();
        });

        it("tags a post-phase (tool_use) derived event with hook_event PostToolUse", () => {
            const records: McpEventRecord[] = [];
            const clock = { ms: 1 };
            const spy = vi.spyOn(collectionBuilder, "buildCollectionRecord");
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: (record) => {
                    records.push(record);
                },
                // Same isolation as the pre-phase case above.
                appendCollectionRecord: () => {},
            });

            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","id":"h2","method":"tools/call","params":{"name":"lookup","arguments":{}}}',
            );
            recorder.recordJsonLine("server_to_client", '{"jsonrpc":"2.0","id":"h2","result":{"content":[]}}');

            const postCall = spy.mock.calls.find((c) => c[0].event_type === "tool_use");
            expect(postCall).toBeDefined();
            expect(nonNull(postCall)[0].hook_event).toBe("PostToolUse");
            spy.mockRestore();
        });

        it("does not forward a null collection record to appendCollectionRecord", () => {
            const collection: CollectionRecord[] = [];
            const clock = { ms: 1 };
            const spy = vi.spyOn(collectionBuilder, "buildCollectionRecord").mockReturnValueOnce(null);
            const recorder = new McpProtocolRecorder({
                serverName: "context7",
                transport: "stdio",
                sessionId: "sess-1",
                now: () => new Date("2026-06-18T12:00:00.000Z"),
                clockMs: () => clock.ms,
                append: () => {},
                appendCollectionRecord: (record) => {
                    collection.push(record);
                },
            });

            recorder.recordJsonLine(
                "client_to_server",
                '{"jsonrpc":"2.0","id":"nr1","method":"tools/call","params":{"name":"lookup","arguments":{}}}',
            );

            expect(collection).toEqual([]);
            spy.mockRestore();
        });
    });
});

// =============================================================================
// extractJsonRpcResponsePayload — the two defensive fallback branches are
// unreachable through McpProtocolRecorder's public recordJsonLine (the only
// call site always hands it a message already classified as "response" or
// "error" by inspectJsonRpcMessage, which guarantees a JSON object carrying
// one of "error"/"result"); exercised directly per the campaign's exported-
// last-resort rule.
// =============================================================================

describe("extractJsonRpcResponsePayload", () => {
    // test-contract: boundary — a non-object message is returned as-is
    it("returns a non-object message unchanged instead of throwing on the property lookups", () => {
        expect(extractJsonRpcResponsePayload(null)).toBeNull();
    });

    // test-contract: boundary — an object with neither "error" nor "result" falls through
    it("returns the whole message when it carries neither an error nor a result key", () => {
        const message = { jsonrpc: "2.0", id: 7 };
        expect(extractJsonRpcResponsePayload(message)).toEqual({ jsonrpc: "2.0", id: 7 });
    });
});
