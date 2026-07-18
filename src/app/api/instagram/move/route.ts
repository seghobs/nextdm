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

    if (body.isPending) {
      console.log(`Approving pending thread ${threadId} via GraphQL mutation...`);
      const { scrapeTokens } = await import('@/lib/token-scraper');
      const tokens = await scrapeTokens(cookieHeaderStr);
      const fbDtsg = tokens.fbDtsg || '';
      const lsdToken = tokens.lsd || '';

      const offlineThreadingId = String(Math.floor(Math.random() * 9000000000000000) + 1000000000000000) + String(Math.floor(Math.random() * 1000));

      const variables = {
        ig_inbox_folder: 'PRIMARY',
        offline_threading_id: offlineThreadingId,
        thread_fbid: threadId
      };

      const form = new URLSearchParams();
      const formPayload: Record<string, string> = {
        'av': String(customCookies['ds_user_id'] || '0'),
        '__d': 'www',
        '__user': '0',
        '__a': '1',
        '__req': '1',
        '__hs': '20648.HYP:instagram_web_pkg.2.1...0',
        'dpr': '1',
        '__ccg': 'GOOD',
        '__rev': '1043126676',
        'fb_api_caller_class': 'RelayModern',
        'fb_api_req_friendly_name': 'useIGDirectAcceptMessageRequestMutation',
        'variables': JSON.stringify(variables),
        'doc_id': '36571001125823973',
        ...(fbDtsg ? { fb_dtsg: fbDtsg } : {}),
        ...(lsdToken ? { lsd: lsdToken } : {})
      };

      Object.entries(formPayload).forEach(([k, v]) => form.append(k, v));

      const res = await fetch('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: {
          ...DEFAULT_HEADERS,
          ...customHeaders,
          'x-fb-friendly-name': 'useIGDirectAcceptMessageRequestMutation',
          'cookie': cookieHeaderStr,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
      });

      const responseText = await res.text();
      if (!res.ok) {
        console.error(`Instagram GraphQL returned non-ok status on accept: ${res.status}`, responseText);
        return NextResponse.json({
          success: false,
          error: `Instagram GraphQL returned status ${res.status} on accept`,
          details: responseText.slice(0, 500)
        }, { status: 400 });
      }

      const responseJson = JSON.parse(responseText);
      if (responseJson.errors) {
        console.error(`GraphQL mutation returned errors on accept:`, responseJson.errors);
        return NextResponse.json({
          success: false,
          error: 'Instagram returned GraphQL errors on accept',
          details: responseJson.errors
        }, { status: 200 });
      }

      // Extract any new cookies sent by Instagram (e.g. updated rur)
      const setCookieHeaders = res.headers.getSetCookie();
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

      console.log(`Thread ${threadId} successfully approved/accepted!`);
      
      // Trigger instant seen/AI response check
      const { runBackgroundAutoSeen } = await import('@/lib/automation-engine');
      runBackgroundAutoSeen(true, threadId).catch(err => {
        console.error(`[Move-API] Failed to trigger seen check for approved thread:`, err);
      });

      return NextResponse.json({
        success: true,
        message: 'Thread folder successfully updated',
        cookies: Object.keys(updatedCookies).length > 0 ? updatedCookies : undefined
      });
    }

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

    // If moved to primary (folderValue === '0'), trigger instant seen/AI response check
    if (folderValue === '0') {
      const { runBackgroundAutoSeen } = await import('@/lib/automation-engine');
      runBackgroundAutoSeen(true, threadId).catch(err => {
        console.error(`[Move-API] Failed to trigger seen check:`, err);
      });
    }

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
