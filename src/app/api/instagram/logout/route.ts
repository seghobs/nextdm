import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { cookies, headers, data } = body;

    const customCookies = cookies || DEFAULT_COOKIES;
    const customHeaders = headers || DEFAULT_HEADERS;
    const customData = data || DEFAULT_DATA;

    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    const userId = customCookies.ds_user_id || '';
    const fbDtsg = customData.fb_dtsg || '';
    const csrftoken = customCookies.csrftoken || customHeaders['x-csrftoken'] || '';

    const formBody = new URLSearchParams();
    formBody.append('one_tap_app_login', '0');
    formBody.append('user_id', String(userId));
    formBody.append('jazoest', '22801');
    formBody.append('fb_dtsg', String(fbDtsg));

    console.log('[Logout-API] Sending logout request to Instagram for user:', userId);

    const instagramResponse = await fetch('https://www.instagram.com/api/v1/web/accounts/logout/ajax/', {
      method: 'POST',
      headers: {
        'cookie': cookieHeaderStr,
        'x-csrftoken': csrftoken,
        'x-ig-app-id': customHeaders['x-ig-app-id'] || '936619743392459',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': customHeaders['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'origin': 'https://www.instagram.com',
        'referer': 'https://www.instagram.com/',
      },
      body: formBody.toString(),
      redirect: 'manual'
    });

    const status = instagramResponse.status;
    const responseText = await instagramResponse.text();

    console.log('[Logout-API] Instagram logout response status:', status, 'body:', responseText);

    return NextResponse.json({
      success: true,
      status,
      details: responseText.slice(0, 200)
    });

  } catch (error: any) {
    console.error('[Logout-API] Error during logout proxy:', error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Internal Server Error'
    }, { status: 500 });
  }
}
