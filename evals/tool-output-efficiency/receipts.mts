import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Receipt } from "./selection.mjs";
type Input = Omit<Receipt, "id">;
function identity(input: Input): string {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
export class ReceiptStore {
    constructor(private directory: string) { mkdirSync(directory, { recursive: true }); }
    put(input: Input): Receipt {
        const receipt = { ...input, id: identity(input) };
        try { writeFileSync(join(this.directory, receipt.id + ".json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            this.get(receipt.id);
        }
        return receipt;
    }
    get(id: string): Receipt {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid receipt ID");
        const receipt = JSON.parse(readFileSync(join(this.directory, id + ".json"), "utf8")) as Receipt;
        const { id: saved, ...input } = receipt;
        if (saved !== id || identity(input) !== id) throw new Error("Receipt content or metadata changed");
        return receipt;
    }
    expand(id: string, start = 0, end?: number): string {
        const text = this.get(id).text; end ??= text.length;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) {
            throw new Error("Invalid UTF-16 range");
        }
        if (/[\uDC00-\uDFFF]/.test(text.charAt(start)) || /[\uDC00-\uDFFF]/.test(text.charAt(end))) {
            throw new Error("Range splits a Unicode character");
        }
        return text.slice(start, end);
    }
}

