import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS } from '@/lib/instagram-defaults';

const decodeHtmlEntities = (str: string): string => {
  if (!str) return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { shortcode, cookies, headers } = body;

    if (!shortcode) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameter: shortcode'
      }, { status: 400 });
    }

    const customCookies = cookies || DEFAULT_COOKIES;
    const customHeaders = headers || DEFAULT_HEADERS;

    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    // 1. Try public crawler fetch (extremely reliable for public posts)
    let html = '';
    let fetchedSuccess = false;

    try {
      console.log(`[Media-Info] Crawler fetch for shortcode: ${shortcode}`);
      const crawlerRes = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
        method: 'GET',
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_patched.html)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        cache: 'no-store'
      });

      if (crawlerRes.ok) {
        html = await crawlerRes.text();
        fetchedSuccess = true;
      }
    } catch (e) {
      console.warn('[Media-Info] Crawler fetch failed, trying cookie fallback:', e);
    }

    // 2. Cookie fallback if crawler failed (for private accounts)
    if (!fetchedSuccess) {
      try {
        console.log(`[Media-Info] Cookie fallback fetch for shortcode: ${shortcode}`);
        const fallbackRes = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
          method: 'GET',
          headers: {
            ...DEFAULT_HEADERS,
            ...customHeaders,
            'cookie': cookieHeaderStr,
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          cache: 'no-store',
          redirect: 'manual'
        });

        if (fallbackRes.ok) {
          html = await fallbackRes.text();
          fetchedSuccess = true;
        }
      } catch (e) {
        console.error('[Media-Info] Cookie fallback fetch also failed:', e);
      }
    }

    if (!fetchedSuccess || !html) {
      return NextResponse.json({
        success: false,
        error: 'Failed to fetch Instagram page'
      });
    }

    // 3. Extract OpenGraph tags
    const getMetaTag = (property: string) => {
      const regex1 = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
      const regex2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i');
      
      const match1 = html.match(regex1);
      if (match1) return match1[1];
      
      const match2 = html.match(regex2);
      if (match2) return match2[1];
      
      return null;
    };

    const ogImage = getMetaTag('og:image');
    const ogTitle = getMetaTag('og:title');
    const ogDescription = getMetaTag('og:description');
    const ogVideo = getMetaTag('og:video') || getMetaTag('og:video:secure_url');
    const ogType = getMetaTag('og:type');

    if (!ogImage && !ogTitle) {
      return NextResponse.json({
        success: false,
        error: 'Could not extract preview details. Post may be deleted, private, or blocked.'
      });
    }

    // 4. Extract true numeric media_id using App Link metas or raw matches
    let mediaId = shortcode; // Fallback
    const mediaIdMatch = html.match(/instagram:\/\/media\?id=(\d+)/i) || 
                         html.match(/instagram:\/\/media\/\?id=(\d+)/i) ||
                         html.match(/"media_id"\s*:\s*"(\d+)"/i) ||
                         html.match(/"id"\s*:\s*"(\d+)"/i) ||
                         html.match(/"postId"\s*:\s*"(\d+)"/i);
    if (mediaIdMatch) {
      mediaId = mediaIdMatch[1];
    }

    // 5. Try to fetch dynamic counts from private API using resolved mediaId
    let likeCount: number | null = null;
    let commentCount: number | null = null;

    if (mediaId && mediaId !== shortcode) {
      try {
        console.log(`[Media-Info] Fetching counts for numeric mediaId: ${mediaId}`);
        const infoRes = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
          method: 'GET',
          headers: {
            ...DEFAULT_HEADERS,
            ...customHeaders,
            'cookie': cookieHeaderStr,
          },
          cache: 'no-store'
        });

        if (infoRes.ok) {
          const infoJson = await infoRes.json();
          const item = infoJson.items?.[0] || {};
          if (item.like_count !== undefined) {
            likeCount = item.like_count;
          }
          if (item.comment_count !== undefined) {
            commentCount = item.comment_count;
          }
          console.log(`[Media-Info] Successfully retrieved counts - Likes: ${likeCount}, Comments: ${commentCount}`);
        }
      } catch (e) {
        console.warn('[Media-Info] Failed to fetch counts from private API:', e);
      }
    }

    // Clean and decode details
    const previewUrl = ogImage ? decodeHtmlEntities(ogImage) : null;
    const videoUrl = ogVideo ? decodeHtmlEntities(ogVideo) : null;
    const rawTitle = ogTitle ? decodeHtmlEntities(ogTitle) : '';
    const rawDescription = ogDescription ? decodeHtmlEntities(ogDescription) : '';

    // Extract cleaner title and author
    let title = rawTitle;
    const titleMatch = rawTitle.match(/on Instagram:\s*"?(.*?)"?$/i);
    if (titleMatch) {
      title = titleMatch[1];
    }

    let author = null;
    if (rawDescription) {
      const descMatch = rawDescription.match(/^([A-Za-z0-9_.-]+)\s+on\s+/i);
      if (descMatch) {
        author = descMatch[1];
      }
    }
    if (!author && rawTitle) {
      const titleAuthorMatch = rawTitle.match(/^([A-Za-z0-9_.-]+)\s+on\s+Instagram/i);
      if (titleAuthorMatch) {
        author = titleAuthorMatch[1];
      }
    }

    const isVideo = ogType === 'video' || !!videoUrl;

    return NextResponse.json({
      success: true,
      media: {
        mediaId,
        previewUrl,
        videoUrl,
        title: title || 'Paylaşılan Gönderi',
        author: author || 'instagram_user',
        mediaType: isVideo ? 'clip' : 'media_share',
        likeCount,
        commentCount
      }
    });

  } catch (err: any) {
    console.error('[Media-Info] Error in route handler:', err);
    return NextResponse.json({
      success: false,
      error: err.message || 'Server error'
    }, { status: 500 });
  }
}
