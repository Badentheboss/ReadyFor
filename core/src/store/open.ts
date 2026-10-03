import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@neondatabase/serverless";
import type { Store } from "../types.ts";
import { createSqlStore } from "./sqlStore.ts";

async function readSchema(): Promise<string> {
  return Bun.file(new URL("../../../db/schema.sql", import.meta.url)).text();
}

/** Splits the schema into single statements for drivers that cannot run several at once. */
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function openMemoryStore(): Promise<Store> {
  const db = new PGlite();
  await db.exec(await readSchema());
  return createSqlStore(db);
}

export async function openStore(
  env: Record<string, string | undefined>,
): Promise<{ store: Store; database: "neon" | "memory" }> {
  if (env.DATABASE_URL) {
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    for (const statement of splitStatements(await readSchema())) {
      await pool.query(statement);
    }
    return { store: createSqlStore(pool), database: "neon" };
  }
  return { store: await openMemoryStore(), database: "memory" };
}
