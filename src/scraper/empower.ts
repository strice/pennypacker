import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { resolve } from "path";
import { existsSync } from "fs";
import {
  insertSnapshot,
  insertAccount,
  insertHolding,
  insertTransaction,
  insertAllocation,
  insertPerformance,
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

// --- Transactions scraper (from Cash Flow page) ---

interface ScrapedTransaction {
  date: string;
  accountName: string;
  description: string;
  category: string;
  tags: string | null;
  amount: number;
}

async function scrapeTransactions(page: Page): Promise<ScrapedTransaction[]> {
  console.log("\n💳 Scraping transactions...");

  // Navigate to Cash Flow page via menu
  const budgetingBtn = await page.$('button:has-text("Budgeting")');
  if (!budgetingBtn) {
    console.log("  ⚠️  Could not find Budgeting menu");
    return [];
  }
  await budgetingBtn.click();
  await page.waitForTimeout(500);

  const cashFlowItem = await page.$('[data-testid="submenu-link-cashflow"]');
  if (!cashFlowItem) {
    // Try clicking away to close menu and retry
    console.log("  ⚠️  Could not find Cash Flow menu item");
    await page.keyboard.press("Escape");
    return [];
  }
  await cashFlowItem.click();

  try {
    await page.waitForSelector('[role="grid"]', { timeout: 15000 });
  } catch {
    console.log("  ⚠️  Cash Flow page didn't load");
    return [];
  }

  // Change date range to 90 days for more data
  try {
    const dateDropdown = await page.$('select, [role="combobox"]:near(:text("Date range"))');
    if (dateDropdown) {
      await dateDropdown.click();
      await page.waitForTimeout(300);
      // Look for 90 Days option
      const option90 = await page.$('li:has-text("90 Days"), [role="option"]:has-text("90 Days")');
      if (option90) {
        await option90.click();
        await page.waitForTimeout(2000);
        console.log("  📅 Set date range to 90 days");
      }
    }
  } catch {
    console.log("  📅 Using default date range");
  }

  const allTransactions: ScrapedTransaction[] = [];
  let hasMore = true;

  while (hasMore) {
    // Scrape current page of transactions
    const pageTransactions = await page.evaluate(() => {
      const results: Array<{
        date: string;
        accountName: string;
        description: string;
        category: string;
        amount: string;
      }> = [];

      const main = document.querySelector("main") || document;
      const rows = main.querySelectorAll(
        '[role="grid"] [role="rowgroup"]:last-child [role="row"]'
      );

      for (const row of rows) {
        const cells = row.querySelectorAll('[role="gridcell"]');
        if (cells.length < 6) continue;

        const dateText = cells[0]?.textContent?.trim() || "";
        const accountText = cells[1]?.textContent?.trim() || "";
        const descText = cells[2]?.textContent?.trim() || "";
        const catText = cells[3]?.textContent?.trim() || "";
        const amountText = cells[5]?.textContent?.trim() || "";

        // Skip total row
        if (dateText === "Total" || descText === "") continue;

        results.push({
          date: dateText,
          accountName: accountText,
          description: descText,
          category: catText,
          amount: amountText,
        });
      }

      return results;
    });

    for (const txn of pageTransactions) {
      if (txn.date === "Total") continue;
      allTransactions.push({
        date: txn.date,
        accountName: txn.accountName,
        description: txn.description,
        category: txn.category,
        tags: null,
        amount: parseDollar(txn.amount),
      });
    }

    // Check for next page
    const nextButton = await page.$('button:has-text("Go to next page"):not([disabled])');
    if (nextButton) {
      await nextButton.click();
      await page.waitForTimeout(1500);
    } else {
      hasMore = false;
    }
  }

  console.log(`  📋 Found ${allTransactions.length} transactions`);
  return allTransactions;
}

// --- Allocation scraper (from Investing > Allocations page) ---

interface ScrapedAllocation {
  assetClass: string;
  value: number;
  percentTotal: number;
  dayChangePercent: number | null;
}

async function scrapeAllocations(page: Page): Promise<ScrapedAllocation[]> {
  console.log("\n📊 Scraping allocations...");

  // Navigate to Investing > Allocations
  const investingBtn = await page.$('button:has-text("Investing")');
  if (!investingBtn) {
    console.log("  ⚠️  Could not find Investing menu");
    return [];
  }
  await investingBtn.click();
  await page.waitForTimeout(500);

  const allocItem = await page.$('[data-testid="submenu-link-allocations"]');
  if (!allocItem) {
    console.log("  ⚠️  Could not find Allocations menu item");
    await page.keyboard.press("Escape");
    return [];
  }
  await allocItem.click();

  try {
    await page.waitForSelector('[role="grid"]', { timeout: 15000 });
  } catch {
    console.log("  ⚠️  Allocations page didn't load");
    return [];
  }

  await page.waitForTimeout(1000);

  const allocations = await page.evaluate(() => {
    const results: Array<{
      assetClass: string;
      percentTotal: string;
      dayChangePercent: string;
      value: string;
    }> = [];

    const main = document.querySelector("main") || document;
    const rows = main.querySelectorAll(
      '[role="grid"] [role="rowgroup"]:last-child [role="row"]'
    );

    for (const row of rows) {
      const cells = row.querySelectorAll('[role="gridcell"]');
      if (cells.length < 5) continue;

      const assetClass = cells[1]?.textContent?.trim() || "";
      const pctTotal = cells[2]?.textContent?.trim() || "0";
      const dayPct = cells[3]?.textContent?.trim() || "0";
      const value = cells[4]?.textContent?.trim() || "$0";

      if (!assetClass) continue;

      results.push({
        assetClass,
        percentTotal: pctTotal,
        dayChangePercent: dayPct,
        value,
      });
    }

    return results;
  });

  const result = allocations.map((a) => ({
    assetClass: a.assetClass,
    value: parseDollar(a.value),
    percentTotal: parsePercent(a.percentTotal),
    dayChangePercent: parsePercent(a.dayChangePercent),
  }));

  console.log(`  📊 Found ${result.length} asset classes`);
  for (const a of result) {
    console.log(`    ${a.assetClass}: $${a.value.toLocaleString()} (${a.percentTotal}%)`);
  }

  return result;
}

// --- Performance scraper (from Investing > Performance page) ---

interface ScrapedPerformance {
  accountName: string;
  accountType: string | null;
  cashFlow: number;
  income: number;
  expense: number;
  priorDayPct: number | null;
  periodPct: number | null;
  balance: number;
}

async function scrapePerformance(page: Page): Promise<ScrapedPerformance[]> {
  console.log("\n📈 Scraping performance...");

  // Navigate to Investing > Performance
  const investingBtn = await page.$('button:has-text("Investing")');
  if (!investingBtn) {
    console.log("  ⚠️  Could not find Investing menu");
    return [];
  }
  await investingBtn.click();
  await page.waitForTimeout(500);

  const perfItem = await page.$('[data-testid="submenu-link-performance"]');
  if (!perfItem) {
    console.log("  ⚠️  Could not find Performance menu item");
    await page.keyboard.press("Escape");
    return [];
  }
  await perfItem.click();

  try {
    await page.waitForSelector('[role="grid"]', { timeout: 15000 });
  } catch {
    console.log("  ⚠️  Performance page didn't load");
    return [];
  }

  await page.waitForTimeout(1000);

  const performances = await page.evaluate(() => {
    const results: Array<{
      accountName: string;
      accountType: string | null;
      cashFlow: string;
      income: string;
      expense: string;
      priorDayPct: string;
      periodPct: string;
      balance: string;
    }> = [];

    const main = document.querySelector("main") || document;
    const rows = main.querySelectorAll(
      '[role="grid"] [role="rowgroup"]:last-child [role="row"]'
    );

    for (const row of rows) {
      const cells = row.querySelectorAll('[role="gridcell"]');
      if (cells.length < 8) continue;

      // Cell 1 has account info: institution name (h3) + account type (span)
      const acctCell = cells[1];
      const h3 = acctCell?.querySelector("h3");
      const institution = h3?.textContent?.trim() || "";
      const typeSpan = acctCell?.querySelector("span, div:not(:has(h3))");
      const accountType = typeSpan?.textContent?.trim() || null;

      const cashFlow = cells[2]?.textContent?.trim() || "$0";
      const income = cells[3]?.textContent?.trim() || "$0";
      const expense = cells[4]?.textContent?.trim() || "$0";
      const priorDayPct = cells[5]?.textContent?.trim() || "0";
      const periodPct = cells[6]?.textContent?.trim() || "0";
      const balance = cells[7]?.textContent?.trim() || "$0";

      if (!institution || institution === "Grand Total") continue;

      results.push({
        accountName: institution,
        accountType: accountType !== institution ? accountType : null,
        cashFlow,
        income,
        expense,
        priorDayPct,
        periodPct,
        balance,
      });
    }

    return results;
  });

  const result = performances.map((p) => ({
    accountName: p.accountName,
    accountType: p.accountType,
    cashFlow: parseDollar(p.cashFlow),
    income: parseDollar(p.income),
    expense: parseDollar(p.expense),
    priorDayPct: parsePercent(p.priorDayPct),
    periodPct: parsePercent(p.periodPct),
    balance: parseDollar(p.balance),
  }));

  console.log(`  📈 Found ${result.length} account performance records`);
  for (const p of result) {
    console.log(`    ${p.accountName}: ${p.periodPct >= 0 ? "+" : ""}${p.periodPct}% (90d) | $${p.balance.toLocaleString()}`);
  }

  return result;
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

    // Navigate back to dashboard before new scrapes
    if (!page.url().includes("dashboard/#/user/home")) {
      await page.click('a:has-text("Go to dashboard")').catch(async () => {
        await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
      });
      await page.waitForSelector('[id="networth-balance"]', { timeout: 15000 });
    }

    // Scrape transactions from Cash Flow page
    const transactions = await scrapeTransactions(page);
    for (const txn of transactions) {
      insertTransaction(snapshotId, {
        account_name: txn.accountName,
        date: txn.date,
        description: txn.description,
        category: txn.category,
        amount: txn.amount,
        tags: txn.tags,
      });
    }

    // Navigate back to dashboard
    await page.click('a:has-text("Go to dashboard")').catch(async () => {
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
    });
    await page.waitForSelector('[id="networth-balance"]', { timeout: 15000 });

    // Scrape allocations
    const allocations = await scrapeAllocations(page);
    for (const alloc of allocations) {
      insertAllocation(snapshotId, {
        asset_class: alloc.assetClass,
        value: alloc.value,
        percent_total: alloc.percentTotal,
        day_change_percent: alloc.dayChangePercent,
      });
    }

    // Navigate back to dashboard
    await page.click('a:has-text("Go to dashboard")').catch(async () => {
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
    });
    await page.waitForSelector('[id="networth-balance"]', { timeout: 15000 });

    // Scrape performance
    const performances = await scrapePerformance(page);
    for (const perf of performances) {
      insertPerformance(snapshotId, {
        account_name: perf.accountName,
        account_type: perf.accountType,
        cash_flow: perf.cashFlow,
        income: perf.income,
        expense: perf.expense,
        prior_day_pct: perf.priorDayPct,
        period_pct: perf.periodPct,
        balance: perf.balance,
        period_days: 90,
      });
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
