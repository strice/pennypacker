import {
  getLatestSnapshot,
  getAllocationsForSnapshot,
  getPerformanceForSnapshot,
} from "../db/queries";
import { heading, subheading, dim, money, percent, table, banner } from "./format";

export function showAllocation() {
  const snapshot = getLatestSnapshot();
  if (!snapshot) {
    console.log("No data yet. Run: bun run scrape");
    return;
  }

  console.log(banner());
  console.log(heading("Portfolio Allocation"));
  console.log(dim(`Snapshot: ${snapshot.scraped_at}\n`));

  const allocations = getAllocationsForSnapshot(snapshot.id);
  if (allocations.length === 0) {
    console.log("  No allocation data. Run scrape to pull allocation breakdown.");
    return;
  }

  // Allocation breakdown with visual bars
  const maxValue = Math.max(...allocations.map((a) => a.value));
  const allocRows = allocations.map((a) => {
    const barLen = Math.round((a.value / maxValue) * 25);
    const bar = "█".repeat(barLen);
    return [
      a.asset_class,
      money(a.value),
      `${a.percent_total.toFixed(1)}%`,
      a.day_change_percent != null ? percent(a.day_change_percent) : dim("—"),
      bar,
    ];
  });

  const totalValue = allocations.reduce((sum, a) => sum + a.value, 0);
  allocRows.push(["", "─────────", "", "", ""]);
  allocRows.push(["TOTAL", money(totalValue), "100%", "", ""]);

  console.log(
    table(
      ["Asset Class", "Value", "Weight", "1-Day", ""],
      allocRows,
      ["left", "right", "right", "right", "left"]
    )
  );

  // Stocks vs Bonds ratio
  const stocks = allocations
    .filter((a) => a.asset_class.toLowerCase().includes("stock"))
    .reduce((sum, a) => sum + a.percent_total, 0);
  const bonds = allocations
    .filter((a) => a.asset_class.toLowerCase().includes("bond"))
    .reduce((sum, a) => sum + a.percent_total, 0);
  const intl = allocations
    .filter((a) => a.asset_class.toLowerCase().includes("intl"))
    .reduce((sum, a) => sum + a.percent_total, 0);
  const domestic = allocations
    .filter(
      (a) =>
        a.asset_class.toLowerCase().includes("u.s.") ||
        a.asset_class.toLowerCase().includes("us ")
    )
    .reduce((sum, a) => sum + a.percent_total, 0);

  console.log("\n" + subheading("Ratios"));
  console.log(`  Stocks / Bonds:      ${stocks.toFixed(1)}% / ${bonds.toFixed(1)}%`);
  console.log(`  International / US:  ${intl.toFixed(1)}% / ${domestic.toFixed(1)}%`);

  // Performance section
  const performances = getPerformanceForSnapshot(snapshot.id);
  if (performances.length > 0) {
    console.log("\n" + heading("Account Performance (90-day)"));

    const perfRows = performances
      .filter((p) => p.balance > 0)
      .map((p) => [
        p.account_name,
        p.account_type ? p.account_type.slice(0, 30) : "",
        p.period_pct != null ? percent(p.period_pct) : dim("—"),
        p.income > 0 ? money(p.income) : dim("—"),
        money(p.balance),
      ]);

    console.log(
      table(
        ["Account", "Type", "90-Day", "Income", "Balance"],
        perfRows,
        ["left", "left", "right", "right", "right"]
      )
    );

    const totalIncome = performances.reduce((sum, p) => sum + p.income, 0);
    if (totalIncome > 0) {
      console.log(dim(`\n  Total investment income (90d): ${money(totalIncome)}`));
    }
  }
}
