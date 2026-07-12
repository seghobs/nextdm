import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { cookies, headers } = body;

    // Extract custom credentials or fallback to defaults
    const customCookies = cookies || DEFAULT_COOKIES;
    const customHeaders = headers || DEFAULT_HEADERS;

    // Convert cookies object into standard cookie header string
    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    const commonUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

    console.log('[Login-Activity-API] Fetching Accounts Center to scrape tokens...');
    
    // Step 1: Scrape fb_dtsg, lsd, and actorID from Accounts Center
    const acResponse = await fetch('https://accountscenter.instagram.com/password_and_security/?theme=dark', {
      headers: {
        'cookie': cookieHeaderStr,
        'user-agent': customHeaders['user-agent'] || commonUserAgent,
      },
      cache: 'no-store'
    });

    if (!acResponse.ok) {
      console.error('[Login-Activity-API] Failed to fetch Accounts Center homepage. Status:', acResponse.status);
      return NextResponse.json({
        success: false,
        error: `Accounts Center access failed with status ${acResponse.status}`
      }, { status: 400 });
    }

    const html = await acResponse.text();

    const dtsgMatch = html.match(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) || 
                       html.match(/"token"\s*:\s*"([^"]+)"/) ||
                       html.match(/"fb_dtsg"\s*,\s*"([^"]+)"/) ||
                       html.match(/"fb_dtsg"\s*:\s*"([^"]+)"/);
    const fbDtsg = dtsgMatch ? dtsgMatch[1] : '';

    const lsdMatch = html.match(/"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) || 
                     html.match(/"LSD"\s*:\s*"([^"]+)"/) ||
                     html.match(/"lsd"\s*:\s*"([^"]+)"/);
    const lsd = lsdMatch ? lsdMatch[1] : '';

    const actorMatch = html.match(/"actorID"\s*:\s*"([^"]+)"/) ||
                       html.match(/"userID"\s*:\s*"([^"]+)"/);
    const actorID = actorMatch ? actorMatch[1] : '';

    console.log('[Login-Activity-API] Scraped token status:', { fbDtsg: !!fbDtsg, lsd: !!lsd, actorID: actorID });

    if (!fbDtsg || !actorID) {
      console.warn('[Login-Activity-API] Failed to extract required tokens or actor ID.');
      return NextResponse.json({
        success: false,
        error: 'Oturumunuz sonlanmış veya geçersiz. Lütfen tekrar giriş yapın.',
        isLoginRequired: true
      }, { status: 401 });
    }

    // Step 2: Query 1 (Get internal account ID linked to Instagram)
    console.log('[Login-Activity-API] Querying Login Activities Start Root...');
    const form1 = new URLSearchParams();
    form1.append('av', actorID);
    form1.append('__user', '0');
    form1.append('__a', '1');
    form1.append('__req', 'z');
    form1.append('__hs', '20645.HYP:accounts_center_pkg.2.1...0');
    form1.append('__ccg', 'EXCELLENT');
    form1.append('__rev', '1043016926');
    form1.append('fb_dtsg', fbDtsg);
    form1.append('lsd', lsd);
    form1.append('fb_api_caller_class', 'RelayModern');
    form1.append('fb_api_req_friendly_name', 'FXAccountsCenterLoginActivitiesStartRootQuery');
    form1.append('server_timestamps', 'true');
    form1.append('variables', JSON.stringify({ interface: 'IG_WEB' }));
    form1.append('doc_id', '26011455941859192');

    const q1Res = await fetch('https://accountscenter.instagram.com/api/graphql/', {
      method: 'POST',
      headers: {
        'cookie': cookieHeaderStr,
        'user-agent': customHeaders['user-agent'] || commonUserAgent,
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://accountscenter.instagram.com',
        'referer': 'https://accountscenter.instagram.com/password_and_security/?theme=dark',
        'x-fb-friendly-name': 'FXAccountsCenterLoginActivitiesStartRootQuery',
        'x-fb-lsd': lsd,
        'x-ig-app-id': '936619743392459',
        'x-asbd-id': '359341',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
      body: form1.toString()
    });

    if (!q1Res.ok) {
      console.error('[Login-Activity-API] Query 1 returned status:', q1Res.status);
      return NextResponse.json({
        success: false,
        error: `GraphQL Query 1 failed with status ${q1Res.status}`
      }, { status: 400 });
    }

    const r1Text = await q1Res.text();
    const sanitizedR1Text = r1Text.replace(/^for\s*\(;;\);/, '');

    let r1Json;
    try {
      r1Json = JSON.parse(sanitizedR1Text);
    } catch (e) {
      console.error('[Login-Activity-API] Failed to parse Query 1 JSON');
      return NextResponse.json({
        success: false,
        error: 'Failed to parse accounts list response'
      }, { status: 500 });
    }

    if (r1Json.error || r1Json.errors) {
      console.error('[Login-Activity-API] Query 1 returned error response:', r1Json);
      return NextResponse.json({
        success: false,
        error: r1Json.error?.errorSummary || 'GraphQL Query 1 returned error response'
      }, { status: 400 });
    }

    const accounts = r1Json.data?.fxcal_settings?.node?.accounts_with_settings_v2 || [];
    if (accounts.length === 0) {
      console.warn('[Login-Activity-API] No accounts found linked in accounts_with_settings_v2.');
      return NextResponse.json({
        success: false,
        error: 'Hesap Merkezinde bağlı hesap bulunamadı.'
      }, { status: 404 });
    }

    const accountId = accounts[0].profile?.profile_identifier || accounts[0].profile?.id;
    console.log('[Login-Activity-API] Found account ID:', accountId);

    // Step 3: Query 2 (Get Login Sessions)
    console.log('[Login-Activity-API] Querying Device Login Activities Dialog...');
    const form2 = new URLSearchParams();
    form2.append('av', actorID);
    form2.append('__user', '0');
    form2.append('__a', '1');
    form2.append('__req', 'y');
    form2.append('__hs', '20645.HYP:accounts_center_pkg.2.1...0');
    form2.append('__ccg', 'EXCELLENT');
    form2.append('__rev', '1043016926');
    form2.append('fb_dtsg', fbDtsg);
    form2.append('lsd', lsd);
    form2.append('fb_api_caller_class', 'RelayModern');
    form2.append('fb_api_req_friendly_name', 'FXAccountsCenterDeviceLoginActivitiesDialogQuery');
    form2.append('server_timestamps', 'true');
    form2.append('variables', JSON.stringify({
      account_id: accountId,
      account_type: 'INSTAGRAM',
      interface: 'IG_WEB'
    }));
    form2.append('doc_id', '27067975882805325');

    const q2Res = await fetch('https://accountscenter.instagram.com/api/graphql/', {
      method: 'POST',
      headers: {
        'cookie': cookieHeaderStr,
        'user-agent': customHeaders['user-agent'] || commonUserAgent,
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://accountscenter.instagram.com',
        'referer': 'https://accountscenter.instagram.com/password_and_security/login_activity/?theme=dark',
        'x-fb-friendly-name': 'FXAccountsCenterDeviceLoginActivitiesDialogQuery',
        'x-fb-lsd': lsd,
        'x-ig-app-id': '936619743392459',
        'x-asbd-id': '359341',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
      body: form2.toString()
    });

    if (!q2Res.ok) {
      console.error('[Login-Activity-API] Query 2 returned status:', q2Res.status);
      return NextResponse.json({
        success: false,
        error: `GraphQL Query 2 failed with status ${q2Res.status}`
      }, { status: 400 });
    }

    const r2Text = await q2Res.text();
    const sanitizedR2Text = r2Text.replace(/^for\s*\(;;\);/, '');

    let r2Json;
    try {
      r2Json = JSON.parse(sanitizedR2Text);
    } catch (e) {
      console.error('[Login-Activity-API] Failed to parse Query 2 JSON');
      return NextResponse.json({
        success: false,
        error: 'Failed to parse login activities response'
      }, { status: 500 });
    }

    const sessions = r2Json.data?.fxcal_settings?.node?.sessions_data_v2 || [];
    console.log('[Login-Activity-API] Login sessions fetched successfully. Count:', sessions.length);

    return NextResponse.json({
      success: true,
      sessions
    });

  } catch (err: any) {
    console.error('[Login-Activity-API] Error:', err);
    return NextResponse.json({
      success: false,
      error: err.message || 'Bir iç hata oluştu'
    }, { status: 500 });
  }
}
