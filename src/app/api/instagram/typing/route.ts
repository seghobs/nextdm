import { NextRequest, NextResponse } from 'next/server';
import { sendTypingIndicator, startRealtimeBridge } from '@/lib/realtime-manager';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { threadId, isActive, cookies } = body;

    if (!threadId) {
      return NextResponse.json({
        success: false,
        error: 'Missing required parameter: threadId'
      }, { status: 400 });
    }

    console.log(`[Typing-API] Request received to set typing status to ${isActive} for thread ${threadId}`);
    
    // Attempt sending the typing indicator
    let success = await sendTypingIndicator(threadId, !!isActive);

    // Self-healing: if failed and we have cookies, start/reconnect the bridge on-the-fly and retry
    if (!success && cookies) {
      console.log('[Typing-API] Realtime client not ready or send failed. Attempting to restore bridge...');
      await startRealtimeBridge(cookies, '0').catch(err => {
        console.error('[Typing-API] Failed to restore realtime bridge:', err);
      });
      
      // Retry sending indicator
      success = await sendTypingIndicator(threadId, !!isActive);
    }

    return NextResponse.json({
      success,
      message: success ? 'Typing indicator updated successfully.' : 'Failed to update typing indicator.'
    });
  } catch (error: any) {
    console.error('Error in typing proxy route:', error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Unknown server error'
    }, { status: 500 });
  }
}
