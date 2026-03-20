import {
  getLatestSnapshot,
  getAccountsForSnapshot,
} from "../db/queries";
import { money, heading, dim, table } from "./format";

export function showAccounts() {
  const snapshot = getLatestSnapshot();
  if (!snapshot) {
    console.log("\nNo data yet. Run `pennypacker scrape` first.\n");
    return;
  }

  const accounts = getAccountsForSnapshot(snapshot.id);

  console.log(heading("ALL ACCOUNTS"));
  console.log(dim(`  as of ${new Date(snapshot.scraped_at + "Z").toLocaleString()}\n`));

  const rows = accounts.map(a => [
    a.asset_or_liability === "asset" ? "+" : "-",
    a.institution,
    a.account_number || "—",
    a.category,
    a.asset_or_liability === "liability" ? `-${money(a.balance)}` : money(a.balance),
    a.change_amount !== null ? money(a.change_amount, true) : (a.is_manual ? dim("manual") : "—"),
  ]);

  console.log(table(
    ["", "Institution", "Acct#", "Category", "Balance", "Change"],
    rows,
    ["left", "left", "left", "left", "right", "right"]
  ));

  console.log(`\n  ${dim("Total accounts:")} ${accounts.length}`);
  console.log("");
}
