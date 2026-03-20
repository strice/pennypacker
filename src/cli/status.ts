import {
  getLatestSnapshot,
  getAccountsForSnapshot,
  getSnapshotHistory,
} from "../db/queries";
import { money, heading, subheading, dim, table, sparkline, banner } from "./format";

export function showStatus() {
  const snapshot = getLatestSnapshot();
  if (!snapshot) {
    console.log("\nNo data yet. Run `pennypacker scrape` first.\n");
    return;
  }

  console.log(banner());

  const accounts = getAccountsForSnapshot(snapshot.id);
  const assets = accounts.filter(a => a.asset_or_liability === "asset");
  const liabilities = accounts.filter(a => a.asset_or_liability === "liability");

  // Net worth sparkline from history
  const history = getSnapshotHistory(90);
  const spark = history.length > 1
    ? `  ${sparkline(history.map(h => h.net_worth))}`
    : "";

  console.log(heading("NET WORTH"));
  console.log(`  ${money(snapshot.net_worth)}${spark}`);
  console.log(dim(`  as of ${new Date(snapshot.scraped_at + "Z").toLocaleString()}`));

  // Assets
  console.log(heading("ASSETS") + `  ${money(snapshot.total_assets)}`);

  const assetsByCategory = groupBy(assets, "category");
  for (const [category, accts] of Object.entries(assetsByCategory)) {
    console.log(`\n  ${subheading(categoryLabel(category))}`);
    for (const a of accts) {
      const label = `${a.institution}${a.account_number ? ` (${a.account_number})` : ""}`;
      const change = a.change_amount !== null
        ? `  ${money(a.change_amount, true)}`
        : a.is_manual ? dim("  manual") : "";
      console.log(`    ${label.padEnd(35)} ${money(a.balance).padStart(12)}${change}`);
    }
  }

  // Liabilities
  if (liabilities.length > 0) {
    console.log(heading("LIABILITIES") + `  ${money(snapshot.total_liabilities)}`);

    const liabByCategory = groupBy(liabilities, "category");
    for (const [category, accts] of Object.entries(liabByCategory)) {
      console.log(`\n  ${subheading(categoryLabel(category))}`);
      for (const a of accts) {
        const label = `${a.institution}${a.account_number ? ` (${a.account_number})` : ""}`;
        const change = a.change_amount !== null
          ? `  ${money(a.change_amount, true)}`
          : "";
        console.log(`    ${label.padEnd(35)} ${money(a.balance).padStart(12)}${change}`);
      }
    }
  }

  console.log("");
}

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    cash: "Cash",
    investment: "Investments",
    property: "Property",
    vehicle: "Vehicle",
    credit_card: "Credit Cards",
    mortgage: "Mortgage",
    loan: "Loans",
    other: "Other",
  };
  return labels[category] || category;
}

function groupBy<T>(items: T[], key: keyof T): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = String(item[key]);
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  }
  return groups;
}
