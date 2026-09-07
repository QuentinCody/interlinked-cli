import type { EvidenceObjectStore } from "./segments.js";
import { evidenceHash } from "./corpus.js";

export interface EvidenceR2Bucket {
    get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
    put(key: string, value: Uint8Array | string, options?: { onlyIf: { etagDoesNotMatch: string } }): Promise<unknown>;
}
/** Structural binding also accepts a real R2Bucket in Workers without a Node SDK. */
export class R2EvidenceStore implements EvidenceObjectStore {
    constructor(private readonly bucket: EvidenceR2Bucket) {}
    async get(key: string): Promise<Uint8Array> {
        const object = await this.bucket.get(key);
        if (!object) throw new Error("evidence object unavailable");
        return new Uint8Array(await object.arrayBuffer());
    }
    async put(key: string, bytes: Uint8Array): Promise<void> {
        await this.bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
        if (evidenceHash(await this.get(key)) !== evidenceHash(bytes)) throw new Error("immutable R2 object conflict or failed persistence");
    }
}
