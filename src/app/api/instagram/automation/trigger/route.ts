import { NextResponse } from 'next/server';
import { runAutomationCheck } from '@/lib/automation-engine';

export async function POST() {
  try {
    console.log('[Automation-Trigger-API] Manually triggering automation run...');
    // Run asynchronously so we return a response to client immediately
    runAutomationCheck().catch(err => {
      console.error('[Automation-Trigger-API] Run error:', err);
    });

    return NextResponse.json({
      success: true,
      message: 'Otomasyon taraması arka planda manuel olarak başlatıldı. Log sayfasından takip edebilirsiniz.'
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to trigger manual run'
    }, { status: 500 });
  }
}
