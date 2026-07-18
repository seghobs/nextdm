import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { startAutomationScheduler, stopAutomationScheduler } from '@/lib/automation-engine';

// Emergency purge of old duplicate intervals from memory (runs once on hot reload/load)
if (!(global as any)._purgedOldIntervals) {
  console.log('[Automation-Scheduler] Purging old duplicate intervals from Node.js memory...');
  for (let i = 1; i < 15000; i++) {
    try {
      clearInterval(i as any);
    } catch {}
  }
  (global as any)._purgedOldIntervals = true;
}

export async function GET() {
  try {
    const settings = db.prepare('SELECT * FROM automation_settings WHERE id = 1').get() as any;
    const threadsConfig = db.prepare('SELECT * FROM automation_threads').all() as any[];
    if (settings && (settings.enabled || settings.ai_assistant_enabled)) {
      startAutomationScheduler();
    }
    return NextResponse.json({
      success: true,
      settings,
      threads_config: threadsConfig
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to fetch settings'
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    
    // Extract settings values
    const {
      enabled,
      threads,
      check_hours,
      dm_template,
      group_report_template,
      break_minutes,
      dm_delay_seconds,
      comment_check_enabled,
      like_check_enabled,
      auto_dm_enabled,
      auto_group_report_enabled,
      cookies,
      headers,
      post_data,
      scan_mode,
      target_username,
      admin_report_enabled,
      admin_username,
      scan_date,
      dm_bulk_template,
      ai_assistant_enabled,
      ai_api_key,
      ai_model,
      ai_system_prompt,
      ai_delay_seconds,
      threads_config,
      exempt_usernames
    } = body;

    // Convert booleans/numbers properly
    const isEnabled = enabled ? 1 : 0;
    const isCommentCheck = comment_check_enabled ? 1 : 0;
    const isLikeCheck = like_check_enabled ? 1 : 0;
    const isAutoDm = auto_dm_enabled ? 1 : 0;
    const isAutoReport = auto_group_report_enabled ? 1 : 0;
    const isAdminReport = admin_report_enabled ? 1 : 0;
    const isAiAssistantEnabled = ai_assistant_enabled ? 1 : 0;

    // Convert object payloads to strings if provided
    const cookiesStr = cookies ? (typeof cookies === 'string' ? cookies : JSON.stringify(cookies)) : '';
    const headersStr = headers ? (typeof headers === 'string' ? headers : JSON.stringify(headers)) : '';
    const postDataStr = post_data ? (typeof post_data === 'string' ? post_data : JSON.stringify(post_data)) : '';

    // Update settings table
    const stmt = db.prepare(`
      UPDATE automation_settings
      SET 
        enabled = ?,
        threads = ?,
        check_hours = ?,
        dm_template = ?,
        group_report_template = ?,
        break_minutes = ?,
        dm_delay_seconds = ?,
        comment_check_enabled = ?,
        like_check_enabled = ?,
        auto_dm_enabled = ?,
        auto_group_report_enabled = ?,
        scan_mode = ?,
        target_username = ?,
        admin_report_enabled = ?,
        admin_username = ?,
        scan_date = ?,
        dm_bulk_template = ?,
        ai_assistant_enabled = ?,
        ai_api_key = ?,
        ai_model = ?,
        ai_system_prompt = ?,
        ai_delay_seconds = ?,
        exempt_usernames = ?
        ${cookiesStr ? ', cookies = ?' : ''}
        ${headersStr ? ', headers = ?' : ''}
        ${postDataStr ? ', post_data = ?' : ''}
      WHERE id = 1
    `);

    const params = [
      isEnabled,
      threads || '',
      check_hours || '09:00,13:00,17:00,21:00',
      dm_template || '',
      group_report_template || '',
      Number(break_minutes) || 5,
      Number(dm_delay_seconds) || 30,
      isCommentCheck,
      isLikeCheck,
      isAutoDm,
      isAutoReport,
      scan_mode || 'all',
      target_username || '',
      isAdminReport,
      admin_username || '',
      scan_date || 'yesterday',
      dm_bulk_template || 'Merhaba {grup_ismi} grubunda eksiğiniz var dönüş yapmanız gerekiyor',
      isAiAssistantEnabled,
      ai_api_key || '',
      ai_model || 'openrouter/free',
      ai_system_prompt || 'Sen bir Instagram grup otomasyon asistanısın. Üyelerin eksik bildirimlerine ve sorularına nazikçe ve Türkçe cevap ver.',
      Number(ai_delay_seconds) ?? 30,
      exempt_usernames || ''
    ];

    if (cookiesStr) params.push(cookiesStr);
    if (headersStr) params.push(headersStr);
    if (postDataStr) params.push(postDataStr);

    stmt.run(...params);

    // Save thread specific configurations
    if (threads) {
      const activeIds = threads.split(',').filter(Boolean);
      if (activeIds.length > 0) {
        const placeholders = activeIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM automation_threads WHERE thread_id NOT IN (${placeholders})`).run(...activeIds);
      } else {
        db.prepare(`DELETE FROM automation_threads`).run();
      }
    } else {
      db.prepare(`DELETE FROM automation_threads`).run();
    }

    if (threads_config && Array.isArray(threads_config)) {
      const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO automation_threads (thread_id, comment_check_enabled, like_check_enabled, admin_report_enabled, admin_username, scan_mode)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      threads_config.forEach((cfg: any) => {
        insertStmt.run(
          cfg.thread_id,
          cfg.comment_check_enabled ? 1 : 0,
          cfg.like_check_enabled ? 1 : 0,
          cfg.admin_report_enabled ? 1 : 0,
          cfg.admin_username || '',
          cfg.scan_mode || 'all'
        );
      });
    }

    // Always keep background loop running for background seen worker
    startAutomationScheduler();

    return NextResponse.json({
      success: true,
      message: 'Otomasyon ayarları başarıyla kaydedildi.'
    });

  } catch (error: any) {
    console.error('[Automation-Settings-API] Save error:', error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to save settings'
    }, { status: 500 });
  }
}
