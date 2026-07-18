/**
 * Helper utility to scrape fresh fb_dtsg and lsd tokens from Instagram web homepage.
 */
export interface ScrapedTokens {
  fbDtsg: string;
  lsd: string;
}

// Global cached variables persisting across requests
let cachedTokens: ScrapedTokens | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL

// In-flight promise to handle concurrent stampedes
let activeScrapePromise: Promise<ScrapedTokens> | null = null;

export async function scrapeTokens(cookieHeaderStr: string): Promise<ScrapedTokens> {
  const now = Date.now();
  
  // 1. If we have fresh cached tokens, return them instantly
  if (cachedTokens && (now - cacheTimestamp < CACHE_TTL_MS) && cachedTokens.fbDtsg && cachedTokens.lsd) {
    return cachedTokens;
  }

  // 2. If a scrape is already in progress, reuse its promise to prevent duplicate requests
  if (activeScrapePromise) {
    console.log('[Token-Scraper] Concurrent request detected. Reusing in-flight scraping promise...');
    return activeScrapePromise;
  }

  // 3. Start a new single-flight scrape promise
  activeScrapePromise = (async () => {
    let fbDtsg = '';
    let lsd = '';
    try {
      console.log('[Token-Scraper] Fetching Instagram homepage to extract DTSG/LSD...');
      const response = await fetch('https://www.instagram.com/', {
        headers: {
          'cookie': cookieHeaderStr,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
        },
        cache: 'no-store'
      });
      
      if (response.ok) {
        const html = await response.text();
        
        const dtsgMatch = html.match(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) || html.match(/"token"\s*:\s*"([^"]+)"/);
        if (dtsgMatch) {
          fbDtsg = dtsgMatch[1];
        }
        
        const lsdMatch = html.match(/"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) || html.match(/"lsd"\s*:\s*"([^"]+)"/);
        if (lsdMatch) {
          lsd = lsdMatch[1];
        }
        
        console.log('[Token-Scraper] Successfully extracted fb_dtsg and lsd:', { fbDtsg: !!fbDtsg, lsd: !!lsd });
        
        // Cache the result
        if (fbDtsg && lsd) {
          cachedTokens = { fbDtsg, lsd };
          cacheTimestamp = Date.now();
        }
      } else {
        console.warn('[Token-Scraper] Failed to fetch homepage. Status:', response.status);
      }
    } catch (e) {
      console.error('[Token-Scraper] Error scraping tokens:', e);
    } finally {
      // Clear the in-flight promise reference when done
      activeScrapePromise = null;
    }
    return { fbDtsg, lsd };
  })();

  return activeScrapePromise;
}
