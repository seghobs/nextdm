import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';
import { scrapeTokens } from '@/lib/token-scraper';

async function unsendMessage(threadId: string, messageId: string, cookies: any, headers: any, postData: any) {
  const cookieHeaderStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
  
  let fbDtsg = postData.fb_dtsg || '';
  let lsdToken = postData.lsd || '';
  try {
    const tokens = await scrapeTokens(cookieHeaderStr);
    fbDtsg = tokens.fbDtsg || fbDtsg;
    lsdToken = tokens.lsd || lsdToken;
  } catch {}

  const headersToSend: Record<string, string> = {
    ...DEFAULT_HEADERS,
    ...headers,
    'cookie': cookieHeaderStr,
    'content-type': 'application/x-www-form-urlencoded',
    'x-fb-friendly-name': 'IGDMessageUnsendDialogOffMsysMutation',
    'referer': `https://www.instagram.com/direct/t/${threadId}/`,
  };

  const variablesObj = {
    message_id: messageId,
    send_data: {
      thread_id: String(threadId)
    }
  };

  const formBody = new URLSearchParams();
  const postDataFields = {
    ...DEFAULT_DATA,
    ...postData,
    'fb_api_req_friendly_name': 'IGDMessageUnsendDialogOffMsysMutation',
    'variables': JSON.stringify(variablesObj),
    'doc_id': '26948700068153789',
    ...(fbDtsg ? { fb_dtsg: fbDtsg } : {}),
    ...(lsdToken ? { lsd: lsdToken } : {})
  };

  Object.entries(postDataFields).forEach(([k, v]) => formBody.append(k, String(v)));

  try {
    const res = await fetch('https://www.instagram.com/api/graphql', {
      method: 'POST',
      headers: headersToSend,
      body: formBody.toString()
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function POST() {
  try {
    // Fetch messages
    const messages = db.prepare('SELECT * FROM sent_messages_history').all() as { id: number, thread_id: string, message_id: string }[];
    if (messages.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Geri alınacak herhangi bir otomasyon mesajı kaydı bulunamadı.'
      });
    }

    // Fetch settings credentials
    const settings = db.prepare('SELECT cookies, headers, post_data FROM automation_settings WHERE id = 1').get() as any;
    if (!settings || !settings.cookies) {
      return NextResponse.json({
        success: false,
        error: 'Giriş çerezleri bulunamadı.'
      });
    }

    const cookies = JSON.parse(settings.cookies);
    const headers = JSON.parse(settings.headers);
    const postData = JSON.parse(settings.post_data);

    let successCount = 0;
    let failCount = 0;

    // Delete each message slowly to avoid spam detection
    for (const msg of messages) {
      const ok = await unsendMessage(msg.thread_id, msg.message_id, cookies, headers, postData);
      if (ok) {
        successCount++;
        db.prepare('DELETE FROM sent_messages_history WHERE id = ?').run(msg.id);
      } else {
        failCount++;
      }
      // Wait 1.5 seconds between unsends to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // Also clear the sent_dms list for today so that they can rerun
    db.prepare('DELETE FROM sent_dms').run();

    // Add log to DB
    db.prepare('INSERT INTO automation_logs (type, message) VALUES (?, ?)')
      .run('success', `Son yapılan işlemler geri alındı: ${successCount} mesaj silindi, ${failCount} başarısız.`);

    return NextResponse.json({
      success: true,
      message: `İşlemler geri alındı. Başarıyla geri alınan (silinen) mesaj: ${successCount}. Başarısız: ${failCount}.`
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message || 'Geri alma işlemi sırasında bir hata oluştu.'
    }, { status: 500 });
  }
}
