import { describe, expect, it, vi } from "vitest";
import { measureFile } from "./measure.js";
import { requestWholeFileReport, type ClaimFetchLike, type FetchLike, type FetchResponseLike } from "./measure-request.js";

const response = (status: number, body: unknown): FetchResponseLike => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
});
function requestOptions() {
    let now = 0;
    return {
        file: "src/a.ts", content: "export const a = 1;", overlays: [], endpoints: ["http://runner/"],
        jobId: "job/retained", requestTimeoutMs: 1000, deadlineMs: 60_000,
        now: () => now, sleep: async (ms: number) => { now += ms; },
    };
}
const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

describe("retained mutation results", () => {
    it.each([
        new Error("transport", { cause: { name: "HeadersTimeoutError" } }),
        { name: "BodyTimeoutError" },
        new Error("transport", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }),
        { code: "UND_ERR_BODY_TIMEOUT" },
    ])("recognizes transport timeout variants before attempting another execution (%j)", async (error) => {
        const body = { retained: true };
        const post = vi.fn<FetchLike>().mockRejectedValue(error);
        const claim = vi.fn<ClaimFetchLike>().mockResolvedValue(response(200, body));
        expect(await requestWholeFileReport({ ...requestOptions(), fetchImpl: post, claimFetch: claim }))
            .toEqual({ ok: true, body, attempts: 1, resumed: true });
        expect(post).toHaveBeenCalledTimes(1);
        expect(claim.mock.calls[0]?.[0]).toBe("http://runner/job/job%2Fretained");
    });

    it("returns a definitive retained-job error without starting a replacement run", async () => {
        const post = vi.fn<FetchLike>().mockRejectedValue(timeout());
        const claim = vi.fn<ClaimFetchLike>().mockResolvedValue({
            ...response(500, {}), text: async () => "retained worker crashed",
        });
        const result = await requestWholeFileReport({ ...requestOptions(), fetchImpl: post, claimFetch: claim });
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("retained worker crashed") });
        expect(post).toHaveBeenCalledTimes(1);
        expect(claim).toHaveBeenCalledTimes(1);
    });

    it.each(["connection", "malformed JSON"])("retries an unavailable claim (%s) without repeating its POST", async (failure) => {
        const body = { retained: true };
        const post = vi.fn<FetchLike>().mockRejectedValue(timeout());
        const claim = vi.fn<ClaimFetchLike>()
            .mockImplementationOnce(async () => {
                if (failure === "connection") throw new Error("ECONNRESET");
                return { ...response(200, null), json: async () => { throw new SyntaxError("invalid JSON"); } };
            })
            .mockResolvedValue(response(200, body));
        expect(await requestWholeFileReport({ ...requestOptions(), fetchImpl: post, claimFetch: claim }))
            .toEqual({ ok: true, body, attempts: 1, resumed: true });
        expect(post).toHaveBeenCalledTimes(1);
        expect(claim).toHaveBeenCalledTimes(2);
    });

    it("does not count repeated timeout observations as additional accepted jobs", async () => {
        const post = vi.fn<FetchLike>().mockRejectedValue(timeout());
        const claim = vi.fn<ClaimFetchLike>()
            .mockResolvedValueOnce(response(404, {})).mockResolvedValue(response(200, { retained: true }));
        expect(await requestWholeFileReport({ ...requestOptions(), fetchImpl: post, claimFetch: claim }))
            .toEqual({ ok: true, body: { retained: true }, attempts: 1, resumed: true });
        expect(post).toHaveBeenCalledTimes(2);
    });

    it("terminates cyclic error causes as unreachable instead of hanging or claiming a job", async () => {
        const error: { cause?: unknown } = {};
        error.cause = error;
        const post = vi.fn<FetchLike>().mockRejectedValue(error);
        const claim = vi.fn<ClaimFetchLike>();
        expect(await requestWholeFileReport({ ...requestOptions(), fetchImpl: post, claimFetch: claim }))
            .toMatchObject({ ok: false, busy: true, reason: expect.stringContaining("runner_unreachable") });
        expect(post).toHaveBeenCalledTimes(3);
        expect(claim).not.toHaveBeenCalled();
    });

    it("preserves claim provenance when a retained result is not measurable", async () => {
        const post = vi.fn<FetchLike>().mockRejectedValue(timeout());
        const claim = vi.fn<ClaimFetchLike>().mockResolvedValue(response(200, { not_measurable: { reason: "no_tests" } }));
        const outcome = await measureFile({ ...requestOptions(), fetchImpl: post, claimFetch: claim });
        expect(outcome).toMatchObject({ status: "not_measurable", reason: "no_tests", request: { attempts: 1, resumed: true } });
        expect(post).toHaveBeenCalledTimes(1);
    });
});
