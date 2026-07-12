import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const customCookiesStr = formData.get('cookies') as string | null;
    const customHeadersStr = formData.get('headers') as string | null;
    const customDataStr = formData.get('data') as string | null;

    if (!file) {
      return NextResponse.json({
        success: false,
        error: 'Missing file parameter'
      }, { status: 400 });
    }

    // Parse custom credentials
    const customCookies = customCookiesStr ? JSON.parse(customCookiesStr) : DEFAULT_COOKIES;
    const customHeaders = customHeadersStr ? JSON.parse(customHeadersStr) : DEFAULT_HEADERS;
    const customData = customDataStr ? JSON.parse(customDataStr) : DEFAULT_DATA;

    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    const headersToSend: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'referer': 'https://www.instagram.com/direct/inbox/',
      // Note: Do not hardcode Content-Type boundary; let fetch set it automatically from the FormData object
    };

    // Build the multipart payload for Instagram mercury upload.php
    const formToInstagram = new FormData();
    
    // We append the file to the field 'farr' as seen in the user's upload log
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const fileBlob = new Blob([fileBuffer], { type: file.type });
    formToInstagram.append('farr', fileBlob, file.name);

    // Append common parameters
    const postDataFields = {
      ...DEFAULT_DATA,
      ...customData,
    };

    Object.entries(postDataFields).forEach(([key, val]) => {
      formToInstagram.append(key, String(val));
    });

    console.log(`Proxying mercury upload.php for file: ${file.name} (${file.size} bytes)...`);

    const instagramResponse = await fetch('https://www.instagram.com/ajax/mercury/upload.php?__d=www', {
      method: 'POST',
      headers: headersToSend,
      body: formToInstagram,
      redirect: 'manual',
    });

    const status = instagramResponse.status;

    if (status === 301 || status === 302 || status === 307 || status === 308) {
      return NextResponse.json({
        success: false,
        error: 'Oturumunuz sonlanmış veya geçersiz. Lütfen tekrar giriş yapın.',
        isLoginRequired: true
      }, { status: 401 });
    }

    const responseText = await instagramResponse.text();
    const sanitizedText = responseText.replace(/^for\s*\(;;\);/, '');

    if (!instagramResponse.ok) {
      console.error(`Instagram mercury upload returned status ${status}:`, responseText);
      return NextResponse.json({
        success: false,
        error: `Instagram returned status ${status} on upload`,
        details: responseText.slice(0, 500)
      }, { status: 400 });
    }

    // Extract cookies
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
      
      // Recursive helper to search for fbid or attachment_id in the JSON tree
      const findFbid = (obj: any): string | null => {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.fbid) return String(obj.fbid);
        if (obj.attachment_id) return String(obj.attachment_id);
        
        for (const val of Object.values(obj)) {
          const found = findFbid(val);
          if (found) return found;
        }
        return null;
      };

      const fbid = findFbid(jsonResponse);

      if (!fbid) {
        console.error('[UploadMedia] Could not find fbid in upload response:', jsonResponse);
        return NextResponse.json({
          success: false,
          error: 'Could not find attachment fbid in Instagram upload response',
          rawResponse: jsonResponse,
          cookies: updatedCookies
        }, { status: 502 });
      }

      console.log(`[UploadMedia] Successfully uploaded media, parsed fbid: ${fbid}`);

      return NextResponse.json({
        success: true,
        fbid,
        cookies: updatedCookies
      });
    } catch (e: any) {
      return NextResponse.json({
        success: false,
        error: 'Invalid JSON response on upload',
        details: responseText.slice(0, 1000),
        parseError: e.message
      }, { status: 502 });
    }

  } catch (error: any) {
    console.error('Error uploading media:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: error.message
    }, { status: 500 });
  }
}
