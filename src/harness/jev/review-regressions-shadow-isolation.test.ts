import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jevClaimsAction } from "../../commands/jev.js";
import { splitClaims } from "./claim-evidence.js";
import { JevClient } from "./client.js";
import type { ReceiptShadowRow } from "./receipt-shadow.js";

/** Pins for scratch/review-jev-receipt-shadow/REVIEW.md R1 follow-up: the shadow scores on its OWN client and ledger. */
const LONG = "The daemon now serves the rebuilt bundle on the socket.";
const GRAMMAR = "Command completed.";
const MESSAGE = `${LONG}\n${GRAMMAR}`;

let dir = "";
const out: string[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jev-shadow-iso-"));
	out.length = 0;
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

interface Double {
	client: JevClient;
	bodies: string[];
}

/** A real JevClient over an injected fetch: `k*` answers 0.9, `e*` answers `evidenced`; `status` != 200 fails every call. */
function fetchDouble(opts: { status?: number; evidenced?: number; tokens?: number } = {}): Double {
	const bodies: string[] = [];
	const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
		bodies.push(String(init.body));
		const status = opts.status ?? 200;
		if (status !== 200) return new Response("down", { status });
		const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> }; // SAFETY: the client serializes exactly this shape
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: id.startsWith("k") ? 0.9 : (opts.evidenced ?? 0.9) };
		return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: opts.tokens ?? 5, output_tokens: 1 } }), { status: 200 });
	});
	return { client: new JevClient({ apiKey: "k", fetchImpl }), bodies };
}

function opLink(claim: string) {
	return { claim, family: "operational", scope: { receiptId: "r2", sourceIdentity: "rev1", selection: ["suite"], cwd: "/p" },
		receipt: { id: "r2", cwd: "/p", sourceIdentity: "rev1", selection: ["suite"], completion: "completed", runner: "command",
			directInvocation: true, outputComplete: true, sourceUnchanged: true, exitCode: 0, signal: null } };
}

/** `linked` is the claim the links file names: an unlinked row's claim is logged as a digest, a linked one verbatim. */
function fixture(message: string, linked: string): { finalFile: string; transcript: string; links: string } {
	const finalFile = join(dir, "final.txt");
	const transcript = join(dir, "transcript.jsonl");
	const links = join(dir, "links.json");
	writeFileSync(finalFile, message);
	writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { content: [
		{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run build" } },
	] } })}\n`);
	writeFileSync(links, JSON.stringify([opLink(linked)]));
	return { finalFile, transcript, links };
}

async function run(judgment: Double, shadow?: Double | null, message = MESSAGE, linked = GRAMMAR): Promise<{ code: number; findings: string[]; summary: string }> {
	const f = fixture(message, linked);
	out.length = 0;
	const opts = shadow === undefined
		? { client: judgment.client, json: true, cwd: dir }
		: { client: judgment.client, json: true, cwd: dir, receiptShadow: f.links, shadowClient: shadow ? shadow.client : null };
	const code = await jevClaimsAction(f.finalFile, f.transcript, opts);
	const parsed = JSON.parse(out.join("")) as { findings: string[]; summary: string }; // SAFETY: emit writes exactly this JSON shape
	return { code, ...parsed };
}

function rows(): ReceiptShadowRow[] {
	return readFileSync(join(dir, ".interlinked", "claim-receipt-shadow.jsonl"), "utf8").trim().split("\n")
		.map((l) => JSON.parse(l) as ReceiptShadowRow); // SAFETY: the shadow writer appends one ReceiptShadowRow per line
}

describe("receipt shadow isolation — positive (must hold)", () => {
	it("P1: a shadow-only Jev failure leaves jevClaimsAction at exit 0 with unchanged findings", async () => {
		const plain = await run(fetchDouble({ evidenced: 0.0 }));
		const failingShadow = fetchDouble({ status: 500 });
		const shadowed = await run(fetchDouble({ evidenced: 0.0 }), failingShadow);
		expect(plain.findings).toHaveLength(1);
		expect(shadowed.code).toBe(0);
		expect(shadowed.findings).toEqual(plain.findings);
		expect(failingShadow.client.spend()).toMatchObject({ calls: 1, failures: 1 });
		expect(rows()).toContainEqual(expect.objectContaining({ claim: GRAMMAR, status: "supported", jevSupported: null, disagrees: null }));
	});

	it("P2: a judgment-call failure still returns EXIT_UNAVAILABLE with the shadow on", async () => {
		const shadow = fetchDouble();
		const result = await run(fetchDouble({ status: 500 }), shadow);
		expect(result.code).toBe(2);
		expect(shadow.client.spend()).toMatchObject({ calls: 1, failures: 0 });
	});

	it("P3: the judgment request body is byte-identical with and without the shadow", async () => {
		const plain = fetchDouble();
		await run(plain);
		const shadowed = fetchDouble();
		const shadow = fetchDouble();
		await run(shadowed, shadow);
		expect(plain.bodies).toHaveLength(1);
		expect(shadowed.bodies).toEqual(plain.bodies);
		expect(shadow.bodies).toHaveLength(1);
		expect((JSON.parse(shadow.bodies[0] ?? "{}") as { state: { claims: string[] } }).state.claims).toEqual([GRAMMAR]); // SAFETY: the client serializes { model, state, questions }
	});

	it("P4: with a shadow client, a grammar line gets jevSupported and disagrees", async () => {
		await run(fetchDouble(), fetchDouble({ evidenced: 0.0 }));
		expect(rows()).toContainEqual(expect.objectContaining({ claim: GRAMMAR, status: "supported", jevSupported: false, disagrees: true }));
	});

	it("P5: the summary reports shadow spend separately", async () => {
		const judgment = fetchDouble({ tokens: 5 });
		const result = await run(judgment, fetchDouble({ tokens: 1_000_000 }));
		expect(judgment.client.spend().calls).toBe(1);
		expect(result.summary).toBe("jev claims: 0 warning(s); spend $0.0000; shadow spend $0.0420 (1 call(s), 0 failure(s))");
		const plain = await run(fetchDouble({ tokens: 5 }));
		expect(plain.summary).toBe("jev claims: 0 warning(s); spend $0.0000");
	});
});

describe("receipt shadow isolation — negative (must not fire)", () => {
	it("N1: a shadow without its own client makes zero extra calls on the judgment client and rows stay unmeasured", async () => {
		const judgment = fetchDouble({ evidenced: 0.0 });
		const result = await run(judgment, null);
		expect(result.code).toBe(0);
		expect(judgment.client.spend().calls).toBe(1);
		expect((JSON.parse(judgment.bodies[0] ?? "{}") as { state: { claims: string[] } }).state.claims).toEqual([LONG]); // SAFETY: as in P3
		expect(rows()).toContainEqual(expect.objectContaining({ claim: GRAMMAR, jevSupported: null, disagrees: null }));
		expect(result.summary).toBe("jev claims: 1 warning(s); spend $0.0000; shadow spend $0.0000 (0 call(s), 0 failure(s))");
	});
});

/** The claims the shadow client was asked to score (empty when it made no call). */
function shadowClaims(shadow: Double): string[] {
	return shadow.bodies.flatMap((b) => (JSON.parse(b) as { state: { claims: string[] } }).state.claims); // SAFETY: as in P3
}

/** Refuter inputs: each message holds exactly one grammar sentence, and must give exactly one row keyed on it. */
const MEASURED: ReadonlyArray<{ id: string; message: string; key: string }> = [
	{ id: "M1 pipe spans in a path", message: "File `out | tee x | more words here.log` was written.", key: "File `out | tee x | more words here.log` was written." },
	{ id: "M2 sentence break in a path", message: "File `notes. Draft one two three.md` was written.", key: "File `notes. Draft one two three.md` was written." },
	{ id: "M3 bullet marker", message: "- Command completed.", key: GRAMMAR },
	{ id: "M4 numbered marker", message: "1. Command completed.", key: GRAMMAR },
	{ id: "M5 wrapping emphasis", message: "**Typecheck completed cleanly.**", key: "Typecheck completed cleanly." },
	{ id: "M6 blockquote marker", message: "> All 3 executed tests passed.", key: "All 3 executed tests passed." },
	{ id: "M7 second sentence of a line", message: "I ran the build. Command completed.", key: GRAMMAR },
];

describe("receipt shadow measurement — positive (must hold)", () => {
	for (const c of MEASURED) {
		it(`${c.id}: one grammar row with the exact key and no extra row`, async () => {
			const shadow = fetchDouble();
			await run(fetchDouble(), shadow, c.message, c.key);
			expect(rows().map((r) => r.claim)).toEqual([c.key]);
			expect(rows()[0]).toMatchObject({ claim: c.key, jevSupported: true });
			expect(shadowClaims(shadow)).toEqual([c.key]);
		});
	}
});

describe("receipt shadow measurement — negative (must not fire)", () => {
	it("N2: a grammar sentence inside a fenced code block yields no row", async () => {
		const shadow = fetchDouble();
		await run(fetchDouble(), shadow, `${LONG}\n\x60\x60\x60\n${GRAMMAR}\n\x60\x60\x60`, LONG);
		expect(rows().map((r) => r.claim)).toEqual([LONG]);
		expect(shadow.client.spend().calls).toBe(0);
	});

	it("N3: \"Command completed successfully.\" is not the exact form and yields no grammar row", async () => {
		const shadow = fetchDouble();
		await run(fetchDouble(), shadow, `${LONG}\nCommand completed successfully.`, LONG);
		expect(rows().map((r) => r.claim)).toEqual([LONG]);
		expect(shadow.client.spend().calls).toBe(0);
	});

	it("M8: grammar claims past the 12-claim scoring cap still get one row each, unmeasured", async () => {
		const keys = Array.from({ length: 14 }, (_, i) => `File \x60f${i}.ts\x60 was written.`);
		const shadow = fetchDouble();
		await run(fetchDouble(), shadow, keys.map((k) => `- ${k}`).join("\n"), keys[13]);
		expect(rows()).toHaveLength(14);
		expect(rows().filter((r) => r.jevSupported === true)).toHaveLength(12);
		expect(rows().find((r) => r.claim === keys[13])).toMatchObject({ jevSupported: null, disagrees: null });
		expect(shadowClaims(shadow)).toEqual(keys.slice(0, 12));
		expect(shadow.client.spend().calls).toBe(1);
	});

	it("N4: the judgment request body is unchanged by the grammar extraction", async () => {
		const message = `I ran the build and read the whole output. ${GRAMMAR}\n- Typecheck completed cleanly.\n**All 3 executed tests passed.**\n${LONG}`;
		const plain = fetchDouble();
		await run(plain, undefined, message);
		const shadowed = fetchDouble();
		const shadow = fetchDouble();
		await run(shadowed, shadow, message);
		expect(shadowed.bodies).toEqual(plain.bodies);
		expect(shadowClaims(plain)).toEqual(splitClaims(message));
		expect(shadowClaims(shadow)).toEqual([GRAMMAR, "Typecheck completed cleanly.", "All 3 executed tests passed."]);
	});
});
