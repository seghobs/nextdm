import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS } from '@/lib/instagram-defaults';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function mediaIdToShortcode(mediaIdStr: string): string {
  const cleanId = mediaIdStr.split('_')[0];
  try {
    let id = BigInt(cleanId);
    let shortcode = '';
    while (id > BigInt(0)) {
      const remainder = Number(id % BigInt(64));
      shortcode = ALPHABET[remainder] + shortcode;
      id = id / BigInt(64);
    }
    return shortcode;
  } catch (e) {
    console.error('[mediaIdToShortcode] Error converting media ID:', e);
    return mediaIdStr;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { mediaId, shortcode, cookies, headers } = body;

    if (!mediaId) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameter: mediaId'
      }, { status: 400 });
    }

    const customCookies = cookies || DEFAULT_COOKIES;
    const customHeaders = headers || DEFAULT_HEADERS;

    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    const headersToSend: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'content-type': 'application/json',
      'accept': '*/*',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    };

    // 0. Pre-check post details first by visiting the web page to verify the like count naturally
    let likeCount = 0;
    const shortcodeToUse = shortcode || mediaIdToShortcode(mediaId);

    try {
      console.log(`[Likers-API] Pre-checking like count naturally via web page for shortcode: ${shortcodeToUse}`);
      const pageUrl = `https://www.instagram.com/p/${shortcodeToUse}/`;
      
      const pageRes = await fetch(pageUrl, {
        method: 'GET',
        headers: {
          ...DEFAULT_HEADERS,
          ...customHeaders,
          'cookie': cookieHeaderStr,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        cache: 'no-store',
        redirect: 'manual'
      });

      if (pageRes.ok) {
        const html = await pageRes.text();
        
        // Extract like count from raw JSON pattern inside html
        const likeCountMatch = html.match(/"like_count"\s*:\s*(\d+)/i);
        if (likeCountMatch) {
          likeCount = parseInt(likeCountMatch[1], 10);
          console.log(`[Likers-API] Extracted like count from HTML JSON: ${likeCount}`);
        } else {
          // Fallback to og:description meta tag parsing
          const ogDescMatch = html.match(/<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
                             html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:description["']/i);
          if (ogDescMatch) {
            const desc = ogDescMatch[1];
            const likesMatch = desc.match(/^([\d.,]+)\s*(?:likes|beğenme|beğeni)/i) || desc.match(/^([\d.,]+)\s*/i);
            if (likesMatch) {
              const cleanNum = likesMatch[1].replace(/[,.]/g, '');
              likeCount = parseInt(cleanNum, 10) || 0;
              console.log(`[Likers-API] Extracted like count from og:description: ${likeCount}`);
            }
          }
        }
      } else {
        console.warn(`[Likers-API] Web page precheck returned status ${pageRes.status}`);
      }
    } catch (e) {
      console.warn('[Likers-API] Failed to precheck like count naturally, continuing...', e);
    }

    if (likeCount > 90) {
      console.warn(`[Likers-API] Blocked likes fetch: Post has ${likeCount} likes (> 90).`);
      return NextResponse.json({
        success: false,
        error: `Bu gönderi 90'dan fazla beğeni aldığı için (${likeCount} beğeni) güvenlik amacıyla kontrol edilmedi.`,
        likeCount
      });
    }

    // 1. Simulate the browser's bootloader request for safety (downloading the Likes List UI module)
    try {
      const bootloaderUrl = `https://www.instagram.com/ajax/bootloader-endpoint/?modules=PolarisLikedByListContainer.react&__d=www&__user=0&__a=1`;
      console.log(`[Likers-API] Simulating browser bootloader module load...`);
      await fetch(bootloaderUrl, {
        method: 'GET',
        headers: headersToSend,
        cache: 'no-store',
      }).catch(() => {});
    } catch (e) {
      console.warn('[Likers-API] Bootloader simulation failed, continuing to likers list...');
    }

    // 2. Fetch the actual likers list
    const url = `https://www.instagram.com/api/v1/media/${mediaId}/likers/`;
    console.log(`[Likers-API] Fetching likers for media: ${mediaId}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: headersToSend,
      cache: 'no-store',
      redirect: 'manual',
    });

    const status = response.status;

    if (status === 301 || status === 302 || status === 307 || status === 308) {
      return NextResponse.json({
        success: false,
        error: 'Oturumunuz sonlanmış veya geçersiz. Lütfen tekrar giriş yapın.',
        isLoginRequired: true
      }, { status: 401 });
    }

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`[Likers-API] Instagram returned error status ${status}:`, responseText.slice(0, 500));
      return NextResponse.json({
        success: false,
        status,
        error: `Instagram API returned status ${status}`,
        details: responseText.slice(0, 500)
      }, { status: 400 });
    }

    const json = JSON.parse(responseText);
    const usersList = json.users || [];
    
    const likers = usersList.map((u: any) => ({
      username: u.username || 'unknown',
      fullName: u.full_name || '',
      profilePicUrl: u.profile_pic_url || '',
    }));

    return NextResponse.json({
      success: true,
      likers
    });

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown server error';
    console.error('[Likers-API] Error fetching likers:', err);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: errorMsg
    }, { status: 500 });
  }
}
