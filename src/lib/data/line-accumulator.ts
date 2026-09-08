import { LineAccumulator, type FileLine } from "../bounded-file-io.js";

export interface DataFileLine extends FileLine { invalidUtf8?: true; }

/** Validate incrementally before exposing decoded evidence. Invalid bytes stay on disk. */
export class DataLineAccumulator extends LineAccumulator {
    private decoder = new TextDecoder("utf-8", { fatal: true });
    private invalidUtf8 = false;

    override add(piece: Buffer): void {
        super.add(piece);
        if (this.invalidUtf8) return;
        try { this.decoder.decode(piece, { stream: true }); }
        catch { this.invalidUtf8 = true; }
    }

    override finish(end: number, nextOffset: number, complete: boolean): DataFileLine {
        if (!this.invalidUtf8) {
            try { this.decoder.decode(); }
            catch { this.invalidUtf8 = true; }
        }
        const line: DataFileLine = super.finish(end, nextOffset, complete);
        if (this.invalidUtf8) {
            delete line.text;
            line.invalidUtf8 = true;
            this.decoder = new TextDecoder("utf-8", { fatal: true });
            this.invalidUtf8 = false;
        }
        return line;
    }
}
