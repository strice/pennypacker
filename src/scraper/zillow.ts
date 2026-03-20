/**
 * Zillow Zestimate scraper
 *
 * Fetches the current Zestimate for a property by scraping the Zillow property page.
 * No API key needed — just the property URL.
 */

const ZILLOW_URL = process.env.ZILLOW_PROPERTY_URL;

export interface ZillowResult {
  address: string;
  zestimate: number;
  url: string;
}

export async function scrapeZillow(): Promise<ZillowResult | null> {
  if (!ZILLOW_URL) {
    console.log("  ℹ️  No ZILLOW_PROPERTY_URL set, skipping home value update");
    return null;
  }

  console.log(`\n🏠 Fetching Zillow Zestimate...`);
  console.log(`  🔗 ${ZILLOW_URL}`);

  try {
    // Fetch the page with a browser-like user agent
    const response = await fetch(ZILLOW_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      console.log(`  ⚠️  Zillow returned ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Zillow embeds property data in a JSON-LD script or in __NEXT_DATA__
    // Try JSON-LD first
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (jsonLdMatch) {
      try {
        const data = JSON.parse(jsonLdMatch[1]);
        // Could be an array
        const item = Array.isArray(data) ? data.find((d: any) => d["@type"] === "SingleFamilyResidence" || d["@type"] === "Product") : data;
        if (item?.offers?.price) {
          const result = {
            address: item.name || item.address?.streetAddress || "Unknown",
            zestimate: parseFloat(item.offers.price),
            url: ZILLOW_URL,
          };
          console.log(`  🏠 ${result.address}: $${result.zestimate.toLocaleString()}`);
          return result;
        }
      } catch {
        // JSON-LD parse failed, try other methods
      }
    }

    // Try __NEXT_DATA__ pattern
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        const property = data?.props?.pageProps?.componentProps?.gdpClientCache;
        if (property) {
          // The cache is keyed by zpid, find first entry
          const firstKey = Object.keys(property)[0];
          const propData = JSON.parse(property[firstKey]);
          const zestimate = propData?.property?.zestimate;
          const address = propData?.property?.address?.streetAddress;
          if (zestimate) {
            const result = { address: address || "Unknown", zestimate, url: ZILLOW_URL };
            console.log(`  🏠 ${result.address}: $${result.zestimate.toLocaleString()}`);
            return result;
          }
        }
      } catch {
        // __NEXT_DATA__ parse failed
      }
    }

    // Fallback: regex for Zestimate in the HTML
    const zestimateMatch = html.match(/\$[\d,]+(?=<\/span>[\s\S]*?Zestimate)/i)
      || html.match(/"zestimate"\s*:\s*(\d+)/);

    if (zestimateMatch) {
      const valueStr = zestimateMatch[1] || zestimateMatch[0];
      const value = parseFloat(valueStr.replace(/[^0-9]/g, ""));
      if (value > 10000) { // sanity check
        const result = { address: "Home", zestimate: value, url: ZILLOW_URL };
        console.log(`  🏠 Zestimate: $${result.zestimate.toLocaleString()}`);
        return result;
      }
    }

    console.log("  ⚠️  Could not parse Zestimate from Zillow page");
    console.log(`  📄 Page length: ${html.length} chars`);
    return null;

  } catch (err) {
    console.log(`  ⚠️  Zillow fetch failed: ${err}`);
    return null;
  }
}
