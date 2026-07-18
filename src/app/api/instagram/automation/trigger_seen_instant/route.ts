import { NextRequest, NextResponse } from 'next/server';
import { runBackgroundAutoSeen } from '@/lib/automation-engine';

export async function POST(request: NextRequest) {
  try {
    const { threadId } = await request.json().catch(() => ({}));

    // Run the background seen loop instantly (force = true) targeting only this thread
    runBackgroundAutoSeen(true, threadId).catch(e => {
      console.error('[TriggerSeenInstant] Error in background seen execution:', e);
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to trigger seen'
    }, { status: 500 });
  }
}
