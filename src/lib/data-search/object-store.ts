import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { corpusPath, evidenceHash } from "./corpus.js";
import type { EvidenceObjectStore } from "./segments.js";

/** Local implementation of immutable content-addressed object storage; no deletion API. */
export class DirectoryEvidenceStore implements EvidenceObjectStore {
    constructor(private readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
    async get(key: string): Promise<Uint8Array> { return readFileSync(corpusPath(this.root, key)); }
    async put(key: string, bytes: Uint8Array): Promise<void> {
        if (!/^[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl\.gz$/.test(key)) throw new Error("invalid content-addressed key");
        const path = join(this.root, key);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (existsSync(path)) {
            if (evidenceHash(await this.get(key)) !== evidenceHash(bytes)) throw new Error("immutable object conflict");
            return;
        }
        writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    }
}
