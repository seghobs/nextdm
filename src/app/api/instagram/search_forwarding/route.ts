import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { searchText, cookies, headers, data } = body;

    if (!searchText) {
      return NextResponse.json({
        success: true,
        users: [],
        threads: []
      });
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
      'x-fb-friendly-name': 'IGDForwardingSearchResultsListQuery',
      'referer': `https://www.instagram.com/direct/inbox/`,
    };

    // Construct variables object for IGDForwardingSearchResultsListQuery
    const variablesObj = {
      search_text: String(searchText)
    };

    // Form data payload for query
    const formBody = new URLSearchParams();
    
    const postDataFields = {
      ...DEFAULT_DATA,
      ...customData,
      'fb_api_req_friendly_name': 'IGDForwardingSearchResultsListQuery',
      'variables': JSON.stringify(variablesObj),
      'doc_id': '26976704625359269', // Forwarding search doc_id
    };

    Object.entries(postDataFields).forEach(([key, val]) => {
      formBody.append(key, String(val));
    });

    console.log(`Proxying IGDForwardingSearchResultsListQuery for text: "${searchText}"...`);

    const instagramResponse = await fetch('https://www.instagram.com/api/graphql', {
      method: 'POST',
      headers: headersToSend,
      body: formBody.toString(),
      redirect: 'manual',
    });

    const status = instagramResponse.status;

    if (status === 301 || status === 302 || status === 307 || status === 308) {
      console.warn('[SearchForwarding-API] Instagram redirected the request (likely login required).');
      return NextResponse.json({
        success: false,
        error: 'Oturumunuz sonlanmış veya geçersiz. Lütfen tekrar giriş yapın.',
        isLoginRequired: true
      }, { status: 401 });
    }

    const responseText = await instagramResponse.text();
    const sanitizedText = responseText.replace(/^for\s*\(;;\);/, '');

    if (!instagramResponse.ok) {
      console.error(`Instagram API returned non-OK status on search: ${status}`, responseText);
      return NextResponse.json({
        success: false,
        status,
        error: `Instagram API returned status ${status} on search`,
        details: responseText.slice(0, 500)
      }, { status: 400 });
    }

    // Extract any new cookies sent by Instagram
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

      // Self-healing: Check if we got error 1357004 (invalid or expired web tokens)
      if (jsonResponse?.error === 1357004) {
        console.warn('[SearchForwarding-API] Mismatched web tokens detected. Attempting self-healing...');
        
        const { scrapeTokens } = await import('@/lib/token-scraper');
        const { fbDtsg, lsd } = await scrapeTokens(cookieHeaderStr);
        
        if (fbDtsg || lsd) {
          console.log('[SearchForwarding-API] Successfully scraped fresh tokens. Retrying request...');
          
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

            const searchResults = retryJson.data?.xfb_combinedIGSearchQuery;

            return NextResponse.json({
              success: true,
              users: searchResults?.search_messenger_contact_v2 || [],
              threads: searchResults?.search_thread_metadata_v2 || [],
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
          error: 'Instagram returned GraphQL errors on search',
          details: jsonResponse.errors,
          cookies: updatedCookies
        }, { status: 200 });
      }

      const searchResults = jsonResponse.data?.xfb_combinedIGSearchQuery;

      return NextResponse.json({
        success: true,
        users: searchResults?.search_messenger_contact_v2 || [],
        threads: searchResults?.search_thread_metadata_v2 || [],
        cookies: updatedCookies
      });
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : 'Unknown parsing error';
      return NextResponse.json({
        success: false,
        error: 'Invalid JSON response from Instagram on search',
        details: responseText.slice(0, 1000),
        parseError: errorMsg
      }, { status: 502 });
    }

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown server error';
    console.error('Error in search forwarding proxy route:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: errorMsg
    }, { status: 500 });
  }
}
