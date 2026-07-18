import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS } from '@/lib/instagram-defaults';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const audioUrl = searchParams.get('url');
    const customCookiesStr = searchParams.get('cookies');
    const customHeadersStr = searchParams.get('headers');

    if (!audioUrl) {
      return new Response('Missing url parameter', { status: 400 });
    }

    const customCookies = customCookiesStr ? JSON.parse(customCookiesStr) : DEFAULT_COOKIES;
    const customHeaders = customHeadersStr ? JSON.parse(customHeadersStr) : DEFAULT_HEADERS;

    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    const headersToSend: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
    };

    console.log(`[AudioProxy-API] Proxying direct audio from: ${audioUrl.slice(0, 100)}...`);

    const res = await fetch(audioUrl, {
      headers: headersToSend
    });

    if (!res.ok) {
      console.error(`[AudioProxy-API] Instagram CDN returned status ${res.status}`);
      return new Response(`Failed to fetch audio: ${res.status}`, { status: res.status });
    }

    const audioBuffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'audio/mp4';

    return new Response(audioBuffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(audioBuffer.byteLength),
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      }
    });

  } catch (error: any) {
    console.error('[AudioProxy-API] Error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
