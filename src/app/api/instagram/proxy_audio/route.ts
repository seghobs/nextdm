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
    const byteLength = audioBuffer.byteLength;
    const rangeHeader = request.headers.get('range');

    if (rangeHeader) {
      console.log(`[AudioProxy-API] Handling range request: ${rangeHeader}`);
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : byteLength - 1;
      const chunksize = (end - start) + 1;
      
      const slicedBuffer = audioBuffer.slice(start, end + 1);
      
      return new Response(slicedBuffer, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${byteLength}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunksize),
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    return new Response(audioBuffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(byteLength),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      }
    });

  } catch (error: any) {
    console.error('[AudioProxy-API] Error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
