// Vitest-only shim: maps the `bun:sqlite` module surface used by this repo
// onto `node:sqlite` (DatabaseSync), so storage-dependent tests load and run
// under Node. Wired via `resolve.alias` in vitest.config.ts — production code
// still uses the real bun:sqlite when running under Bun.
//
// Only the surface consumed by src/storage/db.ts is implemented:
//   new Database(filename, { create, strict })
//   .exec(sql) / .run(sql, binding?) / .query(sql).get/all(binding?)
//   .transaction(fn) / .close()
//
// Binding semantics mirror bun's: a single scalar binds one positional
// parameter, an array binds positionally, a plain object binds named
// parameters (node:sqlite accepts bare names — equivalent to bun's
// `strict: true`).

import { DatabaseSync } from "node:sqlite";

type Binding = unknown;

function bindArgs(binding: Binding): unknown[] {
  if (binding === undefined) return [];
  if (Array.isArray(binding)) return binding;
  return [binding];
}

export interface SQLiteQuery {
  get(binding?: Binding): unknown;
  all(binding?: Binding): unknown[];
}

export class Database {
  private readonly db: DatabaseSync;

  constructor(filename = ":memory:", _options?: { create?: boolean; strict?: boolean; readonly?: boolean }) {
    this.db = new DatabaseSync(filename, _options?.readonly ? { readOnly: true } : {});
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, binding?: Binding): unknown {
    return this.db.prepare(sql).run(...(bindArgs(binding) as never[]));
  }

  query(sql: string): SQLiteQuery {
    const stmt = this.db.prepare(sql);
    return {
      get: (binding?: Binding) => stmt.get(...(bindArgs(binding) as never[])),
      all: (binding?: Binding) => stmt.all(...(bindArgs(binding) as never[])),
    };
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.exec("BEGIN");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Rollback failure is secondary — surface the original error.
        }
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}
