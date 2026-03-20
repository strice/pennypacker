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
const EMPOWER_USERNAME = process.env.EMPOWER_USERNAME;
const EMPOWER_PASSWORD = process.env.EMPOWER_PASSWORD;

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
  if (HEADLESS) {
    console.error("  ❌ Cannot log in headless — Empower requires interactive 2FA.");
    return false;
  }

  // Always start fresh — Empower sessions don't survive between browser instances
  console.log("\n  🔐 Opening login page...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // Auto-fill credentials if provided
  if (EMPOWER_USERNAME && EMPOWER_PASSWORD) {
    console.log("  🔑 Auto-filling credentials...");
    try {
      // Wait for the login form to render
      await page.waitForSelector('input[type="text"], input[type="email"], input[id*="user"], input[name*="user"]', { timeout: 15000 });

      // Find and fill username field
      const usernameField = await page.$('input[type="text"], input[type="email"], input[id*="user"], input[name*="user"]');
      if (usernameField) {
        await usernameField.fill(EMPOWER_USERNAME);
        console.log("  ✏️  Username filled");
      }

      // Find and fill password field
      const passwordField = await page.$('input[type="password"]');
      if (passwordField) {
        await passwordField.fill(EMPOWER_PASSWORD);
        console.log("  ✏️  Password filled");
      }

      // Click the login/submit button
      const submitButton = await page.$('button[type="submit"], button:has-text("Log In"), button:has-text("Sign In"), button:has-text("Submit")');
      if (submitButton) {
        await submitButton.click();
        console.log("  🚀 Submitted login form");
      }

      console.log("  ⏳ Waiting for 2FA...\n");
    } catch (err) {
      console.log(`  ⚠️  Auto-fill failed: ${err}`);
      console.log("  👉 Please log in manually in the browser window.");
    }
  } else {
    console.log("  👉 Please log in to Empower in the browser window.");
    console.log("  💡 Tip: set EMPOWER_USERNAME and EMPOWER_PASSWORD in .env for auto-fill");
  }
  console.log("  ⏳ Waiting up to 5 minutes for login + 2FA...\n");

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

    // innerText comes as newline-separated lines like:
    //   "Vanguard"
    //   "4156 • 15m ago"
    //   "$158,572"      (sr-only duplicate)
    //   "$158,572"      (visible balance)
    //   "+$11,519"      (change amount)
    // Or for manual accounts, last line is "Manual"
    //
    // ariaLabel is cleaner single-line:
    //   "Vanguard 4156 • 15m ago $158,572 +$11,519"

    // Parse from newline-separated innerText (more reliable than regex on collapsed text)
    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 3) continue;

    // Find the line with "• Xm ago" — that splits institution/detail from balance/change
    const agoLineIdx = lines.findIndex(l => /•\s+\d+[mhd]\s+ago/.test(l));
    if (agoLineIdx === -1) continue;

    const institution = lines.slice(0, agoLineIdx).join(" ").trim();
    const detailLine = lines[agoLineIdx]; // e.g. "4156 • 15m ago"

    // Everything after the ago line: balance values and change
    const afterAgo = lines.slice(agoLineIdx + 1);
    // Last item is either a change amount (+$X / -$X) or "Manual"
    const lastItem = afterAgo[afterAgo.length - 1] || "";
    const isManual = lastItem === "Manual";

    // Balance is the first dollar amount after the ago line
    const balanceStr = afterAgo.find(l => l.startsWith("$")) || "$0";
    const balance = parseDollar(balanceStr);

    // Change is the last item (if it starts with + or - or is "Manual")
    const changeAmount = isManual ? null : parseDollar(lastItem);

    // Extract account number from detail line
    const acctNumMatch = detailLine.match(/^(\d{4})\s+•/);
    const accountNumber = acctNumMatch ? acctNumMatch[1] : null;

    // Extract name from detail (everything before "•")
    const detailName = detailLine.replace(/\s*•.*$/, "").trim();
    const name = accountNumber
      ? detailName.replace(/^\d{4}\s*/, "").trim() || institution
      : detailName;

    const fullText = `${institution} ${detailLine} ${balanceStr} ${lastItem}`;
    const { category, assetOrLiability } = categorizeAccount(institution, name, fullText);

    accounts.push({
      name: name || institution,
      institution,
      accountNumber,
      category,
      assetOrLiability,
      balance,
      changeAmount,
      changeLabel: lastItem,
      isManual,
    });
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
// Strategy: click account in sidebar → click Holdings tab → scrape grid → click back to dashboard
// Must stay within the SPA — page.goto() with hash URLs doesn't trigger proper SPA routing

async function scrapeAllHoldings(
  page: Page,
  investmentAccounts: Array<{ accountId: number; institution: string; accountNumber: string | null; name: string }>
): Promise<Map<number, ScrapedHolding[]>> {
  const allHoldings = new Map<number, ScrapedHolding[]>();

  for (const acct of investmentAccounts) {
    const label = `${acct.institution} ${acct.accountNumber || acct.name}`;
    console.log(`\n📈 Scraping holdings for ${label}...`);

    try {
      // Find and click this account's button in the sidebar
      // The sidebar persists across views, so we can always click from it
      const buttonSelector = acct.accountNumber
        ? `button:has-text("${acct.institution}"):has-text("${acct.accountNumber}")`
        : `button:has-text("${acct.institution}"):has-text("${acct.name}")`;

      console.log(`  🔍 Looking for: ${buttonSelector}`);

      // Wait for sidebar buttons to be present
      await page.waitForSelector('button[data-testid="click-account-card"]', { timeout: 10000 });

      // Use data-testid buttons and match by text content
      const buttons = await page.$$('button[data-testid="click-account-card"]');
      let clicked = false;

      for (const btn of buttons) {
        const text = await btn.innerText().catch(() => "");
        const hasInstitution = text.includes(acct.institution);
        const hasIdentifier = acct.accountNumber
          ? text.includes(acct.accountNumber)
          : text.includes(acct.name);

        if (hasInstitution && hasIdentifier) {
          console.log(`  🖱️  Clicking: ${text.replace(/\n/g, " ").slice(0, 60)}...`);
          await btn.click();
          clicked = true;
          break;
        }
      }

      if (!clicked) {
        console.log(`  ⚠️  Could not find sidebar button for ${label}`);
        continue;
      }

      // Wait for the detail view to load (look for Holdings tab link)
      try {
        await page.waitForSelector('a:has-text("Holdings")', { timeout: 10000 });
      } catch {
        console.log(`  ⚠️  Detail page didn't load for ${label}, skipping`);
        // Click the logo/home to get back to dashboard
        await page.click('a:has-text("Go to dashboard")').catch(() => {});
        await page.waitForSelector('[id="networth-balance"]', { timeout: 10000 }).catch(() => {});
        continue;
      }

      // Verify we're on the right account's detail page
      const pageHeading = await page.innerText('h1').catch(() => "");
      console.log(`  📄 Detail page: ${pageHeading}`);

      // Click the Holdings tab
      console.log("  📋 Clicking Holdings tab...");
      await page.click('a:has-text("Holdings")');

      // Wait for the holdings grid to render
      try {
        await page.waitForSelector('[role="grid"] [role="gridcell"], table td', { timeout: 10000 });
      } catch {
        console.log(`  ⚠️  Holdings grid didn't render for ${label}`);
        await page.click('a:has-text("Go to dashboard")').catch(() => {});
        await page.waitForSelector('[id="networth-balance"]', { timeout: 10000 }).catch(() => {});
        continue;
      }

      // Wait for data to populate
      await page.waitForTimeout(2000);

      // Scrape the holdings grid (scope to main content area to avoid picking up stale data)
      const holdings = await page.evaluate(() => {
        const main = document.querySelector('main') || document;
        const gridRows = main.querySelectorAll('[role="grid"] [role="rowgroup"]:last-child [role="row"]');
        const tableRows = main.querySelectorAll('table tbody tr');
        const rows = gridRows.length > 0 ? gridRows : tableRows;

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

          if (holdingCell.toLowerCase().includes("grand total")) continue;
          if (holdingCell.toLowerCase() === "holding") continue;
          if (holdingCell === "Cash Cash" && valueText === "$0.00") continue;

          // Ticker is all-caps 2-6 chars at start, may or may not have space before fund name
          const tickerMatch = holdingCell.match(/^([A-Z]{2,6})(?:\s+|(?=[A-Z][a-z]))/);
          const ticker = tickerMatch ? tickerMatch[1] : null;
          const fundName = ticker
            ? holdingCell.slice(ticker.length).trim()
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
      allHoldings.set(acct.accountId, holdings);

      // Navigate back to dashboard by clicking the logo
      console.log("  🔙 Back to dashboard...");
      await page.click('a:has-text("Go to dashboard")').catch(async () => {
        // Fallback: use browser back
        await page.goBack();
      });
      await page.waitForSelector('[id="networth-balance"]', { timeout: 15000 });

    } catch (err) {
      console.error(`  ⚠️  Failed to scrape holdings for ${label}: ${err}`);
      // Try to recover to dashboard
      try {
        await page.click('a:has-text("Go to dashboard")').catch(() => {});
        await page.waitForSelector('[id="networth-balance"]', { timeout: 10000 });
      } catch {
        console.log("  🔄 Recovering by reloading dashboard...");
        await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[id="networth-balance"]', { timeout: 15000 });
      }
    }
  }

  return allHoldings;
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

    // Insert accounts and collect investment accounts for holdings scraping
    const investmentAccounts: Array<{ accountId: number; institution: string; accountNumber: string | null; name: string }> = [];

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

      // Only scrape holdings for brokerage accounts with a detail page
      // Skip manual entries (I-Bonds, TreasuryDirect) that don't have holdings views
      const skipForHoldings = acct.isManual
        || acct.institution.includes("Series")
        || acct.institution.includes("TreasuryDirect")
        || acct.name.includes("TreasuryDirect");
      if (acct.category === "investment" && !skipForHoldings) {
        investmentAccounts.push({
          accountId,
          institution: acct.institution,
          accountNumber: acct.accountNumber,
          name: acct.name,
        });
      }
    }

    // Scrape holdings for each investment account (click-based, stays in SPA)
    const allHoldings = await scrapeAllHoldings(page, investmentAccounts);

    for (const [accountId, holdings] of allHoldings) {
      for (const holding of holdings) {
        insertHolding(snapshotId, accountId, {
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
