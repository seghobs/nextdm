import { IgApiClientExt, withFbnsAndRealtime, GraphQLSubscriptions, MQTToTConnection } from 'instagram_mqtt';
import { realtimeEmitter } from './emitter';
// @ts-ignore
import debug from 'debug';
import zlib from 'zlib';

// Programmatically enable all instagram API and MQTT client debug logs
debug.enable('ig:*');

let activeClient: any = null;
let activeSessionId: string | null = null;
let activeSeqId: string | null = null;
let isConnecting = false;

export async function startRealtimeBridge(cookies: Record<string, string>, seqId: string) {
  const sessionId = cookies['sessionid'];
  if (!sessionId) {
    console.log('[MQTT-Bridge] No sessionid cookie provided. Cannot start realtime bridge.');
    return;
  }

  // If already connected with the same session and same sequence ID, do nothing
  if (activeClient && activeSessionId === sessionId && activeSeqId === seqId) {
    return;
  }

  // If credentials or sequence ID changed, disconnect the old client first
  if (activeClient) {
    console.log(`[MQTT-Bridge] Session or sequence ID changed (stale: ${activeSeqId}, new: ${seqId}). Disconnecting old realtime bridge...`);
    try {
      await activeClient.realtime.disconnect();
    } catch (e) {}
    activeClient = null;
    activeSessionId = null;
    activeSeqId = null;
  }

  if (isConnecting) return;
  isConnecting = true;

  console.log(`[MQTT-Bridge] Starting direct Instagram WebSocket connection from backend with seqId: ${seqId}...`);

  try {
    const ig = new IgApiClientExt();

    // Redefine read-only app details to spoof a modern Android client
    Object.defineProperty(ig.state, 'appVersion', { get: () => '315.0.0.37.110' });
    Object.defineProperty(ig.state, 'appVersionCode', { get: () => '555234123' });
    Object.defineProperty(ig.state, 'appUserAgent', { 
      get: () => 'Instagram 315.0.0.37.110 Android (26/8.0.0; 480dpi; 1080x1920; HUAWEI/HONOR; STF-L09; HWSTF; hi3660; en_US; 555234123)' 
    });

    Object.defineProperty(ig.state, 'fbAnalyticsApplicationId', { get: () => '256212827726612' });
    Object.defineProperty(ig.state, 'fbOrcaApplicationId', { get: () => '124024574287414' });

    // Generate device matching user's account ID
    const userId = cookies['ds_user_id'] || decodeURIComponent(sessionId).split(':')[0];
    ig.state.generateDevice(userId || '0');

    // Inject cookies into tough-cookie store
    for (const [key, value] of Object.entries(cookies)) {
      ig.state.cookieJar.setCookie(`${key}=${value}`, 'https://instagram.com');
      ig.state.cookieJar.setCookie(`${key}=${value}`, 'https://i.instagram.com');
    }

    const igRealtime = withFbnsAndRealtime(ig);

    // Override constructConnection to spoof Web client and clear the message blacklist
    const rt = igRealtime.realtime as any;
    rt.constructConnection = function() {
      const userAgent = this.ig.state.appUserAgent;
      const deviceId = this.ig.state.phoneId;
      const sessionid = this.ig.state.extractCookieValue('sessionid');
      const password = `sessionid=${sessionid}`;
      
      this.connection = new MQTToTConnection({
          clientIdentifier: deviceId.substring(0, 20),
          clientInfo: {
              userId: BigInt(Number(this.ig.state.cookieUserId)),
              userAgent,
              clientCapabilities: BigInt(439), // Modern client capabilities
              endpointCapabilities: BigInt(128), // Modern endpoint capabilities
              publishFormat: 1,
              noAutomaticForeground: false,
              makeUserAvailableInForeground: true,
              deviceId,
              isInitiallyForeground: true,
              networkType: 1,
              networkSubtype: 0,
              clientMqttSessionId: BigInt(Date.now()) & BigInt(0xffffffff),
              subscribeTopics: [88, 135, 149, 150, 133, 146],
              clientType: 'cookie_auth',
              appId: BigInt(567067343352427), // Instagram Android App ID
              deviceSecret: '',
              clientStack: 3,
          },
          password,
          appSpecificInfo: {
              app_version: this.ig.state.appVersion,
              'X-IG-Capabilities': this.ig.state.capabilitiesHeader,
              everclear_subscriptions: JSON.stringify({
                  inapp_notification_subscribe_comment: '17899377895239777',
                  inapp_notification_subscribe_comment_mention_and_reply: '17899377895239777',
                  video_call_participant_state_delivery: '17977239895057311',
                  presence_subscribe: '17846944882223835',
              }),
              'User-Agent': userAgent,
              'Accept-Language': this.ig.state.language.replace('_', '-'),
              platform: 'android',
              ig_mqtt_route: 'django',
              pubsub_msg_type_blacklist: 'direct', // Allow typing indicators, routing DMs to Iris sync channel
              auth_cache_enabled: '0',
          },
      });
    };

    // Register event listeners
    igRealtime.realtime.on('error', (err: any) => {
      console.error('[MQTT-Bridge] Realtime error:', err);
    });

    igRealtime.realtime.on('close', () => {
      console.log('[MQTT-Bridge] Realtime connection closed.');
      if (activeSessionId === sessionId) {
        // Automatically restart connection if it closed unexpectedly
        activeClient = null;
        activeSessionId = null;
        isConnecting = false;
        setTimeout(() => startRealtimeBridge(cookies, seqId), 5000);
      }
    });

    igRealtime.realtime.on('message', (msg: any) => {
      const messageData = msg?.message || {};
      const path = messageData.path || '';
      
      // Check if this is a participant seen/read update instead of a new message
      if (path.includes('/participants/')) {
        console.log('[MQTT-Bridge] Raw messageData for participant seen event:', JSON.stringify(messageData));
        const threadId = messageData.thread_id;
        const participantMatch = path.match(/\/participants\/(\d+)/);
        const participantId = participantMatch ? participantMatch[1] : null;
        
        const watermark = messageData.timestamp || messageData.last_read_watermark_timestamp_ms || messageData.last_read_timestamp || messageData.read_timestamp;
        const itemId = messageData.item_id || messageData.last_read_item_id;
        
        if (threadId && participantId) {
          console.log(`[MQTT-Bridge] Read/Seen update (via message path): Thread ${threadId}, User ${participantId}, watermark: ${watermark}, itemId: ${itemId}`);
          realtimeEmitter.emit('event', {
            type: 'seen',
            threadId,
            userId: String(participantId),
            watermark: watermark ? String(watermark) : null,
            itemId: itemId ? String(itemId) : null
          });
          return;
        }
      }

      // Filter out system placeholder/reaction/action_log messages
      if (
        messageData.item_type === 'action_log' || 
        messageData.item_type === 'like' || 
        messageData.item_type === 'reaction' || 
        messageData.hide_in_thread === 1
      ) {
        console.log('[MQTT-Bridge] Ignoring system action_log/like message event:', messageData.item_id);
        return;
      }

      const threadId = messageData.thread_id;
      const itemId = messageData.item_id;
      const senderId = messageData.user_id;
      
      if (!senderId) {
        return; // Ignore system/empty packets without a sender ID
      }
      
      const text = messageData.text || '';
      // Convert microsecond timestamp to millisecond string
      const timestampMs = Math.floor(Number(messageData.timestamp || Date.now() * 1000) / 1000).toString();

      console.log(`[MQTT-Bridge] Direct message event: Thread ${threadId}, Text: "${text}", Sender: ${senderId}`);
      realtimeEmitter.emit('update');
      realtimeEmitter.emit('event', {
        type: 'message',
        threadId,
        message: {
          id: itemId,
          sender_fbid: senderId,
          timestamp_ms: timestampMs,
          text_body: text,
          igd_snippet: text,
          content_type: 'TEXT'
        }
      });
    });

    igRealtime.realtime.on('iris', (data: any) => {
      console.log('[MQTT-Bridge] Message sync (iris) event received.');
      realtimeEmitter.emit('update');
      realtimeEmitter.emit('event', { type: 'message' });
    });

    // Fallback: trigger update on ANY raw packet received on the realtime channel
    igRealtime.realtime.on('receive', (topic: any, messages: any) => {
      console.log('[MQTT-Bridge] Raw packet received on topic:', topic?.path || topic);
      realtimeEmitter.emit('update');
    });

    igRealtime.realtime.on('realtimeSub', (data: any) => {
      console.log('[MQTT-Bridge] realtimeSub raw data received:', data);
    });

    igRealtime.realtime.on('receiveRaw', (msg: any) => {
      console.log('[MQTT-Bridge] receiveRaw packet received:', msg.topic);
      if (msg.topic === '146' && msg.payload) {
        try {
          const rawStr = zlib.unzipSync(msg.payload).toString('utf8');
          const syncData = JSON.parse(rawStr);
          if (Array.isArray(syncData)) {
            for (const element of syncData) {
              const data = element.data;
              if (Array.isArray(data)) {
                data.forEach((e: any) => {
                  if (e.path && e.path.startsWith('/direct_v2/threads') && e.path.includes('/participants/')) {
                    const threadMatch = e.path.match(/^\/direct_v2\/threads\/(\d+)/);
                    const threadId = threadMatch ? threadMatch[1] : null;
                    const participantMatch = e.path.match(/\/participants\/(\d+)/);
                    const participantId = participantMatch ? participantMatch[1] : null;
                    
                    if (threadId && participantId && e.value !== undefined) {
                      let val = e.value;
                      if (typeof val === 'string') {
                        try {
                          val = JSON.parse(val);
                        } catch (err) {}
                      }
                      
                      const watermark = (typeof val === 'object' && val !== null)
                        ? (val.timestamp || val.last_read_watermark_timestamp_ms || val.last_read_timestamp || val.read_timestamp)
                        : val;
                      const itemId = (typeof val === 'object' && val !== null)
                        ? (val.item_id || val.last_read_item_id)
                        : null;
                      
                      console.log(`[MQTT-Bridge] Extracted Seen update from raw topic 146: Thread ${threadId}, User ${participantId}, watermark: ${watermark}, itemId: ${itemId}`);
                      
                      realtimeEmitter.emit('event', {
                        type: 'seen',
                        threadId,
                        userId: String(participantId),
                        watermark: watermark ? String(watermark) : null,
                        itemId: itemId ? String(itemId) : null
                      });
                    }
                  }
                  
                  if (e.path && e.path.startsWith('/direct_v2/threads') && e.path.includes('/reactions/likes/')) {
                    const threadMatch = e.path.match(/^\/direct_v2\/threads\/(\d+)/);
                    const threadId = threadMatch ? threadMatch[1] : null;
                    const itemMatch = e.path.match(/\/items\/([A-Za-z0-9_-]+|\d+)/);
                    const messageId = itemMatch ? itemMatch[1] : null;
                    const senderMatch = e.path.match(/\/reactions\/likes\/(\d+)/);
                    const senderId = senderMatch ? senderMatch[1] : null;
                    
                    if (threadId && messageId && senderId) {
                      const isAdded = e.op === 'add' || e.op === 'replace';
                      console.log(`[MQTT-Bridge] Extracted Reaction update from raw topic 146: Thread ${threadId}, Message ${messageId}, User ${senderId}, added: ${isAdded}`);
                      
                      realtimeEmitter.emit('event', {
                        type: 'reaction',
                        threadId,
                        messageId,
                        userId: String(senderId),
                        reaction: '❤️',
                        isAdded
                      });
                    }
                  }
                });
              }
            }
          }
        } catch (err) {
          console.error('[MQTT-Bridge] Failed to parse raw topic 146 payload:', err);
        }
      }
    });

    igRealtime.realtime.on('direct', (data: any) => {
      console.log('[MQTT-Bridge] direct event received:', JSON.stringify(data));
      if (!data || !data.path) return;
      
      const path = data.path;
      const threadMatch = path.match(/\/direct_v2\/threads\/(\d+)/);
      const threadId = threadMatch ? threadMatch[1] : null;

      if (path.includes('activity_indicator_id')) {
        const val = data.value || {};
        
        if (threadId && val.sender_id) {
          const senderId = val.sender_id;
          const isTyping = val.activity_status === 1;
          console.log(`[MQTT-Bridge] Typing update (direct event): Thread ${threadId}, User ${senderId}, typing: ${isTyping}`);
          
          realtimeEmitter.emit('event', {
            type: 'typing',
            threadId,
            userId: String(senderId),
            isTyping
          });
        }
      } else if (path.includes('/participants')) {
        const participantMatch = path.match(/\/participants\/(\d+)/);
        const participantId = participantMatch ? participantMatch[1] : null;
        
        let val = data.value;
        if (typeof val === 'string') {
          try {
            val = JSON.parse(val);
          } catch(e) {}
        }

        if (threadId && val) {
          if (participantId) {
            const watermark = val.last_read_watermark_timestamp_ms || val.last_read_timestamp || val.read_timestamp;
            const itemId = val.last_read_item_id;
            
            console.log(`[MQTT-Bridge] Read/Seen update (direct event): Thread ${threadId}, User ${participantId}, watermark: ${watermark}, itemId: ${itemId}`);
            
            realtimeEmitter.emit('event', {
              type: 'seen',
              threadId,
              userId: String(participantId),
              watermark: watermark ? String(watermark) : null,
              itemId: itemId ? String(itemId) : null
            });
          } else if (Array.isArray(val)) {
            val.forEach((p: any) => {
              const pId = p.user_id || p.id;
              const watermark = p.last_read_watermark_timestamp_ms || p.last_read_timestamp;
              const itemId = p.last_read_item_id;
              if (pId) {
                console.log(`[MQTT-Bridge] Read/Seen update array: Thread ${threadId}, User ${pId}, watermark: ${watermark}`);
                realtimeEmitter.emit('event', {
                  type: 'seen',
                  threadId,
                  userId: String(pId),
                  watermark: watermark ? String(watermark) : null,
                  itemId: itemId ? String(itemId) : null
                });
              }
            });
          }
        }
      }
    });

    // Construct Skywalker and GraphQL subscriptions matching the user's ID
    const skywalkerSubs = [
      `ig/u/v1/${userId}`,
      `ig/live_notification/${userId}`
    ];
    const graphQlSubs = [
      GraphQLSubscriptions.getDirectStatusSubscription({ clientLogged: true }),
      GraphQLSubscriptions.getDirectTypingSubscription(userId, true),
      GraphQLSubscriptions.getClientConfigUpdateSubscription({ clientLogged: true }),
      GraphQLSubscriptions.getAppPresenceSubscription({ clientLogged: true })
    ];

    console.log('[MQTT-Bridge] Subscribing to Skywalker and GraphQL topics for user ID:', userId);

    const initOptions = {
      skywalkerSubs,
      graphQlSubs,
      irisData: {
        seq_id: parseInt(seqId, 10) || 0,
        snapshot_at_ms: Date.now(),
      }
    };

    // Connect to gateway passing options directly
    await igRealtime.realtime.connect(initOptions);
    
    activeClient = igRealtime;
    activeSessionId = sessionId;
    activeSeqId = seqId;
    console.log('[MQTT-Bridge] Direct Instagram WebSocket connection successfully established!');
  } catch (err) {
    console.error('[MQTT-Bridge] Failed to establish direct connection:', err);
    activeClient = null;
    activeSessionId = null;
    activeSeqId = null;
  } finally {
    isConnecting = false;
  }
}

export async function sendTypingIndicator(threadId: string, isActive: boolean): Promise<boolean> {
  if (!activeClient) {
    console.log('[MQTT-Bridge] No active realtime client to send typing indicator.');
    return false;
  }
  
  try {
    console.log(`[MQTT-Bridge] Sending typing indicator to thread ${threadId}: ${isActive}`);
    await activeClient.realtime.direct.indicateActivity({
      threadId,
      isActive
    });
    return true;
  } catch (err) {
    console.error('[MQTT-Bridge] Failed to send typing indicator:', err);
    return false;
  }
}
