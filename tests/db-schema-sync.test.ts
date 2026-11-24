import { describe, expect, test } from "bun:test";
import { isTable } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { openDatabase } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";

describe("DB schema sync", () => {
  test("every exported sqliteTable in schema.ts matches INIT_SQL PRAGMA table_info", () => {
    const dbHandle = openDatabase(":memory:");
    try {
      const exportedTables = Object.values(schema).filter((val) => isTable(val));
      expect(exportedTables.length).toBeGreaterThan(0);

      for (const table of exportedTables) {
        const cfg = getTableConfig(table);
        const pragmaRows = dbHandle.sqlite
          .query<{ name: string; notnull: number; pk: number }, []>(`PRAGMA table_info("${cfg.name}")`)
          .all();

        expect(pragmaRows.length).toBeGreaterThan(0);

        const actualCols = new Map(pragmaRows.map((r) => [r.name, r.notnull === 1 || r.pk > 0]));
        const expectedCols = new Map(cfg.columns.map((c) => [c.name, Boolean(c.notNull || c.primary)]));

        expect(Array.from(actualCols.keys()).sort()).toEqual(Array.from(expectedCols.keys()).sort());
        for (const [colName, expectedNotNull] of expectedCols) {
          expect(actualCols.get(colName)).toBe(expectedNotNull);
        }
      }
    } finally {
      dbHandle.close();
    }
  });
});
