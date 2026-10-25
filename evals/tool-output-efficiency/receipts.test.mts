import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiptStore } from "./receipts.mjs";
test("receipts keep exact Unicode, scope, versions, and reject invalid addresses", () => {
    const dir = mkdtempSync(join(tmpdir(), "output-receipts-"));
    try {
        const store = new ReceiptStore(dir);
        const input = { text: "a\r\n😀α\n", source: "a.ts", version: "v1", callId: "c1" };
        const first = store.put(input); const second = store.put({ ...input, version: "v2" });
        assert.notEqual(first.id, second.id);
        assert.equal(store.get(first.id).text, input.text);
        assert.equal(store.expand(first.id, 3, 5), "😀");
        assert.throws(()=>store.expand(first.id,4,5));
        assert.throws(() => store.get("../private"));
        assert.throws(() => store.expand(first.id, -1, 99));
        writeFileSync(join(dir,first.id+".json"),JSON.stringify({...first,text:"changed"}));
        assert.throws(()=>store.get(first.id),/changed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

