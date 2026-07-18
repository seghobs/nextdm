import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    
    // Extract custom credentials sent from client settings, or fallback to defaults
    const customCookies = body.cookies || DEFAULT_COOKIES;
    const customHeaders = body.headers || DEFAULT_HEADERS;
    const customData = body.data || DEFAULT_DATA;

    const folder = body.folder || 'PRIMARY';
    const isPending = folder === 'PENDING';

    // Convert cookies object into standard cookie header string
    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    // Merge default and custom headers, and set the Cookie header
    const headersToSend: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'content-type': 'application/x-www-form-urlencoded',
      'x-fb-friendly-name': isPending ? 'PolarisDirectMessageRequestQuery' : (customHeaders['x-fb-friendly-name'] || DEFAULT_HEADERS['x-fb-friendly-name'] || 'PolarisDirectInboxMobileQuery'),
    };

    // Parse and override the ig_inbox_folder variable inside variables JSON
    const mergedData = { 
      ...DEFAULT_DATA, 
      ...customData,
      fb_api_req_friendly_name: isPending ? 'PolarisDirectMessageRequestQuery' : 'PolarisDirectInboxMobileQuery',
      doc_id: isPending ? '27512223021750545' : '27307632732226966'
    };

    try {
      let variablesObj: Record<string, any> = {};
      if (isPending) {
        let deviceId = '2f285675-f0b4-480c-8bec-51ae03541c51';
        if (customData.variables) {
          try {
            const customVars = JSON.parse(customData.variables);
            if (customVars.device_id_for_iris_subscription) {
              deviceId = customVars.device_id_for_iris_subscription;
            }
          } catch (e) {}
        }
        variablesObj = {
          device_id_for_iris_subscription: deviceId,
          __relay_internal__pv__IGD30DayAgoTimestampMsrelayprovider: String(Date.now() - 30 * 24 * 60 * 60 * 1000),
          __relay_internal__pv__IGDPinnedThreadsRenderEnabledGKrelayprovider: true,
          __relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider: 5,
          __relay_internal__pv__PolarisAIGMAccountLabelEnabledrelayprovider: false,
          __relay_internal__pv__IGDThreadListActionsEnabledGKrelayprovider: true
        };
      } else {
        variablesObj = JSON.parse(DEFAULT_DATA.variables || '{}');
        if (customData.variables) {
          try {
            const customVars = JSON.parse(customData.variables);
            if (customVars.device_id_for_iris_subscription) {
              variablesObj.device_id_for_iris_subscription = customVars.device_id_for_iris_subscription;
            }
          } catch (e) {}
        }
        variablesObj.ig_inbox_folder = folder;
      }
      mergedData.variables = JSON.stringify(variablesObj);
    } catch (e) {
      console.warn('[Inbox-API] Failed to parse variables JSON:', e);
    }

    // Construct form urlencoded body
    const formBody = new URLSearchParams();
    Object.entries(mergedData).forEach(([key, val]) => {
      formBody.append(key, String(val));
    });

    console.log(`Proxying inbox request to Instagram GraphQL (Folder: ${folder})...`);

    const instagramResponse = await fetch('https://www.instagram.com/api/graphql', {
      method: 'POST',
      headers: headersToSend,
      body: formBody.toString(),
      cache: 'no-store', // Disable caching to fetch live messages
      redirect: 'manual',
    });

    const status = instagramResponse.status;

    if (status === 301 || status === 302 || status === 307 || status === 308) {
      console.warn('[Inbox-API] Instagram redirected the request (likely login required).');
      return NextResponse.json({
        success: false,
        error: 'Oturumunuz sonlanmış veya geçersiz. Lütfen tekrar giriş yapın.',
        isLoginRequired: true
      }, { status: 401 });
    }

    const responseText = await instagramResponse.text();
    const sanitizedText = responseText.replace(/^for\s*\(;;\);/, '');

    if (!instagramResponse.ok) {
      console.error(`Instagram API returned non-OK status: ${status}`, responseText);
      return NextResponse.json({
        success: false,
        status,
        error: `Instagram API returned status ${status}`,
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

    try {
      const jsonResponse = JSON.parse(sanitizedText);
      
      // Self-healing: Check if we got error 1357004 (invalid or expired web tokens)
      if (jsonResponse?.error === 1357004) {
        console.warn('[Inbox-API] Mismatched web tokens detected (Error 1357004). Attempting self-healing...');
        
        // 1. Scrape fresh tokens using the current cookies
        const { scrapeTokens } = await import('@/lib/token-scraper');
        const { fbDtsg, lsd } = await scrapeTokens(cookieHeaderStr);
        
        if (fbDtsg || lsd) {
          console.log('[Inbox-API] Successfully scraped fresh tokens. Retrying request...');
          
          const healedData = {
            ...customData,
            ...(fbDtsg ? { fb_dtsg: fbDtsg } : {}),
            ...(lsd ? { lsd } : {})
          };

          const mergedHealedData = { 
            ...DEFAULT_DATA, 
            ...healedData,
            fb_api_req_friendly_name: isPending ? 'PolarisDirectMessageRequestQuery' : 'PolarisDirectInboxMobileQuery',
            doc_id: isPending ? '27512223021750545' : '27307632732226966'
          };
          try {
            let variablesObj: Record<string, any> = {};
            if (isPending) {
              let deviceId = '2f285675-f0b4-480c-8bec-51ae03541c51';
              if (healedData.variables) {
                try {
                  const customVars = JSON.parse(healedData.variables);
                  if (customVars.device_id_for_iris_subscription) {
                    deviceId = customVars.device_id_for_iris_subscription;
                  }
                } catch (e) {}
              }
              variablesObj = {
                device_id_for_iris_subscription: deviceId,
                __relay_internal__pv__IGD30DayAgoTimestampMsrelayprovider: String(Date.now() - 30 * 24 * 60 * 60 * 1000),
                __relay_internal__pv__IGDPinnedThreadsRenderEnabledGKrelayprovider: true,
                __relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider: 5,
                __relay_internal__pv__PolarisAIGMAccountLabelEnabledrelayprovider: false,
                __relay_internal__pv__IGDThreadListActionsEnabledGKrelayprovider: true
              };
            } else {
              variablesObj = JSON.parse(DEFAULT_DATA.variables || '{}');
              if (healedData.variables) {
                try {
                  const customVars = JSON.parse(healedData.variables);
                  if (customVars.device_id_for_iris_subscription) {
                    variablesObj.device_id_for_iris_subscription = customVars.device_id_for_iris_subscription;
                  }
                } catch (e) {}
              }
              variablesObj.ig_inbox_folder = folder;
            }
            mergedHealedData.variables = JSON.stringify(variablesObj);
          } catch (e) {}

          const healedFormBody = new URLSearchParams();
          Object.entries(mergedHealedData).forEach(([key, val]) => {
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
            
            console.log('[Inbox-API] Self-healing retry completed successfully!');

            // Capture any new cookies from the retry response
            const retrySetCookieHeaders = retryResponse.headers.getSetCookie();
            const retryUpdatedCookies = { ...updatedCookies };
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
              postData: healedData, // Pass the new tokens back to frontend
              headers: {
                ...customHeaders,
                ...(lsd ? { 'x-fb-lsd': lsd } : {})
              }
            });
          }
        }
      }
      
      // Validate that the structure contains what we expect
      if (jsonResponse.errors) {
        return NextResponse.json({
          success: false,
          error: 'Instagram returned GraphQL errors',
          details: jsonResponse.errors,
          cookies: updatedCookies
        }, { status: 200 }); // GraphQL errors are usually returned with 200 status
      }

      return NextResponse.json({
        success: true,
        data: jsonResponse.data,
        cookies: updatedCookies
      });
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : 'Unknown parsing error';
      console.error('Failed to parse Instagram response as JSON:', e);
      return NextResponse.json({
        success: false,
        error: 'Invalid JSON response from Instagram',
        details: responseText.slice(0, 1000),
        parseError: errorMsg
      }, { status: 502 });
    }

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown server error';
    console.error('Error in proxy route:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: errorMsg
    }, { status: 500 });
  }
}
