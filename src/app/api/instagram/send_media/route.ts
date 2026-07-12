import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { attachmentFbid, threadId, cookies, headers, data } = body;

    // Validate parameters
    if (!attachmentFbid || !threadId) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: attachmentFbid or threadId'
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

    // Setup request headers
    const headersToSend: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'content-type': 'application/x-www-form-urlencoded',
      'x-fb-friendly-name': 'IGDirectMediaSendMutation',
      'referer': `https://www.instagram.com/direct/inbox/`,
    };

    // Generate a unique offline threading ID (random 19-digit number)
    const generateOfflineThreadingId = () => {
      let id = '';
      for (let i = 0; i < 19; i++) {
        id += Math.floor(Math.random() * 10).toString();
      }
      return id;
    };

    const offlineThreadingId = generateOfflineThreadingId();

    // Construct variables object for IGDirectMediaSendMutation
    const variablesObj = {
      attachment_fbid: String(attachmentFbid),
      thread_id: String(threadId),
      offline_threading_id: offlineThreadingId,
      reply_to_message_id: null,
      forwarded_from_thread_id: null,
      is_forwarded_from_own_message: null
    };

    // Form data payload for mutation
    const formBody = new URLSearchParams();
    
    // Merge post-data form variables
    const postDataFields = {
      ...DEFAULT_DATA,
      ...customData,
      'fb_api_req_friendly_name': 'IGDirectMediaSendMutation',
      'variables': JSON.stringify(variablesObj),
      'doc_id': '25766288509716264', // Media send mutation doc_id
    };

    Object.entries(postDataFields).forEach(([key, val]) => {
      formBody.append(key, String(val));
    });

    console.log(`Proxying IGDirectMediaSendMutation for threadId: ${threadId}, attachmentFbid: ${attachmentFbid}...`);

    const instagramResponse = await fetch('https://www.instagram.com/api/graphql', {
      method: 'POST',
      headers: headersToSend,
      body: formBody.toString(),
      redirect: 'manual',
    });

    const status = instagramResponse.status;

    if (status === 301 || status === 302 || status === 307 || status === 308) {
      console.warn('[SendMedia-API] Instagram redirected the request (likely login required).');
      return NextResponse.json({
        success: false,
        error: 'Oturumunuz sonlanmış veya geçersiz. Lütfen tekrar giriş yapın.',
        isLoginRequired: true
      }, { status: 401 });
    }

    const responseText = await instagramResponse.text();
    const sanitizedText = responseText.replace(/^for\s*\(;;\);/, '');

    if (!instagramResponse.ok) {
      console.error(`Instagram API returned non-OK status on send media: ${status}`, responseText);
      return NextResponse.json({
        success: false,
        status,
        error: `Instagram API returned status ${status} on send media`,
        details: responseText.slice(0, 500)
      }, { status: 400 });
    }

    // Extract set-cookies
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

    try {
      const jsonResponse = JSON.parse(sanitizedText);

      // Self-healing: Check if we got error 1357004
      if (jsonResponse?.error === 1357004) {
        console.warn('[SendMedia-API] Mismatched web tokens detected. Attempting self-healing...');
        
        const { scrapeTokens } = await import('@/lib/token-scraper');
        const { fbDtsg, lsd } = await scrapeTokens(cookieHeaderStr);
        
        if (fbDtsg || lsd) {
          console.log('[SendMedia-API] Successfully scraped fresh tokens. Retrying request...');
          
          const healedData = {
            ...customData,
            ...(fbDtsg ? { fb_dtsg: fbDtsg } : {}),
            ...(lsd ? { lsd } : {})
          };

          const healedPostFields = {
            ...postDataFields,
            ...healedData
          };

          const healedFormBody = new URLSearchParams();
          Object.entries(healedPostFields).forEach(([key, val]) => {
            healedFormBody.append(key, String(val));
          });

          const healedHeaders = {
            ...headersToSend,
            ...(lsd ? { 'x-fb-lsd': lsd } : {})
          };

          const retryResponse = await fetch('https://www.instagram.com/api/graphql', {
            method: 'POST',
            headers: healedHeaders,
            body: healedFormBody.toString(),
            cache: 'no-store',
            redirect: 'manual'
          });

          if (retryResponse.ok) {
            const retryText = await retryResponse.text();
            const sanitizedRetryText = retryText.replace(/^for\s*\(;;\);/, '');
            const retryJson = JSON.parse(sanitizedRetryText);

            const retrySetCookieHeaders = retryResponse.headers.getSetCookie();
            const retryUpdatedCookies: Record<string, string> = { ...updatedCookies };
            if (retrySetCookieHeaders && retrySetCookieHeaders.length > 0) {
              retrySetCookieHeaders.forEach(cookieStr => {
                const parts = cookieStr.split(';')[0].split('=');
                if (parts.length >= 2) {
                  const name = parts[0].trim();
                  const val = parts.slice(1).join('=').trim();
                  retryUpdatedCookies[name] = val;
                }
              });
            }

            return NextResponse.json({
              success: true,
              data: retryJson.data,
              cookies: Object.keys(retryUpdatedCookies).length > 0 ? retryUpdatedCookies : undefined,
              postData: healedData,
              headers: {
                ...customHeaders,
                ...(lsd ? { 'x-fb-lsd': lsd } : {})
              }
            });
          }
        }
      }

      if (jsonResponse.errors) {
        return NextResponse.json({
          success: false,
          error: 'Instagram returned GraphQL errors on send media',
          details: jsonResponse.errors,
          cookies: updatedCookies
        }, { status: 200 });
      }

      return NextResponse.json({
        success: true,
        data: jsonResponse.data,
        cookies: updatedCookies
      });
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : 'Unknown parsing error';
      return NextResponse.json({
        success: false,
        error: 'Invalid JSON response from Instagram on send media',
        details: responseText.slice(0, 1000),
        parseError: errorMsg
      }, { status: 502 });
    }

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown server error';
    console.error('Error in send media proxy route:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: errorMsg
    }, { status: 500 });
  }
}
