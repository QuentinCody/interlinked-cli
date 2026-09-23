import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";
import { isJsonObject } from "../lib/json-types.js";

describe("Stop verification and session attribution", () => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture({ rules: { per_edit_coverage: { enabled: false } } }); });
    afterAll(async () => { await fixture?.close(); });
    async function post(sessionId: string, tool: string, input: Record<string, unknown>) {
        const result = await fixture.hook({ sessionId, event: "PostToolUse", tool, input, payload: { tool_response: "success" } });
        fixture.assertServed(result);
    }
    async function stop(sessionId: string) {
        const offset = fixture.ledger("stop-digest.jsonl").length;
        const result = await fixture.hook({ sessionId, event: "Stop" });
        fixture.assertServed(result);
        expect(result.code).toBe(0);
        const detail = fixture.ledger("stop-digest.jsonl").slice(offset).filter((row) => isJsonObject(row) && row.session === sessionId);
        return result.stdout + result.stderr + JSON.stringify(detail);
    }
    async function write(sessionId: string, path: string, content = "export const value = 1;\n") {
        await post(sessionId, "Write", { file_path: fixture.file(path, content), content });
    }
    async function extraCode(session: string) {
        for (let index = 0; index < 4; index++) await post(session, "Write", { file_path: `${fixture.cwd}/src/${session}-${index}.ts`, content: "export const value = 1;\n" });
    }

    it("warns about unverified code and clears only the verification axis after a test command", async () => {
        const session = `${fixture.sessionPrefix}-code`;
        await write(session, "src/code.ts");
        await extraCode(session);
        const warning = await stop(session);
        expect(warning).toContain("no tsc / test / lint / build invocation observed");
        expect(warning).not.toContain("UI file edit");
        expect(warning).not.toContain("stub / TODO");
        await post(session, "Bash", { command: "bun run test" });
        expect(await stop(session)).not.toContain("no tsc / test / lint / build invocation observed");
    });

    it.each(["none", "dev", "browser"])("checks the UI axis independently (%s)", async (signal) => {
        const session = `${fixture.sessionPrefix}-ui-${signal}`;
        await write(session, `src/${signal}.tsx`, "export function View() { return <div />; }\n");
        await extraCode(session);
        if (signal === "dev") await post(session, "Bash", { command: "npm run dev" });
        if (signal === "browser") await post(session, "mcp__chrome-devtools__navigate_page", {});
        const warning = await stop(session);
        expect(warning.includes("UI file edit")).toBe(signal === "none");
        expect(warning).toContain("no tsc / test / lint / build invocation observed");
    });

    it("reports concrete stubs, while prose-only edits do not require code verification", async () => {
        const session = `${fixture.sessionPrefix}-stubs`;
        await write(session, "src/stubs.ts", '// TODO: implement\n// FIXME: unfinished\nexport function missing() { throw new Error("not implemented"); }\ndescribe.skip("pending", () => {});\n');
        const warning = await stop(session);
        for (const marker of ["TODO", "FIXME", "not-implemented-throw", "disabled-test"]) expect(warning).toContain(marker);
        const prose = `${fixture.sessionPrefix}-prose`;
        await write(prose, "README.md", "TODO: document examples\n");
        expect(await stop(prose)).not.toContain("no tsc / test / lint / build invocation observed");
    });

    it("reports repeated implementations at Stop without repeating unchanged advice", async () => {
        const session = `${fixture.sessionPrefix}-repeated`;
        const body = `(state) { const next = structuredClone(state); const job = next.job; job.status = "done"; job.token = null; job.expiry = null; return next; }`;
        await write(session, "src/handlers.ts", `export function ack${body}\nexport function retry${body.replace('"done"', '"pending"')}\n`);
        const first = await stop(session);
        expect(first).toContain("similar implementations");
        expect(first).toContain("ack");
        expect(first).toContain("retry");
        const next = await fixture.hook({ sessionId: session, event: "Stop" });
        fixture.assertServed(next);
        expect(next.code).toBe(0);
        expect(next.stdout + next.stderr).not.toContain("similar implementations");
    });

    it("MUST-FIRE: boundary and adapter edits need this session's e2e lane", async () => {
        const a = `${fixture.sessionPrefix}-boundary`;
        const b = `${fixture.sessionPrefix}-adapter`;
        await write(a, "src/hook-entry.ts");
        await write(b, "src/harness/adapters/example.ts");
        await post(b, "Bash", { command: "npm run test:unit" });
        expect(await stop(a)).toContain("e2e-obligation");
        await post(a, "Bash", { command: "npm run test:e2e" });
        expect(await stop(a)).not.toContain("e2e-obligation");
        expect(await stop(b)).toContain("e2e-obligation");
    });

    it.each(["src/ordinary.ts", "src/harness/server/example.test.ts", "src/e2e/example.e2e.test.ts"])("MUST-NOT-FIRE: %s", async (path) => {
        const session = `${fixture.sessionPrefix}-${path.replaceAll("/", "-")}`;
        await write(session, path);
        expect(await stop(session)).not.toContain("e2e-obligation");
    });
});
