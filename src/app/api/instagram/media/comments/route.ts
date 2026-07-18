import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { mediaId, sortOrder, cursor, cookies, headers, data, source } = body;

    if (!mediaId) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameter: mediaId'
      }, { status: 400 });
    }

    const customCookies = cookies || DEFAULT_COOKIES;
    const customHeaders = headers || DEFAULT_HEADERS;
    const customData = data || DEFAULT_DATA;
    const selectedSort = sortOrder || 'recent';

    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    const baseHeaders: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'x-ig-app-id': '936619743392459', // Force comments query app ID
    };

    // Scrape fresh tokens using the user's current session cookies to prevent Error 1357004
    let fbDtsg = '';
    let lsdToken = '';
    try {
      const { scrapeTokens } = await import('@/lib/token-scraper');
      const tokens = await scrapeTokens(cookieHeaderStr);
      fbDtsg = tokens.fbDtsg || '';
      lsdToken = tokens.lsd || '';
      console.log(`[Comments-API] Scraped fresh tokens: fbDtsg=${!!fbDtsg}, lsd=${!!lsdToken}`);
    } catch (e) {
      console.warn('[Comments-API] Failed to scrape fresh tokens:', e);
    }

    // 1. Try fetching via Instagram's GraphQL endpoint to support sort orders
    if (source !== 'rest') {
      try {
        const validationVariables = {
          after: cursor || null,
          before: null,
          first: 20,
          last: null,
          media_id: mediaId,
          sort_order: selectedSort,
          __relay_internal__pv__PolarisIsLoggedInrelayprovider: true
        };

        const graphqlForm = new URLSearchParams();
        Object.entries({
          ...DEFAULT_DATA,
          ...customData,
          'fb_api_req_friendly_name': 'PolarisPostCommentsPaginationQuery',
          'variables': JSON.stringify(validationVariables),
          'doc_id': '26864966453197043',
          ...(fbDtsg ? { 'fb_dtsg': fbDtsg } : {}),
          ...(lsdToken ? { 'lsd': lsdToken } : {})
        }).forEach(([key, val]) => {
          graphqlForm.append(key, String(val));
        });

        console.log(`[Comments-GraphQL] Fetching comments for media: ${mediaId} (sort: ${selectedSort}, cursor: ${cursor || 'none'})`);

        const res = await fetch('https://www.instagram.com/api/graphql', {
          method: 'POST',
          headers: {
            ...baseHeaders,
            'content-type': 'application/x-www-form-urlencoded',
            'x-fb-friendly-name': 'PolarisPostCommentsPaginationQuery',
            'x-fb-lsd': customData.lsd || DEFAULT_DATA.lsd,
          },
          body: graphqlForm.toString(),
          cache: 'no-store',
          redirect: 'manual'
        });

        if (res.ok) {
          const text = await res.text();
          const sanitizedText = text.replace(/^for\s*\(;;\);/, '');
          const json = JSON.parse(sanitizedText);
          
          // Resolve edges path in GraphQL response
          const mediaConnection = json.data?.xdt_api__v1__media__media_id__comments__connection || {};
          const edges = mediaConnection.edges || [];
          const pageInfo = mediaConnection.page_info || {};
          let hasNextPage = pageInfo.has_next_page || false;
          let endCursor = pageInfo.end_cursor || null;

          // Server-side Guard: Stop pagination if next cursor matches current cursor
          if (endCursor && cursor && String(endCursor).trim() === String(cursor).trim()) {
            console.log(`[Comments-GraphQL] Server-side Guard: Duplicate cursor detected (${endCursor}). Terminating pagination.`);
            hasNextPage = false;
            endCursor = null;
          }

          if (edges.length > 0) {
            const comments: any[] = [];
            edges.forEach((edge: any) => {
              const node = edge.node || {};
              comments.push({
                username: node.user?.username || 'unknown',
                fullName: node.user?.full_name || '',
                profilePicUrl: node.user?.profile_pic_url || '',
                text: node.text || '',
                timestamp: node.created_at || 0
              });

              // Extract child replies if they are embedded in the GraphQL response
              const threaded = node.edge_threaded_comments?.edges || [];
              if (Array.isArray(threaded)) {
                threaded.forEach((tEdge: any) => {
                  const tNode = tEdge.node || {};
                  comments.push({
                    username: tNode.user?.username || 'unknown',
                    fullName: tNode.user?.full_name || '',
                    profilePicUrl: tNode.user?.profile_pic_url || '',
                    text: tNode.text || '',
                    timestamp: tNode.created_at || 0
                  });
                });
              }
            });

            console.log(`[Comments-GraphQL] Successfully loaded ${comments.length} comments (including replies). Has next: ${hasNextPage}`);
            return NextResponse.json({
              success: true,
              comments,
              hasNextPage,
              endCursor,
              source: 'graphql'
            });
          } else {
          console.warn(`[Comments-GraphQL] Parsed 0 edges. GraphQL payload keys:`, Object.keys(json.data || {}));
        }
      } else {
        console.warn(`[Comments-GraphQL] Failed status ${res.status}. Falling back to REST API...`);
      }
    } catch (graphError) {
      console.warn('[Comments-GraphQL] Error in GraphQL comments fetch, falling back to REST:', graphError);
    }
  }

    // 2. Fallback to standard REST API endpoint if GraphQL fails
    let restUrl = `https://www.instagram.com/api/v1/media/${mediaId}/comments/`;
    if (cursor) {
      let maxIdParam = cursor;
      // If the cursor is a JSON string (which GraphQL uses), extract the nested ID for REST compatibility
      if (typeof cursor === 'string' && cursor.includes('{')) {
        try {
          const parsed = JSON.parse(cursor);
          if (parsed.cached_comments_cursor) {
            maxIdParam = parsed.cached_comments_cursor;
            console.log(`[Comments-REST] Extracted simple ID "${maxIdParam}" from JSON cursor`);
          }
        } catch (e) {
          console.warn('[Comments-REST] Failed to parse JSON cursor:', e);
        }
      }
      restUrl += `?max_id=${encodeURIComponent(maxIdParam)}`;
    }
    
    console.log(`[Comments-REST] Fetching comments for media: ${mediaId} (cursor: ${cursor || 'none'})`);

    const response = await fetch(restUrl, {
      method: 'GET',
      headers: {
        ...baseHeaders,
        'accept': '*/*',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
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
      console.error(`[Comments-REST] Instagram returned error status ${status}:`, responseText.slice(0, 500));
      return NextResponse.json({
        success: false,
        status,
        error: `Instagram API returned status ${status}`,
        details: responseText.slice(0, 500)
      }, { status: 400 });
    }

    const json = JSON.parse(responseText);
    
    if (json.comments_disabled === true) {
      console.log('[Comments-REST] Comments are disabled for this media.');
      return NextResponse.json({
        success: true,
        comments: [],
        commentsDisabled: true,
        hasNextPage: false,
        endCursor: null,
        source: 'rest'
      });
    }

    const commentsList = json.comments || [];
    let endCursor = json.next_max_id || json.next_min_id || null;
    let hasNextPage = (endCursor !== undefined && endCursor !== null) || json.has_more_comments || json.has_more_headload_comments || false;
    
    // Server-side Guard 1: Stop pagination if 0 comments are returned
    if (commentsList.length === 0) {
      console.log('[Comments-REST] Server-side Guard: 0 comments returned. Terminating pagination.');
      hasNextPage = false;
      endCursor = null;
    }

    // Server-side Guard 2: Stop pagination if next cursor matches current cursor to prevent infinite loop
    if (endCursor && cursor && String(endCursor).trim() === String(cursor).trim()) {
      console.log(`[Comments-REST] Server-side Guard: Duplicate cursor detected (${endCursor}). Terminating pagination.`);
      hasNextPage = false;
      endCursor = null;
    }
    
    const comments: any[] = [];
    commentsList.forEach((c: any) => {
      comments.push({
        username: c.user?.username || 'unknown',
        fullName: c.user?.full_name || '',
        profilePicUrl: c.user?.profile_pic_url || '',
        text: c.text || '',
        timestamp: c.created_at || 0
      });

      // Parse nested child comments (replies) if they exist in the REST response
      const childComments = c.preview_child_comments || c.child_comments || [];
      if (Array.isArray(childComments)) {
        childComments.forEach((cc: any) => {
          comments.push({
            username: cc.user?.username || 'unknown',
            fullName: cc.user?.full_name || '',
            profilePicUrl: cc.user?.profile_pic_url || '',
            text: cc.text || '',
            timestamp: cc.created_at || 0
          });
        });
      }
    });

    return NextResponse.json({
      success: true,
      comments,
      hasNextPage,
      endCursor,
      source: 'rest'
    });

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown server error';
    console.error('[Comments-API] Error fetching comments:', err);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: errorMsg
    }, { status: 500 });
  }
}
