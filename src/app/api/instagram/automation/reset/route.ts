import { NextResponse } from 'next/server';
import db from '@/lib/db';

export async function POST() {
  try {
    // 1. Clear locked posts
    db.prepare('DELETE FROM locked_posts').run();
    
    // 2. Clear sent DMs
    db.prepare('DELETE FROM sent_dms').run();
    
    // 3. Clear checked posts history (main list of checked posts/reels)
    db.prepare('DELETE FROM checked_posts').run();
    
    // 4. Clear automation logs
    db.prepare('DELETE FROM automation_logs').run();

    // 4b. Clear sent messages history
    db.prepare('DELETE FROM sent_messages_history').run();

    // 5. Emergency memory purge of any duplicate timers
    for (let i = 1; i < 15000; i++) {
      try {
        clearInterval(i as any);
      } catch {}
    }
    (global as any)._purgedOldIntervals = true;

    // 6. Reset global scheduler state
    if ((global as any).automationState) {
      (global as any).automationState.abortScan = true;
      (global as any).automationState.lastRunMinuteStr = '';
      (global as any).automationState.isRunningNow = false;
      (global as any).automationState.schedulerInterval = null;
    }

    // 7. Restart fresh single scheduler instance
    const { startAutomationScheduler } = await import('@/lib/automation-engine');
    startAutomationScheduler();

    // 8. Add initial success log
    db.prepare('INSERT INTO automation_logs (type, message) VALUES (?, ?)')
      .run('success', 'Otomasyon geçmişi, kilitli gönderiler, kontrol edilen paylaşımlar ve gönderilen DM kayıtları sıfırlandı.');

    return NextResponse.json({
      success: true,
      message: 'Otomasyon geçmişi ve zamanlayıcı durumları başarıyla sıfırlandı.'
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to reset automation state'
    }, { status: 500 });
  }
}
