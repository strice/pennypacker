#!/usr/bin/env bun
/**
 * H.E. Pennypacker — A Wealthy American Industrialist
 *
 * Personal finance tracker that scrapes Empower/Personal Capital
 * and stores historical snapshots in SQLite.
 *
 * Usage:
 *   pennypacker scrape              Scrape Empower dashboard
 *   pennypacker status              Show current net worth & accounts
 *   pennypacker holdings [filter]   Show investment holdings
 *   pennypacker history [days]      Show net worth history
 *   pennypacker accounts            List all accounts
 *   pennypacker help                Show this message
 */

import { resolve } from "path";

// Load .env from project root
const envPath = resolve(import.meta.dir, "../.env");
try {
  const envFile = Bun.file(envPath);
  if (await envFile.exists()) {
    const text = await envFile.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  }
} catch {
  // No .env, that's fine
}

// Initialize database
import { getDb } from "./db/schema";
getDb();

const command = process.argv[2] || "status";
const args = process.argv.slice(3);

switch (command) {
  case "scrape": {
    const { scrapeEmpower } = await import("./scraper/empower");
    await scrapeEmpower();
    break;
  }

  case "status": {
    const { showStatus } = await import("./cli/status");
    showStatus();
    break;
  }

  case "holdings": {
    const { showHoldings } = await import("./cli/holdings");
    showHoldings(args[0]);
    break;
  }

  case "history": {
    const { showHistory } = await import("./cli/history");
    showHistory(parseInt(args[0]) || 30);
    break;
  }

  case "accounts": {
    const { showAccounts } = await import("./cli/accounts");
    showAccounts();
    break;
  }

  case "spending":
  case "txn":
  case "transactions": {
    const { showSpending } = await import("./cli/spending");
    showSpending(args[0]);
    break;
  }

  case "allocation":
  case "alloc": {
    const { showAllocation } = await import("./cli/allocation");
    showAllocation();
    break;
  }

  case "help":
  case "--help":
  case "-h": {
    console.log(`
H.E. Pennypacker — A Wealthy American Industrialist
Personal finance tracker powered by Empower scraping + SQLite

Commands:
  scrape              Scrape Empower dashboard (opens browser first time)
  status              Current net worth, account balances, sparkline
  holdings [filter]   Investment holdings detail (filter by institution/acct#)
  history [days]      Net worth history with changes (default: 30 days)
  accounts            Full account list
  spending [filter]   Spending by category + recent transactions
  allocation          Portfolio allocation breakdown + performance

First run:
  1. cp .env.example .env
  2. bun install
  3. bun run scrape    (browser opens, log in manually, cookies saved)
  4. bun run status    (see your data)

Subsequent runs:
  bun run scrape      (uses saved cookies, headless if HEADLESS=true)
`);
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.log('Run "pennypacker help" for usage.');
    process.exit(1);
}
