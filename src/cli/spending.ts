import {
  getLatestSnapshot,
  getTransactionsForSnapshot,
  getSpendingByCategory,
  getMonthlySpending,
} from "../db/queries";
import { heading, subheading, dim, money, moneyExact, table, banner } from "./format";

export function showSpending(filter?: string) {
  const snapshot = getLatestSnapshot();
  if (!snapshot) {
    console.log("No data yet. Run: bun run scrape");
    return;
  }

  console.log(banner());
  console.log(heading("Spending"));
  console.log(dim(`Snapshot: ${snapshot.scraped_at}\n`));

  // Category breakdown
  const categories = getSpendingByCategory(snapshot.id);
  if (categories.length === 0) {
    console.log("  No transaction data. Run scrape to pull transactions.");
    return;
  }

  console.log(subheading("By Category"));
  const totalSpending = categories.reduce((sum, c) => sum + c.total, 0);

  const catRows = categories.map((c) => {
    const pct = ((c.total / totalSpending) * 100).toFixed(1);
    const bar = "█".repeat(Math.round((c.total / totalSpending) * 30));
    return [c.category, moneyExact(Math.abs(c.total)), `${pct}%`, `${c.count}`, bar];
  });
  catRows.push(["", "─────────", "", "", ""]);
  catRows.push(["TOTAL", moneyExact(Math.abs(totalSpending)), "100%", "", ""]);

  console.log(
    table(
      ["Category", "Amount", "%", "Txns", ""],
      catRows,
      ["left", "right", "right", "right", "left"]
    )
  );

  // Monthly totals
  const monthly = getMonthlySpending(snapshot.id);
  if (monthly.length > 0) {
    console.log("\n" + subheading("Monthly Spending"));
    const monthRows = monthly.map((m) => [m.month, moneyExact(Math.abs(m.total))]);
    console.log(table(["Month", "Spending"], monthRows, ["left", "right"]));
  }

  // Recent transactions
  const transactions = getTransactionsForSnapshot(snapshot.id);
  const filtered = filter
    ? transactions.filter(
        (t) =>
          t.category.toLowerCase().includes(filter.toLowerCase()) ||
          t.description.toLowerCase().includes(filter.toLowerCase())
      )
    : transactions.slice(0, 25);

  console.log("\n" + subheading(filter ? `Transactions matching "${filter}"` : "Recent Transactions (last 25)"));
  const txnRows = filtered.map((t) => [
    t.date,
    t.description.slice(0, 35),
    t.category,
    t.amount >= 0 ? `+${moneyExact(t.amount)}` : `-${moneyExact(Math.abs(t.amount))}`,
  ]);

  console.log(
    table(["Date", "Description", "Category", "Amount"], txnRows, [
      "left",
      "left",
      "left",
      "right",
    ])
  );

  console.log(dim(`\n${transactions.length} total transactions in snapshot`));
}
