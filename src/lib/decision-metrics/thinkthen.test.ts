import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { CATALOG } from "./contracts.js";
import { privateDirectory } from "./store.js";
import { annotate, annotateArguments, decodeAnnotated } from "./thinkthen.js";
import type { DecisionConfig, DecisionQuestion } from "./types.js";

// The rows below are stdout lines captured from the ThinkThen 0.2.0 binary (`annotate --json`),
// not hand-written shapes: one live answer and three answers to a canned System One backend.
const renamed: DecisionQuestion = { id: "renamed", kind: "decide", question: "Is it renamed?", on: ["/ev"] };
const risk: DecisionQuestion = { id: "risk", kind: "score", question: "How risky?", on: ["/ev"], levels: ["low", "medium", "high"] };
const area = (names: string[]): DecisionQuestion => ({ id: "area", kind: "choose", question: "Which area?", on: ["/ev"], options: Object.fromEntries(names.map((name) => [name, `${name} code`])) });
const tags = (labels: string[]): DecisionQuestion => ({ id: "tags", kind: "tag", question: "Which labels?", on: ["/ev"], labels });

const LIVE =
    '{"function":"annotate","position":1,"id":"unit-1","source":{"question_identity":"d8070efd8478481746af6b49f5d6b81dde9263533a67a33faaa6c44abc68fa5f","backend":"systemone","model":"jev-1.13.0"},"status":"answered","answer":{"area":{"function":"choose","status":"answered","answer":"source","probability":1.0,"detail":{"labels":{"docs":0.0,"source":1.0,"tests":0.0}}},"renamed":{"function":"decide","status":"answered","answer":true,"probability":0.98},"risk":{"function":"score","status":"answered","answer":0.465,"detail":{"levels":[0.27,0.53,0.2]}},"tags":{"function":"tag","status":"answered","answer":["refactor"],"detail":{"labels":{"bugfix":0.22,"feature":0.17,"refactor":0.77}}}}}';
const PARTIAL =
    '{"function":"annotate","position":1,"id":"u1","source":{"question_identity":"ebe57d924e1dc3980d2fb4d4aa882b0ddf67d5a2de9c2219e8e171d354a6aecf","backend":"systemone","model":"clef-flash:9b"},"status":"answered","answer":{"area":{"function":"choose","status":"answered","answer":"source","probability":0.9,"detail":{"labels":{"insufficient_evidence":0.05,"source":0.9,"tests":0.05}}},"renamed":{"function":"decide","status":"failed","error":{"code":"backend.reply","message":"the backend gave no answer to the question"}},"risk":{"function":"score","status":"failed","error":{"code":"backend.reply","message":"the backend gave no probability from 0 to 1 for a level"}},"tags":{"function":"tag","status":"answered","answer":["refactor"],"detail":{"labels":{"bugfix":0.1,"refactor":0.9}}}}}';
const UNSURE =
    '{"function":"annotate","position":1,"id":"u1","source":{"question_identity":"ebe57d924e1dc3980d2fb4d4aa882b0ddf67d5a2de9c2219e8e171d354a6aecf","backend":"systemone","model":"clef-flash:9b"},"status":"answered","answer":{"area":{"function":"choose","status":"unsure","probability":0.3412345,"detail":{"labels":{"insufficient_evidence":0.327531,"source":0.3312345,"tests":0.3412345}}},"renamed":{"function":"decide","status":"answered","answer":false,"probability":0.4712345678},"tags":{"function":"tag","status":"answered","answer":[],"detail":{"labels":{"bugfix":0.1712345,"refactor":0.4812345}}}}}';
const RECORD_FAILED =
    '{"function":"annotate","position":1,"source":{"question_identity":"ebe57d924e1dc3980d2fb4d4aa882b0ddf67d5a2de9c2219e8e171d354a6aecf","backend":"stub","model":"stub"},"status":"failed","error":{"code":"record.invalid","message":"the record cannot be converted without loss"}}';

describe("decodeAnnotated — ThinkThen 0.2 annotate rows", () => {
    it("maps each question function to its probability distribution", () => {
        const results = decodeAnnotated(LIVE, "unit-1", [renamed, area(["tests", "docs", "source"]), risk, tags(["refactor", "bugfix", "feature"])], "jev-1.13.0");
        expect(results.map((result) => result.raw)).toEqual([
            { kind: "yes_no", probability: 0.98 },
            { kind: "choice", probabilities: { docs: 0, source: 1, tests: 0 } },
            { kind: "score", probabilities: { low: 0.27, medium: 0.53, high: 0.2 } },
            { kind: "tag", probabilities: { bugfix: 0.22, feature: 0.17, refactor: 0.77 } },
        ]);
        expect(results.every((result) => result.failure === undefined)).toBe(true);
        expect(results[0]).toMatchObject({
            metric: "renamed",
            servedModel: "jev-1.13.0",
            adapterVersion: "thinkthen-cli-0.2/annotate-json",
            questionKey: "d8070efd8478481746af6b49f5d6b81dde9263533a67a33faaa6c44abc68fa5f",
            requestHash: null,
        });
    });

    it("preserves partial failures and never treats a missing answer as abstention", () => {
        const results = decodeAnnotated(PARTIAL, "u1", [area(["tests", "source", "insufficient_evidence"]), renamed, risk, CATALOG.intent!], "clef-flash:9b");
        expect(results[0]?.raw).toEqual({ kind: "choice", probabilities: { insufficient_evidence: 0.05, source: 0.9, tests: 0.05 } });
        expect(results[1]).toMatchObject({ raw: null, failure: "backend question failed: backend.reply" });
        expect(results[2]).toMatchObject({ raw: null, failure: "backend question failed: backend.reply" });
        expect(results[3]).toMatchObject({ raw: null, failure: "missing question in backend response" });
    });

    it("keeps the full-precision distribution of an answer ThinkThen calls unsure", () => {
        const results = decodeAnnotated(UNSURE, "u1", [area(["tests", "source", "insufficient_evidence"]), renamed, tags(["refactor", "bugfix"])], null);
        expect(results[0]?.raw).toEqual({ kind: "choice", probabilities: { insufficient_evidence: 0.327531, source: 0.3312345, tests: 0.3412345 } });
        expect(results[1]?.raw).toEqual({ kind: "yes_no", probability: 0.4712345678 });
        expect(results[2]?.raw).toEqual({ kind: "tag", probabilities: { bugfix: 0.1712345, refactor: 0.4812345 } });
        expect(results[0]?.servedModel).toBeNull();
    });

    it("reports a record-level failure on every question", () => {
        const results = decodeAnnotated(RECORD_FAILED, "u1", [renamed, risk], null);
        expect(results).toHaveLength(2);
        for (const result of results) expect(result).toMatchObject({ raw: null, failure: "backend record failed: record.invalid" });
    });

    it("rejects a distribution that does not match the contract", () => {
        const [wrongOptions] = decodeAnnotated(LIVE, "unit-1", [area(["tests", "docs"])], null);
        expect(wrongOptions).toMatchObject({ raw: null, failure: "malformed backend probability distribution" });
        const [wrongLevels] = decodeAnnotated(LIVE, "unit-1", [{ ...risk, levels: ["low", "high"] }], null);
        expect(wrongLevels).toMatchObject({ raw: null, failure: "malformed backend probability distribution" });
        const [wrongFunction] = decodeAnnotated(LIVE, "unit-1", [{ ...renamed, id: "area" }], null);
        expect(wrongFunction).toMatchObject({ raw: null, failure: "malformed backend probability distribution" });
    });

    it("rejects another record, another function, and anything but one row", () => {
        expect(() => decodeAnnotated(LIVE, "other", [renamed], null)).toThrow(/identity/);
        expect(() => decodeAnnotated(LIVE.replace('"function":"annotate"', '"function":"decide"'), "unit-1", [renamed], null)).toThrow(/schema/);
        expect(() => decodeAnnotated(`${LIVE}\n${LIVE}`, "unit-1", [renamed], null)).toThrow(/exactly one/);
        expect(() => decodeAnnotated("", "unit-1", [renamed], null)).toThrow(/exactly one/);
        // The 0.1 row shape (`schema: thinkthen.result/1`) is no longer accepted.
        expect(() => decodeAnnotated('{"schema":"thinkthen.result/1","input":{"id":"unit-1"},"answers":{},"meta":{"model":"m","tool":"thinkthen 0.1.2"}}', "unit-1", [renamed], null)).toThrow(/schema/);
    });
});

describe("annotateArguments — the ThinkThen 0.2 command line", () => {
    const config: DecisionConfig = { ...DEFAULT_CONFIG, model: "clef-flash:9b" };

    it("always addresses the recorder as a System One backend, whatever the upstream backend is", () => {
        for (const backend of ["ollama", "typesafe", "liquid", "openrouter", "perplexity"] as const) {
            expect(annotateArguments({ ...config, backend }, "/run/questions.json", "http://127.0.0.1:4010/v1")).toEqual([
                "annotate", "/run/questions.json", "--json", "--from", "jsonl", "--batch", "1",
                "--model", "clef-flash:9b", "--backend", "systemone", "--url", "http://127.0.0.1:4010/v1",
            ]);
        }
    });

    it("uses the offline stub backend to validate a plan without a request", () => {
        expect(annotateArguments(config, "/run/questions.json", null)).toEqual([
            "annotate", "/run/questions.json", "--json", "--from", "jsonl", "--batch", "1",
            "--model", "clef-flash:9b", "--backend", "stub",
        ]);
    });
});

// A stand-in executable that records how it was invoked, then behaves as ThinkThen 0.2 does:
// one POST to <url>/systemone per record (none for the stub backend) and one JSON row on stdout.
const FAKE_THINKTHEN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const record = JSON.parse(fs.readFileSync(0, "utf8"));
const toolbox = JSON.parse(fs.readFileSync(args[1], "utf8"));
fs.writeFileSync(path.join(__dirname, "invocation.json"), JSON.stringify({ args, record, toolbox, env: Object.keys(process.env).sort(), key: process.env.THINKTHEN_API_KEY }));
const row = (model, answer) => ({ function: "annotate", position: 1, id: record.id, source: { question_identity: "fixture-identity", backend: value("--backend"), model }, status: "answered", answer });
const answers = { name_matches: { function: "decide", status: "answered", answer: true, probability: 0.9 }, intent: { function: "choose", status: "answered", answer: "fix", probability: 0.9, detail: { labels: { fix: 0.9, feature: 0.02, refactor: 0.02, revert: 0.02, chore: 0.02, insufficient_evidence: 0.02 } } } };
if (value("--backend") === "stub") {
    if (record.fail) process.exit(6);
    process.stdout.write(JSON.stringify(row("stub", answers)) + "\\n");
} else {
    fetch(value("--url") + "/systemone", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.THINKTHEN_API_KEY }, body: JSON.stringify({ state: "s", model: value("--model"), questions: {} }) })
        .then(async (response) => {
            await response.text();
            process.stdout.write(JSON.stringify(row(value("--model"), response.ok ? answers : { name_matches: { function: "decide", status: "failed", error: { code: "backend.status", message: "status " + response.status, http_status: response.status } } })) + "\\n");
            process.exit(response.ok ? 0 : 6);
        });
}
`;

describe("annotate — end to end through the recorder", () => {
    let root: string;
    let upstream: Server;
    let upstreamUrl: string;
    let upstreamStatus: number;
    let upstreamModel: string;
    let upstreamHeaders: (string | undefined)[];

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), "thinkthen-adapter-"));
        writeFileSync(join(root, "thinkthen"), FAKE_THINKTHEN);
        chmodSync(join(root, "thinkthen"), 0o755);
        upstreamStatus = 200;
        upstreamModel = "clef-flash:9b";
        upstreamHeaders = [];
        vi.stubEnv("OLLAMA_API_KEY", "real-upstream-key");
        upstream = createServer((req, res) => {
            upstreamHeaders.push(req.headers.authorization);
            req.resume();
            req.on("end", () => {
                res.writeHead(upstreamStatus, { "content-type": "application/json" });
                res.end(JSON.stringify({ model: upstreamModel, answers: {} }));
            });
        });
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        const address = upstream.address();
        if (!address || typeof address === "string") throw new Error("no upstream port");
        upstreamUrl = `http://127.0.0.1:${address.port}/v1`;
    });

    afterEach(async () => {
        await new Promise((resolve) => upstream.close(resolve));
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
    });

    const configFor = (): DecisionConfig => ({ ...DEFAULT_CONFIG, command: join(root, "thinkthen"), url: upstreamUrl, ollamaUrl: upstreamUrl.replace(/\/v1$/, "") });
    // Callers create the private call folder before they hand it to the adapter.
    const callFolder = (name: string): string => {
        const folder = join(root, name);
        privateDirectory(folder);
        return folder;
    };
    const contracts = [CATALOG.name_matches!, CATALOG.intent!];
    const evidence = { signature: "function loadCfg()", body: "return read();", message: "fix: load", hunk: "+x" };
    const invocation = (): { args: string[]; record: Record<string, unknown>; toolbox: { questions: Record<string, { field: string }> }; env: string[]; key: string } =>
        JSON.parse(readFileSync(join(root, "invocation.json"), "utf8"));

    it("sends one record with a derived evidence field per multi-field question and decodes the row", async () => {
        const folder = callFolder("call");
        const answers = await annotate(configFor(), { id: "unit-1", evidence }, contracts, { folder, deadline: Date.now() + 20000, plan: false });

        const seen = invocation();
        expect(seen.args.slice(0, 9)).toEqual(["annotate", join(folder, "questions.json"), "--json", "--from", "jsonl", "--batch", "1", "--model", DEFAULT_CONFIG.model]);
        expect(seen.args[seen.args.indexOf("--backend") + 1]).toBe("systemone");
        expect(seen.args[seen.args.indexOf("--url") + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
        expect(seen.args[seen.args.indexOf("--url") + 1]).not.toBe(upstreamUrl);
        // The child holds only the loopback placeholder; the recorder alone sends the real upstream key.
        expect(seen.env.filter((name) => name.endsWith("_API_KEY"))).toEqual(["THINKTHEN_API_KEY"]);
        expect(seen.key).toBe("interlinked-loopback-proxy");
        expect(upstreamHeaders).toEqual(["Bearer real-upstream-key"]);
        expect(seen.record).toEqual({
            ...evidence,
            id: "unit-1",
            "interlinked.evidence:name_matches": { signature: "function loadCfg()", body: "return read();" },
            "interlinked.evidence:intent": { message: "fix: load", hunk: "+x" },
        });
        expect(seen.toolbox.questions.name_matches?.field).toBe("/interlinked.evidence:name_matches");
        expect(JSON.parse(readFileSync(join(folder, "input.json"), "utf8"))).toEqual(seen.record);

        expect(answers.map((answer) => answer.raw?.kind)).toEqual(["yes_no", "choice"]);
        expect(answers.every((answer) => answer.servedModel === "clef-flash:9b")).toBe(true);
        expect(readdirSync(join(folder, "exchanges"))).toHaveLength(1);
        expect(answers[0]?.requestHashes).toHaveLength(1);
        expect(answers[0]?.requestHash).toBe(answers[0]?.requestHashes?.[0]);
        expect(JSON.parse(readFileSync(join(folder, "command.json"), "utf8"))).toMatchObject({ exitCode: 0, timedOut: false });
    });

    it("reports the model the backend served, not the model that was requested", async () => {
        upstreamModel = "another-model";
        const answers = await annotate(configFor(), { id: "unit-1", evidence }, contracts, { folder: callFolder("call"), deadline: Date.now() + 20000, plan: false });
        expect(answers.map((answer) => answer.servedModel)).toEqual(["another-model", "another-model"]);
    });

    it("keeps per-question failures of a failed backend call (exit 6) and serves no model", async () => {
        upstreamStatus = 503;
        const answers = await annotate(configFor(), { id: "unit-1", evidence }, contracts, { folder: callFolder("call"), deadline: Date.now() + 20000, plan: false });
        expect(answers[0]).toMatchObject({ raw: null, servedModel: null, failure: "backend question failed: backend.status" });
        expect(answers[1]).toMatchObject({ raw: null, failure: "missing question in backend response" });
    });

    it("plans with the stub backend: no recorder, no request, no answers", async () => {
        const folder = callFolder("plan");
        expect(await annotate(configFor(), { id: "unit-1", evidence }, contracts, { folder, deadline: Date.now() + 20000, plan: true })).toEqual([]);
        expect(invocation().args).toEqual(annotateArguments(configFor(), join(folder, "questions.json"), null));
        expect(upstreamHeaders).toEqual([]);
        await expect(
            annotate(configFor(), { id: "unit-2", evidence: { ...evidence, fail: true } }, contracts, { folder: callFolder("plan-2"), deadline: Date.now() + 20000, plan: true }),
        ).rejects.toThrow("ThinkThen plan failed (6)");
    });

    it("fails closed on an exit code other than 0 or 6", async () => {
        writeFileSync(join(root, "thinkthen"), "#!/bin/sh\ncat > /dev/null\nexit 2\n");
        await expect(
            annotate(configFor(), { id: "unit-1", evidence }, contracts, { folder: callFolder("call"), deadline: Date.now() + 20000, plan: false }),
        ).rejects.toThrow("ThinkThen failed (2)");
    });
});
