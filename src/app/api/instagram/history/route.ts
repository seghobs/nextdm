import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';
import { syncActiveSettings } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { threadId, cursor, cookies, headers } = body;

    if (!threadId) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameter: threadId'
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
    };

    // Construct URL with optional cursor parameter for pagination
    let url = `https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/`;
    if (cursor) {
      url += `?cursor=${cursor}`;
    }

    console.log(`[API-History] Fetching history from: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: headersToSend,
      cache: 'no-store',
      redirect: 'manual',
    });

    const status = response.status;

    if (status === 301 || status === 302 || status === 307 || status === 308) {
      console.warn('[History-API] Instagram redirected the request (likely login required).');
      return NextResponse.json({
        success: false,
        error: 'Oturumunuz sonlanmış veya geçersiz. Lütfen tekrar giriş yapın.',
        isLoginRequired: true
      }, { status: 401 });
    }

    const responseText = await response.text();

    // Extract any new cookies sent by Instagram (e.g. updated rur)
    const setCookieHeaders = response.headers.getSetCookie();
    const updatedCookies: Record<string, string> = {};
    if (setCookieHeaders && setCookieHeaders.length > 0) {
      setCookieHeaders.forEach(cookieStr => {
        const parts = cookieStr.split(';')[0].split('=');
        if (parts.length >= 2) {
          const name = parts[0].trim();
          const val = parts.slice(1).join('=').trim();
          updatedCookies[name] = val;
        }
      });
    }

    if (!response.ok) {
      console.error(`[API-History] Instagram returned error status ${status}:`, responseText.slice(0, 500));
      return NextResponse.json({
        success: false,
        status,
        error: `Instagram API returned status ${status}`,
        details: responseText.slice(0, 500),
        cookies: updatedCookies
      }, { status: 400 });
    }

    const json = JSON.parse(responseText);
    const thread = json.thread || {};

    // Sync active session credentials to database for background tasks
    try {
      const mergedCookies = { ...customCookies, ...updatedCookies };
      syncActiveSettings(mergedCookies, customHeaders);
    } catch (dbSyncErr) {
      console.error('[History-API] Failed to sync session database:', dbSyncErr);
    }

    return NextResponse.json({
      success: true,
      hasOlder: thread.has_older ?? false,
      oldestCursor: thread.oldest_cursor || null,
      items: thread.items || [],
      users: thread.users || [],
      admin_user_ids: thread.admin_user_ids || [],
      last_seen_at: thread.last_seen_at || null,
      cookies: updatedCookies
    });

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown server error';
    console.error('[API-History] Error in proxy route:', err);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: errorMsg
    }, { status: 500 });
  }
}
