import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { Database as SQLite, type SQLQueryBindings } from "bun:sqlite";

/** Only the D1 prepare/batch surface used by Drizzle; never a production binding. */
// oxlint-disable anti-slop/no-runtime-typeof -- This adapter validates the D1 SQL binding representation at its input boundary.
export function sqliteTestClient(sqlite: SQLite): D1Database {
  class Statement implements D1PreparedStatement {
    constructor(
      readonly sql: string,
      readonly params: SQLQueryBindings[] = [],
    ) {}

    bind(...values: unknown[]): Statement {
      return new Statement(
        this.sql,
        values.map((value) => {
          if (
            value === null ||
            typeof value === "string" ||
            typeof value === "number" ||
            value instanceof Uint8Array
          )
            return value;

          if (value instanceof ArrayBuffer) return new Uint8Array(value);
          throw new Error("Unsupported D1 binding value");
        }),
      );
    }

    execute<T>(): D1Result<T> {
      const results = sqlite.query<T, SQLQueryBindings[]>(this.sql).all(...this.params);

      const changes = sqlite
        .query<{ changes: number; rowid: number }, []>(
          "select changes() as changes, last_insert_rowid() as rowid",
        )
        .get();

      return {
        success: true,
        results,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: results.length,
          rows_written: changes?.changes ?? 0,
          last_row_id: changes?.rowid ?? 0,
          changed_db: (changes?.changes ?? 0) > 0,
          changes: changes?.changes ?? 0,
        },
      };
    }

    async all<T>(): Promise<D1Result<T>> {
      return this.execute<T>();
    }
    async run<T>(): Promise<D1Result<T>> {
      return this.execute<T>();
    }
    async first<T>(column?: string): Promise<T | null> {
      const row = this.execute<Record<string, T>>().results[0];

      // SAFETY: D1's generic row type is chosen by the caller, as with the real binding.
      return ((column === undefined ? row : row?.[column]) as T) ?? null;
    }

    raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
    raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    async raw<T = unknown[]>(options?: {
      columnNames?: boolean;
    }): Promise<T[] | [string[], ...T[]]> {
      const statement = sqlite.query(this.sql);
      // SAFETY: SQLite values are rows of scalar columns, matching D1.raw's caller-selected generic.
      const values = statement.values(...this.params) as T[];

      return options?.columnNames ? [statement.columnNames, ...values] : values;
    }
  }

  const client: D1Database = {
    prepare: (sql) => new Statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) =>
      sqlite.transaction(() =>
        statements.map((statement) => {
          if (!(statement instanceof Statement))
            throw new Error("Statement belongs to a different test database");

          return statement.execute<T>();
        }),
      )(),
    exec: async (sql) => {
      sqlite.exec(sql);

      return { count: 1, duration: 0 };
    },
    withSession: () => ({ prepare: client.prepare, batch: client.batch, getBookmark: () => null }),
    dump: async () => {
      throw new Error("D1 dump is unsupported");
    },
  };

  return client;
}
