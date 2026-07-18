import { NextResponse } from 'next/server';
import db from '@/lib/db';

export async function GET() {
  try {
    const logs = db.prepare('SELECT * FROM automation_logs ORDER BY id DESC LIMIT 100').all();
    return NextResponse.json({
      success: true,
      logs
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to fetch automation logs'
    }, { status: 500 });
  }
}
