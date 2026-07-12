import { NextRequest } from 'next/server';
import { realtimeEmitter } from '@/lib/emitter';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  console.log('[SocketTrigger] Intercepted incoming live message trigger from Instagram WebSocket bridge.');
  
  // Broadcast update event to all active SSE dashboard connections
  realtimeEmitter.emit('update');

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}

// Handle CORS Preflight requests
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
