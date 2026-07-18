import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { DEFAULT_COOKIES, DEFAULT_HEADERS } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const threadId = formData.get('threadId') as string | null;
    const customCookiesStr = formData.get('cookies') as string | null;
    const customHeadersStr = formData.get('headers') as string | null;

    if (!file || !threadId) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: file and threadId'
      }, { status: 400 });
    }

    // Parse custom credentials
    const customCookies = customCookiesStr ? JSON.parse(customCookiesStr) : DEFAULT_COOKIES;
    const customHeaders = customHeadersStr ? JSON.parse(customHeadersStr) : DEFAULT_HEADERS;

    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    // Generate unique context IDs
    const uploadId = Date.now().toString();
    const clientContext = crypto.randomUUID();

    // Use Android User-Agent for private API compatibility
    const androidUserAgent = 'Instagram 315.0.0.37.110 Android (26/8.0.0; 480dpi; 1080x1920; HUAWEI/HONOR; STF-L09; HWSTF; hi3660; en_US; 555234123)';

    // Step 1: Upload the audio binary to rupload_igvideo
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const fileLength = fileBuffer.length;

    const ruploadParams = {
      upload_id: uploadId,
      media_type: '11', // Voice media
      is_direct_voice: '1',
      direct_reader_watermark_enabled: '1'
    };

    const uploadHeaders: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'user-agent': androidUserAgent,
      'x-entity-type': 'video/mp4', // Voice files uploaded under video container rules
      'x-entity-name': file.name || 'voice_message.m4a',
      'x-entity-length': String(fileLength),
      'offset': '0',
      'x-instagram-rupload-params': JSON.stringify(ruploadParams),
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate, br',
      'connection': 'keep-alive'
    };

    // Remove content-type so the binary payload is sent raw
    delete uploadHeaders['content-type'];
    delete uploadHeaders['Content-Type'];

    const uploadUrl = `https://i.instagram.com/rupload_igvideo/${uploadId}`;
    console.log(`[Send-Voice-API] Uploading audio binary (${fileLength} bytes) to rupload_igvideo: ${uploadId}...`);

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: uploadHeaders,
      body: fileBuffer,
    });

    if (!uploadResponse.ok) {
      const uploadErrText = await uploadResponse.text();
      console.error(`[Send-Voice-API] Upload failed with status ${uploadResponse.status}:`, uploadErrText);
      return NextResponse.json({
        success: false,
        error: `Upload failed: Instagram returned status ${uploadResponse.status}`,
        details: uploadErrText.slice(0, 500)
      }, { status: 400 });
    }

    console.log('[Send-Voice-API] Audio upload completed successfully. Finalizing upload via upload_finish...');

    // Step 1.5: Finalize the upload
    const finishUrl = 'https://i.instagram.com/api/v1/media/upload_finish/';
    const finishHeaders: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'user-agent': androidUserAgent,
      'content-type': 'application/x-www-form-urlencoded',
    };
    const finishParams = new URLSearchParams();
    finishParams.append('upload_id', uploadId);
    finishParams.append('source_type', '4');

    try {
      const finishResponse = await fetch(finishUrl, {
        method: 'POST',
        headers: finishHeaders,
        body: finishParams.toString()
      });
      if (finishResponse.ok) {
        console.log('[Send-Voice-API] upload_finish successfully completed.');
      } else {
        console.warn(`[Send-Voice-API] upload_finish warning: returned status ${finishResponse.status}`);
      }
    } catch (finishErr) {
      console.warn('[Send-Voice-API] upload_finish request error, attempting configuration anyway:', finishErr);
    }

    // Step 2: Configure and broadcast the voice note
    const configureUrl = 'https://i.instagram.com/api/v1/direct_v2/threads/broadcast/voice_media/';
    
    // Generate dummy waveform (Instagram expects array of float values)
    const dummyWaveform = Array.from({ length: 30 }, () => parseFloat((Math.random() * 0.8 + 0.2).toFixed(2)));

    const configureHeaders: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'user-agent': androidUserAgent,
      'content-type': 'application/x-www-form-urlencoded',
      'accept': '*/*'
    };

    // Build URL-encoded form parameters
    const formParams = new URLSearchParams();
    formParams.append('client_context', clientContext);
    formParams.append('thread_ids', JSON.stringify([String(threadId)]));
    formParams.append('upload_id', uploadId);
    formParams.append('waveform', JSON.stringify(dummyWaveform));
    formParams.append('waveform_sampling_frequency_hz', '10');

    console.log(`[Send-Voice-API] Sending broadcast configure request for thread: ${threadId}, upload_id: ${uploadId}...`);

    const configureResponse = await fetch(configureUrl, {
      method: 'POST',
      headers: configureHeaders,
      body: formParams.toString()
    });

    const configStatus = configureResponse.status;
    const configText = await configureResponse.text();

    if (!configureResponse.ok) {
      console.error(`[Send-Voice-API] Configure failed with status ${configStatus}:`, configText);
      return NextResponse.json({
        success: false,
        error: `Configure failed: Instagram returned status ${configStatus}`,
        details: configText.slice(0, 500)
      }, { status: 400 });
    }

    console.log('[Send-Voice-API] Voice media successfully configured and sent!');

    // Capture any cookie updates
    const setCookieHeaders = configureResponse.headers.getSetCookie();
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
      const jsonResponse = JSON.parse(configText);
      return NextResponse.json({
        success: true,
        data: jsonResponse,
        cookies: Object.keys(updatedCookies).length > 0 ? updatedCookies : undefined
      });
    } catch (e: any) {
      return NextResponse.json({
        success: true,
        rawResponse: configText,
        cookies: Object.keys(updatedCookies).length > 0 ? updatedCookies : undefined
      });
    }

  } catch (error: any) {
    console.error('[Send-Voice-API] Internal error:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: error.message
    }, { status: 500 });
  }
}
