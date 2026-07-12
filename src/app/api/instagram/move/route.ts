import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { threadId, folder, cookies, headers } = body;

    // Validate parameters
    if (!threadId || folder === undefined) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: threadId or folder'
      }, { status: 400 });
    }

    // Convert folder keyword ('primary'/'general') to Instagram REST numeric values (0/1)
    let folderValue = String(folder);
    if (folderValue === 'primary') folderValue = '0';
    else if (folderValue === 'general') folderValue = '1';

    // Extract custom credentials or fallback to defaults
    const customCookies = cookies || DEFAULT_COOKIES;
    const customHeaders = headers || DEFAULT_HEADERS;

    // Convert cookies object into standard cookie header string
    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    // Setup request headers
    const headersToSend: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'content-type': 'application/x-www-form-urlencoded',
      'referer': `https://www.instagram.com/direct/t/${threadId}/`,
    };

    // Construct form body
    const formBody = new URLSearchParams();
    formBody.append('folder', folderValue);

    const url = `https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/move/`;
    console.log(`Moving thread ${threadId} to folder ${folderValue} (URL: ${url})...`);

    const instagramResponse = await fetch(url, {
      method: 'POST',
      headers: headersToSend,
      body: formBody.toString(),
      redirect: 'manual',
    });

    const status = instagramResponse.status;

    if (status === 301 || status === 302 || status === 307 || status === 308) {
      console.warn('[Move-API] Instagram redirected the request (likely login required).');
      return NextResponse.json({
        success: false,
        error: 'Oturumunuz sonlanmış veya geçersiz. Lütfen tekrar giriş yapın.',
        isLoginRequired: true
      }, { status: 401 });
    }

    const responseText = await instagramResponse.text();

    if (!instagramResponse.ok) {
      console.error(`Instagram API returned non-OK status on move: ${status}`, responseText);
      return NextResponse.json({
        success: false,
        status,
        error: `Instagram API returned status ${status} on thread move`,
        details: responseText.slice(0, 500)
      }, { status: 400 });
    }

    // Extract any new cookies sent by Instagram (e.g. updated rur)
    const setCookieHeaders = instagramResponse.headers.getSetCookie();
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

    console.log(`Thread ${threadId} successfully moved to folder ${folderValue}!`);

    return NextResponse.json({
      success: true,
      message: 'Thread folder successfully updated',
      cookies: Object.keys(updatedCookies).length > 0 ? updatedCookies : undefined
    });

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown server error';
    console.error('Error in move thread proxy route:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: errorMsg
    }, { status: 500 });
  }
}
