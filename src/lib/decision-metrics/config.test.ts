import { expect, it } from "vitest";
import { parseConfig, parseBand } from "./config.js";
it("defaults to local inference and validates disclosure and budgets", () => {
    expect(parseConfig({ version: 1 })).toMatchObject({
        enabled: false,
        allowRemote: false,
        model: "clef-flash:9b",
        embeddingModel: "embeddinggemma-2:740m-bf16",
        hook: { enabled: false },
    });
    expect(() => parseConfig({ version: 1, url: "https://example.com/v1" })).toThrow(/remote/);
    expect(() =>
        parseConfig({ version: 1, allowRemote: true, url: "http://example.com/v1" }),
    ).toThrow(/HTTPS/);
    expect(() => parseConfig({ version: 1, url: "http://user:secret@localhost/v1" })).toThrow();
    expect(() => parseConfig({ version: 1, maxRecords: -1 })).toThrow();
    expect(() => parseConfig({ version: 1, unexpected: true })).toThrow();
    expect(() => parseBand("0.8:0.2")).toThrow();
});
