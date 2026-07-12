import { NextRequest } from 'next/server';
import { realtimeEmitter } from '@/lib/emitter';
import { startRealtimeBridge } from '@/lib/realtime-manager';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Extract and parse cookies from request parameters
  const { searchParams } = new URL(request.url);
  const cookiesParam = searchParams.get('cookies');
  const seqId = searchParams.get('seqId') || '0';
  if (cookiesParam) {
    try {
      const cookies = JSON.parse(decodeURIComponent(cookiesParam));
      // Start direct background WebSocket bridge asynchronously
      startRealtimeBridge(cookies, seqId).catch(err => {
        console.error('[SSE] Background realtime bridge error:', err);
      });
    } catch (e) {
      console.error('[SSE] Failed to parse cookies query parameter:', e);
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      console.log('[SSE] Browser client connected for realtime triggers.');
      
      // Send a connection established notification
      try {
        controller.enqueue('data: connected\n\n');
      } catch (e) {
        // stream is closed
      }

      const updateListener = () => {
        console.log('[SSE] Received legacy update. Broadcasting message sync to browser...');
        try {
          controller.enqueue('data: {"type":"message"}\n\n');
        } catch (e) {
          realtimeEmitter.off('update', updateListener);
        }
      };

      const eventListener = (eventData: any) => {
        console.log('[SSE] Received realtime event. Broadcasting to browser:', eventData.type);
        try {
          controller.enqueue(`data: ${JSON.stringify(eventData)}\n\n`);
        } catch (e) {
          realtimeEmitter.off('event', eventListener);
        }
      };

      // Register emitter listeners
      realtimeEmitter.on('update', updateListener);
      realtimeEmitter.on('event', eventListener);

      // Keepalive pings every 15 seconds to prevent stream timeout
      const keepAliveInterval = setInterval(() => {
        try {
          controller.enqueue('data: ping\n\n');
        } catch (e) {
          clearInterval(keepAliveInterval);
          realtimeEmitter.off('update', updateListener);
          realtimeEmitter.off('event', eventListener);
        }
      }, 15000);

      // Cleanup listeners when client closes the SSE stream
      request.signal.addEventListener('abort', () => {
        console.log('[SSE] Browser client disconnected.');
        clearInterval(keepAliveInterval);
        realtimeEmitter.off('update', updateListener);
        realtimeEmitter.off('event', eventListener);
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
}
