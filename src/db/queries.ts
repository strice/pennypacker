import { getDb } from "./schema";

export interface Snapshot {
  id: number;
  scraped_at: string;
  net_worth: number;
  total_assets: number;
  total_liabilities: number;
}

export interface Account {
  id: number;
  snapshot_id: number;
  name: string;
  institution: string;
  account_number: string | null;
  category: string;
  asset_or_liability: string;
  balance: number;
  change_amount: number | null;
  change_label: string | null;
  is_manual: number;
}

export interface Holding {
  id: number;
  snapshot_id: number;
  account_id: number;
  ticker: string | null;
  fund_name: string;
  shares: number;
  price: number;
  value: number;
  day_change_amount: number | null;
  day_change_percent: number | null;
}

// --- Snapshot operations ---

export function insertSnapshot(netWorth: number, totalAssets: number, totalLiabilities: number): number {
  const db = getDb();
  const result = db.run(
    "INSERT INTO snapshots (net_worth, total_assets, total_liabilities) VALUES (?, ?, ?)",
    [netWorth, totalAssets, totalLiabilities]
  );
  return Number(result.lastInsertRowid);
}

export function getLatestSnapshot(): Snapshot | null {
  const db = getDb();
  return db.query<Snapshot, []>(
    "SELECT * FROM snapshots ORDER BY scraped_at DESC LIMIT 1"
  ).get() ?? null;
}

export function getSnapshotHistory(days: number = 30): Snapshot[] {
  const db = getDb();
  return db.query<Snapshot, [number]>(
    `SELECT * FROM snapshots
     WHERE scraped_at >= datetime('now', '-' || ? || ' days')
     ORDER BY scraped_at ASC`
  ).all(days);
}

export function getAllSnapshots(): Snapshot[] {
  const db = getDb();
  return db.query<Snapshot, []>(
    "SELECT * FROM snapshots ORDER BY scraped_at ASC"
  ).all();
}

// --- Account operations ---

export function insertAccount(
  snapshotId: number,
  account: Omit<Account, "id" | "snapshot_id">
): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO accounts (snapshot_id, name, institution, account_number, category, asset_or_liability, balance, change_amount, change_label, is_manual)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshotId,
      account.name,
      account.institution,
      account.account_number,
      account.category,
      account.asset_or_liability,
      account.balance,
      account.change_amount,
      account.change_label,
      account.is_manual,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function getAccountsForSnapshot(snapshotId: number): Account[] {
  const db = getDb();
  return db.query<Account, [number]>(
    "SELECT * FROM accounts WHERE snapshot_id = ? ORDER BY asset_or_liability, category, balance DESC"
  ).all(snapshotId);
}

export function getAccountHistory(institution: string, accountNumber: string, days: number = 90): Array<{ scraped_at: string; balance: number }> {
  const db = getDb();
  return db.query<{ scraped_at: string; balance: number }, [string, string, number]>(
    `SELECT s.scraped_at, a.balance
     FROM accounts a
     JOIN snapshots s ON s.id = a.snapshot_id
     WHERE a.institution = ? AND a.account_number = ?
       AND s.scraped_at >= datetime('now', '-' || ? || ' days')
     ORDER BY s.scraped_at ASC`
  ).all(institution, accountNumber, days);
}

// --- Holding operations ---

export function insertHolding(
  snapshotId: number,
  accountId: number,
  holding: Omit<Holding, "id" | "snapshot_id" | "account_id">
): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO holdings (snapshot_id, account_id, ticker, fund_name, shares, price, value, day_change_amount, day_change_percent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshotId,
      accountId,
      holding.ticker,
      holding.fund_name,
      holding.shares,
      holding.price,
      holding.value,
      holding.day_change_amount,
      holding.day_change_percent,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function getHoldingsForSnapshot(snapshotId: number): Array<Holding & { institution: string; account_number: string }> {
  const db = getDb();
  return db.query<Holding & { institution: string; account_number: string }, [number]>(
    `SELECT h.*, a.institution, a.account_number
     FROM holdings h
     JOIN accounts a ON a.id = h.account_id
     WHERE h.snapshot_id = ?
     ORDER BY h.value DESC`
  ).all(snapshotId);
}

export function getHoldingHistory(ticker: string, days: number = 90): Array<{ scraped_at: string; shares: number; price: number; value: number }> {
  const db = getDb();
  return db.query<{ scraped_at: string; shares: number; price: number; value: number }, [string, number]>(
    `SELECT s.scraped_at, h.shares, h.price, h.value
     FROM holdings h
     JOIN snapshots s ON s.id = h.snapshot_id
     WHERE h.ticker = ?
       AND s.scraped_at >= datetime('now', '-' || ? || ' days')
     ORDER BY s.scraped_at ASC`
  ).all(ticker, days);
}

// --- Aggregate queries ---

export function getNetWorthChange(days: number): { current: number; previous: number; change: number } | null {
  const db = getDb();
  const current = getLatestSnapshot();
  if (!current) return null;

  const previous = db.query<Snapshot, [number]>(
    `SELECT * FROM snapshots
     WHERE scraped_at <= datetime('now', '-' || ? || ' days')
     ORDER BY scraped_at DESC LIMIT 1`
  ).get(days);

  if (!previous) return null;

  return {
    current: current.net_worth,
    previous: previous.net_worth,
    change: current.net_worth - previous.net_worth,
  };
}

export function getTopHoldings(limit: number = 10): Array<{ ticker: string; fund_name: string; value: number; day_change_percent: number }> {
  const db = getDb();
  const latest = getLatestSnapshot();
  if (!latest) return [];

  return db.query<{ ticker: string; fund_name: string; value: number; day_change_percent: number }, [number, number]>(
    `SELECT ticker, fund_name, value, day_change_percent
     FROM holdings
     WHERE snapshot_id = ? AND ticker IS NOT NULL
     ORDER BY value DESC
     LIMIT ?`
  ).all(latest.id, limit);
}

// --- Transaction operations ---

export interface Transaction {
  id: number;
  snapshot_id: number;
  account_name: string;
  date: string;
  description: string;
  category: string;
  amount: number;
  tags: string | null;
}

export function insertTransaction(
  snapshotId: number,
  txn: Omit<Transaction, "id" | "snapshot_id">
): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO transactions (snapshot_id, account_name, date, description, category, amount, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [snapshotId, txn.account_name, txn.date, txn.description, txn.category, txn.amount, txn.tags]
  );
  return Number(result.lastInsertRowid);
}

export function getTransactionsForSnapshot(snapshotId: number): Transaction[] {
  const db = getDb();
  return db.query<Transaction, [number]>(
    "SELECT * FROM transactions WHERE snapshot_id = ? ORDER BY date DESC"
  ).all(snapshotId);
}

export function getSpendingByCategory(snapshotId: number): Array<{ category: string; total: number; count: number }> {
  const db = getDb();
  return db.query<{ category: string; total: number; count: number }, [number]>(
    `SELECT category, SUM(amount) as total, COUNT(*) as count
     FROM transactions
     WHERE snapshot_id = ? AND amount < 0
     GROUP BY category
     ORDER BY total ASC`
  ).all(snapshotId);
}

export function getMonthlySpending(snapshotId: number): Array<{ month: string; total: number }> {
  const db = getDb();
  // Dates are stored as M/D/YYYY — extract month by splitting
  return db.query<{ month: string; total: number }, [number]>(
    `SELECT
       substr(date, -4) || '-' || printf('%02d', CAST(substr(date, 1, instr(date, '/') - 1) AS INTEGER)) as month,
       SUM(amount) as total
     FROM transactions
     WHERE snapshot_id = ? AND amount < 0
     GROUP BY month
     ORDER BY month DESC`
  ).all(snapshotId);
}

// --- Allocation operations ---

export interface Allocation {
  id: number;
  snapshot_id: number;
  asset_class: string;
  value: number;
  percent_total: number;
  day_change_percent: number | null;
}

export function insertAllocation(
  snapshotId: number,
  alloc: Omit<Allocation, "id" | "snapshot_id">
): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO allocations (snapshot_id, asset_class, value, percent_total, day_change_percent)
     VALUES (?, ?, ?, ?, ?)`,
    [snapshotId, alloc.asset_class, alloc.value, alloc.percent_total, alloc.day_change_percent]
  );
  return Number(result.lastInsertRowid);
}

export function getAllocationsForSnapshot(snapshotId: number): Allocation[] {
  const db = getDb();
  return db.query<Allocation, [number]>(
    "SELECT * FROM allocations WHERE snapshot_id = ? ORDER BY value DESC"
  ).all(snapshotId);
}

// --- Performance operations ---

export interface Performance {
  id: number;
  snapshot_id: number;
  account_name: string;
  account_type: string | null;
  cash_flow: number;
  income: number;
  expense: number;
  prior_day_pct: number | null;
  period_pct: number | null;
  balance: number;
  period_days: number;
}

export function insertPerformance(
  snapshotId: number,
  perf: Omit<Performance, "id" | "snapshot_id">
): number {
  const db = getDb();
  const result = db.run(
    `INSERT INTO performance (snapshot_id, account_name, account_type, cash_flow, income, expense, prior_day_pct, period_pct, balance, period_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [snapshotId, perf.account_name, perf.account_type, perf.cash_flow, perf.income, perf.expense, perf.prior_day_pct, perf.period_pct, perf.balance, perf.period_days]
  );
  return Number(result.lastInsertRowid);
}

export function getPerformanceForSnapshot(snapshotId: number): Performance[] {
  const db = getDb();
  return db.query<Performance, [number]>(
    "SELECT * FROM performance WHERE snapshot_id = ? ORDER BY balance DESC"
  ).all(snapshotId);
}
