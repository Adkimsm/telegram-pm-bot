// Minimal D1Database implementation over node:sqlite, matching the subset of
// the API the project uses: prepare/bind/first/all/run/batch and meta.changes.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params); }

  #prep() { return this.db.prepare(this.sql); }

  async first(col) {
    const row = this.#prep().get(...this.params);
    if (row === undefined) return null;
    return col ? row[col] : { ...row };
  }
  async all() {
    const rows = this.#prep().all(...this.params).map(r => ({ ...r }));
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
  }
  async run() {
    const info = this.#prep().run(...this.params);
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
    };
  }
}

export class D1 {
  constructor(schemaPath) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(schemaPath, "utf8"));
  }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    const out = [];
    for (const s of stmts) {
      // A read returns rows; a write returns changes. Dispatch on the verb so
      // batch() behaves like D1 for both.
      out.push(/^\s*(select|with)/i.test(s.sql) ? await s.all() : await s.run());
    }
    return out;
  }
  raw(sql, ...p) { return this.db.prepare(sql).all(...p); }
  exec(sql) { this.db.exec(sql); }
}
