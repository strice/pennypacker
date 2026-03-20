#!/usr/bin/env bun
/**
 * Pennypacker MCP Server
 *
 * Exposes personal finance data to Claude Code / Zoey via MCP protocol.
 * Uses stdio transport for direct integration.
 *
 * Tools:
 *   pennypacker_status    - Current net worth, assets, liabilities
 *   pennypacker_accounts  - All accounts with balances
 *   pennypacker_holdings  - Investment holdings detail
 *   pennypacker_history   - Net worth over time
 *   pennypacker_query     - Raw SQL query (read-only)
 */

import { resolve } from "path";

// Load .env
const envPath = resolve(import.meta.dir, "../../.env");
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
} catch {}

import { getDb } from "../db/schema";
import {
  getLatestSnapshot,
  getAccountsForSnapshot,
  getHoldingsForSnapshot,
  getSnapshotHistory,
  getNetWorthChange,
  getTopHoldings,
  getTransactionsForSnapshot,
  getSpendingByCategory,
  getAllocationsForSnapshot,
  getPerformanceForSnapshot,
} from "../db/queries";

// Initialize database
getDb();

// MCP protocol types
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// Tool definitions
const TOOLS = [
  {
    name: "pennypacker_status",
    description: "Get current net worth summary with assets and liabilities totals. Returns the latest financial snapshot.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "pennypacker_accounts",
    description: "List all tracked accounts with current balances, categories, and recent changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Filter by category: cash, investment, property, credit_card, mortgage, loan, other",
        },
      },
    },
  },
  {
    name: "pennypacker_holdings",
    description: "Get detailed investment holdings with ticker symbols, share counts, prices, and daily changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        account: {
          type: "string",
          description: "Filter by institution name or account number",
        },
      },
    },
  },
  {
    name: "pennypacker_history",
    description: "Get net worth history over time. Shows snapshots and period-over-period changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: {
          type: "number",
          description: "Number of days of history (default: 30)",
        },
      },
    },
  },
  {
    name: "pennypacker_spending",
    description: "Get spending breakdown by category and recent transactions. Shows where money is going.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Filter transactions by category name",
        },
      },
    },
  },
  {
    name: "pennypacker_allocation",
    description: "Get true portfolio allocation by asset class (US stocks, Intl stocks, US bonds, Intl bonds, Cash, Alternatives). Unwraps target-date funds to show effective exposure.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "pennypacker_performance",
    description: "Get 90-day performance by account with returns, income, and benchmarks.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "pennypacker_query",
    description: "Run a read-only SQL query against the Pennypacker database. Tables: snapshots, accounts, holdings, transactions, allocations, performance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: {
          type: "string",
          description: "SQL SELECT query to execute",
        },
      },
      required: ["sql"],
    },
  },
];

// Tool handlers
function handleTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "pennypacker_status": {
      const snapshot = getLatestSnapshot();
      if (!snapshot) return { error: "No data. Run `pennypacker scrape` first." };

      const accounts = getAccountsForSnapshot(snapshot.id);
      const changes: Record<string, unknown> = {};
      for (const period of [7, 30, 90, 365]) {
        const result = getNetWorthChange(period);
        if (result) changes[`${period}d`] = result;
      }

      return {
        scraped_at: snapshot.scraped_at,
        net_worth: snapshot.net_worth,
        total_assets: snapshot.total_assets,
        total_liabilities: snapshot.total_liabilities,
        account_count: accounts.length,
        changes,
      };
    }

    case "pennypacker_accounts": {
      const snapshot = getLatestSnapshot();
      if (!snapshot) return { error: "No data." };

      let accounts = getAccountsForSnapshot(snapshot.id);
      const category = args.category as string | undefined;
      if (category) {
        accounts = accounts.filter(a => a.category === category);
      }

      return {
        scraped_at: snapshot.scraped_at,
        accounts: accounts.map(a => ({
          institution: a.institution,
          account_number: a.account_number,
          name: a.name,
          category: a.category,
          type: a.asset_or_liability,
          balance: a.balance,
          change: a.change_amount,
          manual: !!a.is_manual,
        })),
      };
    }

    case "pennypacker_holdings": {
      const snapshot = getLatestSnapshot();
      if (!snapshot) return { error: "No data." };

      let holdings = getHoldingsForSnapshot(snapshot.id);
      const filter = args.account as string | undefined;
      if (filter) {
        holdings = holdings.filter(h =>
          h.institution.toLowerCase().includes(filter.toLowerCase()) ||
          (h.account_number && h.account_number.includes(filter))
        );
      }

      return {
        scraped_at: snapshot.scraped_at,
        holdings: holdings.map(h => ({
          account: `${h.institution} (${h.account_number})`,
          ticker: h.ticker,
          fund_name: h.fund_name,
          shares: h.shares,
          price: h.price,
          value: h.value,
          day_change_pct: h.day_change_percent,
        })),
        total_value: holdings.reduce((sum, h) => sum + h.value, 0),
      };
    }

    case "pennypacker_history": {
      const days = (args.days as number) || 30;
      const snapshots = getSnapshotHistory(days);

      const changes: Record<string, unknown> = {};
      for (const period of [7, 30, 90, 365]) {
        const result = getNetWorthChange(period);
        if (result) changes[`${period}d`] = result;
      }

      return {
        days,
        snapshot_count: snapshots.length,
        snapshots: snapshots.map(s => ({
          date: s.scraped_at,
          net_worth: s.net_worth,
          assets: s.total_assets,
          liabilities: s.total_liabilities,
        })),
        changes,
      };
    }

    case "pennypacker_spending": {
      const snapshot = getLatestSnapshot();
      if (!snapshot) return { error: "No data." };

      const categories = getSpendingByCategory(snapshot.id);
      let transactions = getTransactionsForSnapshot(snapshot.id);
      const filter = args.category as string | undefined;
      if (filter) {
        transactions = transactions.filter(t =>
          t.category.toLowerCase().includes(filter.toLowerCase()) ||
          t.description.toLowerCase().includes(filter.toLowerCase())
        );
      }

      return {
        scraped_at: snapshot.scraped_at,
        spending_by_category: categories.map(c => ({
          category: c.category,
          total: c.total,
          transaction_count: c.count,
        })),
        total_spending: categories.reduce((sum, c) => sum + c.total, 0),
        transactions: transactions.slice(0, 50).map(t => ({
          date: t.date,
          description: t.description,
          category: t.category,
          amount: t.amount,
          account: t.account_name,
        })),
        transaction_count: transactions.length,
      };
    }

    case "pennypacker_allocation": {
      const snapshot = getLatestSnapshot();
      if (!snapshot) return { error: "No data." };

      const allocations = getAllocationsForSnapshot(snapshot.id);
      const stocks = allocations
        .filter(a => a.asset_class.toLowerCase().includes("stock"))
        .reduce((sum, a) => sum + a.percent_total, 0);
      const bonds = allocations
        .filter(a => a.asset_class.toLowerCase().includes("bond"))
        .reduce((sum, a) => sum + a.percent_total, 0);
      const intl = allocations
        .filter(a => a.asset_class.toLowerCase().includes("intl"))
        .reduce((sum, a) => sum + a.percent_total, 0);

      return {
        scraped_at: snapshot.scraped_at,
        allocations: allocations.map(a => ({
          asset_class: a.asset_class,
          value: a.value,
          percent: a.percent_total,
          day_change_pct: a.day_change_percent,
        })),
        total_invested: allocations.reduce((sum, a) => sum + a.value, 0),
        ratios: {
          stocks_pct: stocks,
          bonds_pct: bonds,
          international_pct: intl,
          domestic_pct: 100 - intl - (100 - stocks - bonds),
        },
      };
    }

    case "pennypacker_performance": {
      const snapshot = getLatestSnapshot();
      if (!snapshot) return { error: "No data." };

      const performances = getPerformanceForSnapshot(snapshot.id);
      return {
        scraped_at: snapshot.scraped_at,
        accounts: performances.map(p => ({
          account: p.account_name,
          type: p.account_type,
          period_return_pct: p.period_pct,
          prior_day_pct: p.prior_day_pct,
          income: p.income,
          balance: p.balance,
          period_days: p.period_days,
        })),
        total_income: performances.reduce((sum, p) => sum + p.income, 0),
        total_balance: performances.reduce((sum, p) => sum + p.balance, 0),
      };
    }

    case "pennypacker_query": {
      const sql = args.sql as string;
      if (!sql) return { error: "sql parameter required" };

      // Safety: only allow SELECT
      const trimmed = sql.trim().toUpperCase();
      if (!trimmed.startsWith("SELECT")) {
        return { error: "Only SELECT queries allowed" };
      }

      const db = getDb();
      try {
        const results = db.query(sql).all();
        return { rows: results, count: results.length };
      } catch (err) {
        return { error: `Query failed: ${err}` };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// --- MCP stdio transport ---

function respond(res: JsonRpcResponse) {
  const json = JSON.stringify(res);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function handleRequest(req: JsonRpcRequest) {
  switch (req.method) {
    case "initialize":
      respond({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "pennypacker",
            version: "0.1.0",
          },
        },
      });
      break;

    case "notifications/initialized":
      // No response needed for notifications
      break;

    case "tools/list":
      respond({
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: TOOLS },
      });
      break;

    case "tools/call": {
      const { name, arguments: args } = req.params as { name: string; arguments: Record<string, unknown> };
      const result = handleTool(name, args || {});
      respond({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      });
      break;
    }

    default:
      respond({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
  }
}

// Read JSON-RPC messages from stdin
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;

  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);

    try {
      const request = JSON.parse(body) as JsonRpcRequest;
      handleRequest(request);
    } catch (err) {
      console.error("Failed to parse JSON-RPC message:", err);
    }
  }
});

process.stderr.write("Pennypacker MCP server started\n");
