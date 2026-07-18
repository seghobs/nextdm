import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';
import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function transcodeToM4A(inputBuffer: Buffer): Promise<Buffer> {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `ig_voice_input_${Date.now()}.webm`);
  const outputPath = path.join(tempDir, `ig_voice_output_${Date.now()}.m4a`);

  try {
    await fs.promises.writeFile(inputPath, inputBuffer);
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -c:a aac -b:a 64k "${outputPath}"`;
    console.log(`[Send-Voice-API] Transcoding voice note with command: ${ffmpegCmd}`);
    await execAsync(ffmpegCmd);
    const outputBuffer = await fs.promises.readFile(outputPath);
    return outputBuffer;
  } catch (err: any) {
    console.error('[Send-Voice-API] FFmpeg transcoding failed:', err.message || err);
    return inputBuffer;
  } finally {
    try {
      if (fs.existsSync(inputPath)) await fs.promises.unlink(inputPath);
    } catch {}
    try {
      if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath);
    } catch {}
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const threadId = formData.get('threadId') as string | null;
    const customCookiesStr = formData.get('cookies') as string | null;
    const customHeadersStr = formData.get('headers') as string | null;
    const customDataStr = formData.get('data') as string | null;

    if (!file || !threadId) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameters: file and threadId'
      }, { status: 400 });
    }

    // Parse custom credentials
    const customCookies = customCookiesStr ? JSON.parse(customCookiesStr) : DEFAULT_COOKIES;
    const customHeaders = customHeadersStr ? JSON.parse(customHeadersStr) : DEFAULT_HEADERS;
    const customData = customDataStr ? JSON.parse(customDataStr) : DEFAULT_DATA;

    const cookieHeaderStr = Object.entries(customCookies)
      .map(([name, val]) => `${name}=${val}`)
      .join('; ');

    // ----------------------------------------------------
    // Step 1: Upload the audio file via Mercury upload.php
    // ----------------------------------------------------
    const uploadHeaders: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'referer': `https://www.instagram.com/direct/t/${threadId}/`,
    };

    delete uploadHeaders['content-type'];
    delete uploadHeaders['Content-Type'];

    const queryParams = new URLSearchParams();
    queryParams.append('__d', 'www');
    queryParams.append('__user', '0');
    queryParams.append('__a', '1');

    const postDataFields = {
      ...DEFAULT_DATA,
      ...customData,
    };

    Object.entries(postDataFields).forEach(([key, val]) => {
      queryParams.append(key, String(val));
    });

    const uploadUrl = `https://www.instagram.com/ajax/mercury/upload.php?${queryParams.toString()}`;

    const formToInstagram = new FormData();
    let fileBuffer: Buffer = Buffer.from(await file.arrayBuffer());
    
    // Transcode the voice note to a valid AAC M4A container for native player compatibility
    try {
      console.log('[Send-Voice-API] Commencing FFmpeg audio transcoding to AAC...');
      fileBuffer = await transcodeToM4A(fileBuffer);
    } catch (e: any) {
      console.error('[Send-Voice-API] Audio transcode step error:', e);
    }

    const fileBlob = new Blob([new Uint8Array(fileBuffer)], { type: 'audio/mp4' }); // Use audio/mp4 for voice notes compatibility
    formToInstagram.append('farr', fileBlob, 'recorded_voice.m4a');

    console.log(`[Send-Voice-API] Uploading voice file to mercury upload.php: ${file.name || 'voice.m4a'}...`);

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: uploadHeaders,
      body: formToInstagram,
      redirect: 'manual',
    });

    if (!uploadResponse.ok) {
      const uploadErrText = await uploadResponse.text();
      console.error(`[Send-Voice-API] Mercury upload failed with status ${uploadResponse.status}:`, uploadErrText);
      return NextResponse.json({
        success: false,
        error: `Upload failed: Instagram returned status ${uploadResponse.status}`,
        details: uploadErrText.slice(0, 500)
      }, { status: 400 });
    }

    const uploadResponseText = await uploadResponse.text();
    const sanitizedUploadText = uploadResponseText.replace(/^for\s*\(;;\);/, '');

    let fbid = null;
    try {
      const jsonResponse = JSON.parse(sanitizedUploadText);
      
      const findFbid = (obj: any): string | null => {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.fbid) return String(obj.fbid);
        if (obj.attachment_id) return String(obj.attachment_id);
        if (obj.audio_id) return String(obj.audio_id);
        for (const val of Object.values(obj)) {
          const found = findFbid(val);
          if (found) return found;
        }
        return null;
      };

      fbid = findFbid(jsonResponse);
    } catch (e: any) {
      console.error('[Send-Voice-API] Failed to parse upload response:', e.message);
    }

    if (!fbid) {
      console.error('[Send-Voice-API] Upload response did not contain fbid. Raw response:', sanitizedUploadText);
      return NextResponse.json({
        success: false,
        error: 'Could not find fbid in upload response',
        details: sanitizedUploadText.slice(0, 1000)
      }, { status: 502 });
    }

    console.log(`[Send-Voice-API] Successfully uploaded, fbid: ${fbid}. Now sending media mutation...`);

    // ----------------------------------------------------
    // Step 2: Send the media file via IGDirectMediaSendMutation
    // ----------------------------------------------------
    const sendHeaders: Record<string, string> = {
      ...DEFAULT_HEADERS,
      ...customHeaders,
      'cookie': cookieHeaderStr,
      'content-type': 'application/x-www-form-urlencoded',
      'x-fb-friendly-name': 'IGDirectMediaSendMutation',
      'referer': `https://www.instagram.com/direct/t/${threadId}/`,
    };

    const generateOfflineThreadingId = () => {
      let id = '';
      for (let i = 0; i < 19; i++) {
        id += Math.floor(Math.random() * 10).toString();
      }
      return id;
    };

    const offlineThreadingId = generateOfflineThreadingId();

    const variablesObj = {
      attachment_fbid: String(fbid),
      thread_id: String(threadId),
      offline_threading_id: offlineThreadingId,
      reply_to_message_id: null,
      forwarded_from_thread_id: null,
      is_forwarded_from_own_message: null
    };

    const sendFormBody = new URLSearchParams();
    const sendPostDataFields = {
      ...DEFAULT_DATA,
      ...customData,
      'fb_api_req_friendly_name': 'IGDirectMediaSendMutation',
      'variables': JSON.stringify(variablesObj),
      'doc_id': '25766288509716264',
    };

    Object.entries(sendPostDataFields).forEach(([key, val]) => {
      sendFormBody.append(key, String(val));
    });

    const sendResponse = await fetch('https://www.instagram.com/api/graphql', {
      method: 'POST',
      headers: sendHeaders,
      body: sendFormBody.toString(),
      redirect: 'manual',
    });

    const sendStatus = sendResponse.status;
    const sendResponseText = await sendResponse.text();
    const sanitizedSendText = sendResponseText.replace(/^for\s*\(;;\);/, '');

    if (!sendResponse.ok) {
      console.error(`[Send-Voice-API] Send mutation failed with status ${sendStatus}:`, sendResponseText);
      return NextResponse.json({
        success: false,
        error: `Send media failed: Instagram returned status ${sendStatus}`,
        details: sendResponseText.slice(0, 500)
      }, { status: 400 });
    }

    console.log('[Send-Voice-API] Voice message successfully sent via GraphQL!');

    // Capture set-cookie headers
    const setCookieHeaders = sendResponse.headers.getSetCookie();
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
      const jsonResponse = JSON.parse(sanitizedSendText);
      return NextResponse.json({
        success: true,
        data: jsonResponse.data,
        cookies: Object.keys(updatedCookies).length > 0 ? updatedCookies : undefined
      });
    } catch (e: any) {
      return NextResponse.json({
        success: true,
        rawResponse: sanitizedSendText,
        cookies: Object.keys(updatedCookies).length > 0 ? updatedCookies : undefined
      });
    }

  } catch (error: any) {
    console.error('[Send-Voice-API] Error:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal Server Error',
      details: error.message
    }, { status: 500 });
  }
}
