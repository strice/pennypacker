import {
  getLatestSnapshot,
  getHoldingsForSnapshot,
  getTopHoldings,
} from "../db/queries";
import { money, moneyExact, percent, heading, dim, table } from "./format";

export function showHoldings(accountFilter?: string) {
  const snapshot = getLatestSnapshot();
  if (!snapshot) {
    console.log("\nNo data yet. Run `pennypacker scrape` first.\n");
    return;
  }

  const allHoldings = getHoldingsForSnapshot(snapshot.id);

  // Filter by account if specified
  const holdings = accountFilter
    ? allHoldings.filter(h =>
        h.institution.toLowerCase().includes(accountFilter.toLowerCase()) ||
        (h.account_number && h.account_number.includes(accountFilter))
      )
    : allHoldings;

  if (holdings.length === 0) {
    console.log(accountFilter
      ? `\nNo holdings found matching "${accountFilter}".`
      : "\nNo holdings data. Run `pennypacker scrape` first."
    );
    return;
  }

  console.log(heading("HOLDINGS"));
  console.log(dim(`  as of ${new Date(snapshot.scraped_at + "Z").toLocaleString()}`));

  // Group by account
  const byAccount = new Map<string, typeof holdings>();
  for (const h of holdings) {
    const key = `${h.institution} (${h.account_number})`;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key)!.push(h);
  }

  for (const [account, acctHoldings] of byAccount) {
    const total = acctHoldings.reduce((sum, h) => sum + h.value, 0);
    console.log(`\n  ${account}  ${money(total)}`);

    const rows = acctHoldings.map(h => [
      h.ticker || "---",
      h.fund_name.length > 45 ? h.fund_name.slice(0, 42) + "..." : h.fund_name,
      h.shares.toLocaleString("en-US", { maximumFractionDigits: 2 }),
      moneyExact(h.price),
      money(h.value),
      h.day_change_percent !== null ? percent(h.day_change_percent) : dim("n/a"),
    ]);

    console.log(table(
      ["Ticker", "Fund", "Shares", "Price", "Value", "1-Day"],
      rows,
      ["left", "left", "right", "right", "right", "right"]
    ));
  }

  // Portfolio allocation summary
  const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);
  if (totalValue > 0) {
    console.log(heading("ALLOCATION"));
    const byTicker = new Map<string, number>();
    for (const h of holdings) {
      const key = h.ticker || h.fund_name;
      byTicker.set(key, (byTicker.get(key) || 0) + h.value);
    }

    const sorted = [...byTicker.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, value] of sorted) {
      const pct = ((value / totalValue) * 100).toFixed(1);
      const bar = "█".repeat(Math.round((value / totalValue) * 30));
      console.log(`  ${name.padEnd(8)} ${pct.padStart(5)}%  ${bar}  ${money(value)}`);
    }
  }

  console.log("");
}
