import { join } from "node:path";
import { openNodeSqlite } from "../../harness/mutation/mutation-journal-driver.js";
import { dataIndexPath } from "../data/index-schema.js";
import { dataRow, dataString } from "../data/index-source.js";
import { evidenceHash, readCorpus } from "./corpus.js";
import { compactIndexReceipt } from "./sqlite.js";

export interface FtsAnswer { ids: string[]; total: number; complete: boolean; semantics: string; }
/** Token/phrase grammar is measured separately from portable substring queries. */
export function searchEvidenceFts(root: string, engine: "legacy" | "compact", expression: string): FtsAnswer {
    if (!expression || expression.length > 8192) throw new Error("invalid FTS query bounds");
    const legacy = engine === "legacy";
    const db = openNodeSqlite(legacy ? dataIndexPath(root) : join(root, "index.sqlite"));
    try {
        db.exec("PRAGMA query_only=ON");
        const corpus = legacy ? readCorpus(root) : null;
        const sql = legacy ? "SELECT r.source,r.raw_hash FROM data_records r JOIN data_text f ON r.id=f.record_id WHERE data_text MATCH ?"
            : "SELECT r.id FROM records r JOIN fts f ON r.rid=f.rowid WHERE fts MATCH ?";
        const rows = db.prepare(sql).all(expression).map((value) => {
            const row = dataRow(value);
            return corpus ? evidenceHash(`${corpus.tenant}\0${corpus.project}\0${dataString(row, "source")}\0${dataString(row, "raw_hash")}`) : dataString(row, "id");
        });
        const complete = legacy ? dataRow(db.prepare("SELECT count(*) n FROM data_sources WHERE status!='complete' OR malformed>0 OR oversized>0").get()).n === 0 : compactIndexReceipt(root).coverage.complete;
        return { ids: [...new Set(rows)].sort(), total: new Set(rows).size, complete, semantics: "FTS5 unicode61 tokens/phrases; no substring equivalence or relevance-ranking claim" };
    } finally { db.close(); }
}
