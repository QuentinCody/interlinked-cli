import type { DataIndexDatabase } from "./index-schema.js";

type Statement = ReturnType<DataIndexDatabase["prepare"]>;
const CACHE = new WeakMap<DataIndexDatabase, Map<string, Statement>>();

/** Prepare each projection statement once per connection, outside the row hot path. */
export function dataStatement(db: DataIndexDatabase, sql: string): Statement {
    let statements = CACHE.get(db);
    if (!statements) { statements = new Map(); CACHE.set(db, statements); }
    let statement = statements.get(sql);
    if (!statement) { statement = db.prepare(sql); statements.set(sql, statement); }
    return statement;
}
