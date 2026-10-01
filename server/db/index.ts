import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";

/**
 * Opens `$DATA_DIR/lrbuddy.db` and applies migrations at import. Reads the env
 * directly rather than through config.ts so tests and the seed can point it at
 * a temp directory without supplying the auth secrets.
 */
export const dataDir = process.env.DATA_DIR && process.env.DATA_DIR.trim() !== "" ? process.env.DATA_DIR : "./data";
mkdirSync(dataDir, { recursive: true });

export const dbPath = join(dataDir, "lrbuddy.db");
export const sqlite = new Database(dbPath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec("PRAGMA busy_timeout = 5000;");
sqlite.exec("PRAGMA synchronous = NORMAL;");

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;

migrate(db, { migrationsFolder: new URL("./migrations", import.meta.url).pathname });

export { schema };
