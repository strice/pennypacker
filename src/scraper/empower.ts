import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { resolve } from "path";
import { existsSync } from "fs";
import {
  insertSnapshot,
  insertAccount,
  insertHolding,
  getLatestSnapshot,
  getAccountsForSnapshot,
} from "../db/queries";
import { scrapeZillow } from "./zillow";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const COOKIE_PATH = resolve(PROJECT_ROOT, process.env.COOKIE_PATH || "cookies.json");
const LOGIN_URL = process.env.EMPOWER_LOGIN_URL || "https://ira.empower-retirement.com/participant/#/sfd-login?accu=MYERIRA";
const DASHBOARD_URL = process.env.EMPOWER_DASHBOARD_URL || "https://ira.empower-retirement.com/dashboard/#/user/home";
const HEADLESS = process.env.HEADLESS === "true";

// --- Cookie management ---

async function saveCookies(context: BrowserContext) {
  const cookies = await context.cookies();
  await Bun.write(COOKIE_PATH, JSON.stringify(cookies, null, 2));
  console.log(`  💾 Saved ${cookies.length} cookies`);
}

async function loadCookies(context: BrowserContext): Promise<boolean> {
  if (!existsSync(COOKIE_PATH)) return false;
  try {
    const cookies = JSON.parse(await Bun.file(COOKIE_PATH).text());
    await context.addCookies(cookies);
    console.log(`  🍪 Loaded ${cookies.length} saved cookies`);
    return true;
  } catch {
    return false;
  }
}

// --- Auth flow ---

async function ensureLoggedIn(page: Page, context: BrowserContext): Promise<boolean> {
  const hasCookies = await loadCookies(context);

  if (hasCookies) {
    // Try the dashboard with saved cookies
    console.log("  🔄 Trying saved session...");
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });

    try {
      await page.waitForSelector('[id="networth-balance"]', { timeout: 20000 });
      console.log("  ✅ Logged in with saved cookies");
      return true;
    } catch {
      console.log("  ⚠️  Saved cookies expired, clearing for fresh login...");
      // Clear stale cookies so they don't interfere with fresh login
      await context.clearCookies();
    }
  }

  if (HEADLESS) {
    console.error("  ❌ Not logged in and running headless. Run with HEADLESS=false first to log in.");
    return false;
  }

  // Fresh login — no stale cookies to confuse things
  console.log("\n  🔐 Opening login page...");
  console.log("  👉 Please log in to Empower in the browser window.");
  console.log("  ⏳ Waiting up to 5 minutes for login + 2FA...\n");

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // Wait for user to complete login
  // Monitor for dashboard URL OR the networth element appearing
  // Empower's redirect chain can be unpredictable, so watch for both
  try {
    // Poll for success: either URL changes to dashboard or we see the sidebar
    const result = await Promise.race([
      page.waitForURL("**/dashboard/**", { timeout: 300000 }).then(() => "url"),
      page.waitForSelector('[id="networth-balance"]', { timeout: 300000 }).then(() => "selector"),
    ]);
    console.log(`  🔄 Login detected via ${result}, waiting for dashboard data...`);

    // If we got the URL change, still need to wait for content
    if (result === "url") {
      try {
        await page.waitForSelector('[id="networth-balance"]', { timeout: 30000 });
      } catch {
        // Maybe the page needs a reload
        console.log("  🔄 Dashboard loaded but no data yet, reloading...");
        await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[id="networth-balance"]', { timeout: 30000 });
      }
    }

    console.log("  ✅ Login successful!");
    await saveCookies(context);
    return true;
  } catch (err) {
    // Log where we ended up for debugging
    const currentUrl = page.url();
    console.error(`  ❌ Login failed. Current URL: ${currentUrl}`);
    console.error(`  ❌ Error: ${err}`);
    return false;
  }
}

// --- Parsing helpers ---

function parseDollar(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/[^0-9.\-]/g, "");
  return parseFloat(cleaned) || 0;
}

function parsePercent(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/[^0-9.\-]/g, "");
  return parseFloat(cleaned) || 0;
}

interface ScrapedAccount {
  name: string;
  institution: string;
  accountNumber: string | null;
  category: string;
  assetOrLiability: string;
  balance: number;
  changeAmount: number | null;
  changeLabel: string | null;
  isManual: boolean;
}

interface ScrapedHolding {
  ticker: string | null;
  fundName: string;
  shares: number;
  price: number;
  value: number;
  dayChangeAmount: number | null;
  dayChangePercent: number | null;
}

// --- Sidebar scraper ---

async function scrapeSidebar(page: Page): Promise<{
  netWorth: number;
  totalAssets: number;
  totalLiabilities: number;
  accounts: ScrapedAccount[];
}> {
  console.log("\n📊 Scraping sidebar...");

  // Wait for data to be present
  await page.waitForSelector('[id="networth-balance"]', { timeout: 15000 });

  const data = await page.evaluate(() => {
    const accounts: Array<{
      name: string;
      institution: string;
      accountNumber: string | null;
      category: string;
      assetOrLiability: string;
      balance: number;
      changeAmount: number | null;
      changeLabel: string | null;
      isManual: boolean;
    }> = [];

    // Net worth
    const netWorthEl = document.querySelector('[id="networth-balance"]');
    const netWorthText = netWorthEl?.textContent?.trim() || "$0";

    // Find all account buttons in sidebar using aria labels
    // The sidebar structure: category buttons contain sub-account buttons
    const allButtons = Array.from(document.querySelectorAll('button[data-testid="click-account-card"]'));

    // Also try the button pattern from the accessibility tree
    // Each account button has: institution name, account details, balance, change
    const sidebarContainer = document.querySelector('[id="sidebar-container"]');
    if (!sidebarContainer) {
      // Fallback: parse from button aria-labels
      return { netWorth: netWorthText, totalAssets: "0", totalLiabilities: "0", rawAccounts: [] };
    }

    // Get assets/liabilities totals
    const spans = sidebarContainer.querySelectorAll("span");
    let totalAssets = "0";
    let totalLiabilities = "0";
    let currentSection = "";

    for (const span of spans) {
      const text = span.textContent?.trim() || "";
      if (text === "Assets") currentSection = "assets";
      if (text === "Liabilities") currentSection = "liabilities";
      if (currentSection === "assets" && text.startsWith("$") && totalAssets === "0") {
        totalAssets = text;
      }
      if (currentSection === "liabilities" && text.startsWith("$") && totalLiabilities === "0") {
        totalLiabilities = text;
      }
    }

    // Parse account cards
    const accountCards = sidebarContainer.querySelectorAll('button[data-testid="click-account-card"]');
    for (const card of accountCards) {
      const spans = card.querySelectorAll("span");
      const texts: string[] = [];
      for (const s of spans) {
        const t = s.textContent?.trim();
        if (t && !s.querySelector("span")) texts.push(t); // leaf text only
      }
      if (texts.length >= 2) {
        accounts.push({
          name: texts[0] || "",
          institution: texts[0] || "",
          accountNumber: null,
          category: "unknown",
          assetOrLiability: "asset",
          balance: 0,
          changeAmount: null,
          changeLabel: texts[1] || null,
          isManual: false,
        });
      }
    }

    return { netWorth: netWorthText, totalAssets, totalLiabilities, rawAccounts: accounts };
  });

  // The DOM evaluation above is tricky because of React's rendering.
  // Let's use a more reliable approach: parse the accessibility tree buttons.
  // We already know the button text patterns from our snapshot exploration.

  const accounts = await parseSidebarAccounts(page);

  return {
    netWorth: parseDollar(data.netWorth),
    totalAssets: parseDollar(data.totalAssets),
    totalLiabilities: parseDollar(data.totalLiabilities),
    accounts,
  };
}

async function parseSidebarAccounts(page: Page): Promise<ScrapedAccount[]> {
  const accounts: ScrapedAccount[] = [];

  // Get all account-level buttons from the sidebar
  // These follow a consistent pattern in their accessible names
  const buttons = await page.$$('button');

  for (const button of buttons) {
    const ariaLabel = await button.getAttribute("aria-label");
    const text = await button.innerText().catch(() => "");

    // Account buttons have patterns like:
    // "Ally Bank 6735 • 13m ago $4,122 +$3,891"
    // "Vanguard 4156 • 13m ago $158,572 +$11,519"
    // "CareFirst CareFirst HSA • 0m ago $965 Manual"
    // "SunTrust Mortgage 9645 • 12m ago $185,312 -$7,299"
    // "Home 3102 Trellis Ln • 7d ago $492,500 Manual"
    // "American Express Cards 1001 • 135d ago $1,400 -$241"

    const accountPattern = /^(.+?)\s+(.+?)\s+•\s+\d+[mhd]\s+ago\s+\$([\d,]+(?:\.\d+)?)\s+(.+)$/;
    const fullText = (ariaLabel || text).replace(/\n/g, " ").trim();
    const match = fullText.match(accountPattern);

    if (match) {
      const [, institution, detail, balanceStr, changeStr] = match;

      // Determine account number (4-digit number in detail)
      const acctNumMatch = detail.match(/^(\d{4})\b/);
      const accountNumber = acctNumMatch ? acctNumMatch[1] : null;

      // Determine name from detail
      const name = accountNumber
        ? detail.replace(/^\d{4}\s*/, "").trim() || institution
        : detail.trim();

      const balance = parseDollar(balanceStr);
      const isManual = changeStr.trim() === "Manual";
      const changeAmount = isManual ? null : parseDollar(changeStr);

      // Categorize
      const { category, assetOrLiability } = categorizeAccount(institution, name, fullText);

      accounts.push({
        name: name || institution,
        institution,
        accountNumber,
        category,
        assetOrLiability,
        balance,
        changeAmount,
        changeLabel: changeStr.trim(),
        isManual,
      });
    }
  }

  return accounts;
}

function categorizeAccount(
  institution: string,
  name: string,
  fullText: string
): { category: string; assetOrLiability: string } {
  const lower = `${institution} ${name} ${fullText}`.toLowerCase();

  // Liabilities
  if (lower.includes("mortgage") || lower.includes("suntrust mortgage")) {
    return { category: "mortgage", assetOrLiability: "liability" };
  }
  if (lower.includes("american express") || lower.includes("credit card")) {
    return { category: "credit_card", assetOrLiability: "liability" };
  }
  if (lower.includes("loan")) {
    return { category: "loan", assetOrLiability: "liability" };
  }

  // Assets
  if (lower.includes("home") || lower.includes("trellis")) {
    return { category: "property", assetOrLiability: "asset" };
  }
  if (lower.includes("vehicle")) {
    return { category: "vehicle", assetOrLiability: "asset" };
  }
  // HSA checks must come before generic institution checks
  if (lower.includes("hsa") && lower.includes("investment")) {
    return { category: "investment", assetOrLiability: "asset" };
  }
  if (lower.includes("hsa")) {
    return { category: "cash", assetOrLiability: "asset" };
  }
  if (
    lower.includes("vanguard") ||
    lower.includes("fidelity") ||
    lower.includes("savings bond") ||
    lower.includes("treasurydirect")
  ) {
    return { category: "investment", assetOrLiability: "asset" };
  }
  if (
    lower.includes("savings") ||
    lower.includes("checking") ||
    lower.includes("ally") ||
    lower.includes("bank")
  ) {
    return { category: "cash", assetOrLiability: "asset" };
  }

  return { category: "other", assetOrLiability: "asset" };
}

// --- Holdings scraper ---

async function findAccountUrls(page: Page): Promise<Map<string, string>> {
  // When you click an account in the sidebar, the URL changes to include a `ua=` param.
  // We can find these by looking at where sidebar account clicks navigate to.
  // Strategy: click each investment account, capture the URL, go back.
  // But that's fragile. Better: look for the ua param in the page's network or DOM.

  // From our exploration, the detail URL pattern is:
  // /dashboard/#/accounts/details?ua=XXXXXXX&firmName=Vanguard
  // We need to discover the `ua` values.

  // Let's find them by evaluating click handlers or by clicking and capturing URLs
  const urls = new Map<string, string>();

  console.log("  🔍 Discovering account detail URLs...");

  // Find all sidebar account buttons and click each to discover their URLs
  const buttons = await page.$$('button[data-testid="click-account-card"]');
  console.log(`  📋 Found ${buttons.length} account cards`);

  for (const button of buttons) {
    const buttonText = await button.innerText().catch(() => "");
    const cleanText = buttonText.replace(/\n/g, " ").trim();

    // Only care about investment accounts (have Vanguard, Fidelity, CareFirst HSA Investment)
    const isInvestment = /vanguard|fidelity|hsa investment/i.test(cleanText);
    if (!isInvestment) continue;

    console.log(`  🖱️  Clicking: ${cleanText.slice(0, 60)}...`);

    try {
      await button.click();
      await page.waitForURL("**/accounts/details**", { timeout: 10000 });
      const url = page.url();
      console.log(`  📎 URL: ${url}`);

      // Extract account identifier from button text
      const acctMatch = cleanText.match(/(\w+)\s+(\d{4})\s+•/);
      if (acctMatch) {
        const key = `${acctMatch[1]} ${acctMatch[2]}`;
        urls.set(key, url);
      } else {
        // For accounts without 4-digit number (like CareFirst HSA Investment)
        const nameMatch = cleanText.match(/^(.+?)\s+•/);
        if (nameMatch) urls.set(nameMatch[1].trim(), url);
      }

      // Go back to dashboard
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[id="networth-balance"]', { timeout: 15000 });
    } catch (err) {
      console.log(`  ⚠️  Could not get URL for: ${cleanText.slice(0, 40)} — ${err}`);
      // Make sure we're back on dashboard
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForSelector('[id="networth-balance"]', { timeout: 15000 }).catch(() => {});
    }
  }

  return urls;
}

async function scrapeHoldingsFromUrl(page: Page, detailUrl: string): Promise<ScrapedHolding[]> {
  // Navigate to the holdings tab directly
  const holdingsUrl = detailUrl.includes("tabId=")
    ? detailUrl.replace(/tabId=\w+/, "tabId=holdings")
    : detailUrl + "&tabId=holdings";

  console.log(`  🔗 Navigating to holdings: ${holdingsUrl.slice(0, 80)}...`);
  await page.goto(holdingsUrl, { waitUntil: "domcontentloaded" });

  // Wait for the holdings grid to render
  try {
    await page.waitForSelector('[role="grid"], table', { timeout: 15000 });
  } catch {
    console.log("  ⚠️  No holdings grid found, checking page...");
    const pageText = await page.innerText('body').catch(() => "");
    console.log(`  📄 Page contains: ${pageText.slice(0, 200)}...`);
    return [];
  }

  // Small delay for data to populate
  await page.waitForTimeout(1500);

  const holdings = await page.evaluate(() => {
    // Try both table and grid-role selectors
    const gridRows = document.querySelectorAll('[role="grid"] [role="rowgroup"]:last-child [role="row"]');
    const tableRows = document.querySelectorAll('table tbody tr');
    const rows = gridRows.length > 0 ? gridRows : tableRows;

    console.log(`Found ${rows.length} rows`); // browser console

    const results: Array<{
      ticker: string | null;
      fundName: string;
      shares: number;
      price: number;
      value: number;
      dayChangeAmount: number | null;
      dayChangePercent: number | null;
    }> = [];

    for (const row of rows) {
      const cells = row.querySelectorAll('td, [role="gridcell"]');
      if (cells.length < 4) continue;

      const holdingCell = cells[0]?.textContent?.trim() || "";
      const sharesText = cells[1]?.textContent?.trim() || "0";
      const priceText = cells[2]?.textContent?.trim() || "0";
      const valueText = cells[3]?.textContent?.trim() || "0";
      const dayChangeText = cells[4]?.textContent?.trim() || "0";
      const dayPctText = cells[5]?.textContent?.trim() || "0";

      // Skip header-like rows and totals
      if (holdingCell.toLowerCase().includes("grand total")) continue;
      if (holdingCell.toLowerCase() === "holding") continue;
      if (holdingCell === "Cash Cash" && valueText === "$0.00") continue;

      // Extract ticker — first word if all caps 2-6 chars
      const tickerMatch = holdingCell.match(/^([A-Z]{2,6})\b/);
      const ticker = tickerMatch ? tickerMatch[1] : null;
      const fundName = ticker
        ? holdingCell.replace(ticker, "").trim()
        : holdingCell;

      const parseDollar = (t: string) => parseFloat(t.replace(/[^0-9.\-]/g, "")) || 0;
      const parsePercent = (t: string) => parseFloat(t.replace(/[^0-9.\-]/g, "")) || 0;

      results.push({
        ticker,
        fundName,
        shares: parseFloat(sharesText.replace(/,/g, "")) || 0,
        price: parseDollar(priceText),
        value: parseDollar(valueText),
        dayChangeAmount: parseDollar(dayChangeText),
        dayChangePercent: parsePercent(dayPctText),
      });
    }

    return results;
  });

  console.log(`  📊 Found ${holdings.length} holdings`);
  return holdings;
}

// --- Main scrape orchestrator ---

export async function scrapeEmpower(): Promise<number> {
  console.log("🏦 H.E. Pennypacker — Scraping Empower dashboard\n");

  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--no-sandbox", "--disable-gpu"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    // Login
    const loggedIn = await ensureLoggedIn(page, context);
    if (!loggedIn) {
      console.error("❌ Could not log in. Aborting.");
      return -1;
    }

    // Make sure we're on the dashboard
    if (!page.url().includes("dashboard")) {
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[id="networth-balance"]', { timeout: 15000 });
    }

    // Scrape sidebar
    const sidebar = await scrapeSidebar(page);
    console.log(`\n  Net Worth: $${sidebar.netWorth.toLocaleString()}`);
    console.log(`  Assets: $${sidebar.totalAssets.toLocaleString()}`);
    console.log(`  Liabilities: $${sidebar.totalLiabilities.toLocaleString()}`);
    console.log(`  Accounts found: ${sidebar.accounts.length}`);

    // Insert snapshot
    const snapshotId = insertSnapshot(
      sidebar.netWorth,
      sidebar.totalAssets,
      sidebar.totalLiabilities
    );

    // Insert accounts and track investment account IDs
    const accountIdMap = new Map<string, number>(); // "Institution AcctNum" -> db id

    for (const acct of sidebar.accounts) {
      const accountId = insertAccount(snapshotId, {
        name: acct.name,
        institution: acct.institution,
        account_number: acct.accountNumber,
        category: acct.category,
        asset_or_liability: acct.assetOrLiability,
        balance: acct.balance,
        change_amount: acct.changeAmount,
        change_label: acct.changeLabel,
        is_manual: acct.isManual ? 1 : 0,
      });

      console.log(`  💰 ${acct.institution} ${acct.accountNumber || acct.name}: $${acct.balance.toLocaleString()} [${acct.category}]`);

      // Map for matching with discovered URLs
      const key = acct.accountNumber
        ? `${acct.institution} ${acct.accountNumber}`
        : `${acct.institution} ${acct.name}`;
      accountIdMap.set(key, accountId);
    }

    // Discover account detail URLs by clicking sidebar buttons
    const accountUrls = await findAccountUrls(page);
    console.log(`\n  🗺️  Discovered ${accountUrls.size} investment account URLs`);

    // Scrape holdings for each discovered investment account
    for (const [ref, url] of accountUrls) {
      console.log(`\n📈 Scraping holdings for ${ref}...`);

      // Find matching account ID
      const accountId = accountIdMap.get(ref);
      if (!accountId) {
        // Try fuzzy match
        const fuzzyKey = [...accountIdMap.keys()].find(k => k.includes(ref) || ref.includes(k));
        if (!fuzzyKey) {
          console.log(`  ⚠️  No matching account in DB for "${ref}", skipping`);
          continue;
        }
        console.log(`  🔗 Fuzzy matched "${ref}" → "${fuzzyKey}"`);
      }
      const dbId = accountId || accountIdMap.get([...accountIdMap.keys()].find(k => k.includes(ref) || ref.includes(k))!)!;

      try {
        const holdings = await scrapeHoldingsFromUrl(page, url);

        for (const holding of holdings) {
          insertHolding(snapshotId, dbId, {
            ticker: holding.ticker,
            fund_name: holding.fundName,
            shares: holding.shares,
            price: holding.price,
            value: holding.value,
            day_change_amount: holding.dayChangeAmount,
            day_change_percent: holding.dayChangePercent,
          });
          console.log(`    ${holding.ticker || "---"} | ${holding.fundName.slice(0, 40)} | ${holding.shares} shares @ $${holding.price} = $${holding.value.toLocaleString()}`);
        }
      } catch (err) {
        console.error(`  ⚠️  Failed to scrape holdings for ${ref}: ${err}`);
      }
    }

    // Scrape Zillow for home value (doesn't need browser)
    const zillow = await scrapeZillow();
    if (zillow) {
      // Update the home account if it exists in this snapshot
      const homeAccount = sidebar.accounts.find(a => a.category === "property");
      if (homeAccount) {
        const db = (await import("../db/schema")).getDb();
        db.run(
          `UPDATE accounts SET balance = ?, change_label = 'Zillow Zestimate' WHERE snapshot_id = ? AND category = 'property'`,
          [zillow.zestimate, snapshotId]
        );
        console.log(`  🏠 Updated home value: $${homeAccount.balance.toLocaleString()} → $${zillow.zestimate.toLocaleString()}`);

        // Recalculate net worth with updated home value
        const diff = zillow.zestimate - homeAccount.balance;
        if (diff !== 0) {
          db.run(
            `UPDATE snapshots SET net_worth = net_worth + ?, total_assets = total_assets + ? WHERE id = ?`,
            [diff, diff, snapshotId]
          );
        }
      }
    }

    // Save cookies for next time
    await saveCookies(context);

    console.log(`\n✅ Snapshot #${snapshotId} saved successfully!`);
    return snapshotId;

  } finally {
    await browser.close();
  }
}
