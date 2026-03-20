import { Database } from "bun:sqlite";
import { resolve } from "path";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_DB_PATH = resolve(PROJECT_ROOT, process.env.DB_PATH || "data/pennypacker.db");

let _db: Database | null = null;

export function getDb(dbPath?: string): Database {
  if (_db) return _db;

  const path = dbPath || DEFAULT_DB_PATH;
  _db = new Database(path, { create: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
      net_worth REAL NOT NULL,
      total_assets REAL NOT NULL,
      total_liabilities REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
      name TEXT NOT NULL,
      institution TEXT NOT NULL,
      account_number TEXT,
      category TEXT NOT NULL,
      asset_or_liability TEXT NOT NULL,
      balance REAL NOT NULL,
      change_amount REAL,
      change_label TEXT,
      is_manual INTEGER NOT NULL DEFAULT 0,
      UNIQUE(snapshot_id, institution, account_number)
    );

    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      ticker TEXT,
      fund_name TEXT NOT NULL,
      shares REAL NOT NULL,
      price REAL NOT NULL,
      value REAL NOT NULL,
      day_change_amount REAL,
      day_change_percent REAL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(scraped_at);
    CREATE INDEX IF NOT EXISTS idx_accounts_snapshot ON accounts(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_holdings_snapshot ON holdings(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_holdings_ticker ON holdings(ticker);
  `);
}
