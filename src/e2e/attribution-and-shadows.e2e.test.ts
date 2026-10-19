import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_QUALITY_CHECKS } from "../harness/rules/default-config-quality-checks.js";
import { createFixture, type E2eFixture } from "./fixture.js";

let fixture: E2eFixture | undefined;
let server: Server | undefined;
afterEach(async () => {
    await fixture?.close(); fixture = undefined;
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
});
const disabledChecks = Object.fromEntries(Object.entries(DEFAULT_QUALITY_CHECKS).map(([name, config]) => [name, { ...config, enabled: false }]));

it("labels sibling workspace effects without assigning both writes to each actor", async () => {
    fixture = await createFixture({ rules: { quality_checks: disabledChecks, per_edit_coverage: { enabled: false }, project_wide_checks: { enabled: false } } });
    const a = `${fixture.sessionPrefix}-a`, b = `${fixture.sessionPrefix}-b`;
    const first = { file_path: join(fixture.cwd, "a.md"), content: "first\n" };
    const second = { file_path: join(fixture.cwd, "b.md"), content: "second\n" };
    for (const [sessionId, input, id] of [[a, first, "write-a"], [b, second, "write-b"]] as const) {
        const pre = await fixture.hook({ sessionId, tool: "Write", input, payload: { tool_use_id: id } });
        fixture.assertServed(pre);
        expect(pre.stdout).not.toContain('"deny"');
    }
    fixture.file("a.md", first.content);
    fixture.file("b.md", second.content);
    for (const [sessionId, input, id] of [[a, first, "write-a"], [b, second, "write-b"]] as const) {
        const post = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Write", input, payload: { tool_use_id: id, tool_response: "success" } });
        fixture.assertServed(post);
    }
    const touches = fixture.ledger("files-touched.jsonl");
    expect(touches).toEqual(expect.arrayContaining([
        expect.objectContaining({ session_id: a, file: "a.md", attribution: "declared-target", shadow: false }),
        expect.objectContaining({ session_id: a, file: "b.md", attribution: "shadow", shadow: true }),
        expect.objectContaining({ session_id: b, file: "b.md", attribution: "declared-target", shadow: false }),
    ]));
    expect(fixture.ledger("reservation-events.jsonl")).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "grant", session_id: a, tool_use_id: "write-a" }),
        expect.objectContaining({ action: "grant", session_id: b, tool_use_id: "write-b" }),
    ]));
});

it("logs local shadow answers without releasing a blocked command or transmitting a raw credential", async () => {
    const calls: string[] = [];
    server = createServer((request, response) => {
        let body = "";
        request.on("data", chunk => { body += chunk; });
        request.on("end", () => {
            calls.push(body);
            const questions = Object.keys(JSON.parse(body).questions);
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ model: "fixture", answers: Object.fromEntries(questions.map(key => [key, { type: "noul", noul: 0.01 }])),
                usage: { input_tokens: 10, output_tokens: 0 } }));
        });
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    fixture = await createFixture({ rules: { quality_checks: disabledChecks, per_edit_coverage: { enabled: false },
        jev: { enabled: true, endpoint: `http://127.0.0.1:${address.port}`, shadow_edits: true },
        decision_shadow: { enabled: true, backend: "jev" } }, prepare(cwd) {
        writeFileSync(join(cwd, ".interlinked", "config.local.json"), JSON.stringify({ TYPESAFE_API_KEY: "fixture-only-key" }));
    } });
    const sessionId = `${fixture.sessionPrefix}-shadow`;
    const blocked = await fixture.hook({ sessionId, tool: "Bash", input: { command: "rm -rf /" }, payload: { tool_use_id: "blocked" } });
    fixture.assertServed(blocked);
    expect(blocked.stdout).toContain('"deny"');
    await vi.waitFor(() => expect(fixture!.ledger("decision-shadow.jsonl")).toEqual(expect.arrayContaining([
        expect.objectContaining({ surface: "guard_block", verdict: "would_release", session_id: sessionId }),
    ])), { timeout: 5000 });
    const credential = "ghp_" + "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2";
    const read = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Read", input: { file_path: "fixture.txt" },
        payload: { tool_use_id: "secret", tool_response: credential } });
    fixture.assertServed(read);
    await vi.waitFor(() => expect(fixture!.ledger("decision-shadow.jsonl")).toEqual(expect.arrayContaining([
        expect.objectContaining({ surface: "secret_hit", session_id: sessionId }),
    ])), { timeout: 5000 });
    expect(calls.join("\n")).not.toContain(credential);
    const file_path = fixture.file("src/example.ts", "export const answer = 1;\n");
    const edited = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Write", input: { file_path, content: "export const answer = 1;\n" },
        payload: { tool_use_id: "edit", tool_response: "success" } });
    fixture.assertServed(edited);
    await vi.waitFor(() => expect(fixture!.ledger("decision-shadow.jsonl")).toEqual(expect.arrayContaining([
        expect.objectContaining({ surface: "edit", p: 0.01, session_id: sessionId }),
    ])), { timeout: 5000 });
    const before = calls.length;
    const probe = await fixture.cli(["harness", "test", "rm -rf /", "--json"]);
    expect(probe.stdout).toContain("block");
    expect(calls).toHaveLength(before);
});
