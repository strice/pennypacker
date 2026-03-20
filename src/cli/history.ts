import {
  getSnapshotHistory,
  getAllSnapshots,
  getNetWorthChange,
} from "../db/queries";
import { money, heading, dim, sparkline } from "./format";

export function showHistory(days: number = 30) {
  const snapshots = getSnapshotHistory(days);

  if (snapshots.length === 0) {
    console.log("\nNo history data. Run `pennypacker scrape` a few times first.\n");
    return;
  }

  console.log(heading(`NET WORTH HISTORY (${days} days)`));

  // Sparkline
  if (snapshots.length > 1) {
    console.log(`\n  ${sparkline(snapshots.map(s => s.net_worth))}\n`);
  }

  // Summary
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const change = last.net_worth - first.net_worth;
  const changePct = ((change / first.net_worth) * 100).toFixed(2);

  console.log(`  Start:  ${money(first.net_worth)}  ${dim(new Date(first.scraped_at + "Z").toLocaleDateString())}`);
  console.log(`  Now:    ${money(last.net_worth)}  ${dim(new Date(last.scraped_at + "Z").toLocaleDateString())}`);
  console.log(`  Change: ${money(change, true)}  (${change >= 0 ? "+" : ""}${changePct}%)`);
  console.log(`  Snapshots: ${snapshots.length}`);

  // Table of snapshots
  if (snapshots.length <= 60) {
    console.log(dim(`\n  ${"Date".padEnd(22)} ${"Net Worth".padStart(12)} ${"Assets".padStart(12)} ${"Liabilities".padStart(12)}`));
    console.log(dim("  " + "─".repeat(60)));

    for (const s of snapshots) {
      const date = new Date(s.scraped_at + "Z").toLocaleString();
      console.log(`  ${date.padEnd(22)} ${money(s.net_worth).padStart(12)} ${money(s.total_assets).padStart(12)} ${money(s.total_liabilities).padStart(12)}`);
    }
  }

  // Period changes
  console.log(heading("CHANGES"));
  for (const period of [7, 30, 90, 365]) {
    const result = getNetWorthChange(period);
    if (result) {
      const pct = ((result.change / result.previous) * 100).toFixed(2);
      console.log(`  ${String(period).padStart(3)}d:  ${money(result.change, true)}  (${result.change >= 0 ? "+" : ""}${pct}%)`);
    }
  }

  console.log("");
}
