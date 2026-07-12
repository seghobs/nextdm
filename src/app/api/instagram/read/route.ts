import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { threadId, messageId, timestampMs, cookies, headers, data } = body;

    // Validate parameters
    if (!threadId || !messageId) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: threadId or messageId'
      }, { status: 400 });
    }

    // Extract custom credentials or fallback to defaults
    const customCookies = cookies || DEFAULT_COOKIES;
    const customHeaders = headers || DEFAULT_HEADERS;
    const customData = data || DEFAULT_DATA;

    // Convert cookies object into standard cookie header string
    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    // 1. Setup request headers for both mutations
    const baseHeaders: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'content-type': 'application/x-www-form-urlencoded',
    };

    // 2. Variables for useIGDMarkThreadAsReadValidationMutation
    const validationVariables = {
      metadata: {
        ig_thread_igid: threadId
      },
      data: {
        message_id: messageId,
        message_timestamp_ms: timestampMs || String(Date.now())
      }
    };

    // 3. Variables for useIGDMarkThreadAsReadMutation
    const markReadVariables = {
      metadata: {
        ig_thread_igid: threadId
      },
      data: {
        item_id: '',
        message_id: messageId
      }
    };

    // 4. Create payloads
    const validationForm = new URLSearchParams();
    Object.entries({
      ...DEFAULT_DATA,
      ...customData,
      'fb_api_req_friendly_name': 'useIGDMarkThreadAsReadValidationMutation',
      'variables': JSON.stringify(validationVariables),
      'doc_id': '35211594988486314'
    }).forEach(([key, val]) => {
      validationForm.append(key, String(val));
    });

    const markReadForm = new URLSearchParams();
    Object.entries({
      ...DEFAULT_DATA,
      ...customData,
      'fb_api_req_friendly_name': 'useIGDMarkThreadAsReadMutation',
      'variables': JSON.stringify(markReadVariables),
      'doc_id': '27356881703909995'
    }).forEach(([key, val]) => {
      markReadForm.append(key, String(val));
    });

    console.log(`Sending mark-as-read mutations to thread ID ${threadId} for message ${messageId}...`);

    // Run both mutations in parallel to optimize response speed
    const [validationRes, markReadRes] = await Promise.all([
      fetch('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'x-fb-friendly-name': 'useIGDMarkThreadAsReadValidationMutation',
        },
        body: validationForm.toString(),
        redirect: 'manual',
      }),
      fetch('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'x-fb-friendly-name': 'useIGDMarkThreadAsReadMutation',
        },
        body: markReadForm.toString(),
        redirect: 'manual',
      })
    ]);

    const validationStatus = validationRes.status;
    const markReadStatus = markReadRes.status;

    if (validationStatus === 301 || validationStatus === 302 || markReadStatus === 301 || markReadStatus === 302) {
      console.warn('[Read-API] Instagram redirected the request (likely login required).');
      return NextResponse.json({
        success: false,
        error: 'Oturumunuz sonlanmış veya geçersiz. Lütfen tekrar giriş yapın.',
        isLoginRequired: true
      }, { status: 401 });
    }

    const validationOk = validationRes.ok;
    const markReadOk = markReadRes.ok;

    const validationText = await validationRes.text();
    const markReadText = await markReadRes.text();

    // Extract any new cookies sent by Instagram (e.g. updated rur) from both responses
    const updatedCookies: Record<string, string> = {};
    [validationRes, markReadRes].forEach(res => {
      const setCookieHeaders = res.headers.getSetCookie();
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
    });

    if (!validationOk || !markReadOk) {
      console.error('Failed to mark thread as read on Instagram API:', {
        validationStatus: validationRes.status,
        markReadStatus: markReadRes.status,
        validationText: validationText.slice(0, 200),
        markReadText: markReadText.slice(0, 200)
      });

      return NextResponse.json({
        success: false,
        error: 'Instagram API returned error status on read mutation',
        details: { validationText: validationText.slice(0, 300), markReadText: markReadText.slice(0, 300) },
        cookies: updatedCookies
      }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: 'Thread successfully marked as read',
      cookies: updatedCookies
    });

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown server error';
    console.error('Error in mark read proxy route:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: errorMsg
    }, { status: 500 });
  }
}
