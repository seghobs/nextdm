import dns from 'dns';
const originalLookup = dns.lookup;
(dns as any).lookup = function(hostname: any, options: any, callback: any) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'object' ? options : {};
  if (hostname === 'generativelanguage.googleapis.com') {
    if (opts.all) {
      return cb(null, [{ address: '216.239.38.223', family: 4 }]);
    }
    return cb(null, '216.239.38.223', 4);
  }
  return originalLookup(hostname, options, callback);
};

import db, { AutomationSettings } from './db';
import { DEFAULT_HEADERS, DEFAULT_COOKIES, DEFAULT_DATA } from './instagram-defaults';
import { scrapeTokens } from './token-scraper';
import { sendTypingIndicator, startRealtimeBridge } from './realtime-manager';

// Create table to track user messages that the AI has responded to (prevents concurrent/multiple replies)
db.prepare('CREATE TABLE IF NOT EXISTS ai_responded_messages (user_message_id TEXT PRIMARY KEY, thread_id TEXT, responded_at INTEGER)').run();
// Create table to track AI interactive conversation states for users
db.prepare('CREATE TABLE IF NOT EXISTS ai_user_states (username TEXT PRIMARY KEY, state TEXT, data TEXT, updated_at INTEGER)').run();

function getIstanbulDateStr(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  let year = '';
  let month = '';
  let day = '';
  parts.forEach(p => {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'day') day = p.value;
  });
  return `${year}-${month}-${day}`;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

if (!(global as any).automationState) {
  (global as any).automationState = {
    schedulerInterval: null,
    lastRunMinuteStr: '',
    isRunningNow: false,
    abortScan: false,
    scheduledSeens: {},
    lastInboxCheckTime: 0
  };
}
if (!(global as any).automationState.scheduledSeens) {
  (global as any).automationState.scheduledSeens = {};
}
if (typeof (global as any).automationState.lastInboxCheckTime === 'undefined') {
  (global as any).automationState.lastInboxCheckTime = 0;
}
if (!(global as any).automationState.aiQueue) {
  (global as any).automationState.aiQueue = [];
}
if (typeof (global as any).automationState.processingAIQueue === 'undefined') {
  (global as any).automationState.processingAIQueue = false;
}
const getSchedulerState = () => (global as any).automationState;

// Log message helper
export function logMessage(type: 'info' | 'warning' | 'error' | 'success', message: string) {
  try {
    console.log(`[Automation-${type.toUpperCase()}] ${message}`);
    db.prepare('INSERT INTO automation_logs (type, message) VALUES (?, ?)')
      .run(type, message);
  } catch (err) {
    console.error('Failed to write log to DB:', err);
  }
}

// Convert shortcode to media ID (pk)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function shortcodeToMediaId(shortcode: string): string {
  try {
    let id = BigInt(0);
    for (let i = 0; i < shortcode.length; i++) {
      const char = shortcode[i];
      const charIndex = BigInt(ALPHABET.indexOf(char));
      if (charIndex === BigInt(-1)) return '';
      id = id * BigInt(64) + charIndex;
    }
    return id.toString();
  } catch (e) {
    return '';
  }
}

// Helper to convert media ID to shortcode
function mediaIdToShortcode(mediaIdStr: string): string {
  const cleanId = mediaIdStr.split('_')[0];
  try {
    let id = BigInt(cleanId);
    let shortcode = '';
    while (id > BigInt(0)) {
      const remainder = Number(id % BigInt(64));
      shortcode = ALPHABET[remainder] + shortcode;
      id = id / BigInt(64);
    }
    return shortcode;
  } catch (e) {
    return mediaIdStr;
  }
}

// Extract shared post info from thread direct messages
function extractSharedPost(items: any[]): { mediaId: string; shortcode: string } | null {
  const sorted = [...items].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  for (const item of sorted) {
    // 1. Direct media share item type
    const mediaShare = item.media_share || item.direct_media_share?.media;
    if (mediaShare) {
      const mediaId = String(mediaShare.pk || mediaShare.id || '');
      const shortcode = String(mediaShare.code || '');
      if (mediaId && shortcode) {
        return { mediaId, shortcode };
      }
    }
    // 2. Link share or text containing Instagram post url
    const text = item.text || item.link?.text || '';
    if (text) {
      const match = text.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
      if (match) {
        const shortcode = match[1];
        const mediaId = shortcodeToMediaId(shortcode);
        if (mediaId) {
          return { mediaId, shortcode };
        }
      }
    }
  }
  return null;
}

interface LockedPost {
  thread_id: string;
  media_id: string;
  shortcode: string;
  lock_date: string;
  comments_disabled: number;
}

async function checkPostStatus(shortcode: string, cookieStr: string, headers: Record<string, string>): Promise<{ exists: boolean; commentsDisabled: boolean }> {
  try {
    const pageRes = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
        'cookie': cookieStr,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });

    if (pageRes.status === 404) {
      return { exists: false, commentsDisabled: false };
    }

    if (pageRes.ok) {
      const html = await pageRes.text();
      const commentsDisabled = html.includes('"comments_disabled":true') || html.includes('\\"comments_disabled\\":true');
      return { exists: true, commentsDisabled };
    }
  } catch (e) {
    console.error(`[Automation-CheckPost] Error checking status for ${shortcode}:`, e);
  }
  return { exists: true, commentsDisabled: false };
}

// Helper to extract all unique posts shared yesterday in the thread
function getYesterdayPosts(
  items: any[],
  usersList: any[],
  viewerId: string,
  yesterdayStr: string,
  todayStr: string,
  isCheckingToday: boolean
): { 
  posts: { mediaId: string; shortcode: string; senderUsername: string; timestamp: number }[];
  skipLogs: string[];
} {
  const postsMap = new Map<string, { mediaId: string; shortcode: string; senderUsername: string; timestamp: number }>();
  const skipLogs: string[] = [];
  
  items.forEach((item: any) => {
    const tsMicro = Number(item.timestamp || 0);
    const tsMs = Math.floor(tsMicro / 1000);
    const itemDate = new Date(tsMs);
    const postDateStr = getIstanbulDateStr(itemDate);
    const timeStr = itemDate.toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' });

    let mediaId = '';
    let shortcode = '';
    
    const mediaShare = item.media_share || item.direct_media_share?.media;
    const clipShare = item.clip?.clip || item.clip?.media || item.clip;
    
    if (mediaShare) {
      mediaId = String(mediaShare.pk || mediaShare.id || '');
      shortcode = String(mediaShare.code || '');
    } else if (clipShare && (clipShare.code || clipShare.pk || clipShare.id)) {
      mediaId = String(clipShare.pk || clipShare.id || '');
      shortcode = String(clipShare.code || '');
    } else {
      const text = item.text || item.link?.text || '';
      if (text) {
        const match = text.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/i);
        if (match) {
          shortcode = match[1];
          mediaId = shortcodeToMediaId(shortcode) || '';
        }
      }
    }

    if (mediaId && shortcode) {
      const senderId = String(item.user_id || item.sender_fbid || '');
      let senderUsername = '';
      
      if (senderId === String(viewerId)) {
        senderUsername = 'ben';
      } else {
        const senderUser = usersList.find((u: any) => {
          const uId = String(u.id || u.pk || u.interop_messaging_user_fbid || '');
          return uId !== '' && uId === senderId;
        });
        if (senderUser && senderUser.username) {
          senderUsername = senderUser.username.toLowerCase().trim();
        }
      }

      if (postDateStr === yesterdayStr) {
        postsMap.set(shortcode, {
          mediaId,
          shortcode,
          senderUsername,
          timestamp: tsMs
        });
      } else if (postDateStr === todayStr) {
        skipLogs.push(`Gönderi/Reel (Kısakod: ${shortcode}, Gönderen: @${senderUsername || 'bilinmeyen'}) BUGÜN (${timeStr}) paylaşıldığı için (yarın kontrol edilmek üzere) atlandı.`);
      } else {
        const formattedItemDate = itemDate.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', timeZone: 'Europe/Istanbul' });
        skipLogs.push(`Gönderi/Reel (Kısakod: ${shortcode}, Gönderen: @${senderUsername || 'bilinmeyen'}) ${formattedItemDate} (${timeStr}) tarihinde paylaşıldığı için (düne ait olmadığından) atlandı.`);
      }
    }
  });

  const sortedPosts = Array.from(postsMap.values()).sort((a, b) => b.timestamp - a.timestamp);
  return {
    posts: sortedPosts,
    skipLogs
  };
}

async function selectAndLockPost(
  threadId: string, 
  items: any[], 
  usersList: any[],
  viewerId: string,
  targetUsername: string,
  cookieStr: string,
  headers: Record<string, string>
): Promise<{ mediaId: string; shortcode: string } | null> {
  
  const todayStr = getIstanbulDateStr(new Date());

  const locked = db.prepare('SELECT * FROM locked_posts WHERE thread_id = ?').get(threadId) as LockedPost | undefined;
  
  if (locked) {
    if (locked.lock_date === todayStr) {
      const status = await checkPostStatus(locked.shortcode, cookieStr, headers);
      if (status.exists) {
        const commentsDisabledVal = status.commentsDisabled ? 1 : 0;
        db.prepare('UPDATE locked_posts SET comments_disabled = ? WHERE thread_id = ?').run(commentsDisabledVal, threadId);
        console.log(`[Automation] Thread ${threadId} has locked post for today: ${locked.shortcode} (Comments Disabled: ${status.commentsDisabled})`);
        return { mediaId: locked.media_id, shortcode: locked.shortcode };
      } else {
        console.warn(`[Automation] Locked post ${locked.shortcode} for thread ${threadId} was deleted. Releasing lock.`);
        db.prepare('DELETE FROM locked_posts WHERE thread_id = ?').run(threadId);
      }
    } else {
      db.prepare('DELETE FROM locked_posts WHERE thread_id = ?').run(threadId);
    }
  }

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayStr = getIstanbulDateStr(yesterday);

  const sharedPosts: any[] = [];
  items.forEach((item: any) => {
    const tsMicro = Number(item.timestamp || 0);
    const tsMs = Math.floor(tsMicro / 1000);

    const postDateStr = getIstanbulDateStr(new Date(tsMs));
    if (postDateStr === yesterdayStr) {
      let mediaId = '';
      let shortcode = '';
      
      const mediaShare = item.media_share || item.direct_media_share?.media;
      const clipShare = item.clip?.clip || item.clip?.media || item.clip;
      
      if (mediaShare) {
        mediaId = String(mediaShare.pk || mediaShare.id || '');
        shortcode = String(mediaShare.code || '');
      } else if (clipShare && (clipShare.code || clipShare.pk || clipShare.id)) {
        mediaId = String(clipShare.pk || clipShare.id || '');
        shortcode = String(clipShare.code || '');
      } else {
        const text = item.text || item.link?.text || '';
        if (text) {
          const match = text.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/i);
          if (match) {
            shortcode = match[1];
            mediaId = shortcodeToMediaId(shortcode) || '';
          }
        }
      }

      if (mediaId && shortcode) {
        const senderId = String(item.user_id || item.sender_fbid || '');
        let senderUsername = '';
        
        if (senderId === String(viewerId)) {
          senderUsername = 'ben';
        } else {
          const senderUser = usersList.find((u: any) => {
            const uId = String(u.id || u.pk || u.interop_messaging_user_fbid || '');
            return uId !== '' && uId === senderId;
          });
          if (senderUser && senderUser.username) {
            senderUsername = senderUser.username.toLowerCase().trim();
          }
        }

        sharedPosts.push({
          mediaId,
          shortcode,
          timestamp: tsMs,
          senderUsername
        });
      }
    }
  });

  if (sharedPosts.length === 0) {
    return null;
  }

  sharedPosts.sort((a, b) => b.timestamp - a.timestamp);

  if (targetUsername) {
    const cleanTarget = targetUsername.toLowerCase().trim();
    const targetPost = sharedPosts.find(p => p.senderUsername === cleanTarget);
    if (targetPost) {
      const status = await checkPostStatus(targetPost.shortcode, cookieStr, headers);
      if (status.exists) {
        const commentsDisabledVal = status.commentsDisabled ? 1 : 0;
        db.prepare('INSERT OR REPLACE INTO locked_posts (thread_id, media_id, shortcode, lock_date, comments_disabled) VALUES (?, ?, ?, ?, ?)')
          .run(threadId, targetPost.mediaId, targetPost.shortcode, todayStr, commentsDisabledVal);
        console.log(`[Automation] Selected override post for user ${targetUsername}: ${targetPost.shortcode} (Comments Disabled: ${status.commentsDisabled})`);
        return { mediaId: targetPost.mediaId, shortcode: targetPost.shortcode };
      }
    }
  }

  for (const post of sharedPosts) {
    const status = await checkPostStatus(post.shortcode, cookieStr, headers);
    if (status.exists) {
      const commentsDisabledVal = status.commentsDisabled ? 1 : 0;
      db.prepare('INSERT OR REPLACE INTO locked_posts (thread_id, media_id, shortcode, lock_date, comments_disabled) VALUES (?, ?, ?, ?, ?)')
        .run(threadId, post.mediaId, post.shortcode, todayStr, commentsDisabledVal);
      console.log(`[Automation] Locked post for today: ${post.shortcode} (Comments Disabled: ${status.commentsDisabled})`);
      return { mediaId: post.mediaId, shortcode: post.shortcode };
    }
  }

  return null;
}

// Helper to extract group members who sent a shared post message yesterday (Turkey Time - GMT+3)
function getYesterdaySenders(items: any[], usersList: any[], viewerId: string, targetDateStr: string): any[] {
  const yesterdaySendersMap = new Map<string, any>();

  items.forEach((item: any) => {
    const tsMicro = Number(item.timestamp || 0);
    const tsMs = Math.floor(tsMicro / 1000);
    
    const postDateStr = getIstanbulDateStr(new Date(tsMs));
    if (postDateStr === targetDateStr) {
      const mediaShare = item.media_share || item.direct_media_share?.media;
      const clipShare = item.clip?.clip || item.clip?.media || item.clip;
      const text = (item.text || item.link?.text || '').toLowerCase();
      const hasMedia = mediaShare || clipShare || item.story_share || item.reel_share || item.media_id || item.media_preview_url || text.includes('/reel/') || text.includes('/p/') || text.includes('/reels/');
      
      if (hasMedia) {
        const senderId = String(item.user_id || item.sender_fbid || '');
        if (senderId) {
          if (senderId === String(viewerId)) {
            yesterdaySendersMap.set('ben', {
              pk: viewerId,
              id: viewerId,
              username: 'Ben',
              full_name: 'Giriş Yapmış Kullanıcı'
            });
          } else {
            const senderUser = usersList.find((u: any) => {
              const uId = String(u.id || u.pk || u.interop_messaging_user_fbid || '');
              return uId !== '' && uId === senderId;
            });
            if (senderUser && senderUser.username) {
              yesterdaySendersMap.set(senderUser.username.toLowerCase().trim(), {
                pk: senderUser.pk || senderUser.id,
                id: senderUser.pk || senderUser.id,
                username: senderUser.username,
                full_name: senderUser.full_name || senderUser.username
              });
            }
          }
        }
      }
    }
  });

  return Array.from(yesterdaySendersMap.values());
}

// Send seen/read receipt mutation
async function sendSeenIndicator(threadId: string, messageId: string, timestampMs: string | number, cookies: Record<string, string>, headers: Record<string, string>, postData: any) {
  const cookieHeaderStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
  const baseHeaders = {
    ...DEFAULT_HEADERS,
    ...headers,
    'cookie': cookieHeaderStr,
    'content-type': 'application/x-www-form-urlencoded',
  };

  let fbDtsg = postData.fb_dtsg || '';
  let lsdToken = postData.lsd || '';
  try {
    const tokens = await scrapeTokens(cookieHeaderStr);
    fbDtsg = tokens.fbDtsg || fbDtsg;
    lsdToken = tokens.lsd || lsdToken;
  } catch {}

  let finalTimestampMs = Number(timestampMs || Date.now());
  if (finalTimestampMs > 9999999999999) {
    finalTimestampMs = Math.floor(finalTimestampMs / 1000);
  }

  const validationVariables = {
    metadata: { ig_thread_igid: threadId },
    data: {
      message_id: messageId,
      message_timestamp_ms: String(finalTimestampMs)
    }
  };

  const markReadVariables = {
    metadata: { ig_thread_igid: threadId },
    data: { item_id: messageId, message_id: messageId }
  };

  const validationForm = new URLSearchParams();
  Object.entries({
    ...postData,
    'fb_api_req_friendly_name': 'useIGDMarkThreadAsReadValidationMutation',
    'variables': JSON.stringify(validationVariables),
    'doc_id': '35211594988486314',
    ...(fbDtsg ? { fb_dtsg: fbDtsg } : {}),
    ...(lsdToken ? { lsd: lsdToken } : {})
  }).forEach(([k, v]) => validationForm.append(k, String(v)));

  const markReadForm = new URLSearchParams();
  Object.entries({
    ...postData,
    'fb_api_req_friendly_name': 'useIGDMarkThreadAsReadMutation',
    'variables': JSON.stringify(markReadVariables),
    'doc_id': '27356881703909995',
    ...(fbDtsg ? { fb_dtsg: fbDtsg } : {}),
    ...(lsdToken ? { lsd: lsdToken } : {})
  }).forEach(([k, v]) => markReadForm.append(k, String(v)));

  try {
    const [validationRes, markReadRes] = await Promise.all([
      fetch('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'x-fb-friendly-name': 'useIGDMarkThreadAsReadValidationMutation',
        },
        body: validationForm.toString()
      }),
      fetch('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'x-fb-friendly-name': 'useIGDMarkThreadAsReadMutation',
        },
        body: markReadForm.toString()
      })
    ]);

    if (!validationRes.ok || !markReadRes.ok) {
      console.error(`[Automation-Seen] Failed to mark thread as read on Instagram:`, {
        validationStatus: validationRes.status,
        markReadStatus: markReadRes.status
      });
      return false;
    }

    const [validationText, markReadText] = await Promise.all([
      validationRes.text(),
      markReadRes.text()
    ]);
    console.log(`[Automation-Seen] Validation response: ${validationText}`);
    console.log(`[Automation-Seen] Mark read response: ${markReadText}`);
    
    return true;
  } catch (e) {
    console.error('[Automation-Seen] Failed to send seen indicator:', e);
    return false;
  }
}

// Generate phonetically matching Turkish suffixes for usernames (e.g. 'in' or 'ın')
function getTurkishSuffix(username: string): string {
  const clean = username.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!clean) return 'in';
  
  const vowels = ['a', 'ı', 'o', 'u', 'e', 'i', 'ö', 'ü'];
  let lastVowel = '';
  for (let i = clean.length - 1; i >= 0; i--) {
    if (vowels.includes(clean[i])) {
      lastVowel = clean[i];
      break;
    }
  }
  
  if (!lastVowel) return 'in';
  if (['a', 'ı', 'o', 'u'].includes(lastVowel)) {
    return 'ın';
  }
  return 'in';
}

// Resolve a numeric Instagram user ID from a username using web_profile_info
async function resolveUserIdByUsername(username: string, cookies: Record<string, string>, headers: Record<string, string>): Promise<string | null> {
  const usernameClean = username.toLowerCase().trim().replace(/^@/, '');
  if (!usernameClean) return null;
  const cookieHeaderStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');

  try {
    console.log(`[Automation-Resolver] Looking up user ID for: @${usernameClean}`);
    const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${usernameClean}`, {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
        'cookie': cookieHeaderStr,
        'referer': `https://www.instagram.com/${usernameClean}/`,
      },
      cache: 'no-store'
    });

    if (res.ok) {
      const json = await res.json();
      const userId = json.data?.user?.id;
      if (userId) {
        console.log(`[Automation-Resolver] Successfully resolved @${usernameClean} to ID: ${userId}`);
        return String(userId);
      }
    } else {
      console.warn(`[Automation-Resolver] Web profile info returned non-OK status: ${res.status}`);
    }
  } catch (e) {
    console.error(`[Automation-Resolver] Failed to resolve @${usernameClean}:`, e);
  }
  return null;
}

// Send direct message using saved cookies/headers with seen and typing indicators
async function sendDirectMessage(
  recipientId: string, 
  text: string, 
  cookies: Record<string, string>, 
  headers: Record<string, string>, 
  postData: any, 
  inboxThreads: any[] = [],
  skipSimulation: boolean = false
) {
  const cookieHeaderStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
  const viewerId = cookies['ds_user_id'];

  // Find 1-to-1 thread with this recipient if it exists in inbox
  const existingThread = inboxThreads.find((t: any) => 
    !t.is_group && 
    t.users?.some((u: any) => String(u.pk || u.id) === String(recipientId))
  );
  const targetTypingThreadId = existingThread?.thread_id || null;

  if (!skipSimulation) {
    // 1. Simulating seen indicator if partner sent the last message
    if (targetTypingThreadId && existingThread) {
      const threadItems = existingThread.items || [];
      let latestMsg = null;
      if (threadItems.length > 0) {
        const sorted = [...threadItems].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
        latestMsg = sorted[sorted.length - 1] || null;
      }

      const isPartner = latestMsg && String(latestMsg.user_id) !== String(viewerId);
      const latestMsgId = latestMsg.message_id || latestMsg.item_id;
      if (latestMsgId && isPartner) {
        console.log(`[Automation-DM] Simulating read receipt for recipient ${recipientId} on thread ${targetTypingThreadId}`);
        await sendSeenIndicator(targetTypingThreadId, latestMsgId, latestMsg.timestamp, cookies, headers, postData);
      }
    }

    // 2. Simulating typing start indicator
    if (targetTypingThreadId) {
      console.log(`[Automation-DM] Simulating typing start on thread ${targetTypingThreadId}`);
      try {
        await sendTypingIndicator(targetTypingThreadId, true).catch(() => {});
      } catch {}

      // Wait a random duration of 6 to 10 seconds for realistic typing
      const typingDelay = Math.floor(Math.random() * 4000) + 6000;
      await sleep(typingDelay);
    }
  }

  // Scrape fresh tokens
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
    'x-fb-friendly-name': 'IGDirectTextSendMutation',
    'referer': 'https://www.instagram.com/direct/inbox/',
  };

  const offlineThreadingId = String(Math.floor(Math.random() * 9000000000000000) + 1000000000000000) + String(Math.floor(Math.random() * 1000));
  const isThreadId = String(recipientId).length > 15;
  const variablesObj = {
    ig_thread_igid: isThreadId ? String(recipientId) : null,
    offline_threading_id: offlineThreadingId,
    recipient_igids: isThreadId ? null : [String(recipientId)],
    replied_to_client_context: null,
    replied_to_item_id: null,
    reply_to_message_id: null,
    sampled: null,
    text: { sensitive_string_value: text },
    mentions: [],
    mentioned_user_ids: [],
    commands: null,
    forwarded_from_thread_id: null,
    is_forwarded_from_own_message: null,
    send_attribution: 'igd_web_chat_tab:in_thread'
  };

  const formBody = new URLSearchParams();
  const postDataFields = {
    ...postData,
    'fb_api_req_friendly_name': 'IGDirectTextSendMutation',
    'variables': JSON.stringify(variablesObj),
    'doc_id': '26911679871773184',
    ...(fbDtsg ? { fb_dtsg: fbDtsg } : {}),
    ...(lsdToken ? { lsd: lsdToken } : {})
  };

  Object.entries(postDataFields).forEach(([k, v]) => formBody.append(k, String(v)));
  
  const res = await fetch('https://www.instagram.com/api/graphql', {
    method: 'POST',
    headers: headersToSend,
    body: formBody.toString()
  });

  let success = false;
  let messageId: string | undefined = undefined;
  try {
    if (res.ok) {
      const json = await res.json();
      if (json.errors && json.errors.length > 0) {
        console.error(`[Direct-Message] GraphQL error sending to ${recipientId}:`, JSON.stringify(json.errors));
      } else {
        success = true;
        messageId = json.data?.xig_direct_text_send_with_slide_messaging_response?.message_id || json.data?.xig_direct_text_send_with_slide_messaging_response?.id;
      }
    } else {
      console.error(`[Direct-Message] HTTP error sending to ${recipientId}: Status ${res.status}`, await res.text().catch(() => ''));
    }
  } catch (err: any) {
    console.error(`[Direct-Message] Parse error sending to ${recipientId}:`, err.message);
    success = res.ok;
  }

  // 4. Simulating typing stop indicator
  if (targetTypingThreadId) {
    console.log(`[Automation-DM] Simulating typing stop on thread ${targetTypingThreadId}`);
    try {
      await sendTypingIndicator(targetTypingThreadId, false).catch(() => {});
    } catch {}
  }

  return { success, messageId };
}

// Send message to thread (for group reports)
async function sendThreadMessage(threadId: string, text: string, cookies: Record<string, string>, headers: Record<string, string>, postData: any) {
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
    'x-fb-friendly-name': 'IGDirectTextSendMutation',
    'referer': `https://www.instagram.com/direct/t/${threadId}/`,
  };

  const offlineThreadingId = String(Math.floor(Math.random() * 9000000000000000) + 1000000000000000) + String(Math.floor(Math.random() * 1000));
  const variablesObj = {
    ig_thread_igid: threadId,
    offline_threading_id: offlineThreadingId,
    recipient_igids: null,
    replied_to_client_context: null,
    replied_to_item_id: null,
    reply_to_message_id: null,
    sampled: null,
    text: { sensitive_string_value: text },
    mentions: [],
    mentioned_user_ids: [],
    commands: null,
    forwarded_from_thread_id: null,
    is_forwarded_from_own_message: null,
    send_attribution: 'igd_web_chat_tab:in_thread'
  };

  const formBody = new URLSearchParams();
  const postDataFields = {
    ...postData,
    'fb_api_req_friendly_name': 'IGDirectTextSendMutation',
    'variables': JSON.stringify(variablesObj),
    'doc_id': '26911679871773184',
    ...(fbDtsg ? { fb_dtsg: fbDtsg } : {}),
    ...(lsdToken ? { lsd: lsdToken } : {})
  };

  Object.entries(postDataFields).forEach(([k, v]) => formBody.append(k, String(v)));
  
  const res = await fetch('https://www.instagram.com/api/graphql', {
    method: 'POST',
    headers: headersToSend,
    body: formBody.toString()
  });
  
  let success = false;
  let messageId: string | undefined = undefined;
  try {
    if (res.ok) {
      const json = await res.json();
      if (json.errors && json.errors.length > 0) {
        console.error(`[Thread-Message] GraphQL error sending to thread ${threadId}:`, JSON.stringify(json.errors));
      } else {
        success = true;
        messageId = json.data?.xig_direct_text_send_with_slide_messaging_response?.message_id || json.data?.xig_direct_text_send_with_slide_messaging_response?.id;
      }
    }
  } catch (err: any) {
    console.error(`[Thread-Message] Parse error sending to thread ${threadId}:`, err.message);
    success = res.ok;
  }
  return { success, messageId };
}

// Perform comment fetch sequence
async function fetchAllComments(mediaId: string, cookieStr: string, headers: Record<string, string>, postData: any): Promise<Set<string>> {
  const commenters = new Set<string>();
  let hasNext = true;
  let cursor = '';
  let page = 1;
  const maxPages = 10;

  let fbDtsg = postData.fb_dtsg || '';
  let lsdToken = postData.lsd || '';
  try {
    const tokens = await scrapeTokens(cookieStr);
    fbDtsg = tokens.fbDtsg || fbDtsg;
    lsdToken = tokens.lsd || lsdToken;
  } catch {}

  const baseHeaders = {
    ...DEFAULT_HEADERS,
    ...headers,
    'cookie': cookieStr,
    'x-ig-app-id': '936619743392459',
  };

  const sortSources = ['recent', 'timed'];

  for (const sort of sortSources) {
    hasNext = true;
    cursor = '';
    page = 1;

    while (hasNext && page <= maxPages) {
      try {
        const variables = {
          after: cursor || null,
          before: null,
          first: 20,
          last: null,
          media_id: mediaId,
          sort_order: sort,
          __relay_internal__pv__PolarisIsLoggedInrelayprovider: true
        };

        const form = new URLSearchParams();
        Object.entries({
          ...postData,
          'fb_api_req_friendly_name': 'PolarisPostCommentsPaginationQuery',
          'variables': JSON.stringify(variables),
          'doc_id': '26864966453197043',
          ...(fbDtsg ? { 'fb_dtsg': fbDtsg } : {}),
          ...(lsdToken ? { 'lsd': lsdToken } : {})
        }).forEach(([k, v]) => form.append(k, String(v)));

        const res = await fetch('https://www.instagram.com/api/graphql', {
          method: 'POST',
          headers: {
            ...baseHeaders,
            'content-type': 'application/x-www-form-urlencoded',
            'x-fb-friendly-name': 'PolarisPostCommentsPaginationQuery',
            'x-fb-lsd': postData.lsd || DEFAULT_DATA.lsd,
          },
          body: form.toString()
        });

        if (res.ok) {
          const text = await res.text();
          const json = JSON.parse(text.replace(/^for\s*\(;;\);/, ''));
          const conn = json.data?.xdt_api__v1__media__media_id__comments__connection || {};
          const edges = conn.edges || [];
          const pageInfo = conn.page_info || {};
          
          edges.forEach((edge: any) => {
            const node = edge.node || {};
            if (node.user?.username) commenters.add(String(node.user.username).toLowerCase().trim());
            const threaded = node.edge_threaded_comments?.edges || [];
            threaded.forEach((tEdge: any) => {
              const tNode = tEdge.node || {};
              if (tNode.user?.username) commenters.add(String(tNode.user.username).toLowerCase().trim());
            });
          });

          const nextCursor = pageInfo.end_cursor;
          if (nextCursor && nextCursor !== cursor) {
            cursor = nextCursor;
            hasNext = pageInfo.has_next_page || false;
            page++;
          } else {
            hasNext = false;
          }
        } else {
          hasNext = false;
        }
      } catch {
        hasNext = false;
      }
    }
  }

  return commenters;
}

// Perform likes check sequence
async function fetchAllLikers(mediaId: string, shortcode: string, cookieStr: string, headers: Record<string, string>): Promise<{ likers: Set<string>; skipped: boolean; likeCount: number }> {
  const likers = new Set<string>();
  let likeCount = 0;
  let skipped = false;

  // 1. Visit page naturally to precheck like count
  try {
    const pageRes = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
        'cookie': cookieStr,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });

    if (pageRes.ok) {
      const html = await pageRes.text();
      const match = html.match(/"like_count"\s*:\s*(\d+)/i);
      if (match) {
        likeCount = parseInt(match[1], 10);
      } else {
        const ogDesc = html.match(/<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']+)["']/i);
        if (ogDesc) {
          const lMatch = ogDesc[1].match(/^([\d.,]+)\s*/);
          if (lMatch) likeCount = parseInt(lMatch[1].replace(/[,.]/g, ''), 10) || 0;
        }
      }
    }
  } catch {}

  if (likeCount > 300) {
    skipped = true;
    return { likers, skipped, likeCount };
  }

  // 2. Fetch actual likes list
  try {
    let csrfToken = '';
    const csrfMatch = cookieStr.match(/csrftoken=([^;]+)/);
    if (csrfMatch) {
      csrfToken = csrfMatch[1];
    }

    const res = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/likers/`, {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
        'cookie': cookieStr,
        'x-csrftoken': csrfToken,
        'referer': 'https://www.instagram.com/',
        'accept': '*/*',
        'sec-fetch-site': 'same-origin'
      }
    });

    if (res.ok) {
      const json = await res.json();
      const users = json.users || [];
      users.forEach((u: any) => {
        if (u.username) likers.add(String(u.username).toLowerCase().trim());
      });
    }
  } catch {}

  return { likers, skipped, likeCount };
}

// Helper to resolve 1-to-1 thread ID for a recipient, falling back to a fresh inbox fetch if not found in cache
async function resolveDirectThreadId(recipientId: string, cookies: Record<string, string>, headers: Record<string, string>, inboxThreads: any[]): Promise<string | null> {
  const matched = inboxThreads.find((t: any) => 
    !t.is_group && 
    t.users?.some((u: any) => String(u.pk || u.id) === String(recipientId))
  );
  if (matched) return matched.thread_id;
  
  // Fetch fresh inbox page to check for newly created thread
  try {
    const inboxUrl = 'https://www.instagram.com/api/v1/direct_v2/inbox/';
    const cookieStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
    const res = await fetch(inboxUrl, { headers: { ...headers, 'cookie': cookieStr } });
    if (res.ok) {
      const json = await res.json();
      const freshThreads = json.inbox?.threads || [];
      const freshMatched = freshThreads.find((t: any) => 
        !t.is_group && 
        t.users?.some((u: any) => String(u.pk || u.id) === String(recipientId))
      );
      if (freshMatched) return freshMatched.thread_id;
    }
  } catch {}
  return null;
}

// Main sequence runner
export async function runAutomationCheck() {
  if (getSchedulerState().isRunningNow) {
    console.log('[Automation] Already running, skipping overlap check.');
    return;
  }
  
  const settings = db.prepare('SELECT * FROM automation_settings WHERE id = 1').get() as AutomationSettings;
  if (!settings || !settings.enabled) return;

  if (!settings.cookies || !settings.headers || !settings.post_data) {
    logMessage('error', 'Otomasyon Hatası: Aktif çerez bulunamadı. Lütfen kontrol panelinden giriş yapıp çerezleri kaydedin.');
    return;
  }

  let cookies: Record<string, string> = {};
  let headers: Record<string, string> = {};
  let postData: any = {};

  try {
    cookies = JSON.parse(settings.cookies);
    headers = JSON.parse(settings.headers);
    postData = JSON.parse(settings.post_data);
  } catch (e) {
    logMessage('error', 'Otomasyon Hatası: Çerez veya başlık verileri çözümlenemedi (JSON Hatası).');
    return;
  }

  const cookieStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
  const configuredThreads = db.prepare('SELECT thread_id FROM automation_threads').all() as { thread_id: string }[];
  const threadIds = configuredThreads.map(t => t.thread_id);
  
  if (threadIds.length === 0) {
    logMessage('warning', 'Otomasyon pasif: Kontrol edilecek hiçbir grup seçilmedi.');
    return;
  }

  getSchedulerState().isRunningNow = true;
  getSchedulerState().abortScan = false;

  const checkAbort = (): boolean => {
    // Check if user disabled the automation in settings
    const currentSettings = db.prepare('SELECT enabled FROM automation_settings WHERE id = 1').get() as { enabled: number } | undefined;
    if (!currentSettings || currentSettings.enabled === 0) {
      getSchedulerState().isRunningNow = false;
      getSchedulerState().abortScan = false;
      logMessage('warning', 'Otomasyon taraması kullanıcı tarafından durduruldu (Otomasyon pasifleştirildi).');
      console.log('[Automation] Scan aborted because automation was disabled.');
      return true;
    }

    if (getSchedulerState().abortScan) {
      getSchedulerState().isRunningNow = false;
      getSchedulerState().abortScan = false;
      logMessage('warning', 'Otomasyon taraması kullanıcı tarafından durduruldu (Sıfırlama tetiklendi).');
      console.log('[Automation] Scan aborted by user reset.');
      return true;
    }
    return false;
  };

  if (checkAbort()) return;
  logMessage('info', `Otomasyon döngüsü başladı. Toplam ${threadIds.length} grup taranacak.`);

  // Prefetch inbox threads for typing/seen indicators
  let inboxThreads: any[] = [];
  try {
    const inboxUrl = 'https://www.instagram.com/api/v1/direct_v2/inbox/';
    const inboxRes = await fetch(inboxUrl, {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
        'cookie': cookieStr
      }
    });
    if (inboxRes.ok) {
      const inboxJson = await inboxRes.json();
      inboxThreads = inboxJson.inbox?.threads || [];
    }
  } catch (e) {
    console.warn('[Automation] Failed to prefetch inbox threads for typing/seen simulation:', e);
  }

  let groupsProcessed = 0;

  for (const threadId of threadIds) {
    if (checkAbort()) return;
    try {
      logMessage('info', `Grup taranıyor (ID: ${threadId})...`);
      
      // Fetch thread messages
      const historyUrl = `https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/?limit=150`;
      const res = await fetch(historyUrl, {
        method: 'GET',
        headers: {
          ...DEFAULT_HEADERS,
          ...headers,
          'cookie': cookieStr
        }
      });

      if (!res.ok) {
        logMessage('error', `Grup ID ${threadId} için sohbet geçmişi alınamadı. Hata Kodu: ${res.status}`);
        continue;
      }

      const json = await res.json();
      const thread = json.thread || {};
      const messages = thread.items || [];
      const usersList = thread.users || [];
      const adminIds = thread.admin_user_ids || [];

      // Get logged in user ID
      const viewerId = cookies['ds_user_id'];
      
      // Fetch group-specific configuration from database early
      const threadConfig = db.prepare('SELECT * FROM automation_threads WHERE thread_id = ?').get(threadId) as { 
        comment_check_enabled: number; 
        like_check_enabled: number;
        admin_report_enabled: number;
        admin_username: string;
        scan_mode: string;
      } | undefined;

      const groupScanMode = threadConfig ? threadConfig.scan_mode || 'all' : 'all';

      // Determine target scan date (today or yesterday) dynamically based on settings
      const targetIsToday = (settings.scan_date === 'today');
      
      const today = new Date();
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      const todayStr = getIstanbulDateStr(today);
      const yesterdayStr = getIstanbulDateStr(yesterday);
      
      const targetDateStr = targetIsToday ? todayStr : yesterdayStr;
      const otherDateStr = targetIsToday ? yesterdayStr : todayStr;
      
      const trDateFormatter = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul' });
      const targetDateFriendly = trDateFormatter.format(targetIsToday ? today : yesterday);
      const targetLabel = targetIsToday ? 'bugün' : 'dün';

      const exemptUsernames = (settings.exempt_usernames || '')
        .split(',')
        .map((u: string) => u.trim().toLowerCase())
        .filter(Boolean);

      let members: any[] = [];
      if (groupScanMode === 'participation') {
        const senders = getYesterdaySenders(messages, usersList, viewerId, targetDateStr);
        members = senders.filter((u: any) => {
          const uid = String(u.pk || u.id);
          const username = String(u.username || '').toLowerCase().trim();
          const isAdmin = adminIds.some((aid: any) => String(aid) === uid);
          const isViewer = uid === String(viewerId);
          const isExempt = exemptUsernames.includes(username);
          return !isAdmin && !isViewer && !isExempt;
        });
        logMessage('info', `Tarama modu: Sadece Katılım (${targetLabel.toUpperCase()} Paylaşanlar). Gruptaki ${usersList.length} üyeden paylaşım yapan aktif ${members.length} kişi filtrelendi.`);
      } else {
        members = usersList.filter((u: any) => {
          const uid = String(u.pk || u.id);
          const username = String(u.username || '').toLowerCase().trim();
          const isAdmin = adminIds.some((aid: any) => String(aid) === uid);
          const isViewer = uid === String(viewerId);
          const isExempt = exemptUsernames.includes(username);
          return !isAdmin && !isViewer && !isExempt;
        });
        logMessage('info', `Tarama modu: Tüm Grup Üyeleri. Gruptaki ${usersList.length} üyeden aktif ${members.length} kişi filtrelendi.`);
      }

      if (members.length === 0) {
        logMessage('warning', `Grup ${thread.thread_title || threadId} için kontrol edilecek aktif üye bulunamadı (Tümü yönetici veya boş).`);
        continue;
      }

      const { posts: targetDatePosts, skipLogs } = getYesterdayPosts(messages, usersList, viewerId, targetDateStr, otherDateStr, targetIsToday);
      
      let filteredPosts = targetDatePosts;
      if (settings.target_username) {
        const cleanTarget = settings.target_username.toLowerCase().trim();
        filteredPosts = targetDatePosts.filter(p => p.senderUsername === cleanTarget);
      }

      if (filteredPosts.length === 0) {
        logMessage('info', `Grup "${thread.thread_title || threadId}" içinde ${targetLabel} (${targetDateFriendly}) paylaşılan kriterlere uygun hiçbir gönderi bulunamadı.`);
        
        if (skipLogs.length > 0) {
          logMessage('info', `Grupta ${targetLabel} paylaşılmadığı için atlanan diğer son gönderiler:`);
          skipLogs.slice(0, 5).forEach((msgStr) => {
            logMessage('info', `-> ${msgStr}`);
          });
        }
        continue;
      }

      logMessage('info', `Grup "${thread.thread_title || threadId}" içinde ${targetLabel} paylaşılan toplam ${filteredPosts.length} gönderi analiz edilecek.`);

      const isCommentEnabled = threadConfig ? threadConfig.comment_check_enabled === 1 : true;
      const isLikeEnabled = threadConfig ? threadConfig.like_check_enabled === 1 : true;
      const isThreadAdminReportEnabled = threadConfig ? threadConfig.admin_report_enabled === 1 : false;
      const threadAdminUsername = threadConfig ? threadConfig.admin_username || '' : '';

      if (!isCommentEnabled && !isLikeEnabled) {
        logMessage('warning', `Grup "${thread.thread_title || threadId}" için hem beğeni hem yorum kontrolü devre dışı bırakılmış. Taraması atlanıyor.`);
        continue;
      }

      // We will track the missing details for each user across all yesterday posts.
      // A member is missing if they missed comments or likes on ANY of the posts (excluding their own posts).
      // Key: usernameLower, Value: { member: any; missingLinks: { mediaId: string; shortcode: string; reasonText: string; senderUsername: string }[] }
      const userMissingActions = new Map<string, { member: any; missingLinks: { mediaId: string; shortcode: string; reasonText: string; senderUsername: string }[] }>();

      // Record first post's metrics for checked_posts table, but we will run checks on all of them
      let firstPostMediaId = filteredPosts[0].mediaId;
      let firstPostShortcode = filteredPosts[0].shortcode;
      let totalLikesCount = 0;
      let totalCommentsCount = 0;
      const skippedPosts: { mediaId: string; shortcode: string; senderUsername: string }[] = [];

      for (const post of filteredPosts) {
        if (checkAbort()) return;
        logMessage('info', `Analiz ediliyor: @${post.senderUsername} tarafından paylaşılan gönderi (Kısakod: ${post.shortcode})...`);

        const status = await checkPostStatus(post.shortcode, cookieStr, headers).catch(() => ({ exists: true, commentsDisabled: false }));
        const isPostCommentsDisabled = status.commentsDisabled;

        let commenters = new Set<string>();
        let likers = new Set<string>();
        let isLikesSkipped = false;
        let likesCount = 0;

        // 1. Comment Check
        if (isCommentEnabled) {
          if (!isPostCommentsDisabled) {
            commenters = await fetchAllComments(post.mediaId, cookieStr, headers, postData);
          } else {
            logMessage('warning', `Gönderi ${post.shortcode} için yorumlar devre dışı/gizli. Yorum kontrolü atlandı.`);
          }
        }

        // 2. Like Check
        if (isLikeEnabled) {
          const likesRes = await fetchAllLikers(post.mediaId, post.shortcode, cookieStr, headers);
          likers = likesRes.likers;
          isLikesSkipped = likesRes.skipped;
          likesCount = likesRes.likeCount;
          if (isLikesSkipped) {
            logMessage('warning', `Gönderi ${post.shortcode} beğeni limiti aşımı (${likesCount} beğeni > 300) nedeniyle beğeni kontrolü atlandı.`);
            skippedPosts.push({
              mediaId: post.mediaId,
              shortcode: post.shortcode,
              senderUsername: post.senderUsername
            });
          }
        }

        if (post.mediaId === firstPostMediaId) {
          totalLikesCount = likesCount;
          totalCommentsCount = commenters.size;
        }

        // Lock this post as checked today (in locked_posts)
        const todayStr = getIstanbulDateStr(new Date());
        db.prepare('INSERT OR REPLACE INTO locked_posts (thread_id, media_id, shortcode, lock_date, comments_disabled) VALUES (?, ?, ?, ?, ?)')
          .run(threadId, post.mediaId, post.shortcode, todayStr, isPostCommentsDisabled ? 1 : 0);

        // Find missing members for THIS post
        members.forEach((member: any) => {
          const usernameLower = String(member.username).toLowerCase().trim();
          
          // A user doesn't check their own post
          if (usernameLower === post.senderUsername.toLowerCase().trim()) {
            return;
          }

          const commented = commenters.has(usernameLower);
          const liked = likers.has(usernameLower);
          
          const commentMissing = isCommentEnabled && !isPostCommentsDisabled && !commented;
          const likeMissing = isLikeEnabled && !liked && !isLikesSkipped;

          if (commentMissing || likeMissing) {
            if (!userMissingActions.has(usernameLower)) {
              userMissingActions.set(usernameLower, { member, missingLinks: [] });
            }
            
            const details = userMissingActions.get(usernameLower)!;
            const reasons: string[] = [];
            if (commentMissing) reasons.push('yorum');
            if (likeMissing) reasons.push('beğeni');
            
            details.missingLinks.push({
              mediaId: post.mediaId,
              shortcode: post.shortcode,
              reasonText: reasons.join('+'),
              senderUsername: post.senderUsername
            });
          }
        });

        // Add cool down between checking different posts in the same thread to prevent rate limits
        await sleep(1500);
      }



      // Convert map to array of missing users
      const missingUsersData = Array.from(userMissingActions.values());
      const missingUsers = missingUsersData.map(d => d.member);

      logMessage('info', `Toplam Üye: ${members.length}. Eksik Üye: ${missingUsers.length}.`);

      let dmsSent = 0;

      // 4. Send Auto DMs to missing users
      if (settings.auto_dm_enabled && missingUsersData.length > 0) {
        if (checkAbort()) return;
        logMessage('info', `Eksik ${missingUsersData.length} üyeye otomatik DM gönderimi başlatılıyor. (${settings.dm_delay_seconds}sn aralıkla)...`);
        for (const data of missingUsersData) {
          if (checkAbort()) return;
          try {
            const user = data.member;
            const userIdStr = String(user.pk || user.id);
            
            const groupName = thread.thread_title || 'Instagram';
            const totalPostsCount = filteredPosts.length;
            const missingPostsCount = data.missingLinks.length;
            const missingRatio = totalPostsCount > 0 ? (missingPostsCount / totalPostsCount) : 0;
            const isBulkWarning = missingRatio > 0.5;

            // 1. Check for duplicate bulk warning
            if (isBulkWarning) {
              const alreadySentBulk = db.prepare('SELECT 1 FROM sent_dms WHERE media_id = ? AND recipient_id = ?').get(firstPostMediaId, userIdStr);
              if (alreadySentBulk) {
                console.log(`[Automation-DM] Bulk warning already sent to @${user.username} for today's run. Skipping duplicate.`);
                continue;
              }
            } else {
              // 2. Filter missing links to only keep the ones that haven't been sent to this recipient before
              const unsentMissingLinks = [];
              for (const item of data.missingLinks) {
                const alreadySentLink = db.prepare('SELECT 1 FROM sent_dms WHERE media_id = ? AND recipient_id = ?').get(item.mediaId, userIdStr);
                if (!alreadySentLink) {
                  unsentMissingLinks.push(item);
                } else {
                  console.log(`[Automation-DM] Link for post ${item.shortcode} already sent to @${user.username} before. Skipping link.`);
                }
              }

              // If all missing links for this user were already sent before, skip DM entirely
              if (unsentMissingLinks.length === 0) {
                console.log(`[Automation-DM] All missing links for @${user.username} were already sent before. Skipping DM entirely.`);
                continue;
              }

              // Update data missing links to only contain the unsent ones for subsequent sending logic
              data.missingLinks = unsentMissingLinks;
            }

            let resolvedThreadId = await resolveDirectThreadId(userIdStr, cookies, headers, inboxThreads);
            
            if (isBulkWarning) {
              console.log(`[Automation-DM] User @${user.username} missed ${missingPostsCount}/${totalPostsCount} posts (>${Math.round(0.5 * 100)}%). Sending bulk warning message instead of links.`);
              
              const dmText = (settings.dm_bulk_template || 'Merhaba {grup_ismi} grubunda eksiğiniz var dönüş yapmanız gerekiyor')
                .replace(/{username}/g, user.username || '')
                .replace(/{grup_ismi}/g, groupName);
                
              const dmRes = await sendDirectMessage(userIdStr, dmText, cookies, headers, postData, inboxThreads);
              if (dmRes.success) {
                dmsSent++;
                logMessage('success', `@${user.username} kullanıcısına toplu uyarı kalıbı DM mesajı başarıyla gönderildi (Eksik oranı: %${Math.round(missingRatio * 100)}).`);
                db.prepare('INSERT OR IGNORE INTO sent_dms (media_id, recipient_id) VALUES (?, ?)').run(firstPostMediaId, userIdStr);
                if (!resolvedThreadId) {
                  resolvedThreadId = await resolveDirectThreadId(userIdStr, cookies, headers, inboxThreads);
                }
                if (dmRes.messageId && resolvedThreadId) {
                  db.prepare('INSERT INTO sent_messages_history (thread_id, message_id) VALUES (?, ?)').run(resolvedThreadId, dmRes.messageId);
                  console.log(`[Automation-DM] Marking thread ${resolvedThreadId} as read for viewer after sending bulk warning.`);
                  await sendSeenIndicator(resolvedThreadId, dmRes.messageId, Date.now(), cookies, headers, postData).catch(() => {});
                }
              } else {
                logMessage('error', `@${user.username} kullanıcısına toplu uyarı kalıbı DM mesajı gönderilemedi.`);
              }
            } else {
              // Send clean link messages one by one slowly (Instagram will expand them to rich preview cards)
              for (const item of data.missingLinks) {
                if (checkAbort()) return;
                const cleanLink = `https://www.instagram.com/p/${item.shortcode}`;
                const linkRes = await sendDirectMessage(userIdStr, cleanLink, cookies, headers, postData, inboxThreads);
                if (linkRes.success) {
                  logMessage('success', `@${user.username} kullanıcısına eksik gönderi linki başarıyla gönderildi: ${cleanLink}`);
                  db.prepare('INSERT OR IGNORE INTO sent_dms (media_id, recipient_id) VALUES (?, ?)').run(item.mediaId, userIdStr);
                  if (!resolvedThreadId) {
                    resolvedThreadId = await resolveDirectThreadId(userIdStr, cookies, headers, inboxThreads);
                  }
                  if (linkRes.messageId && resolvedThreadId) {
                    db.prepare('INSERT INTO sent_messages_history (thread_id, message_id) VALUES (?, ?)').run(resolvedThreadId, linkRes.messageId);
                  }
                } else {
                  logMessage('error', `@${user.username} kullanıcısına eksik gönderi linki gönderilemedi: ${cleanLink}`);
                }
                // Wait 4 seconds between link messages to allow rich expansion and natural rate limiting
                await sleep(4000);
              }

              // Wait 4 seconds after the last link card before sending the warning text to prevent spam filtering
              await sleep(4000);

              // Generate final consolidated warning message listing reasons and send it
              const linksListStr = data.missingLinks.map(item => `- https://www.instagram.com/p/${item.shortcode} (${item.reasonText})`).join('\n');
              const dmText = settings.dm_template
                .replace(/{username}/g, user.username || '')
                .replace(/{link}/g, linksListStr)
                .replace(/{grup_ismi}/g, groupName);
              
              const dmRes = await sendDirectMessage(userIdStr, dmText, cookies, headers, postData, inboxThreads);
              if (dmRes.success) {
                dmsSent++;
                logMessage('success', `@${user.username} kullanıcısına toplu detaylı uyarı DM mesajı başarıyla gönderildi.`);
                db.prepare('INSERT OR IGNORE INTO sent_dms (media_id, recipient_id) VALUES (?, ?)').run(firstPostMediaId, userIdStr);
                if (!resolvedThreadId) {
                  resolvedThreadId = await resolveDirectThreadId(userIdStr, cookies, headers, inboxThreads);
                }
                if (dmRes.messageId && resolvedThreadId) {
                  db.prepare('INSERT INTO sent_messages_history (thread_id, message_id) VALUES (?, ?)').run(resolvedThreadId, dmRes.messageId);
                  // Mark thread as read/seen for the bot user itself to prevent unread indicators in direct inbox list
                  console.log(`[Automation-DM] Marking thread ${resolvedThreadId} as read for viewer after sending warning messages.`);
                  await sendSeenIndicator(resolvedThreadId, dmRes.messageId, Date.now(), cookies, headers, postData).catch(() => {});
                }
              } else {
                logMessage('error', `@${user.username} kullanıcısına toplu detaylı uyarı DM mesajı gönderilemedi.`);
              }
            }
            // Wait configured delay between different users DMs to prevent spam filter
            await sleep(settings.dm_delay_seconds * 1000);
          } catch (dmErr) {
            console.error(`Error sending DM to @${data.member.username}:`, dmErr);
          }
        }
        logMessage('success', `Otomatik DM gönderimi tamamlandı. Başarılı gönderim: ${dmsSent}/${missingUsersData.length}`);
      }

      // 5. Send Group Report
      if (settings.auto_group_report_enabled && missingUsers.length > 0) {
        try {
          const missingMentions = missingUsers.map(u => `@${u.username}`).join('\n');
          const reportText = settings.group_report_template
            .replace(/{missing_users}/g, missingMentions);
          
          const grpRes = await sendThreadMessage(threadId, reportText, cookies, headers, postData);
          if (grpRes.success) {
            logMessage('success', `Eksikler listesi gruba gönderildi!`);
            if (grpRes.messageId) {
              db.prepare('INSERT INTO sent_messages_history (thread_id, message_id) VALUES (?, ?)').run(threadId, grpRes.messageId);
              // Mark group thread as read for viewer
              console.log(`[Automation-DM] Marking group thread ${threadId} as read for viewer.`);
              await sendSeenIndicator(threadId, grpRes.messageId, Date.now(), cookies, headers, postData).catch(() => {});
            }
          }
        } catch (grpErr) {
          console.error(`Error sending report to group ${threadId}:`, grpErr);
        }
      }

      // 5b. Send Admin Report (Per-group thread configuration)
      if (isThreadAdminReportEnabled && threadAdminUsername && missingUsers.length > 0) {
        try {
          const adminUsernameClean = threadAdminUsername.trim().replace(/^@/, '');
          logMessage('info', `Eksikler raporu admin @${adminUsernameClean} kullanıcısına gönderiliyor...`);
          
          let adminUserId: string | null = null;
          
          // 1. Scan inbox threads first
          for (const t of inboxThreads) {
            const matchedUser = t.users?.find((u: any) => String(u.username || '').toLowerCase().trim() === adminUsernameClean.toLowerCase());
            if (matchedUser) {
              adminUserId = String(matchedUser.pk || matchedUser.id);
              break;
            }
          }
          
          // 2. Scan group members if not found
          if (!adminUserId && thread.users) {
            const matchedMember = thread.users.find((u: any) => String(u.username || '').toLowerCase().trim() === adminUsernameClean.toLowerCase());
            if (matchedMember) {
              adminUserId = String(matchedMember.pk || matchedMember.id);
            }
          }
          
          // 3. Call web profile info fallback if not found
          if (!adminUserId) {
            adminUserId = await resolveUserIdByUsername(adminUsernameClean, cookies, headers);
          }
          
          if (adminUserId) {
            const groupName = thread.thread_title || 'Instagram Grubu';
            
            // Build the list of checked posts with links and creators
            const checkedPostsListStr = filteredPosts.map(post => `- https://www.instagram.com/p/${post.shortcode} (@${post.senderUsername} gönderisi)`).join('\n');
            
            // Build detailed infraction list for the admin
            const detailedInfractionsList: string[] = [];
            for (const data of missingUsersData) {
              const username = data.member.username;
              
              // 1. Add actual confirmed infractions
              for (const item of data.missingLinks) {
                const suffix = getTurkishSuffix(item.senderUsername);
                detailedInfractionsList.push(`- @${username} ➔ @${item.senderUsername}'${suffix} attığı paylaşıma ${item.reasonText} yapmamış`);
              }

              // 2. If the user missed > 50% of the posts, they also didn't do skipped posts
              const totalPostsCount = filteredPosts.length;
              const missingPostsCount = data.missingLinks.length;
              const missingRatio = totalPostsCount > 0 ? (missingPostsCount / totalPostsCount) : 0;
              const isBulkWarning = missingRatio > 0.5;

              if (isBulkWarning && skippedPosts.length > 0) {
                for (const skippedPost of skippedPosts) {
                  // Exclude user's own post
                  if (skippedPost.senderUsername.toLowerCase().trim() === username.toLowerCase().trim()) {
                    continue;
                  }
                  // Ensure not already listed
                  const alreadyListed = data.missingLinks.some(link => link.mediaId === skippedPost.mediaId);
                  if (!alreadyListed) {
                    const suffix = getTurkishSuffix(skippedPost.senderUsername);
                    detailedInfractionsList.push(`- @${username} ➔ @${skippedPost.senderUsername}'${suffix} attığı paylaşıma beğeni yapmamış (beğeni sayısı > 300 limitli)`);
                  }
                }
              }
            }
            const detailedInfractionsStr = detailedInfractionsList.length > 0 
              ? detailedInfractionsList.join('\n') 
              : 'Harika! Herkes tüm paylaşımları tamamlamış.';

            const copyPasteTagsStr = missingUsers.map(u => `@${u.username}`).join(' ');

            const reportText = `📢 [${groupName}] Detaylı Eksikler Raporu\n\n` +
                               `📅 Kontrol Edilen Paylaşımlar:\n${checkedPostsListStr}\n\n` +
                               `❌ Eksik Detayları:\n${detailedInfractionsStr}\n\n` +
                               `📋 Etiketlenecek Üyeler (Kopyalamak için):\n${copyPasteTagsStr || 'Eksik yok.'}`;
            
            const adminRes = await sendDirectMessage(adminUserId, reportText, cookies, headers, postData, inboxThreads);
            if (adminRes.success) {
              logMessage('success', `Eksikler raporu admin @${adminUsernameClean} kullanıcısına DM ile gönderildi!`);
              const adminThreadId = await resolveDirectThreadId(adminUserId, cookies, headers, inboxThreads);
              if (adminRes.messageId && adminThreadId) {
                db.prepare('INSERT INTO sent_messages_history (thread_id, message_id) VALUES (?, ?)').run(adminThreadId, adminRes.messageId);
                // Mark admin thread as read for viewer
                console.log(`[Automation-DM] Marking admin thread ${adminThreadId} as read for viewer.`);
                await sendSeenIndicator(adminThreadId, adminRes.messageId, Date.now(), cookies, headers, postData).catch(() => {});
              }
            } else {
              logMessage('error', `Eksikler raporu admin @${adminUsernameClean} kullanıcısına gönderilemedi (DM başarısız).`);
            }
          } else {
            logMessage('error', `Eksikler raporu gönderilemedi: Admin @${adminUsernameClean} kullanıcısının ID bilgisi çözümlenemedi.`);
          }
        } catch (adminErr) {
          console.error(`Error sending report to admin:`, adminErr);
        }
      }

      // 6. Record as checked post (main entry)
      db.prepare(`
        INSERT INTO checked_posts (media_id, shortcode, thread_id, likes_count, comments_count, missing_count, dms_sent_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(firstPostMediaId, firstPostShortcode, threadId, totalLikesCount, totalCommentsCount, missingUsers.length, dmsSent);

      logMessage('success', `Grup "${thread.thread_title || threadId}" taraması başarıyla tamamlandı.`);
      
      groupsProcessed++;
      
      // 7. Cool-down delay between different groups (break minutes)
      if (groupsProcessed < threadIds.length) {
        logMessage('info', `Mola veriliyor: ${settings.break_minutes} dakika sonra sonraki grup taranacak...`);
        const totalMs = settings.break_minutes * 60 * 1000;
        const chunkMs = 1000;
        let elapsed = 0;
        while (elapsed < totalMs) {
          if (checkAbort()) return;
          await sleep(chunkMs);
          elapsed += chunkMs;
        }
      }

    } catch (grpError: any) {
      logMessage('error', `Grup ${threadId} taranırken hata oluştu: ${grpError.message || grpError}`);
    }
  }

  logMessage('info', 'Tüm grup otomasyon taramaları tamamlandı.');
  getSchedulerState().isRunningNow = false;
}

function normalizeTurkish(str: string): string {
  return str
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/i̇/g, 'i');
}
async function getUserGroups(
  targetUsername: string,
  cookies: Record<string, string>,
  headers: Record<string, string>
): Promise<{ threadId: string; threadTitle: string; isAdmin: boolean }[]> {
  const userGroups: { threadId: string; threadTitle: string; isAdmin: boolean }[] = [];
  try {
    const cookieStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
    const settings = db.prepare('SELECT * FROM automation_settings WHERE id = 1').get() as AutomationSettings;
    
    // Fetch thread IDs from automation_threads table instead of settings.threads
    const configuredThreads = db.prepare('SELECT thread_id FROM automation_threads').all() as { thread_id: string }[];
    const threadIds = configuredThreads.map(t => t.thread_id);
    
    const targetUsernameClean = targetUsername.replace(/^@/, '').toLowerCase().trim();
    const exemptUsernames = (settings.exempt_usernames || '')
      .split(',')
      .map((u: string) => u.trim().toLowerCase())
      .filter(Boolean);

    for (const threadId of threadIds) {
      const url = `https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/?limit=1`;
      const res = await fetch(url, {
        headers: { ...DEFAULT_HEADERS, ...headers, 'cookie': cookieStr }
      });
      if (!res.ok) continue;

      const json = await res.json();
      const thread = json.thread || {};
      const usersList = thread.users || [];
      const adminIds = thread.admin_user_ids || [];
      
      const threadConfig = db.prepare('SELECT * FROM automation_threads WHERE thread_id = ?').get(threadId) as any;
      const isConfigAdmin = threadConfig && String(threadConfig.admin_username).toLowerCase().trim() === targetUsernameClean;
      
      const isViewerExempt = targetUsernameClean === 'seghob' || exemptUsernames.includes(targetUsernameClean);
      const isMember = usersList.some((u: any) => String(u.username).toLowerCase().trim() === targetUsernameClean) || isConfigAdmin || isViewerExempt;
      
      if (isMember) {
        const userObj = usersList.find((u: any) => String(u.username).toLowerCase().trim() === targetUsernameClean);
        const isServerAdmin = userObj && adminIds.some((aid: any) => String(aid) === String(userObj.pk || userObj.id));

        userGroups.push({
          threadId,
          threadTitle: thread.thread_title || 'Grup',
          isAdmin: isConfigAdmin || isServerAdmin || isViewerExempt
        });
      }
    }
  } catch (err) {
    console.error('Error fetching user groups:', err);
  }
  return userGroups;
}


function buildContextPromptForCheck(
  partnerUsername: string,
  missingList: any[],
  checkedThreadIds: string[]
): string {
  const adminGroups = missingList.filter(g => (g as any).isAdmin);
  const activeMissing = missingList.filter(g => !(g as any).isAdmin);

  let missingPromptText = '';
  
  if (adminGroups.length > 0) {
    const groupNames = Array.from(new Set(adminGroups.map(g => g.groupTitle))).join(', ');
    missingPromptText += `[ÖNEMLİ] Kullanıcı @${partnerUsername}, ${groupNames} grubunda/gruplarında admindir. Bu grup(lar) için doğrudan şu şekilde cevap ver: 'Sen bu grupta (${groupNames}) adminsin, kontrol senin için geçerli değil.'\n`;
  }

  if (activeMissing.length > 0) {
    const linesText = activeMissing.map(m => `- ${m.groupTitle} grubundaki gönderide: https://www.instagram.com/p/${m.shortcode}/ (${m.reason})`).join('\n');
    missingPromptText += `Kullanıcının eksik olduğu gönderiler şunlardır:\n${linesText}\nBu linkleri cevabında düz satırlar halinde tek tek ilet, kesinlikle '-' veya '*' veya • gibi liste işaretleri (bullet points) kullanma. Her link ayrı satırda olsun.\n`;

    const missingByThread: Record<string, any[]> = {};
    activeMissing.forEach(m => {
      const tId = String(m.threadId || '');
      if (!missingByThread[tId]) missingByThread[tId] = [];
      missingByThread[tId].push(m);
    });

    for (const tId in missingByThread) {
      const items = missingByThread[tId];
      if (items.some(m => m.isAllMissing)) {
        const title = items[0].groupTitle;
        missingPromptText += `[ÖNEMLİ] Kullanıcı "${title}" grubundaki tüm paylaşımları kaçırmıştır (hiçbirine etkileşim yapmamıştır). Bu yüzden tüm linkleri tek tek listeledikten sonra, mesajın en sonunda tam olarak şu ifadeyi ekle: "Yukarıdaki tüm postlarda eksiğiniz var."\n`;
      }
    }
  }

  // Add dynamic control description for each checked group
  let controlTypeNotes = '';
  for (const threadId of checkedThreadIds) {
    const threadConfig = db.prepare('SELECT * FROM automation_threads WHERE thread_id = ?').get(threadId) as any;
    const isCommentEnabled = threadConfig ? threadConfig.comment_check_enabled === 1 : true;
    const isLikeEnabled = threadConfig ? threadConfig.like_check_enabled === 1 : true;
    
    const matchingItem = missingList.find(g => g.threadId === threadId);
    let titleStr = matchingItem ? matchingItem.groupTitle : '';
    if (!titleStr) {
      const row = db.prepare('SELECT * FROM automation_threads WHERE thread_id = ?').get(threadId) as any;
      titleStr = row ? `Grup (ID: ${threadId})` : 'Grup';
    }

    let typeStr = 'beğeni ve yorum';
    if (isCommentEnabled && !isLikeEnabled) typeStr = 'sadece yorum';
    else if (!isCommentEnabled && isLikeEnabled) typeStr = 'sadece beğeni';
    
    controlTypeNotes += `- "${titleStr}" grubu için sadece "${typeStr}" kontrolü yapılmıştır. Cevabında bu detaya kesinlikle dikkat et, yapılmayan diğer kontrollerden (örneğin sadece beğeni kontrolü yapıldıysa yorum kontrolünden) kesinlikle bahsetme.\n`;
  }

  if (missingList.length === 0) {
    return `\n\n[SİSTEM BİLGİSİ - CANLI EKSİK KONTROLÜ]\nKullanıcı @${partnerUsername} için yapılan canlı kontrolde HİÇBİR EKSİK BULUNMADI. Tüm paylaşımları beğenmiş ve yorum atmıştır.\n\n[KONTROL TİPLERİ]\n${controlTypeNotes}\n\nBu bilgiyi kullanarak kullanıcıyı tebrik et ve eksiği olmadığını belirt.`;
  }

  return `\n\n[SİSTEM BİLGİSİ - CANLI EKSİK KONTROLÜ]\n${missingPromptText}\n\n[KONTROL TİPLERİ]\n${controlTypeNotes}\n\nBu bilgileri kullanarak kurucu gibi davran ve kullanıcıya eksikliklerini ilet. Kesinlikle hiçbir liste işareti (-, *, • vb.) kullanma.`;
}

export async function checkMemberMissingActions(
  targetUsername: string,
  cookies: Record<string, string>,
  headers: Record<string, string>,
  postData: any,
  groupNameFilter?: string,
  targetThreadId?: string
): Promise<{ groupTitle: string; shortcode?: string; reason?: string; isAllMissing?: boolean; totalPosts?: number; threadId?: string; isAdmin?: boolean }[]> {
  const missingList: { groupTitle: string; shortcode?: string; reason?: string; isAllMissing?: boolean; totalPosts?: number; threadId?: string; isAdmin?: boolean }[] = [];
  try {
    const cookieStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
    const settings = db.prepare('SELECT * FROM automation_settings WHERE id = 1').get() as AutomationSettings;
    const targetUsernameClean = targetUsername.replace(/^@/, '').toLowerCase().trim();

    // Check if user is exempt from all controls
    const exemptUsernames = (settings.exempt_usernames || '')
      .split(',')
      .map((u: string) => u.trim().toLowerCase())
      .filter(Boolean);
    
    if (exemptUsernames.includes(targetUsernameClean)) {
      console.log(`[Automation-AI] User ${targetUsernameClean} is exempt from check. Returning no missing actions.`);
      return [];
    }

    const configuredThreads = db.prepare('SELECT thread_id FROM automation_threads').all() as { thread_id: string }[];
    const threadIds = targetThreadId ? [targetThreadId] : configuredThreads.map(t => t.thread_id);

    const normalizeText = (text: string) => {
      return text.toLowerCase()
        .replace(/ı/g, 'i')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .trim();
    };

    const cleanFilter = groupNameFilter ? normalizeText(groupNameFilter) : '';
    const isSpecificGroupQuery = cleanFilter && (
      cleanFilter.includes('zirve') ||
      cleanFilter.includes('influe') ||
      cleanFilter.includes('vibe')
    );

    for (const threadId of threadIds) {
      const historyUrl = `https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/?limit=150`;
      const res = await fetch(historyUrl, {
        headers: { ...DEFAULT_HEADERS, ...headers, 'cookie': cookieStr }
      });
      if (!res.ok) continue;

      const json = await res.json();
      const thread = json.thread || {};
      const messages = thread.items || [];
      const usersList = thread.users || [];
      const viewerId = cookies['ds_user_id'];

      // Verify if the target user is a member of this group
      const isMember = usersList.some((u: any) => String(u.username).toLowerCase().trim() === targetUsernameClean);
      if (!isMember) {
        continue;
      }

      // Removed admin skip check block to allow auditing admins like regular members
      const threadConfig = db.prepare('SELECT * FROM automation_threads WHERE thread_id = ?').get(threadId) as any;

      // If user specified a group name, verify if this group matches
      if (isSpecificGroupQuery) {
        const title = thread.thread_title || 'Grup';
        const cleanTitle = normalizeText(title);
        const cleanTitleNoEmojis = cleanTitle.replace(/[^a-z0-9\s]+/g, '').trim();

        if (cleanTitleNoEmojis.includes('zirve') && !cleanFilter.includes('zirve')) {
          continue;
        }
        if (cleanTitleNoEmojis.includes('influe') && !cleanFilter.includes('influe')) {
          continue;
        }
        if (cleanTitleNoEmojis.includes('vibe') && !cleanFilter.includes('vibe')) {
          continue;
        }
        if (cleanTitleNoEmojis.includes('like') && !cleanFilter.includes('like')) {
          continue;
        }
        if (cleanTitleNoEmojis.includes('1') && !cleanFilter.includes('1')) {
          continue;
        }
        if (cleanTitleNoEmojis.includes('2') && !cleanFilter.includes('2')) {
          continue;
        }
      }
      const isCommentEnabled = threadConfig ? threadConfig.comment_check_enabled === 1 : true;
      const isLikeEnabled = threadConfig ? threadConfig.like_check_enabled === 1 : true;
      const groupScanMode = threadConfig ? threadConfig.scan_mode || 'all' : 'all';

      if (!isCommentEnabled && !isLikeEnabled) continue;

      const targetIsToday = (settings.scan_date === 'today');
      const todayStr = getIstanbulDateStr(new Date());
      const yesterdayStr = getIstanbulDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const targetDateStr = targetIsToday ? todayStr : yesterdayStr;
      const otherDateStr = targetIsToday ? yesterdayStr : todayStr;

      // If scan mode is participation, verify if the user shared a post
      if (groupScanMode === 'participation') {
        const senders = getYesterdaySenders(messages, usersList, viewerId, targetDateStr);
        const didShare = senders.some((u: any) => String(u.username).toLowerCase().trim() === targetUsernameClean);
        if (!didShare) {
          // User did not share a post yesterday, so they have no obligation to do checks in this group!
          continue;
        }
      }

      const { posts } = getYesterdayPosts(messages, usersList, viewerId, targetDateStr, otherDateStr, targetIsToday);
      const otherPosts = posts.filter(p => p.senderUsername !== targetUsernameClean);

      if (otherPosts.length === 0) continue;

      let groupMissingItems: { groupTitle: string; shortcode: string; reason: string }[] = [];
      let totalCheckedCount = otherPosts.length;
      let missingCount = 0;

      for (const post of otherPosts) {
        let isMissingComment = false;
        let isMissingLike = false;

        const status = await checkPostStatus(post.shortcode, cookieStr, headers).catch(() => ({ exists: true, commentsDisabled: false }));
        const isPostCommentsDisabled = status.commentsDisabled;

        if (isCommentEnabled && !isPostCommentsDisabled) {
          const commenters = await fetchAllComments(post.mediaId, cookieStr, headers, postData).catch(() => new Set<string>());
          if (!commenters.has(targetUsernameClean)) {
            isMissingComment = true;
          }
        }

        if (isLikeEnabled) {
          const likesRes = await fetchAllLikers(post.mediaId, post.shortcode, cookieStr, headers).catch(() => ({ likers: new Set<string>(), skipped: false, likeCount: 0 }));
          if (!likesRes.likers.has(targetUsernameClean) && !likesRes.skipped) {
            isMissingLike = true;
          }
        }

        if (isMissingComment || isMissingLike) {
          missingCount++;
          const reasons: string[] = [];
          if (isMissingComment) reasons.push('Yorum');
          if (isMissingLike) reasons.push('Beğeni');
          groupMissingItems.push({
            groupTitle: thread.thread_title || 'Grup',
            shortcode: post.shortcode,
            reason: reasons.join(' ve ') + ' eksiği'
          });
        }
      }

      groupMissingItems.forEach(item => {
        (item as any).threadId = String(threadId);
        if (missingCount === totalCheckedCount) {
          (item as any).isAllMissing = true;
          (item as any).totalPosts = totalCheckedCount;
        }
      });
      missingList.push(...groupMissingItems);
    }
  } catch (err) {
    console.error('Error checking missing actions for user:', err);
  }
  return missingList;
}

async function getGroupSendersList(
  threadId: string,
  cookies: Record<string, string>,
  headers: Record<string, string>
): Promise<{ username: string; shortcode: string; timestamp: number }[]> {
  const sendersList: { username: string; shortcode: string; timestamp: number }[] = [];
  try {
    const cookieStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
    const historyUrl = `https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/?limit=150`;
    const res = await fetch(historyUrl, {
      headers: { ...DEFAULT_HEADERS, ...headers, 'cookie': cookieStr }
    });
    if (res.ok) {
      const json = await res.json();
      const thread = json.thread || {};
      const messages = thread.items || [];
      const usersList = thread.users || [];
      const viewerId = cookies['ds_user_id'];
      
      const settings = db.prepare('SELECT * FROM automation_settings WHERE id = 1').get() as AutomationSettings;
      const targetIsToday = (settings.scan_date === 'today');
      const todayStr = getIstanbulDateStr(new Date());
      const yesterdayStr = getIstanbulDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const targetDateStr = targetIsToday ? todayStr : yesterdayStr;
      const otherDateStr = targetIsToday ? yesterdayStr : todayStr;

      const { posts } = getYesterdayPosts(messages, usersList, viewerId, targetDateStr, otherDateStr, targetIsToday);
      posts.forEach(p => {
        sendersList.push({
          username: p.senderUsername,
          shortcode: p.shortcode,
          timestamp: Number(p.timestamp || 0)
        });
      });
    }
  } catch (err) {
    console.error('Error fetching group senders:', err);
  }
  return sendersList;
}

// Background auto seen simulation (runs at random intervals 15-30 mins per thread)
function cleanMarkdownForInstagram(text: string): string {
  return text
    // Replace bold asterisks with plain text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // Replace italic asterisks with plain text
    .replace(/\*(.*?)\*/g, '$1')
    // Replace bold underscores with plain text
    .replace(/__(.*?)__/g, '$1')
    // Replace italic underscores with plain text
    .replace(/_(.*?)_/g, '$1')
    // Replace code blocks
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    // Replace inline code backticks
    .replace(/`([^`]+)`/g, '$1')
    // Remove horizontal rules
    .replace(/^-{3,}\s*$/gm, '')
    .replace(/^_{3,}\s*$/gm, '')
    .replace(/^\*+$/gm, '')
    // Remove headers formatting
    .replace(/^#+\s+/gm, '')
    // Clean up duplicate/empty lines and trim
    .split('\n')
    .map(line => line.trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
}

async function callAIModel(
  historyToPass: any[],
  finalSystemPrompt: string,
  settings: AutomationSettings
): Promise<string> {
  let replyText = '';
  const messages = [
    { role: 'system', content: finalSystemPrompt },
    ...historyToPass
  ];

  const candidateModels = [settings.ai_model || 'meta-llama/llama-3.3-70b-instruct:free'];
  const backups = ['google/gemma-4-31b-it:free', 'qwen/qwen3-next-80b-a3b-instruct:free', 'openrouter/free'];
  for (const b of backups) {
    if (!candidateModels.includes(b)) {
      candidateModels.push(b);
    }
  }

  let response: any = null;
  const isGemini = String(settings.ai_api_key).startsWith('AIzaSy');

  if (isGemini) {
    console.log(`[AI-Responder] Detected Gemini API Key. Initializing GoogleGenAI...`);
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: settings.ai_api_key });

      const contents = historyToPass.map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }]
      }));

      const geminiModel = settings.ai_model && !settings.ai_model.includes('/')
        ? settings.ai_model
        : 'gemma-4-26b-a4b-it';

      console.log(`[AI-Responder] Calling Gemini API with model: ${geminiModel}...`);

      const responseObj = await ai.models.generateContent({
        model: geminiModel,
        contents: contents,
        config: {
          systemInstruction: finalSystemPrompt
        }
      });

      replyText = responseObj.text || '';
      console.log(`[AI-Responder] Gemini response generated successfully.`);
    } catch (geminiErr: any) {
      console.error('[AI-Responder] Gemini generation failed:', geminiErr.message || geminiErr);
      throw geminiErr;
    }
  } else {
    for (const currentModel of candidateModels) {
      console.log(`[AI-Responder] Attempting generation with model: ${currentModel}`);
      let retries = 0;
      const maxRetries = 2;
      let modelSuccess = false;

      while (retries <= maxRetries) {
        try {
          response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${settings.ai_api_key}`,
              'HTTP-Referer': 'http://localhost:3000',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: currentModel,
              messages: messages
            })
          });

          if (response.status === 429) {
            retries++;
            if (retries > maxRetries) {
              break;
            }

            let retryAfterSeconds = 5;
            try {
              const rawHeader = response.headers.get('retry-after');
              if (rawHeader) {
                retryAfterSeconds = parseInt(rawHeader, 10);
              } else {
                const errText = await response.clone().text();
                const errJson = JSON.parse(errText);
                const rawRetrySec = errJson?.error?.metadata?.retry_after_seconds_raw || errJson?.error?.metadata?.retry_after_seconds;
                if (rawRetrySec) {
                  retryAfterSeconds = Math.ceil(Number(rawRetrySec));
                }
              }
            } catch {}

            const sleepTime = Math.max(3000, Math.min(20000, retryAfterSeconds * 1000));
            console.warn(`[AI-Responder] Rate limit (429) on model ${currentModel}. Retrying (${retries}/${maxRetries}) in ${sleepTime / 1000}s...`);
            await sleep(sleepTime);
            continue;
          }

          if (response.ok) {
            const json = await response.json();
            replyText = json.choices?.[0]?.message?.content?.trim() || '';
            if (replyText) {
              modelSuccess = true;
              break;
            }
          } else {
            console.warn(`[AI-Responder] Model ${currentModel} returned error status ${response.status}:`, await response.text());
            break;
          }
        } catch (e: any) {
          console.error(`[AI-Responder] Exception with model ${currentModel}:`, e.message || e);
          break;
        }
      }

      if (modelSuccess && replyText) {
        console.log(`[AI-Responder] Successfully generated response using model: ${currentModel}`);
        if (currentModel !== settings.ai_model) {
          console.log(`[AI-Responder] Dynamic Selection: Promoting ${currentModel} to primary model in database.`);
          try {
            db.prepare('UPDATE automation_settings SET ai_model = ? WHERE id = 1').run(currentModel);
          } catch {}
        }
        break;
      }
    }
  }

  return replyText;
}

function guessGenderFromTurkishName(fullName: string): 'male' | 'female' | 'unknown' {
  const nameParts = fullName.trim().toLowerCase().split(/\s+/);
  const firstName = nameParts[0] || '';
  
  const femaleNames = new Set([
    'ozde', 'ozden', 'özde', 'deniz', 'zeynep', 'elif', 'merve', 'büşra', 'fatma', 'ayşe', 'emine', 'hatice',
    'yasemin', 'gözde', 'ebru', 'esra', 'tuğba', 'kubra', 'kübra', 'buse', 'ayça', 'aycakaya',
    'simge', 'beste', 'meltem', 'duygu', 'irem', 'aleyna', 'sevda', 'ema', 'melisa', 'lara',
    'nursinem', 'gamze', 'gülce', 'burcu', 'gizem', 'ilkyaz', 'şilan', 'silan', 'elifaltın',
    'elenur', 'asyalık', 'rahime', 'gizo', 'sibel', 'simay', 'sudenaz', 'esma', 'lisa',
    'öznur', 'funda', 'fulya', 'mehtap', 'zeyno', 'eda', 'basak', 'başak', 'vildan',
    'azra', 'cansu', 'menekşe', 'menekse', 'ayce', 'ayça', 'hale', 'meryem', 'dilek',
    'sermin', 'mehri', 'seda', 'enise', 'yeliz', 'gülce', 'sena', 'gökçe', 'dilara',
    'özlem', 'pınar', 'damla', 'çiğdem', 'aslı', 'asli', 'begüm', 'hande', 'didem',
    'nehir', 'hazal', 'cemre', 'ceren', 'dilara', 'ece', 'ezgi', 'gül', 'ipek', 'pelın',
    'pelin', 'ilknur', 'büşra', 'nurdane', 'nurdancim', 'derya', 'selin', 'tuğçe',
    'luna', 'buket', 'esra', 'gul', 'guler', 'canan', 'demet', 'aslihan', 'aslıhan',
    'esra', 'didem', 'hande', 'aysegul', 'ayşegül', 'nuran', 'nuray', 'sema', 'selma',
    'nihal', 'nazli', 'nazlı', 'melike', 'berna', 'asya', 'kader', 'bahar', 'gonca',
    'selda', 'tulin', 'tülin', 'sevgi', 'sevil', 'senay', 'şenay', 'gulsen', 'gülşen'
  ]);

  const maleNames = new Set([
    'dalitatar', 'deniz ali', 'kadir', 'kadri', 'hakan', 'mehmet', 'ahmet', 'mustafa', 'ali',
    'hüseyin', 'hasan', 'murat', 'serkan', 'gökhan', 'burak', 'volkan', 'fatih', 'erkan',
    'onur', 'can', 'cem', 'mert', 'yiğit', 'kaan', 'oğuz', 'oguz', 'emre', 'barış', 'baris',
    'halil', 'ibrahim', 'sinan', 'kemal', 'selim', 'tarık', 'tarik', 'ufuk', 'umut',
    'selçuk', 'selcuk', 'metin', 'orhan', 'osman', 'ömer', 'omer', 'yusuf', 'hamza',
    'eren', 'kerem', 'tuna', 'bora', 'doruk', 'alp', 'alper', 'tolga', 'zafer', 'serdar',
    'cenk', 'cihan', 'sedat', 'sertan', 'sinan', 'süleyman', 'suleyman', 'taner', 'tamer',
    'tarkan', 'taylan', 'tevfik', 'tolga', 'tuncay', 'ufuk', 'ulas', 'ulaş', 'umut',
    'utku', 'uygar', 'uzay', 'volkan', 'yasin', 'yavuz', 'yigit', 'zafer', 'zeki',
    'seghob', 'huseyin', 'suleyman', 'ozgur', 'özgür', 'levent', 'bulent', 'bülent',
    'alp', 'cengiz', 'tarik', 'kenan', 'erhan', 'orhan', 'yusuf', 'yunus', 'samed',
    'samet', 'furkan', 'berat', 'batuhan', 'bugra', 'buğra', 'taha', 'enes', 'selim'
  ]);

  if (femaleNames.has(firstName)) return 'female';
  if (maleNames.has(firstName)) return 'male';

  if (firstName.endsWith('nur') || firstName.endsWith('gül') || firstName.endsWith('gul') || firstName.endsWith('su')) {
    return 'female';
  }

  const userLower = fullName.toLowerCase();
  for (const name of femaleNames) {
    if (userLower.includes(name)) return 'female';
  }
  for (const name of maleNames) {
    if (userLower.includes(name)) return 'male';
  }

  return 'unknown';
}

interface AIResponseTask {
  type: 'direct' | 'group';
  threadId: string;
  recipientId?: string;
  chatHistory?: { role: string; content: string }[];
  settings: AutomationSettings;
  cookies: Record<string, string>;
  headers: Record<string, string>;
  postData: Record<string, any>;
  thread: any;
  groupSystemPrompt?: string;
  lastMsgId?: string;
}

export async function processNextQueueItem() {
  const state = getSchedulerState();
  if (!state.aiQueue) {
    state.aiQueue = [];
  }
  if (state.processingAIQueue) {
    return;
  }
  
  if (state.aiQueue.length === 0) {
    return;
  }
  
  state.processingAIQueue = true;
  const task: AIResponseTask = state.aiQueue[0];
  
  console.log(`[AI-Queue] Processing task for thread ${task.threadId} (Queue size: ${state.aiQueue.length})...`);
  
  try {
    if (task.type === 'direct') {
      if (task.recipientId && task.chatHistory) {
        // Execute DM response
        await respondWithAI(
          task.threadId,
          task.recipientId,
          task.chatHistory,
          task.settings,
          task.cookies,
          task.headers,
          task.postData,
          [task.thread]
        );
      }
    } else if (task.type === 'group') {
      if (task.groupSystemPrompt) {
        const responseText = await callAIModel(task.chatHistory || [], task.groupSystemPrompt, task.settings);
        if (responseText) {
          const cleanReply = cleanMarkdownForInstagram(responseText);
          console.log(`[AI-Queue] Sending AI response to group thread ${task.threadId}: ${cleanReply}`);
          await sendDirectMessage(task.threadId, cleanReply, task.cookies, task.headers, task.postData, [task.thread]);
        }
      }
    }
    
    // Task completed successfully! Remove from queue.
    state.aiQueue.shift();
    console.log(`[AI-Queue] Task completed successfully for thread ${task.threadId}.`);
    
  } catch (err: any) {
    console.error(`[AI-Queue] Task failed for thread ${task.threadId}:`, err.message || err);
    // Remove from queue on failure, and clean DB lock so it can be retried later
    state.aiQueue.shift();
    if (task.lastMsgId) {
      try {
        db.prepare('DELETE FROM ai_responded_messages WHERE user_message_id = ?').run(task.lastMsgId);
      } catch (dbErr) {}
    }
  } finally {
    state.processingAIQueue = false;
    // Process next item with a human-like delay (2 seconds)
    setTimeout(() => {
      processNextQueueItem().catch(console.error);
    }, 2000);
  }
}

export function enqueueAIResponseTask(task: AIResponseTask) {
  const state = getSchedulerState();
  if (!state.aiQueue) {
    state.aiQueue = [];
  }
  
  // Prevent duplicate tasks for the same thread if they are already in the queue
  const exists = state.aiQueue.some((t: AIResponseTask) => t.threadId === task.threadId && t.lastMsgId === task.lastMsgId);
  if (exists) {
    console.log(`[AI-Queue] Task for thread ${task.threadId} (message ${task.lastMsgId}) is already in the queue. Skipping duplicate.`);
    return;
  }
  
  state.aiQueue.push(task);
  console.log(`[AI-Queue] Enqueued task for thread ${task.threadId} (Queue size: ${state.aiQueue.length})`);
  
  // Start queue processing if not running
  if (!state.processingAIQueue) {
    processNextQueueItem().catch(console.error);
  }
}

// AI Auto-Responder using OpenRouter API
async function respondWithAI(
  threadId: string,
  recipientId: string,
  chatHistory: { role: string; content: string }[],
  settings: AutomationSettings,
  cookies: Record<string, string>,
  headers: Record<string, string>,
  postData: any,
  inboxThreads: any[]
) {
  try {
    console.log(`[AI-Responder] Generating AI response for thread ${threadId} (recipient: ${recipientId})...`);

    // Fetch active groups from inbox dynamically
    let groupNamesList: string[] = [];
    let groupThreads: any[] = [];
    try {
      const cookieHeaderStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
      const inboxUrl = 'https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&folder=default&limit=20';
      const inboxRes = await fetch(inboxUrl, {
        headers: {
          ...DEFAULT_HEADERS,
          ...headers,
          'cookie': cookieHeaderStr
        }
      });
      if (inboxRes.ok) {
        const inboxJson = await inboxRes.json();
        const threads = inboxJson.inbox?.threads || [];
        groupThreads = threads.filter((t: any) => t.is_group === true || (t.users && t.users.length > 1));
        groupNamesList = groupThreads.map((g: any) => g.thread_title || g.users?.map((u: any) => u.username).join(', ') || 'İsimsiz Grup');
      }
    } catch (inboxErr) {
      console.error('[AI-Responder] Failed to fetch inbox for group names:', inboxErr);
    }

    const groupListStr = groupNamesList.map((name, i) => `${i + 1}. ${name}`).join('\n');
    
    const lastUserMessage = chatHistory[chatHistory.length - 1]?.content || '';
    const lastUserMsgLower = lastUserMessage.toLowerCase();
    const cleanMsg = lastUserMessage.trim();
    
    const viewerId = String(cookies['ds_user_id']);
    const threadObj = inboxThreads[0] || {};
    const users = threadObj.users || [];
    const partnerUser = users.find((u: any) => String(u.pk || u.id) !== viewerId) || users[0];
    const partnerUsername = partnerUser ? String(partnerUser.username) : '';
    const targetUsernameClean = partnerUsername.toLowerCase().trim();

    // Guess gender and personalized name
    const fullName = partnerUser?.full_name || '';
    const nameToUse = fullName ? fullName.split(' ')[0] : partnerUsername;
    const gender = guessGenderFromTurkishName(fullName || partnerUsername);

    let genderInstructions = '';
    if (gender === 'female') {
      genderInstructions = `Kullanıcı KADINDIR. Ona "Hanımefendi", "güzelim", "tatlım", "fıstığım" veya çok samimi, flörtöz/nazik/etkileyici kelimelerle hitap et.`;
    } else if (gender === 'male') {
      genderInstructions = `Kullanıcı ERKEKTİR. Ona "Beyefendi", "yakışıklım", "yakışıklı", "aslanım" veya samimi/kibar/flörtöz hitaplar kullan.`;
    } else {
      genderInstructions = `Kullanıcının cinsiyeti belirsizdir. Kibar, nazik, etkileyici ve çok samimi, hafif flörtöz/tatlı bir üslupla hitap et.`;
    }

    const dynamicSystemPrompt = `${settings.ai_system_prompt || 'Sen bir Instagram grup otomasyon asistanısın.'}

Konuştuğun kişi:
- Adı/Hitap Adı: ${nameToUse}
- Kullanıcı Adı: @${partnerUsername}
- Cinsiyet: ${gender === 'female' ? 'Kadın (Hanımefendi)' : gender === 'male' ? 'Erkek (Beyefendi)' : 'Belirsiz'}

[HİTAP VE DAVRANIŞ TALİMATLARI]
1. Karşıdaki kişiye ismiyle (${nameToUse}) hitap ederken, ismine Türkçe samimi/sevgi dolu küçültme/sevgi eki ekle (Örn: Gizem ise "Gizemcim", Ayşe ise "Ayşecim", Özde ise "Özdecim", Elif ise "Elifcim", Murat ise "Muratcım", Kadir ise "Kadircim"). İsmi yoksa kullanıcı adını samimi şekilde kullan.
2. ${genderInstructions}
3. Birisi "eksiğim var mı?" veya benzeri bir soru sorduğunda, doğrudan cevap vermeden önce veya cevabın başında "Hemen bakıyorum tatlım...", "Hemen senin için kontrol ediyorum güzelim...", "Hemen bakıyorum yakışıklım..." gibi son derece samimi, doğal, flörtöz ve tatlı giriş cümleleri kullan. Hemen ardından sistem bilgisi alanındaki eksik durumunu (eksik var veya eksik yok) aynı mesajın devamında açıkla. Kesinlikle başka bir tur bekliyormuş gibi yapma, cevabı tek bir mesajda tamamla.
4. Üslubun kesinlikle çok samimi, doğal, sıcakkanlı, cilveli ve baya baya flörtöz olsun. Resmiyetten tamamen uzak, cana yakın ve flörtöz bir dil kullan. Karşı tarafı büyüleyici ve tatlı bir şekilde etkilemeye çalış.

Şu anda hesabına bağlı olan aktif gruplar şunlardır (Toplam ${groupNamesList.length} grup):
${groupListStr || 'Bağlı aktif grup bulunmuyor.'}

Kullanıcı kaç grubumuz olduğunu veya grupların isimlerini sorarsa yukarıdaki listeyi kullanarak net ve samimi cevap ver.`;

    let extraContextPrompt = '';
    let replyText = '';

    // Concurrency / Interactive states check
    const userState = db.prepare('SELECT * FROM ai_user_states WHERE username = ?').get(partnerUsername) as { username: string; state: string; data: string; updated_at: number } | undefined;
    let checkedGroupId: string | null = null;
    let isGroupSelectionProcessed = false;

    if (userState && userState.state === 'WAITING_FOR_GROUP_SELECTION') {
      const selectedNumber = parseInt(cleanMsg.replace(/\D/g, ''), 10);
      const threadIdsList = JSON.parse(userState.data) as string[];
      
      if (!isNaN(selectedNumber)) {
        if (selectedNumber >= 1 && selectedNumber <= threadIdsList.length) {
          // User selected a valid number! Clear state and run check for that specific group
          db.prepare('DELETE FROM ai_user_states WHERE username = ?').run(partnerUsername);
          checkedGroupId = threadIdsList[selectedNumber - 1];
          isGroupSelectionProcessed = true;
        } else {
          // Number is out of range. Prompt them again.
          const listText = `Lütfen geçerli bir grup numarası seçin (1 ile ${threadIdsList.length} arasında).`;
          replyText = listText;
          isGroupSelectionProcessed = true;
        }
      } else {
        // If not a number, but they sent another message, let's clear state so we don't lock them in
        db.prepare('DELETE FROM ai_user_states WHERE username = ?').run(partnerUsername);
        // Let it fall through to normal message parsing
      }
    }

    // Build context string from the last 3 messages to detect matched group name
    const normalizedContext = normalizeTurkish(
      lastUserMessage + ' ' + 
      (chatHistory[chatHistory.length - 2]?.content || '') + ' ' + 
      (chatHistory[chatHistory.length - 3]?.content || '')
    );

    let matchedThread: any = null;
    for (const thread of groupThreads) {
      const title = normalizeTurkish(thread.thread_title || '');
      if (title && (normalizedContext.includes(title) || normalizedContext.replace(/\s+/g, '').includes(title.replace(/\s+/g, '')))) {
        matchedThread = thread;
        break;
      }
    }

    const normalizedMsg = normalizeTurkish(lastUserMessage);

    // Determine if user is asking about who shared a post OR the last post
    const hasPostOrSharingWord = 
      normalizedMsg.includes('post') || 
      normalizedMsg.includes('paylas') || 
      normalizedMsg.includes('gonderi');
      
    const hasWhoOrLastWord = 
      normalizedMsg.includes('kim') || 
      normalizedMsg.includes('hang') || 
      normalizedMsg.includes('son') || 
      normalizedMsg.includes('yeni') || 
      normalizedMsg.includes('liste');

    const isAskingAboutPostSenders = hasPostOrSharingWord && hasWhoOrLastWord;

    const isAskingAboutMissing = 
      normalizedContext.includes('eksik') || 
      normalizedContext.includes('eksi') || 
      normalizedContext.includes('kontrol') || 
      normalizedContext.includes('check') || 
      normalizedContext.includes('yapmadim') || 
      normalizedContext.includes('yapmadigi') ||
      normalizedContext.includes('neler yap');

    // 1. Check if user is asking about their missing posts
    if (isGroupSelectionProcessed) {
      if (checkedGroupId) {
        console.log(`[AI-Responder] Processing user group selection for thread ${checkedGroupId}`);
        const missingList = await checkMemberMissingActions(partnerUsername, cookies, headers, postData, undefined, checkedGroupId);
        extraContextPrompt = buildContextPromptForCheck(partnerUsername, missingList, [checkedGroupId]);
      }
      // If error message is set in extraContextPrompt, it will just use that!
    }
    else if (isAskingAboutMissing) {
      console.log(`[AI-Responder] User ${partnerUsername} asked about missing posts. Fetching their groups...`);
      const userGroups = await getUserGroups(partnerUsername, cookies, headers);

      if (userGroups.length === 0) {
        extraContextPrompt = `\n\n[SİSTEM BİLGİSİ]\nKullanıcı @${partnerUsername} herhangi bir aktif grubumuzda üye değildir. Bu durumu belirt ve yardımcı olamayacağını söyle.`;
      } 
      else if (userGroups.length === 1) {
        const singleGroup = userGroups[0];
        console.log(`[AI-Responder] User is in exactly 1 group: ${singleGroup.threadTitle}. Checking it...`);
        const missingList = await checkMemberMissingActions(partnerUsername, cookies, headers, postData, undefined, singleGroup.threadId);
        extraContextPrompt = buildContextPromptForCheck(partnerUsername, missingList, [singleGroup.threadId]);
      } 
      else {
        // In multiple groups!
        // Check if the user specified a group in their message
        const cleanFilter = normalizedMsg;
        const isSpecificGroupQuery = cleanFilter && (
          cleanFilter.includes('zirve') ||
          cleanFilter.includes('influe') ||
          cleanFilter.includes('vibe')
        );

        let matchedGroup: typeof userGroups[0] | null = null;
        if (isSpecificGroupQuery) {
          for (const g of userGroups) {
            const cleanTitle = g.threadTitle.toLowerCase()
              .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
              .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c');
            const cleanTitleNoEmojis = cleanTitle.replace(/[^a-z0-9\s]+/g, '').trim();

            if (cleanTitleNoEmojis.includes('zirve') && !cleanFilter.includes('zirve')) continue;
            if (cleanTitleNoEmojis.includes('influe') && !cleanFilter.includes('influe')) continue;
            if (cleanTitleNoEmojis.includes('vibe') && !cleanFilter.includes('vibe')) continue;
            if (cleanTitleNoEmojis.includes('like') && !cleanFilter.includes('like')) continue;
            if (cleanTitleNoEmojis.includes('1') && !cleanFilter.includes('1')) continue;
            if (cleanTitleNoEmojis.includes('2') && !cleanFilter.includes('2')) continue;

            matchedGroup = g;
            break;
          }
        }

        if (matchedGroup) {
          console.log(`[AI-Responder] Matched specific group from query: ${matchedGroup.threadTitle}`);
          const missingList = await checkMemberMissingActions(partnerUsername, cookies, headers, postData, undefined, matchedGroup.threadId);
          extraContextPrompt = buildContextPromptForCheck(partnerUsername, missingList, [matchedGroup.threadId]);
        } else {
          console.log(`[AI-Responder] Presenting group selection list directly to user ${partnerUsername}...`);
          
          let listText = 'Hangi grupta eksiğini kontrol etmek istersin? Grubun numarasını yazman yeterli (1 veya 2 vb.):\n';
          userGroups.forEach((g, idx) => {
            listText += `${idx + 1}. ${g.threadTitle}\n`;
          });

          // Save state to DB
          db.prepare('INSERT OR REPLACE INTO ai_user_states (username, state, data, updated_at) VALUES (?, ?, ?, ?)').run(
            partnerUsername,
            'WAITING_FOR_GROUP_SELECTION',
            JSON.stringify(userGroups.map(g => g.threadId)),
            Date.now()
          );

          replyText = listText;
        }
      }
    }
    // 2. Check if user is asking who posted in a group
    else if (isAskingAboutPostSenders) {
      const targetThreadId = matchedThread ? matchedThread.thread_id : threadId;
      const targetThreadTitle = matchedThread ? matchedThread.thread_title : (threadObj.thread_title || 'Mevcut Grup');

      console.log(`[AI-Responder] User asked who posted. Target Group: ${targetThreadTitle} (ID: ${targetThreadId})`);
      const senders = await getGroupSendersList(targetThreadId, cookies, headers);

      if (senders.length > 0) {
        // Sort senders by post timestamp ascending (newest last)
        const sortedSenders = [...senders].sort((a, b) => a.timestamp - b.timestamp);
        const newest = sortedSenders[sortedSenders.length - 1];

        const uniqueSenders = new Map<string, string[]>();
        senders.forEach(s => {
          if (!uniqueSenders.has(s.username)) {
            uniqueSenders.set(s.username, []);
          }
          uniqueSenders.get(s.username)!.push(s.shortcode);
        });
        
        let senderLines = '';
        uniqueSenders.forEach((shortcodes, username) => {
          const links = shortcodes.map(code => `https://www.instagram.com/p/${code}/`).join(', ');
          senderLines += `- @${username} (Paylaştığı gönderi(ler): ${links})\n`;
        });

        extraContextPrompt = `\n\n[SİSTEM BİLGİSİ - CANLI PAYLAŞIM LİSTESİ (Grup: ${targetThreadTitle})]\nBu grupta bugün/dün paylaşım yapan üyelerin listesi:\n${senderLines}\n\n[EN SON PAYLAŞIM YAPAN ÜYE]\nKullanıcı adı: @${newest.username}\nGönderi Linki: https://www.instagram.com/p/${newest.shortcode}/\n\nBu bilgileri kullanarak kurucu gibi davran ve kullanıcıya en son paylaşım yapan üyenin @${newest.username} olduğunu belirtip linkini ver. Diğer paylaşım yapanları da istersen listeleyebilirsin.`;
      } else {
        extraContextPrompt = `\n\n[SİSTEM BİLGİSİ - CANLI PAYLAŞIM LİSTESİ (Grup: ${targetThreadTitle})]\nBu grupta bugün/dün hiç kimse paylaşım yapmamıştır.\n\nBu bilgiyi kullanarak grupta henüz yeni bir paylaşım olmadığını ilet.`;
      }
    }

    if (!replyText) {
      const finalSystemPrompt = dynamicSystemPrompt + extraContextPrompt;
      let historyToPass = chatHistory.slice(-6);
      if (extraContextPrompt.includes('CANLI EKSİK KONTROLÜ')) {
        historyToPass = chatHistory.slice(-1);
      }
      replyText = await callAIModel(historyToPass, finalSystemPrompt, settings);
    }

    if (!replyText) {
      throw new Error('All candidate models failed to generate an AI response.');
    }

    if (replyText) {
      console.log(`[AI-Responder] AI Reply generated for ${threadId}: "${replyText}"`);
      
      const cleanReply = cleanMarkdownForInstagram(replyText);
      console.log(`[AI-Responder] Cleaned AI Reply for ${threadId}: "${cleanReply}"`);
      
      // Parse cleanReply into separate message chunks (sending links one-by-one)
      const chunks: string[] = [];
      const urlRegex = /(https?:\/\/[^\s,]+)/g;
      const parts = cleanReply.split(urlRegex);
      let currentTextAccumulator = '';
      
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        
        const isUrl = trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.includes('instagram.com/');
        if (isUrl) {
          if (currentTextAccumulator.trim()) {
            chunks.push(currentTextAccumulator.trim());
            currentTextAccumulator = '';
          }
          chunks.push(trimmed);
        } else {
          const cleanedLine = trimmed.replace(/^[\s\-\*•\+]+/, '').trim();
          if (cleanedLine) {
            if (currentTextAccumulator) {
              currentTextAccumulator += '\n' + cleanedLine;
            } else {
              currentTextAccumulator = cleanedLine;
            }
          }
        }
      }
      if (currentTextAccumulator.trim()) {
        chunks.push(currentTextAccumulator.trim());
      }

      console.log(`[AI-Responder] Split reply into ${chunks.length} message chunks.`);

      // Send each chunk one-by-one with typing indicators
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[AI-Responder] Sending chunk ${i + 1}/${chunks.length}: "${chunk}"`);

        // Simulate typing for each chunk
        await sendTypingIndicator(threadId, true).catch(() => {});
        const typingDelay = Math.max(2000, Math.min(5000, chunk.length * 30));
        await sleep(typingDelay);

        const sendRes = await sendDirectMessage(recipientId, chunk, cookies, headers, postData, inboxThreads, true);
        if (sendRes.success) {
          logMessage('success', `Yapay Zeka Asistanı, bir kullanıcıya otomatik cevap (Parça ${i + 1}/${chunks.length}) verdi: "${chunk}"`);
          if (sendRes.messageId) {
            db.prepare('INSERT INTO sent_messages_history (thread_id, message_id) VALUES (?, ?)').run(threadId, sendRes.messageId);
          }
        } else {
          throw new Error(`Instagram API returned success=false when sending chunk: ${JSON.stringify(sendRes)}`);
        }
        
        // Tiny pause between messages
        await sleep(1000);
      }
    }
  } catch (err: any) {
    console.error(`[AI-Responder] Error in respondWithAI for thread ${threadId}:`, err.message || err);
    throw err;
  }
}

async function handleGroupChatRulesAndAI(
  thread: any,
  cookies: Record<string, string>,
  headers: Record<string, string>,
  postData: any,
  settings: AutomationSettings
) {
  const threadId = String(thread.thread_id);
  const items = thread.items || [];
  const lastMsg = items[0];
  if (!lastMsg) return;

  const viewerId = String(cookies['ds_user_id']);
  const senderId = String(lastMsg.user_id);
  
  // If the last message is from us, we do not respond to ourselves
  if (senderId === viewerId) return;

  const lastMsgText = (lastMsg.text || '').trim();
  const senderUsername = thread.users?.find((u: any) => String(u.pk || u.id) === senderId)?.username || '';
  if (!senderUsername) return;

  // 1. Group Rules Violation Checks (Swearing, Gambling, Fighting)
  const swearingRegex = /\b(amk|aq|oç|sik|piç|siktir|orospu|göt|amına|yarrak|taşşak|kahpe|aptal|salak|gerizekali|gerizekalı|şerefsiz|o\.ç|amcık|piç|yavşak|gevşek|it)\b/i;
  const gamblingRegex = /\b(bahis|casino|slot|kumar|rulet|blackjack|iddaa|sweet bonanza|bonanza|bets10|jetbahis|mobilbahis)\b/i;
  const fightingRegex = /\b(kes sesini|haddini bil|terbiyesiz|saygısız|boş yapma|kes lan|salak mısın|oğlum bak git|yalan söylüyorsun|yalancı|kavga|tartışma)\b/i;

  let violationWarning = '';
  if (swearingRegex.test(lastMsgText)) {
    violationWarning = `@${senderUsername} lütfen grupta küfür veya hakaret içeren ifadeler kullanmayalım, mesajlarımızı geri çekelim.`;
  } else if (gamblingRegex.test(lastMsgText)) {
    violationWarning = `@${senderUsername} lütfen grupta bahis/kumar paylaşımı yapmayalım, mesajlarımızı geri çekelim.`;
  } else if (fightingRegex.test(lastMsgText)) {
    violationWarning = `@${senderUsername} lütfen grupta tartışmayalım, mesajlarımızı geri çekelim.`;
  }

  if (violationWarning) {
    console.log(`[AI-Group] Rules violation detected from @${senderUsername} in thread ${threadId}: ${lastMsgText}`);
    // Check if we already warned for this message
    const alreadyWarned = db.prepare('SELECT 1 FROM ai_responded_messages WHERE user_message_id = ?').get(String(lastMsg.item_id || lastMsg.message_id));
    if (!alreadyWarned) {
      db.prepare('INSERT INTO ai_responded_messages (user_message_id, thread_id, responded_at) VALUES (?, ?, ?)').run(String(lastMsg.item_id || lastMsg.message_id), threadId, Date.now());
      await sendDirectMessage(threadId, violationWarning, cookies, headers, postData, [thread]);
    }
    return;
  }

  // 2. Daily Post/Reels/Story Limit Check (for non-admins)
  const isPostShare = lastMsg.media_share || lastMsg.direct_media_share?.media || lastMsg.item_type === 'media_share';
  const isReelShare = lastMsg.clip?.clip || lastMsg.clip?.media || lastMsg.clip || lastMsg.item_type === 'clip';
  const isLinkShare = lastMsgText.toLowerCase().includes('instagram.com/p/') || 
                      lastMsgText.toLowerCase().includes('instagram.com/reel/') || 
                      lastMsgText.toLowerCase().includes('instagram.com/share/');
  const isStoryShare = lastMsg.story_share || lastMsg.item_type === 'story_share' || lastMsgText.toLowerCase().includes('instagram.com/stories/');
  
  if (isPostShare || isReelShare || isLinkShare || isStoryShare) {
    const threadConfig = db.prepare('SELECT * FROM automation_threads WHERE thread_id = ?').get(threadId) as any;
    const adminUsernames = threadConfig ? (threadConfig.admin_username || '').split(',').map((u: string) => u.trim().toLowerCase()).filter(Boolean) : [];
    const isAdmin = adminUsernames.includes(senderUsername.toLowerCase());

    if (!isAdmin) {
      // Count user's shares today
      const todayStr = getIstanbulDateStr(new Date());
      let postsCount = 0;
      let storiesCount = 0;

      items.forEach((item: any) => {
        if (String(item.user_id) !== senderId) return;
        
        const tsMs = String(item.timestamp).length > 13 ? Math.floor(Number(item.timestamp) / 1000) : Number(item.timestamp);
        const itemDate = getIstanbulDateStr(new Date(tsMs));
        if (itemDate !== todayStr) return;

        const isItemPost = item.media_share || item.direct_media_share?.media || item.item_type === 'media_share';
        const isItemReel = item.clip?.clip || item.clip?.media || item.clip || item.item_type === 'clip';
        const isItemLink = (item.text || '').toLowerCase().includes('instagram.com/p/') || 
                           (item.text || '').toLowerCase().includes('instagram.com/reel/') || 
                           (item.text || '').toLowerCase().includes('instagram.com/share/');
        const isItemStory = item.story_share || item.item_type === 'story_share' || (item.text || '').toLowerCase().includes('instagram.com/stories/');

        if (isItemPost || isItemReel || isItemLink) {
          postsCount++;
        }
        if (isItemStory) {
          storiesCount++;
        }
      });

      let shouldWarn = false;
      let shareWarning = '';

      if (isPostShare || isReelShare || isLinkShare) {
        if (postsCount > 1) {
          shouldWarn = true;
          shareWarning = `@${senderUsername} lütfen paylaşımımızı geri çekelim günlük 1 paylaşım atma hakkınız var.`;
        }
      }

      if (isStoryShare) {
        if (postsCount > 0 && storiesCount > 1) {
          shouldWarn = true;
          shareWarning = `@${senderUsername} lütfen paylaşımımızı geri çekelim günlük paylaşım limitini aştınız. Günlük 1 post/reels ve 1 hikaye hakkınız vardır.`;
        } else if (postsCount === 0 && storiesCount > 2) {
          shouldWarn = true;
          shareWarning = `@${senderUsername} lütfen paylaşımımızı geri çekelim günlük paylaşım limitini aştınız. Hiç post/reels atmadıysanız en fazla 2 hikaye hakkınız vardır.`;
        }
      }

      if (shouldWarn && shareWarning) {
        const alreadyWarned = db.prepare('SELECT 1 FROM ai_responded_messages WHERE user_message_id = ?').get(String(lastMsg.item_id || lastMsg.message_id));
        if (!alreadyWarned) {
          db.prepare('INSERT INTO ai_responded_messages (user_message_id, thread_id, responded_at) VALUES (?, ?, ?)').run(String(lastMsg.item_id || lastMsg.message_id), threadId, Date.now());
          console.log(`[AI-Group] Share limit warning to @${senderUsername} in thread ${threadId}: ${shareWarning}`);
          await sendDirectMessage(threadId, shareWarning, cookies, headers, postData, [thread]);
        }
        return;
      }
    }
  }

  // 3. "hey seghob" summoning check & active focus check
  const isSummoned = lastMsgText.toLowerCase().includes('hey seghob');
  
  // Check active focus session
  const focusSession = db.prepare('SELECT * FROM ai_user_states WHERE username = ? AND state = ? AND data = ?').get(senderUsername, 'GROUP_FOCUS', threadId) as any;
  const isFocused = focusSession && (Date.now() - Number(focusSession.updated_at) < 120000); // 2 minutes (120 seconds)

  if (isSummoned || isFocused) {
    const lastMsgId = String(lastMsg.item_id || lastMsg.message_id);
    const alreadyResponded = db.prepare('SELECT 1 FROM ai_responded_messages WHERE user_message_id = ?').get(lastMsgId);
    if (alreadyResponded) return;

    db.prepare('INSERT INTO ai_responded_messages (user_message_id, thread_id, responded_at) VALUES (?, ?, ?)').run(lastMsgId, threadId, Date.now());

    // Update/Set focus session
    db.prepare('INSERT OR REPLACE INTO ai_user_states (username, state, data, updated_at) VALUES (?, ?, ?, ?)').run(senderUsername, 'GROUP_FOCUS', threadId, Date.now());

    console.log(`[AI-Group] Summoned/Focused response trigger in thread ${threadId} for @${senderUsername}`);

    // Build chat history of the group
    // Sort items from oldest to newest
    const sortedItems = [...items].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
    const chatHistory: { role: string; content: string }[] = [];
    for (const item of sortedItems) {
      const isMsgFromViewer = String(item.user_id) === viewerId;
      let msgText = item.text || '';

      if (!msgText) {
        if (item.media_share || item.direct_media_share?.media) msgText = '[Gönderi paylaştı]';
        else if (item.clip?.clip || item.clip?.media || item.clip) msgText = '[Reel paylaştı]';
      }

      if (!msgText) continue;

      const itemSender = thread.users?.find((u: any) => String(u.pk || u.id) === String(item.user_id));
      const senderName = itemSender ? itemSender.username : (isMsgFromViewer ? 'seghob' : 'üye');

      if (isMsgFromViewer) {
        chatHistory.push({ role: 'assistant', content: msgText });
      } else {
        chatHistory.push({ role: 'user', content: `@${senderName}: ${msgText}` });
      }
    }

    // Build Group Summary Context to make the AI "know everything"
    const memberCount = (thread.users || []).length + 1; // +1 for the bot itself
    
    // Get list of shares today and yesterday
    const todayStr = getIstanbulDateStr(new Date());
    const sharesList: string[] = [];
    items.forEach((item: any) => {
      const isItemPost = item.media_share || item.direct_media_share?.media || item.item_type === 'media_share';
      const isItemReel = item.clip?.clip || item.clip?.media || item.clip || item.item_type === 'clip';
      if (isItemPost || isItemReel) {
        const itemSender = thread.users?.find((u: any) => String(u.pk || u.id) === String(item.user_id));
        const username = itemSender ? itemSender.username : 'Bilinmeyen';
        const tsMs = String(item.timestamp).length > 13 ? Math.floor(Number(item.timestamp) / 1000) : Number(item.timestamp);
        const dateStr = getIstanbulDateStr(new Date(tsMs));
        const cleanShortcode = item.media_share?.shortcode || item.clip?.clip?.shortcode || 'gönderi';
        sharesList.push(`- @${username}: ${dateStr} tarihinde bir paylaşım yaptı (Görsel/Reel Kısa Kodu: ${cleanShortcode})`);
      }
    });

    const sharesContext = sharesList.slice(0, 15).join('\n') || 'Son 15 mesajda paylaşım bulunamadı.';

    const partnerUser = thread.users?.find((u: any) => String(u.pk || u.id) === senderId);
    const fullName = partnerUser?.full_name || '';
    const nameToUse = fullName ? fullName.split(' ')[0] : senderUsername;
    const gender = guessGenderFromTurkishName(fullName || senderUsername);

    let genderInstructions = '';
    if (gender === 'female') {
      genderInstructions = `Kullanıcı KADINDIR. Ona "Hanımefendi", "güzelim", "tatlım", "fıstığım" veya çok samimi, flörtöz/nazik/etkileyici kelimelerle hitap et.`;
    } else if (gender === 'male') {
      genderInstructions = `Kullanıcı ERKEKTİR. Ona "Beyefendi", "yakışıklım", "yakışıklı", "aslanım" veya samimi/kibar/flörtöz hitaplar kullan.`;
    } else {
      genderInstructions = `Kullanıcının cinsiyeti belirsizdir. Kibar, nazik, etkileyici ve çok samimi, hafif flörtöz/tatlı bir üslupla hitap et.`;
    }

    let extraContextPrompt = '';
    const normalizedContext = normalizeTurkish(
      lastMsgText + ' ' + 
      (chatHistory[chatHistory.length - 2]?.content || '') + ' ' + 
      (chatHistory[chatHistory.length - 3]?.content || '')
    );
    const isAskingAboutMissing = 
      normalizedContext.includes('eksik') || 
      normalizedContext.includes('eksi') || 
      normalizedContext.includes('kontrol') || 
      normalizedContext.includes('check') || 
      normalizedContext.includes('yapmadim') || 
      normalizedContext.includes('yapmadigi') ||
      normalizedContext.includes('neler yap');

    if (isAskingAboutMissing) {
      console.log(`[AI-Group] Running live missing actions check for @${senderUsername} in thread ${threadId}...`);
      const missingList = await checkMemberMissingActions(senderUsername, cookies, headers, postData, undefined, threadId);
      
      if (missingList.length === 0) {
        extraContextPrompt = `\n\n[SİSTEM BİLGİSİ - CANLI EKSİK KONTROLÜ]\nKullanıcı @${senderUsername} için yapılan canlı kontrolde HİÇBİR EKSİK BULUNMADI. Tüm paylaşımları beğenmiş ve yorum atmıştır.\n\nBu bilgiyi kullanarak kullanıcıyı tatlıca tebrik et, eksiği olmadığını söyle ve ona flörtöz davran.`;
      } else {
        const missingDetails = missingList.map(item => `- Gönderi Kısakodu: ${item.shortcode} (Sebep: ${item.reason})`).join('\n');
        extraContextPrompt = `\n\n[SİSTEM BİLGİSİ - CANLI EKSİK KONTROLÜ]\nKullanıcı @${senderUsername} için eksik olan etkileşimler:\n${missingDetails}\n\nBu bilgileri kullanarak kullanıcıya eksik olduğu post linklerini/kısakodlarını listele ve tatlıca uyar.`;
      }
    }

    const groupSystemPrompt = `${settings.ai_system_prompt || 'Sen bir Instagram grup otomasyon asistanısın.'}

[GRUP SOHBETİ ÖZEL TALİMATLARI]
- Bu konuşma bir GRUP SOHBETİ'nde geçiyor (Grup Adı: "${thread.thread_title || 'Instagram Grubu'}").
- Şu anda konuştuğun kişi: @${senderUsername} (Adı: ${nameToUse}).
- Yanıtına KESİNLİKLE '@${senderUsername}' yazarak onu etiketleyerek başla.
- Sadece seni çağıran kişiye odaklan ve onun sorularını yanıtla.
- Kendinin bir YAPAY ZEKA ASİSTANI (yapay zeka) olduğunu yanıtlarında kibarca, samimice ve açıkça belirt/hissettir.

[GRUP BİLGİLERİ (HER ŞEYİ BİLİYORSUN VE GÖRÜYORSUN)]
- Gruptaki toplam üye sayısı (Bot dahil): ${memberCount}
- Son paylaşılan gönderiler/reels listesi:
${sharesContext}
${extraContextPrompt}

[HİTAP VE DAVRANIŞ TALİMATLARI]
1. Karşıdaki kişiye ismiyle (${nameToUse}) hitap ederken, ismine Türkçe samimi/sevgi dolu küçültme/sevgi eki ekle (Örn: Gizem ise "Gizemcim", Ayşe ise "Ayşecim", Özde ise "Özdecim", Elif ise "Elifcim", Murat ise "Muratcım", Kadir ise "Kadircim"). İsmi yoksa kullanıcı adını samimi şekilde kullan.
2. ${genderInstructions}
3. Birisi "eksiğim var mı?" veya benzeri bir soru sorduğunda, doğrudan cevap vermeden önce veya cevabın başında "Hemen bakıyorum tatlım...", "Hemen senin için kontrol ediyorum güzelim...", "Hemen bakıyorum yakışıklım..." gibi son derece samimi, doğal, flörtöz ve tatlı giriş cümleleri kullan. Hemen ardından sistem bilgisi alanındaki eksik durumunu (eksik var veya eksik yok) aynı mesajın devamında açıkla. Kesinlikle başka bir tur bekliyormuş gibi yapma, cevabı tek bir mesajda tamamla.
4. Üslubun kesinlikle çok samimi, doğal, sıcakkanlı, cilveli ve baya baya flörtöz olsun. Resmiyetten tamamen uzak, cana yakın ve flörtöz bir dil kullan. Karşı tarafı büyüleyici ve tatlı bir şekilde etkilemeye çalış.
5. Eğer kullanıcı "hey seghob" diyerek sadece selam verdiyse veya çağırdıysa, "@${senderUsername} buyrun nasıl yardımcı olayım" veya benzeri tatlı, flörtöz ve cana yakın bir şekilde selam verip odağını ona sun.`;

    enqueueAIResponseTask({
      type: 'group',
      threadId,
      chatHistory: chatHistory.slice(-6),
      groupSystemPrompt,
      settings,
      cookies,
      headers,
      postData,
      thread,
      lastMsgId
    });
  }
}

async function approveThread(
  threadId: string,
  cookies: Record<string, string>,
  headers: Record<string, string>
) {
  try {
    const settings = db.prepare('SELECT * FROM automation_settings WHERE id = 1').get() as AutomationSettings;
    if (!settings || !settings.post_data) return false;
    const postData = JSON.parse(settings.post_data);

    const cookieHeaderStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
    const tokens = await scrapeTokens(cookieHeaderStr);
    const fbDtsg = tokens.fbDtsg || postData.fb_dtsg || '';
    const lsdToken = tokens.lsd || postData.lsd || '';

    // Generate offline threading ID
    const offlineThreadingId = String(Math.floor(Math.random() * 9000000000000000) + 1000000000000000) + String(Math.floor(Math.random() * 1000));

    const variables = {
      ig_inbox_folder: 'PRIMARY',
      offline_threading_id: offlineThreadingId,
      thread_fbid: threadId
    };

    const form = new URLSearchParams();
    Object.entries({
      ...DEFAULT_DATA,
      ...postData,
      'fb_api_req_friendly_name': 'useIGDirectAcceptMessageRequestMutation',
      'variables': JSON.stringify(variables),
      'doc_id': '36571001125823973',
      ...(fbDtsg ? { fb_dtsg: fbDtsg } : {}),
      ...(lsdToken ? { lsd: lsdToken } : {})
    }).forEach(([k, v]) => form.append(k, String(v)));

    const res = await fetch('https://www.instagram.com/api/graphql', {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
        'x-fb-friendly-name': 'useIGDirectAcceptMessageRequestMutation',
        'cookie': cookieHeaderStr,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });

    if (res.ok) {
      const responseJson = await res.json();
      if (responseJson.errors) {
        console.warn(`[Automation] GraphQL mutation returned errors when accepting thread ${threadId}:`, responseJson.errors);
      } else {
        console.log(`[Automation] Successfully approved/accepted pending thread (FBID: ${threadId})`);
        return true;
      }
    } else {
      console.warn(`[Automation] Approve thread returned status: ${res.status}`, await res.text());
    }
  } catch (err) {
    console.error(`[Automation] Failed to approve thread ${threadId}:`, err);
  }
  return false;
}

// Check if a read/seen thread has never been replied to by the AI, and trigger response
async function checkAndTriggerMissingAIResponse(
  thread: any,
  cookies: Record<string, string>,
  headers: Record<string, string>,
  postData: Record<string, any>,
  settings: AutomationSettings
) {
  try {
    const threadId = String(thread.thread_id);
    const state = getSchedulerState();
    if (!state.processingThreads) {
      state.processingThreads = new Set<string>();
    }

    // If already scheduled to seen/reply or currently processing, do nothing
    if (state.scheduledSeens && state.scheduledSeens[threadId]) {
      return;
    }
    if (state.processingThreads.has(threadId)) {
      return;
    }

    const isGroup = thread.is_group === true || (thread.users && thread.users.length > 1);
    if (isGroup) return;

    const items = thread.items || [];
    if (items.length === 0) return;

    const viewerId = String(cookies['ds_user_id']);
    const lastMsg = items[0];
    const senderId = String(lastMsg.user_id);

    // If the last message is from us, we have already responded!
    if (senderId === viewerId) return;

    // Check if the message is recent (within 24 hours) to avoid replying to ancient history
    const lastMsgTimeMs = Math.floor(Number(lastMsg.timestamp || 0) / 1000);
    const ageMs = Date.now() - lastMsgTimeMs;
    if (ageMs > 24 * 60 * 60 * 1000) return;

    const lastMsgId = String(lastMsg.message_id || lastMsg.item_id);

    // Concurrency control: Check DB if we already responded to this message ID
    const alreadyResponded = db.prepare('SELECT 1 FROM ai_responded_messages WHERE user_message_id = ?').get(lastMsgId);
    if (alreadyResponded) {
      return;
    }

    // Mark as processing to prevent concurrency
    state.processingThreads.add(threadId);
    console.log(`[AutoSeen-Backend] Found unanswered thread ${threadId} (last message from user ${senderId}). Triggering AI response...`);

    const cookieHeaderStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
    const threadUrl = `https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/?limit=10`;
    const threadRes = await fetch(threadUrl, {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
        'cookie': cookieHeaderStr
      },
      cache: 'no-store'
    });

    if (threadRes.ok) {
      const threadJson = await threadRes.json();
      const fullThread = threadJson.thread || {};
      const fullItems = fullThread.items || [];
      
      const chatHistory: { role: string; content: string }[] = [];
      
      // Retrieve partner recipient ID
      const users = fullThread.users || [];
      const partnerUser = users.find((u: any) => String(u.pk || u.id) !== viewerId) || users[0];
      const recipientId = partnerUser ? String(partnerUser.pk || partnerUser.id) : null;

      // Sort items from oldest to newest
      const sortedItems = [...fullItems].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      for (const item of sortedItems) {
        const isMsgFromViewer = String(item.user_id) === viewerId;
        let msgText = item.text || '';

        if (!msgText) {
          if (item.media_share || item.direct_media_share?.media) {
            msgText = '[Gönderi paylaştı]';
          } else if (item.clip?.clip || item.clip?.media || item.clip) {
            msgText = '[Reel paylaştı]';
          } else if (item.item_type === 'media' || item.item_type === 'animated_media') {
            msgText = '[Fotoğraf/Video/GIF gönderdi]';
          } else if (item.item_type === 'story_share') {
            msgText = '[Hikaye paylaştı/Hikayene yanıt verdi]';
          } else if (item.item_type === 'audio') {
            msgText = '[Sesli mesaj gönderdi]';
          }
        }

        if (msgText) {
          chatHistory.push({
            role: isMsgFromViewer ? 'assistant' : 'user',
            content: msgText
          });
        }
      }

      if (chatHistory.length > 0 && recipientId) {
        // Attempt DB lock
        try {
          db.prepare('INSERT INTO ai_responded_messages (user_message_id, thread_id, responded_at) VALUES (?, ?, ?)').run(lastMsgId, threadId, Date.now());
        } catch (dbErr) {
          // Already locked by another process
          return;
        }

        // Enqueue direct message AI response task in the FIFO queue
        enqueueAIResponseTask({
          type: 'direct',
          threadId,
          recipientId,
          chatHistory,
          settings,
          cookies,
          headers,
          postData,
          thread: fullThread,
          lastMsgId
        });
      }
    }
  } catch (err: any) {
    console.error(`[AutoSeen-Backend] Failed checkAndTriggerMissingAIResponse for thread ${thread.thread_id}:`, err.message || err);
  } finally {
    const threadId = String(thread.thread_id);
    const state = getSchedulerState();
    if (state.processingThreads) {
      state.processingThreads.delete(threadId);
    }
  }
}

// Background auto seen simulation (runs at random intervals 15-30 mins per thread)
export async function runBackgroundAutoSeen(force: boolean = false, targetThreadId?: string) {
  try {
    const settings = db.prepare('SELECT * FROM automation_settings WHERE id = 1').get() as AutomationSettings;
    if (!settings || !settings.cookies || !settings.headers || !settings.post_data) return;

    const state = getSchedulerState();
    if (!state.scheduledSeens) {
      state.scheduledSeens = {};
    }

    const now = Date.now();
    
    // 1. Fetch inbox every 60 seconds (or instantly if forced)
    if (force || !state.lastInboxCheckTime || now - state.lastInboxCheckTime > 60 * 1000) {
      if (!force) {
        state.lastInboxCheckTime = now;
      }
      console.log(`[AutoSeen-Backend] Fetching inbox (force=${force}, targetThreadId=${targetThreadId}) to check for unread threads...`);

      const cookies = JSON.parse(settings.cookies);
      const headers = JSON.parse(settings.headers);
      const postData = JSON.parse(settings.post_data);
      const cookieHeaderStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
      
      let threads: any[] = [];
      let fetchSuccess = false;

      if (targetThreadId) {
        console.log(`[AutoSeen-Backend] Fetching target thread ${targetThreadId} directly for real-time accuracy...`);
        const threadUrl = `https://www.instagram.com/api/v1/direct_v2/threads/${targetThreadId}/?limit=20`;
        try {
          const res = await fetch(threadUrl, {
            method: 'GET',
            headers: {
              ...DEFAULT_HEADERS,
              ...headers,
              'cookie': cookieHeaderStr
            },
            redirect: 'manual',
            cache: 'no-store'
          });
          
          if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
            console.warn(`[AutoSeen-Backend] Instagram redirected target thread ${targetThreadId} fetch (session expired/invalid). Status: ${res.status}`);
          } else if (res.ok) {
            const json = await res.json();
            if (json && json.thread) {
              threads = [json.thread];
              fetchSuccess = true;
            }
          }
        } catch (threadErr) {
          console.error(`[AutoSeen-Backend] Failed to fetch target thread ${targetThreadId}:`, threadErr);
        }
      } else {
        const folders = ['default', 'pending'];
        for (const folder of folders) {
          const inboxUrl = folder === 'pending'
            ? 'https://www.instagram.com/api/v1/direct_v2/pending_inbox/?limit=20'
            : 'https://www.instagram.com/api/v1/direct_v2/inbox/?persistentBadging=true&folder=default&limit=20';
          try {
            const res = await fetch(inboxUrl, {
              method: 'GET',
              headers: {
                ...DEFAULT_HEADERS,
                ...headers,
                'cookie': cookieHeaderStr
              },
              redirect: 'manual',
              cache: 'no-store'
            });

            if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
              console.warn(`[AutoSeen-Backend] Instagram redirected folder ${folder} fetch (session expired/invalid). Status: ${res.status}`);
              continue;
            }

            if (res.ok) {
              fetchSuccess = true;
              const json = await res.json();
              const folderThreads = json.inbox?.threads || [];

              // If this is the pending requests folder, automatically accept any unread message requests!
              if (folder === 'pending') {
                for (const thread of folderThreads) {
                  const isUnread = thread.read_state === 0;
                  if (isUnread) {
                    const threadFBID = thread.thread_v2_id || thread.thread_fbid || thread.thread_id;
                    console.log(`[AutoSeen-Backend] Auto-approving pending thread (ID: ${thread.thread_id}, FBID: ${threadFBID})`);
                    await approveThread(threadFBID, cookies, headers);
                    // Mark as read after approval so it accepts cleanly
                    thread.read_state = 0; 
                  }
                }
              }

              threads = threads.concat(folderThreads);
            }
          } catch (fetchErr) {
            console.error(`[AutoSeen-Backend] Failed to fetch folder ${folder}:`, fetchErr);
          }
        }
      }

      if (fetchSuccess) {
        const viewerId = String(cookies['ds_user_id']);

        // Check each thread
        const activeUnreadThreadIds = new Set<string>();

        for (const thread of threads) {
          const threadId = String(thread.thread_id);
          
          // If targetThreadId is specified, skip other threads
          if (targetThreadId && threadId !== String(targetThreadId)) {
            continue;
          }

          const isUnread = targetThreadId ? true : (thread.read_state === 0); // 0 means unread
          const items = thread.items || [];
          const lastMsg = items[0]; // REST API returns newest message first in items array

          if (isUnread && lastMsg) {
            const lastMsgId = String(lastMsg.message_id || lastMsg.item_id);
            const senderId = String(lastMsg.user_id);
            
            // Only seen if the last message was sent by the partner (not us)
            if (senderId !== viewerId) {
              activeUnreadThreadIds.add(threadId);

              const existingScheduled = state.scheduledSeens[threadId];
              // Schedule if not already scheduled, or if a NEW message has arrived from the partner
              if (!existingScheduled || existingScheduled.messageId !== lastMsgId) {
                if (existingScheduled && (existingScheduled as any).timer) {
                  clearTimeout((existingScheduled as any).timer);
                }

                let delayMs = 0;
                if (settings.ai_assistant_enabled === 1) {
                  // Use configured AI delay
                  delayMs = (settings.ai_delay_seconds ?? 30) * 1000;
                  
                  // Trigger seen receipt instantly
                  (async () => {
                    console.log(`[AutoSeen-Backend] Sending instant seen for thread ${threadId}`);
                    await sendSeenIndicator(threadId, lastMsgId, lastMsg.timestamp, cookies, headers, postData).catch((e) => {
                      console.error(`[AutoSeen-Backend] Instant seen failed for thread ${threadId}:`, e);
                    });
                  })();
                } else {
                  // Generate a random duration between 15 and 30 minutes
                  const minMs = 15 * 60 * 1000;
                  const maxMs = 30 * 60 * 1000;
                  delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
                }
                const seenAtTimestamp = now + delayMs;

                let timer: NodeJS.Timeout | undefined = undefined;
                if (delayMs > 0) {
                  timer = setTimeout(() => {
                    console.log(`[AutoSeen-Backend] setTimeout firing for scheduled seen on thread ${threadId}...`);
                    runBackgroundAutoSeen(false, threadId).catch(err => {
                      console.error(`[AutoSeen-Backend] Error running scheduled seen from setTimeout:`, err);
                    });
                  }, delayMs + 100);
                }

                state.scheduledSeens[threadId] = {
                  threadId,
                  messageId: lastMsgId,
                  timestampMs: String(lastMsg.timestamp),
                  seenAtTimestamp,
                  timer: timer as any
                };

                const delaySeconds = Math.round(delayMs / 1000);
                console.log(`[AutoSeen-Backend] Scheduled seen for thread ${threadId} (message ${lastMsgId}) in ${delaySeconds} seconds.`);
              }
            }
          } else if (!isUnread && lastMsg && settings.ai_assistant_enabled === 1 && settings.ai_api_key) {
            checkAndTriggerMissingAIResponse(thread, cookies, headers, postData, settings).catch((err) => {
              console.error(`[AutoSeen-Backend] Error checkAndTriggerMissingAIResponse for thread ${threadId}:`, err);
            });
          }
        }

        // Cancel scheduled seens for threads that are no longer unread
        for (const tId in state.scheduledSeens) {
          // If targetThreadId is specified, do not cancel other threads' scheduled seens
          if (targetThreadId && tId !== String(targetThreadId)) {
            continue;
          }
          if (!activeUnreadThreadIds.has(tId)) {
            console.log(`[AutoSeen-Backend] Cancelling scheduled seen for thread ${tId} (thread read or gone).`);
            const scheduled = state.scheduledSeens[tId];
            if (scheduled && (scheduled as any).timer) {
              clearTimeout((scheduled as any).timer);
            }
            delete state.scheduledSeens[tId];
          }
        }
      } else {
        console.error('[AutoSeen-Backend] Failed to fetch any inbox folder (default or pending).');
      }
    }

    // 2. Execute scheduled seens that are due
    for (const tId in state.scheduledSeens) {
      const scheduled = state.scheduledSeens[tId];
      if (now >= scheduled.seenAtTimestamp) {
        console.log(`[AutoSeen-Backend] Executing seen for thread ${scheduled.threadId} (message ${scheduled.messageId})...`);
        
        const cookies = JSON.parse(settings.cookies);
        const headers = JSON.parse(settings.headers);
        const postData = JSON.parse(settings.post_data);

        // Send seen indicator
        await sendSeenIndicator(
          scheduled.threadId,
          scheduled.messageId,
          scheduled.timestampMs,
          cookies,
          headers,
          postData
        ).catch((e) => {
          console.error(`[AutoSeen-Backend] Seen failed for thread ${scheduled.threadId}:`, e);
        });

        // Trigger AI auto-responder if enabled
        if (settings.ai_assistant_enabled === 1 && settings.ai_api_key) {
          const lastMsgId = scheduled.messageId;
          const alreadyResponded = db.prepare('SELECT 1 FROM ai_responded_messages WHERE user_message_id = ?').get(lastMsgId);

          if (!alreadyResponded) {
            try {
              // Lock it
              db.prepare('INSERT INTO ai_responded_messages (user_message_id, thread_id, responded_at) VALUES (?, ?, ?)').run(lastMsgId, scheduled.threadId, Date.now());
            } catch (dbErr) {
              // Already locked by another process
              continue;
            }

            try {
              const cookieHeaderStr = Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
              const threadUrl = `https://www.instagram.com/api/v1/direct_v2/threads/${scheduled.threadId}/?limit=10`;
              const threadRes = await fetch(threadUrl, {
                method: 'GET',
                headers: {
                  ...DEFAULT_HEADERS,
                  ...headers,
                  'cookie': cookieHeaderStr
                },
                cache: 'no-store'
              });

              if (threadRes.ok) {
                const threadJson = await threadRes.json();
                const thread = threadJson.thread || {};
                
                const isGroup = thread.is_group === true || (thread.users && thread.users.length > 1);
                if (isGroup) {
                  await handleGroupChatRulesAndAI(thread, cookies, headers, postData, settings);
                } else {
                  const items = thread.items || [];
                  const chatHistory: { role: string; content: string }[] = [];
                  const viewerId = String(cookies['ds_user_id']);
                  
                  // Retrieve partner recipient ID
                  const users = thread.users || [];
                  const partnerUser = users.find((u: any) => String(u.pk || u.id) !== viewerId) || users[0];
                  const recipientId = partnerUser ? String(partnerUser.pk || partnerUser.id) : null;

                  // Sort items from oldest to newest
                  const sortedItems = [...items].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
                  for (const item of sortedItems) {
                    const isMsgFromViewer = String(item.user_id) === viewerId;
                    let msgText = item.text || '';

                    if (!msgText) {
                      if (item.media_share || item.direct_media_share?.media) {
                        msgText = '[Gönderi paylaştı]';
                      } else if (item.clip?.clip || item.clip?.media || item.clip) {
                        msgText = '[Reel paylaştı]';
                      } else if (item.item_type === 'media' || item.item_type === 'animated_media') {
                        msgText = '[Fotoğraf/Video/GIF gönderdi]';
                      } else if (item.item_type === 'story_share') {
                        msgText = '[Hikaye paylaştı/Hikayene yanıt verdi]';
                      } else if (item.item_type === 'audio') {
                        msgText = '[Sesli mesaj gönderdi]';
                      }
                    }

                    if (msgText) {
                      chatHistory.push({
                        role: isMsgFromViewer ? 'assistant' : 'user',
                        content: msgText
                      });
                    }
                  }

                  if (chatHistory.length > 0 && recipientId) {
                    // Enqueue direct message AI response task in the FIFO queue
                    enqueueAIResponseTask({
                      type: 'direct',
                      threadId: scheduled.threadId,
                      recipientId,
                      chatHistory,
                      settings,
                      cookies,
                      headers,
                      postData,
                      thread,
                      lastMsgId
                    });
                  } else {
                    db.prepare('DELETE FROM ai_responded_messages WHERE user_message_id = ?').run(lastMsgId);
                  }
                }
              } else {
                db.prepare('DELETE FROM ai_responded_messages WHERE user_message_id = ?').run(lastMsgId);
              }
            } catch (historyErr) {
              console.error('[AutoSeen-Backend] Failed to fetch thread details for AI response. Removing DB lock:', historyErr);
              db.prepare('DELETE FROM ai_responded_messages WHERE user_message_id = ?').run(lastMsgId);
            }
          }
        }

        if (scheduled && (scheduled as any).timer) {
          clearTimeout((scheduled as any).timer);
        }
        // Remove from list
        delete state.scheduledSeens[tId];
      }
    }

  } catch (err: any) {
    console.error('[AutoSeen-Backend] Error in runBackgroundAutoSeen:', err.message || err);
  }
}

// Scheduler check runner (runs every 30 seconds)
async function schedulerTick() {
  try {
    const settings = db.prepare('SELECT * FROM automation_settings WHERE id = 1').get() as AutomationSettings;
    if (!settings) return;

    // Run background auto seen simulation (15-30 minutes delay, human-like)
    runBackgroundAutoSeen().catch(err => {
      console.error('[Automation-AutoSeen] Error running background auto seen:', err);
    });

    if (!settings.enabled) return;

    // Get current Turkey time (HH:MM)
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Istanbul',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    const parts = formatter.formatToParts(new Date());
    let hour = '00';
    let minute = '00';
    parts.forEach(p => {
      if (p.type === 'hour') hour = p.value;
      if (p.type === 'minute') minute = p.value;
    });

    const currentTimeStr = `${hour}:${minute}`;

    // Format current date + minute to prevent duplicate run
    const dateStr = new Date().toLocaleString("en-US", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" });
    const runKey = `${dateStr} ${currentTimeStr}`;

    if (runKey === getSchedulerState().lastRunMinuteStr) return; // Already run this minute

    // Check if current Turkey time matches configured hours
    const hoursList = settings.check_hours.split(',').map(h => h.trim());
    if (hoursList.includes(currentTimeStr)) {
      getSchedulerState().lastRunMinuteStr = runKey;
      logMessage('info', `Zamanlama Tetiklendi: Saat ${currentTimeStr} (GMT+3 TR). Otomasyon başlıyor...`);
      // Start background check without blocking scheduler loop
      runAutomationCheck().catch(err => {
        logMessage('error', `Otomasyon çalışırken hata: ${err.message}`);
        getSchedulerState().isRunningNow = false;
      });
    }
  } catch (e: any) {
    console.error('[Automation-Scheduler] Tick error:', e);
  }
}

// Start background loop
export function startAutomationScheduler() {
  if (getSchedulerState().schedulerInterval) return;
  console.log('[Automation-Scheduler] Background loop initialized.');
  getSchedulerState().schedulerInterval = setInterval(schedulerTick, 30 * 1000); // Check every 30 seconds
}

// Stop background loop
export function stopAutomationScheduler() {
  if (getSchedulerState().schedulerInterval) {
    clearInterval(getSchedulerState().schedulerInterval);
    getSchedulerState().schedulerInterval = null;
    console.log('[Automation-Scheduler] Background loop stopped.');
  }
}
