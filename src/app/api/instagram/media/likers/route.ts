import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { mediaId, cookies, headers } = body;

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

    // 0. Pre-check post details first to verify the like count and prevent spam blocks
    let likeCount = 0;
    try {
      console.log(`[Likers-API] Pre-checking like count for media: ${mediaId}`);
      const infoUrl = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;
      const infoRes = await fetch(infoUrl, {
        method: 'GET',
        headers: headersToSend,
        cache: 'no-store'
      });
      if (infoRes.ok) {
        const infoJson = await infoRes.json();
        const item = infoJson.items?.[0] || {};
        likeCount = item.like_count || 0;
        console.log(`[Likers-API] Pre-checked like count: ${likeCount}`);
      }
    } catch (e) {
      console.warn('[Likers-API] Failed to precheck like count, continuing...', e);
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
