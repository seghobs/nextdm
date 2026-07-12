/**
 * Helper utility to scrape fresh fb_dtsg and lsd tokens from Instagram web homepage.
 */
export interface ScrapedTokens {
  fbDtsg: string;
  lsd: string;
}

export async function scrapeTokens(cookieHeaderStr: string): Promise<ScrapedTokens> {
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
    } else {
      console.warn('[Token-Scraper] Failed to fetch homepage. Status:', response.status);
    }
  } catch (e) {
    console.error('[Token-Scraper] Error scraping tokens:', e);
  }
  return { fbDtsg, lsd };
}
