"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';
import { InstagramThread, InstagramMessage, InstagramUser } from '@/lib/mock-data';
import { parseCurlCommand } from '@/lib/curl-parser';

// Helper function to deduplicate message edges by ID or timestamp + content matching
const deduplicateMessageEdges = (edges: any[]) => {
  const result: any[] = [];
  
  // Sort edges chronologically first
  const sorted = [...edges].sort((a, b) => {
    const tsA = parseInt(a.node?.timestamp_ms || '0', 10);
    const tsB = parseInt(b.node?.timestamp_ms || '0', 10);
    return tsA - tsB;
  });

  for (const edge of sorted) {
    const node = edge.node;
    if (!node) continue;
    
    const nodeTs = parseInt(node.timestamp_ms || '0', 10);
    const nodeText = (node.text_body || node.content?.text_body || '').trim();

    // Check if we already have a message in the result that matches this message
    let foundDuplicate = false;
    for (const existingEdge of result) {
      const eNode = existingEdge.node;
      const eTs = parseInt(eNode.timestamp_ms || '0', 10);
      const eText = (eNode.text_body || eNode.content?.text_body || '').trim();
      
      // If IDs are identical, it's a duplicate
      if (eNode.id === node.id) {
        // Determine which node has richer media content
        const nodeHasMedia = !!node.media_preview_url || (node.media_type && node.media_type !== 'text');
        const eNodeHasMedia = !!eNode.media_preview_url || (eNode.media_type && eNode.media_type !== 'text');
        
        // Prefer the richer node for media properties
        const preferredForMedia = nodeHasMedia ? node : eNode;
        const fallbackForMedia = nodeHasMedia ? eNode : node;

        existingEdge.node = {
          ...eNode,
          ...node,
          // Explicitly keep the richer media attributes
          media_preview_url: preferredForMedia.media_preview_url || fallbackForMedia.media_preview_url || null,
          media_video_url: preferredForMedia.media_video_url || fallbackForMedia.media_video_url || null,
          media_title: preferredForMedia.media_title || fallbackForMedia.media_title || null,
          media_author: preferredForMedia.media_author || fallbackForMedia.media_author || null,
          media_type: (preferredForMedia.media_type && preferredForMedia.media_type !== 'text') 
            ? preferredForMedia.media_type 
            : (fallbackForMedia.media_type || 'text'),
          media_id: preferredForMedia.media_id || fallbackForMedia.media_id || null,
          like_count: preferredForMedia.like_count ?? fallbackForMedia.like_count ?? null,
          comment_count: preferredForMedia.comment_count ?? fallbackForMedia.comment_count ?? null,
          reactions: node.reactions || eNode.reactions || null,
          
          text_body: node.text_body || eNode.text_body,
          igd_snippet: node.igd_snippet || eNode.igd_snippet,
          content: {
            ...eNode.content,
            ...node.content,
            // Keep the richer content body
            xma: preferredForMedia.content?.xma || fallbackForMedia.content?.xma || eNode.content?.xma || node.content?.xma || null
          }
        };
        foundDuplicate = true;
        break;
      }
      
      // If one is temporary and they have the same/very close timestamp and text
      const timeDiff = Math.abs(eTs - nodeTs);
      if (timeDiff < 2000 && eText === nodeText) {
        // If the existing one is temporary, and current is official, upgrade the existing one to official ID
        if (!eNode.id.startsWith('mid.$') && node.id.startsWith('mid.$')) {
          existingEdge.node = node;
        }
        foundDuplicate = true;
        break;
      }
    }

    if (!foundDuplicate) {
      result.push(edge);
    }
  }

  return result;
};

// Helper to recursively unwrap media wrappers in Instagram's REST API payload
const unwrapMedia = (obj: any): any => {
  if (!obj) return null;
  if (obj.clip && typeof obj.clip === 'object') {
    return unwrapMedia(obj.clip);
  }
  if (obj.media_share && typeof obj.media_share === 'object') {
    return unwrapMedia(obj.media_share);
  }
  if (obj.media && typeof obj.media === 'object') {
    return unwrapMedia(obj.media);
  }
  return obj;
};

// Helper to unwrap XMA arrays or single objects
const unwrapXma = (xma: any): any => {
  if (!xma) return null;
  if (Array.isArray(xma)) {
    return xma[0] || null;
  }
  return xma;
};

// Helper to recursively extract preview image URL from any media or XMA object
const extractPreviewUrl = (mediaObj: any): string | null => {
  if (!mediaObj) return null;
  
  // 1. Direct candidates in image_versions2
  if (mediaObj.image_versions2?.candidates) {
    const candidate = mediaObj.image_versions2.candidates[0];
    if (candidate && candidate.url) return candidate.url;
  }
  
  // 2. Direct candidates in image_versions
  if (mediaObj.image_versions?.candidates) {
    const candidate = mediaObj.image_versions.candidates[0];
    if (candidate && candidate.url) return candidate.url;
  }
  
  // 3. Carousel media candidates
  if (mediaObj.carousel_media && mediaObj.carousel_media[0]) {
    const firstMedia = mediaObj.carousel_media[0];
    const url = extractPreviewUrl(firstMedia);
    if (url) return url;
  }
  
  // 4. IGTV or Reels first frame candidates
  if (mediaObj.image_versions2?.additional_candidates?.igtv_first_frame?.url) {
    return mediaObj.image_versions2.additional_candidates.igtv_first_frame.url;
  }
  if (mediaObj.image_versions2?.additional_candidates?.first_frame?.url) {
    return mediaObj.image_versions2.additional_candidates.first_frame.url;
  }
  
  // 5. Common flat properties
  if (mediaObj.preview_image?.url) return mediaObj.preview_image.url;
  if (mediaObj.preview_url) return mediaObj.preview_url;
  if (mediaObj.image_url) return mediaObj.image_url;
  if (mediaObj.thumbnail_url) return mediaObj.thumbnail_url;
  if (typeof mediaObj.image === 'string') return mediaObj.image;

  return null;
};

export default function InboxPage() {
  // State for config credentials
  // State for config credentials loaded synchronously from localStorage
  const [cookies, setCookies] = useState<Record<string, string>>(() => {
    if (typeof window === 'undefined') return DEFAULT_COOKIES;
    try {
      const saved = localStorage.getItem('ig_cookies');
      return saved && saved !== 'undefined' && saved !== 'null' ? JSON.parse(saved) : DEFAULT_COOKIES;
    } catch (e) {
      return DEFAULT_COOKIES;
    }
  });

  const [headers, setHeaders] = useState<Record<string, string>>(() => {
    if (typeof window === 'undefined') return DEFAULT_HEADERS;
    try {
      const saved = localStorage.getItem('ig_headers');
      return saved && saved !== 'undefined' && saved !== 'null' ? JSON.parse(saved) : DEFAULT_HEADERS;
    } catch (e) {
      return DEFAULT_HEADERS;
    }
  });

  const [postData, setPostData] = useState<Record<string, string>>(() => {
    if (typeof window === 'undefined') return DEFAULT_DATA;
    try {
      const saved = localStorage.getItem('ig_data');
      return saved && saved !== 'undefined' && saved !== 'null' ? JSON.parse(saved) : DEFAULT_DATA;
    } catch (e) {
      return DEFAULT_DATA;
    }
  });

  // Stringified JSON states for editing in the settings form
  const [cookiesJson, setCookiesJson] = useState(() => JSON.stringify(cookies, null, 2));
  const [headersJson, setHeadersJson] = useState(() => JSON.stringify(headers, null, 2));
  const [postDataJson, setPostDataJson] = useState(() => JSON.stringify(postData, null, 2));
  const [curlInput, setCurlInput] = useState('');

  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [isMounted, setIsMounted] = useState<boolean>(false);

  // Mode & UI states
  const [threads, setThreads] = useState<InstagramThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [typingRegistry, setTypingRegistry] = useState<Record<string, boolean>>({});
  
  // Link previews cache
  const [linkPreviews, setLinkPreviews] = useState<Record<string, any>>({});

  // Group Details Modal states
  const [isGroupDetailsModalOpen, setIsGroupDetailsModalOpen] = useState(false);
  const [memberSearchQuery, setMemberSearchQuery] = useState('');

  // Comment Match Scan states
  interface CommentScanState {
    isOpen: boolean;
    isScanning: boolean;
    matched: Array<{
      member: InstagramUser;
      comment: string;
      timestamp: number;
    }>;
    unmatched: InstagramUser[];
    totalCommentsScanned: number;
    mediaId: string | null;
    scanType?: 'all' | 'participation';
  }
  const [commentScan, setCommentScan] = useState<CommentScanState>({
    isOpen: false,
    isScanning: false,
    matched: [],
    unmatched: [],
    totalCommentsScanned: 0,
    mediaId: null,
    scanType: 'all'
  });
  const [commentScanTab, setCommentScanTab] = useState<'matched' | 'unmatched'>('matched');

  // Likes Match Scan states
  interface LikeScanState {
    isOpen: boolean;
    isScanning: boolean;
    matched: InstagramUser[];
    unmatched: InstagramUser[];
    totalLikesScanned: number;
    mediaId: string | null;
    scanType?: 'all' | 'participation';
  }
  const [likeScan, setLikeScan] = useState<LikeScanState>({
    isOpen: false,
    isScanning: false,
    matched: [],
    unmatched: [],
    totalLikesScanned: 0,
    mediaId: null,
    scanType: 'all'
  });
  const [likeScanTab, setLikeScanTab] = useState<'matched' | 'unmatched'>('matched');

  // Bulk DM states
  interface BulkDmState {
    isOpen: boolean;
    recipients: InstagramUser[];
    messageText: string;
    isSending: boolean;
    currentIndex: number;
    statuses: Record<string, 'pending' | 'sending' | 'success' | 'error'>;
    errorMessages: Record<string, string>;
    paused: boolean;
  }
  const [bulkDm, setBulkDm] = useState<BulkDmState>({
    isOpen: false,
    recipients: [],
    messageText: '',
    isSending: false,
    currentIndex: 0,
    statuses: {},
    errorMessages: {},
    paused: false
  });
  const bulkDmRef = useRef<BulkDmState>(bulkDm);
  useEffect(() => {
    bulkDmRef.current = bulkDm;
  }, [bulkDm]);

  interface ThreadContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    threadId: string;
  }
  const [threadContextMenu, setThreadContextMenu] = useState<ThreadContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    threadId: '',
  });
  const threadContextMenuJustOpenedRef = useRef(false);

  // Message Context Menu and Editing states
  interface MsgContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    messageId: string;
    text: string;
    isOwnMessage: boolean;
  }
  const [msgContextMenu, setMsgContextMenu] = useState<MsgContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    messageId: '',
    text: '',
    isOwnMessage: false,
  });
  const msgContextMenuJustOpenedRef = useRef(false);



  // Toast notifications state
  interface ToastNotification {
    id: string;
    title: string;
    message: string;
    avatarUrl?: string;
    threadId: string;
  }
  const [toasts, setToasts] = useState<ToastNotification[]>([]);

  const addToast = (title: string, message: string, avatarUrl: string | undefined, threadId: string) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, title, message, avatarUrl, threadId }]);
    
    // Auto-dismiss after 6 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 6000);
  };
  const [threadCursors, setThreadCursors] = useState<Record<string, { oldestCursor: string | null; hasOlder: boolean; isLoadingMore: boolean }>>({});
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null);
  
  // Custom right-click context menu state for Reels/Posts
  interface ContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    mediaId: string;
    mediaType: 'clip' | 'media_share';
  }
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    mediaId: '',
    mediaType: 'clip',
  });

  // Modal state for showing likers or comments
  interface UserListModalState {
    isOpen: boolean;
    type: 'comments' | 'likers';
    mediaId: string;
    isLoading: boolean;
    users: any[];
    hasNextPage: boolean;
    endCursor: string | null;
    isLoadingMore: boolean;
  }
  const [userListModal, setUserListModal] = useState<UserListModalState>({
    isOpen: false,
    type: 'comments',
    mediaId: '',
    isLoading: false,
    users: [],
    hasNextPage: false,
    endCursor: null,
    isLoadingMore: false
  });
  const [commentsSortOrder, setCommentsSortOrder] = useState<string>('recent');
  const lastTouchTimeRef = useRef<Record<string, number>>({});
  const [activeFolder, setActiveFolder] = useState<'PRIMARY' | 'GENERAL'>('PRIMARY');
  const contextMenuJustOpenedRef = useRef<boolean>(false);

  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchSuccess, setFetchSuccess] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [loginMethod, setLoginMethod] = useState<'curl' | 'credentials'>('credentials');
  const [loginCurl, setLoginCurl] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginFeedback, setLoginFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [typedMessage, setTypedMessage] = useState('');
  const [isPollingEnabled, setIsPollingEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const saved = localStorage.getItem('ig_polling_enabled');
      return saved !== null ? saved === 'true' : true;
    } catch (e) {
      return true;
    }
  });
  const [pollingInterval, setPollingInterval] = useState<number>(() => {
    if (typeof window === 'undefined') return 30000;
    try {
      const saved = localStorage.getItem('ig_polling_interval');
      return saved !== null ? parseInt(saved, 10) : 30000;
    } catch (e) {
      return 30000;
    }
  });
  const [realtimeConnectionTrigger, setRealtimeConnectionTrigger] = useState(0);

  // Settings validation feedback
  const [settingsFeedback, setSettingsFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Settings Panel Tabs and Sessions list states
  const [settingsTab, setSettingsTab] = useState<'settings' | 'activities'>('settings');
  const [loginSessions, setLoginSessions] = useState<any[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [isLoggingOutSession, setIsLoggingOutSession] = useState(false);

  // Scroll ref for chat
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const lastNewestMessageIdRef = useRef<string | null>(null);
  const lastInteractionTimeRef = useRef<number>(0);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const recordInteraction = () => {
    lastInteractionTimeRef.current = Date.now();
  };

  // Check client-side login status on mount (prevents hydration mismatch)
  useEffect(() => {
    setIsMounted(true);
    try {
      const saved = localStorage.getItem('ig_cookies');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.sessionid) {
          setIsLoggedIn(true);
        }
      }
    } catch (e) {
      // Ignored
    }
  }, []);

  // Fetch live inbox when logged in
  useEffect(() => {
    if (isLoggedIn) {
      fetchLiveInbox(cookies, headers, postData);
    }
  }, [isLoggedIn]);

  // Scroll to bottom of messages when active thread or messages change
  const activeThread = useMemo(() => {
    return threads.find((t) => t.id === activeThreadId) || null;
  }, [threads, activeThreadId]);

  // Helper to check if anyone is typing in a thread
  const isThreadTyping = (thread: InstagramThread | null) => {
    if (!thread) return false;
    return Object.entries(typingRegistry).some(([key, val]) => {
      if (!val) return false;
      const [tid, uid] = key.split('_');
      const isThreadMatch = tid === thread.id || 
                            tid === thread.thread_id || 
                            tid === thread.thread_fbid;
      return isThreadMatch && uid !== thread.viewer?.interop_messaging_user_fbid;
    });
  };

  // Helper to get descriptive typing text for group/individual threads
  const getThreadTypingText = (thread: InstagramThread | null): string | null => {
    if (!thread) return null;
    
    // Find all user IDs typing in this thread (excluding the viewer themselves)
    const typingUserIds: string[] = [];
    Object.entries(typingRegistry).forEach(([key, val]) => {
      if (!val) return;
      const [tid, uid] = key.split('_');
      const isThreadMatch = tid === thread.id || 
                            tid === thread.thread_id || 
                            tid === thread.thread_fbid;
      
      const viewerObj = thread.viewer as any;
      const isViewer = uid === viewerObj?.interop_messaging_user_fbid || 
                       uid === viewerObj?.id || 
                       uid === viewerObj?.viewer_id ||
                       uid === cookies['ds_user_id'];
                       
      if (isThreadMatch && !isViewer) {
        typingUserIds.push(uid);
      }
    });

    if (typingUserIds.length === 0) return null;

    if (thread.is_group) {
      // Look up usernames for typing user IDs
      const typingUsernames = typingUserIds.map(uid => {
        const user = thread.users?.find(u => String(u.id || u.interop_messaging_user_fbid) === String(uid));
        return user ? `@${user.username}` : 'Biri';
      });
      
      // Remove duplicate usernames if any
      const uniqueUsernames = Array.from(new Set(typingUsernames));

      if (uniqueUsernames.length === 1) {
        return `${uniqueUsernames[0]} yazıyor...`;
      } else if (uniqueUsernames.length === 2) {
        return `${uniqueUsernames[0]} ve ${uniqueUsernames[1]} yazıyor...`;
      } else {
        return `${uniqueUsernames.slice(0, 2).join(', ')} ve ${uniqueUsernames.length - 2} kişi daha yazıyor...`;
      }
    } else {
      return 'yazıyor...';
    }
  };

  const isPartnerTyping = useMemo(() => {
    return isThreadTyping(activeThread);
  }, [activeThread, typingRegistry]);

  // Reset lastNewestMessageIdRef when changing active thread and scroll instantly to the bottom
  useEffect(() => {
    lastNewestMessageIdRef.current = null;
    
    // Force instant scroll to bottom on thread switch to prevent visible viewport slides
    setTimeout(() => {
      if (messagesScrollRef.current) {
        messagesScrollRef.current.scrollTop = messagesScrollRef.current.scrollHeight;
      }
    }, 50);
  }, [activeThreadId]);

  // Scroll to bottom dynamically (only on initial load, viewer message, or if already near bottom and not interacting)
  useEffect(() => {
    if (!activeThread) return;
    const edges = activeThread.slide_messages?.edges || [];
    if (edges.length === 0) return;

    // Find the newest message
    const sorted = [...edges].sort((a, b) => {
      const tsA = parseInt(a.node?.timestamp_ms || '0', 10);
      const tsB = parseInt(b.node?.timestamp_ms || '0', 10);
      return tsA - tsB;
    });

    const newestMsg = sorted[sorted.length - 1]?.node;
    if (!newestMsg) return;

    const newestId = newestMsg.id;
    if (lastNewestMessageIdRef.current !== newestId) {
      const isInitialLoad = lastNewestMessageIdRef.current === null;
      lastNewestMessageIdRef.current = newestId;

      const container = messagesScrollRef.current;
      const isNearBottom = container 
        ? (container.scrollHeight - container.scrollTop - container.clientHeight < 200) 
        : true;

      const sent = isSentByViewer(newestMsg, activeThread);

      // Check if user is currently interacting (last interaction < 60s)
      const isInteracting = (Date.now() - lastInteractionTimeRef.current) < 60000;

      if (isInitialLoad) {
        if (container) {
          container.scrollTop = container.scrollHeight;
        } else {
          messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        }
      } else if (sent) {
        // Always scroll to bottom when viewer sends a message
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      } else if (!isInteracting && isNearBottom) {
        // Scroll to bottom for incoming messages only if not interacting and near bottom
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [activeThreadId, activeThread?.slide_messages?.edges?.length]);

  // Periodic check: scroll to bottom if idle for 60 seconds and not at the bottom
  useEffect(() => {
    const interval = setInterval(() => {
      const container = messagesScrollRef.current;
      if (!container) return;

      const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 15;
      if (isAtBottom) return;

      const timeSinceLastInteraction = Date.now() - lastInteractionTimeRef.current;
      if (timeSinceLastInteraction >= 60000) {
        console.log('[Scroll] Idle for 60s, scrolling to bottom.');
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      }
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  // Auto-refresh messages in background when active thread changes in live mode
  useEffect(() => {
    if (activeThreadId) {
      fetchLiveInbox(cookies, headers, postData, true);
    }
  }, [activeThreadId]);

  // Request desktop notification permission on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const lastReadMessageIdRef = useRef<string | null>(null);

  // Sort edges chronologically to ensure we find the absolute newest message ID
  const activeSortedEdges = [...(activeThread?.slide_messages?.edges || [])].sort((a, b) => {
    const tsA = parseInt(a.node?.timestamp_ms || '0', 10);
    const tsB = parseInt(b.node?.timestamp_ms || '0', 10);
    return tsA - tsB;
  });
  const lastMessageId = activeSortedEdges[activeSortedEdges.length - 1]?.node?.id || '';

  // Automatically mark messages as read when they are loaded in the active thread
  useEffect(() => {
    if (!activeThread) return;
    
    // Sort edges chronologically to find the absolute newest message
    const sortedEdges = [...(activeThread.slide_messages?.edges || [])].sort((a, b) => {
      const tsA = parseInt(a.node?.timestamp_ms || '0', 10);
      const tsB = parseInt(b.node?.timestamp_ms || '0', 10);
      return tsA - tsB;
    });

    const lastMsg = sortedEdges[sortedEdges.length - 1]?.node;
    
    if (lastMsg) {
      const sent = isSentByViewer(lastMsg, activeThread);
      if (!sent && lastReadMessageIdRef.current !== lastMsg.id) {
        lastReadMessageIdRef.current = lastMsg.id;
        sendReadReceipt(activeThread.thread_id, lastMsg.id, lastMsg.timestamp_ms);
      }
    }
  }, [
    activeThread?.slide_messages?.edges?.length,
    lastMessageId,
    activeThreadId
  ]);

  const lastSeenMessageIds = useRef<Record<string, string>>({});
  const lastSeenMessageTimestamps = useRef<Record<string, number>>({});

  // Refs for sending typing status indicators
  const lastTypingSentRef = useRef<number>(0);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const sendTypingIndicatorToServer = async (isActive: boolean) => {
    if (!activeThread) return;
    
    try {
      await fetch('/api/instagram/typing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: activeThread.thread_id || activeThread.id,
          isActive,
          cookies: cookiesRef.current
        })
      });
    } catch (err) {
      console.error('Failed to send typing indicator to server:', err);
    }
  };

  const handleUserTyping = () => {
    if (!activeThreadId) return;

    const now = Date.now();
    // Throttle typing indicator signals to once every 4 seconds to avoid API rate limits
    if (now - lastTypingSentRef.current > 4000) {
      lastTypingSentRef.current = now;
      sendTypingIndicatorToServer(true);
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = setTimeout(() => {
      sendTypingIndicatorToServer(false);
      lastTypingSentRef.current = 0;
    }, 3000);
  };

  // Detect incoming messages and show browser notifications
  useEffect(() => {
    if (threads.length === 0) return;

    threads.forEach(thread => {
      const edges = thread.slide_messages?.edges || [];
      if (edges.length === 0) return;

      // Sort edges chronologically to find the absolute newest message
      const sortedEdges = [...edges].sort((a, b) => {
        const tsA = parseInt(a.node?.timestamp_ms || '0', 10);
        const tsB = parseInt(b.node?.timestamp_ms || '0', 10);
        return tsA - tsB;
      });

      const newestMsg = sortedEdges[sortedEdges.length - 1]?.node;
      if (!newestMsg) return;

      const threadId = thread.id;
      const prevMessageId = lastSeenMessageIds.current[threadId];
      const prevTimestamp = lastSeenMessageTimestamps.current[threadId] || 0;
      const currentTimestamp = parseInt(newestMsg.timestamp_ms || '0', 10);

      // If we have seen this thread before in this session, check if there is a new message with a newer timestamp
      if (prevMessageId && prevMessageId !== newestMsg.id && currentTimestamp > prevTimestamp) {
        // Register activity since a new message has arrived
        lastActivityRef.current = Date.now();

        // If the sender of the message is NOT the viewer, it's an incoming message!
        const isSentByViewer = newestMsg.sender_fbid === thread.viewer?.interop_messaging_user_fbid;
        if (!isSentByViewer) {
          console.log(`New incoming message detected in thread ${threadId}:`, newestMsg);
          
          // Find the actual sender user in thread users list
          const senderId = newestMsg.sender_fbid || '';
          const senderUser = thread.users?.find(
            u => String(u.id) === String(senderId) || 
                 String(u.interop_messaging_user_fbid) === String(senderId) ||
                 String((u as any).pk) === String(senderId)
          );

          const senderName = senderUser 
            ? (senderUser.full_name || senderUser.username)
            : (thread.thread_title || 'Instagram User');
            
          const senderAvatar = senderUser
            ? senderUser.profile_pic_url
            : (thread.thread_image_url || '');

          const bodyText = newestMsg.text_body || newestMsg.content?.text_body || 'Yeni bir mesaj gönderildi.';
          
          // Show toast if we are NOT viewing this thread, or if the browser window is hidden
          const isCurrentThreadActive = activeThreadIdRef.current === threadId;
          const isDocumentHidden = typeof document !== 'undefined' && document.hidden;
          if (!isCurrentThreadActive || isDocumentHidden) {
            addToast(
              senderName,
              bodyText,
              senderAvatar,
              threadId
            );
          }

          if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(senderName, {
              body: bodyText,
              icon: senderAvatar || undefined,
            });
          }
        }
      }

      // Update the last seen message ID and timestamp for this thread
      lastSeenMessageIds.current[threadId] = newestMsg.id;
      lastSeenMessageTimestamps.current[threadId] = Math.max(prevTimestamp, currentTimestamp);
    });
  }, [threads]);



  const cookiesRef = useRef(cookies);
  const headersRef = useRef(headers);
  const postDataRef = useRef(postData);
  const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fetchInProgressRef = useRef<boolean>(false);
  const lastActivityRef = useRef<number>(Date.now());
  const seqIdRef = useRef<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const threadsRef = useRef(threads);
  const autoSeenTimersRef = useRef<Record<string, NodeJS.Timeout>>({});

  // Keep refs updated with current state values
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  // Automated seen simulation for unread threads (delays 5 to 12 minutes)
  useEffect(() => {
    const currentTimers = autoSeenTimersRef.current;
    
    threads.forEach(thread => {
      const threadId = thread.id;
      
      // If thread is active, it's already read. If it's not marked as unread, no need to seen.
      if (threadId === activeThreadId || !thread.marked_as_unread) {
        if (currentTimers[threadId]) {
          console.log(`[AutoSeen] Cancelling timer for thread ${threadId} (read by user or active)`);
          clearTimeout(currentTimers[threadId]);
          delete currentTimers[threadId];
        }
        return;
      }
      
      // If the thread is unread AND we don't have a timer scheduled yet:
      if (!currentTimers[threadId]) {
        // Generate a random duration between 4 and 30 minutes (240,000 to 1,800,000 ms)
        const minMs = 4 * 60 * 1000;
        const maxMs = 30 * 60 * 1000;
        const randomDelay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        const randomMinutes = Math.round(randomDelay / 1000 / 60);
        
        console.log(`[AutoSeen] Scheduling auto-seen for thread ${threadId} in ${randomMinutes} minutes.`);
        
        currentTimers[threadId] = setTimeout(async () => {
          try {
            const currentThreads = threadsRef.current || [];
            const freshThread = currentThreads.find(t => t.id === threadId);
            if (!freshThread || !freshThread.marked_as_unread || threadId === activeThreadIdRef.current) {
              delete currentTimers[threadId];
              return;
            }
            
            const messages = freshThread.slide_messages?.edges || [];
            let latestMsg = null;
            if (messages.length > 0) {
              const sorted = [...messages].sort((a, b) => {
                return parseInt(a.node?.timestamp_ms || '0', 10) - parseInt(b.node?.timestamp_ms || '0', 10);
              });
              latestMsg = sorted[sorted.length - 1]?.node || null;
            }
            
            const viewerId = String(freshThread.viewer?.id || freshThread.viewer?.viewer_id || cookiesRef.current['ds_user_id'] || '');
            const isPartnerMessage = latestMsg && String(latestMsg.sender_fbid) !== viewerId;
            
            if (latestMsg?.id && isPartnerMessage) {
              console.log(`[AutoSeen] Automatically sending seen receipt for thread ${threadId} (message ${latestMsg.id}) after ${randomMinutes} minutes`);
              
              const res = await fetch('/api/instagram/read', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  threadId,
                  messageId: latestMsg.id,
                  timestampMs: latestMsg.timestamp_ms,
                  cookies: cookiesRef.current
                })
              });
              
              const result = await res.json();
              if (res.ok && result.success) {
                // Mark as read locally
                setThreads(prev => 
                  prev.map(t => t.id === threadId ? { ...t, marked_as_unread: false } : t)
                );
              }
            }
          } catch (e) {
            console.error('[AutoSeen] Error during auto-seen execution:', e);
          }
          
          delete currentTimers[threadId];
        }, randomDelay);
      }
    });
    
    // Cleanup timers for threads that are no longer in our threads list
    Object.keys(currentTimers).forEach(tid => {
      const exists = threads.some(t => t.id === tid);
      if (!exists) {
        clearTimeout(currentTimers[tid]);
        delete currentTimers[tid];
      }
    });
  }, [threads, activeThreadId]);

  // Keep refs updated with current state values
  useEffect(() => {
    cookiesRef.current = cookies;
  }, [cookies]);

  useEffect(() => {
    headersRef.current = headers;
  }, [headers]);

  useEffect(() => {
    postDataRef.current = postData;
  }, [postData]);

  // Update activity timestamp on thread selection
  useEffect(() => {
    if (activeThreadId) {
      lastActivityRef.current = Date.now();
    }
  }, [activeThreadId]);

  // Establish real-time WebSocket connection (via Server-Sent Events)
  useEffect(() => {
    if (!isPollingEnabled || !seqIdRef.current) return;

    console.log('[Realtime] Connecting to local socket bridge EventSource with seqId:', seqIdRef.current);
    
    const cookiesEncoded = encodeURIComponent(JSON.stringify(cookiesRef.current));
    const url = `/api/instagram/realtime?cookies=${cookiesEncoded}&seqId=${seqIdRef.current}`;

    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'message') {
          console.log('[Realtime] Live message received:', payload);
          
          if (payload.threadId && payload.message) {
            // Skip local appends for empty messages (such as seen receipts or typing statuses sent on topic 146)
            const hasText = payload.message.text_body && payload.message.text_body.trim() !== '';
            const hasSnippet = payload.message.igd_snippet && payload.message.igd_snippet.trim() !== '';
            if (!hasText && !hasSnippet) {
              console.log('[Realtime] Skipping local append for empty message (status patch/read receipt)');
              return;
            }
            
            // Append message locally for instant UI update!
            setThreads(prevThreads => {
              const updated = prevThreads.map(thread => {
                const isMatch = thread.id === payload.threadId || 
                                thread.thread_id === payload.threadId || 
                                thread.thread_fbid === payload.threadId;
                if (isMatch) {
                  const edges = thread.slide_messages?.edges || [];
                  const exists = edges.some(edge => edge.node?.id === payload.message.id);
                  if (exists) return thread;

                  const newMsgNode: InstagramMessage = {
                    id: payload.message.id,
                    sender_fbid: payload.message.sender_fbid,
                    timestamp_ms: payload.message.timestamp_ms,
                    text_body: payload.message.text_body || '',
                    igd_snippet: payload.message.igd_snippet || payload.message.text_body || '',
                    content_type: payload.message.content_type || 'TEXT',
                    content: {
                      __typename: 'SlideMessageText',
                      text_body: payload.message.text_body || '',
                    }
                  };

                  const viewerId = String(thread.viewer?.id || thread.viewer?.viewer_id || cookiesRef.current['ds_user_id'] || '');
                  const isSentByViewer = String(payload.message.sender_fbid) === viewerId;
                  const isCurrentlyActive = activeThreadIdRef.current === thread.id;
                  const markedAsUnread = !isSentByViewer && !isCurrentlyActive ? true : thread.marked_as_unread;

                  return {
                    ...thread,
                    last_activity_timestamp_ms: payload.message.timestamp_ms,
                    marked_as_unread: markedAsUnread,
                    slide_messages: {
                      ...thread.slide_messages,
                      edges: deduplicateMessageEdges([...edges, { node: newMsgNode }])
                    }
                  };
                }
                return thread;
              });

              // Re-sort threads by last activity (newest first)
              return [...updated].sort((a, b) => {
                const tsA = a.last_activity_timestamp_ms || 0;
                const tsB = b.last_activity_timestamp_ms || 0;
                return tsB - tsA;
              });
            });
          }

          // Debounce the background sync to pull official state from Instagram
          if (fetchTimeoutRef.current) {
            clearTimeout(fetchTimeoutRef.current);
          }

          fetchTimeoutRef.current = setTimeout(() => {
            console.log('[Realtime] Background sync triggering fetchLiveInbox...');
            fetchLiveInbox(cookiesRef.current, headersRef.current, postData, true);
          }, 1000); // 1-second delay to avoid spamming calls
        } else if (payload.type === 'seen') {
          console.log('[Realtime] Seen receipt received:', payload);
          const viewerId = String(cookiesRef.current?.['ds_user_id'] || '');
          const isFromPartner = !payload.userId || String(payload.userId) !== viewerId;
          
          if (isFromPartner) {
            const rawWatermark = payload.watermark;
            let watermarkMs = '';
            if (rawWatermark) {
              const num = Number(rawWatermark);
              if (num > 10000000000000) {
                // Microseconds (16 digits) -> convert to milliseconds
                watermarkMs = String(Math.floor(num / 1000));
              } else if (num < 10000000000) {
                // Seconds (10 digits) -> convert to milliseconds
                watermarkMs = String(num * 1000);
              } else {
                // Milliseconds (13 digits) -> keep as is
                watermarkMs = String(num);
              }
            }

            setThreads(prevThreads => {
              return prevThreads.map(thread => {
                const isMatch = thread.id === payload.threadId || 
                                thread.thread_id === payload.threadId || 
                                thread.thread_fbid === payload.threadId;
                if (isMatch) {
                  return {
                    ...thread,
                    last_seen_watermark_ms: watermarkMs || thread.last_seen_watermark_ms
                  };
                }
                return thread;
              });
            });
          }
        } else if (payload.type === 'reaction') {
          console.log('[Realtime] Reaction event received:', payload);
          const { threadId, messageId, userId, reaction, isAdded } = payload;
          
          setThreads(prevThreads => 
            prevThreads.map(thread => {
              const isMatch = thread.id === threadId || 
                              thread.thread_id === threadId || 
                              thread.thread_fbid === threadId;
              if (!isMatch) return thread;
              
              const edges = thread.slide_messages?.edges || [];
              const updatedEdges = edges.map((edge: any) => {
                const isMsgMatch = edge.node?.id === messageId || edge.node?.item_id === messageId;
                if (!isMsgMatch) return edge;
                
                const currentReactions = edge.node.reactions || [];
                let newReactions;
                
                if (isAdded) {
                  const exists = currentReactions.some((r: any) => String(r.sender_fbid) === String(userId) && r.reaction === reaction);
                  if (exists) return edge;
                  newReactions = [...currentReactions, {
                    reaction,
                    reaction_timestamp_ms: String(Date.now()),
                    sender_fbid: String(userId)
                  }];
                } else {
                  newReactions = currentReactions.filter((r: any) => !(String(r.sender_fbid) === String(userId) && r.reaction === reaction));
                }
                
                return {
                  ...edge,
                  node: {
                    ...edge.node,
                    reactions: newReactions
                  }
                };
              });
              
              return {
                ...thread,
                slide_messages: {
                  ...thread.slide_messages,
                  edges: updatedEdges
                }
              };
            })
          );
        } else if (payload.type === 'typing') {
          const key = `${payload.threadId}_${payload.userId}`;
          console.log(`[Realtime] Typing status update: ${key} = ${payload.isTyping}`);
          setTypingRegistry(prev => ({
            ...prev,
            [key]: payload.isTyping
          }));
          
          if (payload.isTyping) {
            // Auto-clear typing indicator after 6 seconds in case we miss the stop event
            setTimeout(() => {
              setTypingRegistry(prev => {
                if (prev[key]) {
                  return { ...prev, [key]: false };
                }
                return prev;
              });
            }, 6000);
          }
        } else if (payload.type === 'connected') {
          console.log('[Realtime] Live socket bridge connection established.');
        }
      } catch (e) {
        // Fallback for legacy text data
        if (event.data === 'message') {
          console.log('[Realtime] Live message trigger received from socket bridge. Debouncing sync...');
          
          if (fetchTimeoutRef.current) {
            clearTimeout(fetchTimeoutRef.current);
          }

          fetchTimeoutRef.current = setTimeout(() => {
            console.log('[Realtime] Debounced sync triggering fetchLiveInbox...');
            fetchLiveInbox(cookiesRef.current, headersRef.current, postData, true);
          }, 1000); // 1-second debounce window
        } else if (event.data === 'connected') {
          console.log('[Realtime] Live socket bridge connection established.');
        }
      }
    };

    eventSource.onerror = (err) => {
      console.error('[Realtime] Realtime EventSource encountered an error, closing:', err);
      eventSource.close();
      setIsPollingEnabled(false);
    };

    return () => {
      console.log('[Realtime] Closing realtime EventSource connection.');
      eventSource.close();
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
      }
    };
  }, [isPollingEnabled, realtimeConnectionTrigger]);

  // Update cookies dynamically when server sends set-cookie updates
  const handleUpdateCookies = (newCookies: Record<string, string>) => {
    if (!newCookies || Object.keys(newCookies).length === 0) return;
    
    setCookies(prev => {
      const merged = { ...prev, ...newCookies };
      localStorage.setItem('ig_cookies', JSON.stringify(merged));
      setCookiesJson(JSON.stringify(merged, null, 2));
      return merged;
    });
  };

  // Helper to fetch details of a shared Instagram post/reel link dynamically from backend
  const fetchLinkPreview = async (shortcode: string) => {
    if (!shortcode) return;
    if (linkPreviews[shortcode] || linkPreviews[shortcode] === 'loading') return;

    setLinkPreviews(prev => ({ ...prev, [shortcode]: 'loading' }));

    try {
      const response = await fetch('/api/instagram/media/info', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          shortcode,
          cookies: cookiesRef.current,
          headers: headersRef.current
        })
      });

      const result = await response.json();
      if (result.success && result.media) {
        setLinkPreviews(prev => ({
          ...prev,
          [shortcode]: result.media
        }));
      } else {
        setLinkPreviews(prev => ({
          ...prev,
          [shortcode]: 'error'
        }));
      }
    } catch (e) {
      console.error('[Preview] Failed to fetch dynamic link preview:', e);
      setLinkPreviews(prev => ({
        ...prev,
        [shortcode]: 'error'
      }));
    }
  };

  const getShortcodeFromUrl = (url: string) => {
    if (!url) return null;
    const match = url.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  };

  // Load initial history messages for a thread to get rich previews and history
  const fetchThreadHistory = async (thread: InstagramThread, force = false) => {
    const threadId = thread.id;
    
    // Check if already loaded or currently loading
    if (!force && threadCursors[threadId]) {
      return;
    }

    // Set loading cursor state
    setThreadCursors(prev => ({
      ...prev,
      [threadId]: { oldestCursor: null, hasOlder: true, isLoadingMore: true }
    }));

    console.log(`[History] Fetching initial REST history for thread ${threadId}...`);

    try {
      const response = await fetch('/api/instagram/history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadId: thread.thread_id,
          cookies: cookiesRef.current,
          headers: headersRef.current,
        }),
      });

      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to fetch thread history');
      }

      if (result.cookies) {
        handleUpdateCookies(result.cookies);
      }

      const items = (result.items || []).filter((item: any) => {
        if (item.item_type === 'like' || item.item_type === 'reaction' || item.item_type === 'action_log' || item.hide_in_thread === 1) {
          return false;
        }
        return true;
      });
      const mappedMessages: InstagramMessage[] = items.map((item: any) => {
        let text = item.text || '';
        let previewUrl: string | null = null;
        let videoUrl: string | null = null;
        let title: string | null = null;
        let author: string | null = null;
        let mediaType: string | null = null;
        
        // Unwrap nested wrappers dynamically (e.g. clip.clip, media_share.media_share)
        const clipObj = unwrapMedia(item.clip || item.xma_clip_share || item.xma_clip);
        const mediaShareObj = unwrapMedia(item.media_share || item.direct_media_share || item.xma_media_share || item.xma_media);
        const storyShareObj = unwrapMedia(item.story_share || item.xma_story_share || item.xma_story);
        const xmaObj = unwrapXma(item.xma || item.xma_share || item.xma_layout_data);

        let mediaId: string | null = null;
        let likeCount: number | null = null;
        let commentCount: number | null = null;

        if (clipObj) {
          mediaType = 'clip';
          previewUrl = extractPreviewUrl(clipObj);
          videoUrl = clipObj.video_versions?.[0]?.url || null;
          title = clipObj.caption?.text || 'Paylaşılan Reels videosu';
          author = clipObj.user?.username || null;
          mediaId = clipObj.pk || clipObj.id || null;
          likeCount = clipObj.like_count ?? null;
          commentCount = clipObj.comment_count ?? null;
          text = text || `Bir Reels videosu paylaştı: ${title}`;

          // Fallback to xmaObj preview if missing (restricted/private accounts)
          if (!previewUrl && xmaObj) {
            previewUrl = extractPreviewUrl(xmaObj);
            if (!mediaId) mediaId = xmaObj.target_id || null;
            if (!title) title = xmaObj.title || xmaObj.title_text || xmaObj.caption || null;
          }
        } else if (mediaShareObj) {
          mediaType = 'media_share';
          previewUrl = extractPreviewUrl(mediaShareObj);
          videoUrl = mediaShareObj.video_versions?.[0]?.url || 
                     mediaShareObj.carousel_media?.[0]?.video_versions?.[0]?.url || 
                     null;
          title = mediaShareObj.caption?.text || 'Paylaşılan gönderi';
          author = mediaShareObj.user?.username || null;
          mediaId = mediaShareObj.pk || mediaShareObj.id || null;
          likeCount = mediaShareObj.like_count ?? null;
          commentCount = mediaShareObj.comment_count ?? null;
          text = text || `Bir gönderi paylaştı: ${title}`;

          // Fallback to xmaObj preview if missing (restricted/private accounts)
          if (!previewUrl && xmaObj) {
            previewUrl = extractPreviewUrl(xmaObj);
            if (!mediaId) mediaId = xmaObj.target_id || null;
            if (!title) title = xmaObj.title || xmaObj.title_text || xmaObj.caption || null;
          }
        } else if (storyShareObj) {
          mediaType = 'story_share';
          const media = storyShareObj.media || storyShareObj;
          previewUrl = extractPreviewUrl(media) || extractPreviewUrl(storyShareObj);
          title = storyShareObj.title || storyShareObj.message || 'Paylaşılan hikaye';
          author = media.user?.username || storyShareObj.user?.username || null;
          text = text || `Bir hikaye paylaştı: ${title}`;

          // Fallback to xmaObj preview if missing (restricted/private accounts)
          if (!previewUrl && xmaObj) {
            previewUrl = extractPreviewUrl(xmaObj);
            if (!mediaId) mediaId = xmaObj.target_id || null;
            if (!title) title = xmaObj.title || xmaObj.title_text || xmaObj.caption || null;
          }
        } else if (xmaObj) {
          const isReel = xmaObj.target_url?.includes('/reel/') || xmaObj.target_url?.includes('/reels/') || xmaObj.title?.toLowerCase()?.includes('reels');
          mediaType = isReel ? 'clip' : 'media_share';
          previewUrl = extractPreviewUrl(xmaObj);
          title = xmaObj.title || xmaObj.title_text || xmaObj.caption || 'Paylaşılan içerik';
          author = xmaObj.header_title_text || xmaObj.subtitle_text || xmaObj.user?.username || null;
          mediaId = xmaObj.target_id || null;

          const innerMedia = xmaObj.media || xmaObj.xma_media || null;
          if (innerMedia) {
            likeCount = innerMedia.like_count || innerMedia.like_and_view_metadata_dict?.like_count || null;
            commentCount = innerMedia.comment_count || null;
          }
          
          text = text || `${isReel ? 'Bir Reels videosu' : 'Bir gönderi'} paylaştı: ${title}`;
        } else if (item.item_type === 'link' && item.link) {
          const linkContext = item.link.link_context || {};
          const linkUrl = item.link.text || linkContext.link_url || '';
          const isInstagramPost = linkUrl.includes('instagram.com/p/') || linkUrl.includes('instagram.com/reel/') || linkUrl.includes('instagram.com/reels/');
          
          const gotPreview = extractPreviewUrl(linkContext);
          if (isInstagramPost && gotPreview) {
            const isReel = linkUrl.includes('/reel/') || linkUrl.includes('/reels/');
            mediaType = isReel ? 'clip' : 'media_share';
            previewUrl = gotPreview;
            title = linkContext.link_title || 'Paylaşılan Gönderi Bağlantısı';
            author = linkContext.link_summary || null;
            
            const shortcodeMatch = linkUrl.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
            if (shortcodeMatch) {
              mediaId = shortcodeMatch[1];
            }
            
            text = text || linkUrl;
          } else {
            text = linkUrl;
          }
        } else if (item.item_type === 'voice_media' && item.voice_media) {
          mediaType = 'voice_media';
          text = text || 'Bir sesli mesaj gönderdi.';
        } else if (item.item_type === 'media' && item.media) {
          mediaType = 'photo';
          previewUrl = item.media.image_versions2?.candidates?.[0]?.url || null;
          videoUrl = item.media.video_versions?.[0]?.url || null;
          text = text || (item.media.video_versions ? 'Bir video gönderdi.' : 'Bir fotoğraf gönderdi.');
        }

        // Map REST reactions
        let mappedReactions: any[] = [];
        if (item.reactions) {
          if (Array.isArray(item.reactions)) {
            mappedReactions = item.reactions.map((r: any) => ({
              reaction: r.reaction || r.emoji || '❤️',
              sender_fbid: String(r.sender_id || r.sender_fbid || ''),
              reaction_timestamp_ms: r.timestamp ? String(Math.floor(Number(r.timestamp) / 1000)) : undefined
            }));
          } else if (typeof item.reactions === 'object') {
            const likes = item.reactions.likes || [];
            if (Array.isArray(likes)) {
              likes.forEach((r: any) => {
                mappedReactions.push({
                  reaction: '❤️',
                  sender_fbid: String(r.sender_id || ''),
                  reaction_timestamp_ms: r.timestamp ? String(Math.floor(Number(r.timestamp) / 1000)) : undefined
                });
              });
            }
            const emojis = item.reactions.emojis || item.reactions.reactions || [];
            if (Array.isArray(emojis)) {
              emojis.forEach((r: any) => {
                mappedReactions.push({
                  reaction: r.emoji || r.reaction || '❤️',
                  sender_fbid: String(r.sender_id || r.sender_fbid || ''),
                  reaction_timestamp_ms: r.timestamp ? String(Math.floor(Number(r.timestamp) / 1000)) : undefined
                });
              });
            }
          }
        }

        const fallbackText = text || item.igd_snippet || (item.item_type ? `[${item.item_type}]` : 'Ek içerik');

        return {
          id: item.message_id || item.item_id,
          item_id: item.item_id || undefined,
          sender_fbid: item.user_id,
          timestamp_ms: Math.floor(Number(item.timestamp) / 1000).toString(),
          content: {
            __typename: item.item_type === 'text' ? 'SlideMessageText' : 'SlideMessageAttachment',
            text_body: fallbackText
          },
          content_type: item.item_type === 'text' ? 'TEXT' : 'ATTACHMENT',
          igd_snippet: fallbackText,
          text_body: fallbackText,
          media_preview_url: previewUrl,
          media_video_url: videoUrl,
          media_title: title,
          media_author: author,
          media_type: mediaType as any,
          media_id: mediaId,
          like_count: likeCount,
          comment_count: commentCount,
          reactions: mappedReactions
        };
      });

      // Merge messages into threads state
      setThreads(prevThreads => {
        return prevThreads.map(t => {
          if (t.id === threadId) {
            const existingEdges = t.slide_messages?.edges || [];
            const uniqueEdges = deduplicateMessageEdges([...mappedMessages.map(m => ({ node: m })), ...existingEdges]);

            // Try to extract partner watermark from result.last_seen_at
            let partnerWatermark: string | null = t.last_seen_watermark_ms || null;
            if (result.last_seen_at) {
              const viewerId = String(cookiesRef.current?.['ds_user_id'] || '');
              const partnerId = Object.keys(result.last_seen_at).find(id => String(id) !== viewerId);
              if (partnerId) {
                const seenObj = result.last_seen_at[partnerId];
                if (seenObj?.timestamp) {
                  partnerWatermark = String(seenObj.timestamp);
                }
              }
            }

            // Also check users fallback inside result.users
            if (!partnerWatermark && result.users) {
              const viewerId = String(cookiesRef.current?.['ds_user_id'] || '');
              const partnerUser = result.users.find((u: any) => String(u.pk || u.id || u.interop_messaging_user_fbid) !== viewerId);
              if (partnerUser?.last_read_watermark_timestamp_ms) {
                partnerWatermark = String(partnerUser.last_read_watermark_timestamp_ms);
              }
            }

            // Normalize the partnerWatermark
            if (partnerWatermark) {
              const num = Number(partnerWatermark);
              if (num > 10000000000000) {
                partnerWatermark = String(Math.floor(num / 1000));
              } else if (num < 10000000000) {
                partnerWatermark = String(num * 1000);
              } else {
                partnerWatermark = String(num);
              }
            }

            return {
              ...t,
              users: mergeThreadUsers(t.users || [], result.users || []),
              admin_user_ids: result.admin_user_ids || t.admin_user_ids || [],
              last_seen_watermark_ms: partnerWatermark || t.last_seen_watermark_ms,
              slide_messages: {
                ...t.slide_messages,
                edges: uniqueEdges
              }
            };
          }
          return t;
        });
      });

      // Update cursor state
      setThreadCursors(prev => ({
        ...prev,
        [threadId]: {
          oldestCursor: result.oldestCursor,
          hasOlder: result.hasOlder,
          isLoadingMore: false
        }
      }));

      // Scroll to bottom after load
      setTimeout(() => {
        if (messagesScrollRef.current) {
          messagesScrollRef.current.scrollTop = messagesScrollRef.current.scrollHeight;
        }
      }, 100);

    } catch (err) {
      console.error('[History] Failed to load initial thread history:', err);
      // Reset loading state
      setThreadCursors(prev => ({
        ...prev,
        [threadId]: { oldestCursor: null, hasOlder: true, isLoadingMore: false }
      }));
    }
  };  // Helper to merge thread users by ID, ensuring we never lose members loaded from REST history
  const mergeThreadUsers = (existingUsers: any[], newUsers: any[]): any[] => {
    const mergedUsersMap = new Map();
    (existingUsers || []).forEach((u: any) => {
      const key = String(u.username || '').toLowerCase().trim();
      if (key) mergedUsersMap.set(key, u);
    });
    (newUsers || []).forEach((u: any) => {
      const key = String(u.username || '').toLowerCase().trim();
      if (key) {
        const existingUser = mergedUsersMap.get(key);
        mergedUsersMap.set(key, { ...existingUser, ...u });
      }
    });
    return Array.from(mergedUsersMap.values());
  };

  // Helper to normalize raw GraphQL message nodes to unified InstagramMessage format
  const normalizeGraphQLMessage = (node: any): any => {
    if (!node) return null;
    
    // If it's already normalized, keep it
    if ('media_preview_url' in node) {
      return node;
    }

    let text = node.text_body || node.content?.text_body || node.igd_snippet || '';
    let previewUrl = null;
    let videoUrl = null;
    let title = null;
    let author = null;
    let mediaType = 'text';
    let mediaId = null;
    let likeCount = null;
    let commentCount = null;

    // Handle XMA (e.g. SlideMessageXMAContent)
    const xmaContent = node.content?.xma || node.xma || null;
    if (xmaContent) {
      const isReel = xmaContent.target_url?.includes('/reel/') || 
                      xmaContent.target_url?.includes('/reels/') || 
                      xmaContent.title_text?.toLowerCase()?.includes('reels') ||
                      xmaContent.xmaTitle?.toLowerCase()?.includes('reels');
                      
      const isStory = xmaContent.target_url?.includes('/stories/') || 
                       xmaContent.title_text?.toLowerCase()?.includes('hikaye') ||
                       xmaContent.xmaTitle?.toLowerCase()?.includes('story') ||
                       node.igd_snippet?.toLowerCase()?.includes('hikaye') ||
                       node.igd_snippet?.toLowerCase()?.includes('dosya eki') ||
                       text?.toLowerCase()?.includes('dosya eki');
                      
      mediaType = isStory ? 'story_share' : (isReel ? 'clip' : 'media_share');
      previewUrl = xmaContent.preview_image?.url || 
                   xmaContent.xmaPreviewImage?.url || 
                   xmaContent.preview_url || 
                   xmaContent.image_url || 
                   null;
                   
      title = xmaContent.title_text || xmaContent.xmaTitle || xmaContent.caption || null;
      author = xmaContent.header_title_text || xmaContent.xmaHeaderTitle || xmaContent.subtitle_text || null;
      mediaId = xmaContent.target_id || null;
      
      // Try to unwrap counts if present in the raw media object inside xma
      const innerMedia = xmaContent.media || xmaContent.xma_media || null;
      if (innerMedia) {
        likeCount = innerMedia.like_count || innerMedia.like_and_view_metadata_dict?.like_count || null;
        commentCount = innerMedia.comment_count || null;
      }
      
      if (!text) {
        text = `${isStory ? 'Hikaye' : (isReel ? 'Reels videosu' : 'Gönderi')} paylaştı: ${title || ''}`;
      }
    }

    return {
      id: node.id || node.message_id,
      sender_fbid: node.sender_fbid,
      timestamp_ms: node.timestamp_ms ? String(node.timestamp_ms) : Date.now().toString(),
      content: {
        __typename: node.content?.__typename || 'SlideMessageText',
        text_body: text
      },
      content_type: node.content_type || 'TEXT',
      igd_snippet: node.igd_snippet || text,
      text_body: text,
      media_preview_url: previewUrl,
      media_video_url: videoUrl,
      media_title: title,
      media_author: author,
      media_type: mediaType as any,
      media_id: mediaId,
      like_count: likeCount,
      comment_count: commentCount,
      reactions: node.reactions || null
    };
  };

  // Handle live data fetch
  const fetchLiveInbox = async (
    currentCookies = cookies, 
    currentHeaders = headers, 
    currentData = postData,
    background = false,
    folderOverride?: 'PRIMARY' | 'GENERAL'
  ) => {
    // If not logged in, skip inbox sync
    if (!isLoggedIn) {
      return;
    }

    // Prevent concurrent inbox fetches
    if (fetchInProgressRef.current) {
      console.log('[Fetch] Inbox sync already in progress. Skipping duplicate call.');
      return;
    }

    fetchInProgressRef.current = true;

    if (!background) {
      setIsFetching(true);
    }
    setFetchError(null);
    setFetchSuccess(false);

    const folder = folderOverride || activeFolder;

    try {
      const response = await fetch('/api/instagram/inbox', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify({
          folder,
          cookies: currentCookies,
          headers: currentHeaders,
          data: currentData,
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        let errorMsg = result.error || 'Failed to fetch live inbox data';
        if (result.details && Array.isArray(result.details)) {
          const detailMsgs = result.details.map((d: any) => d.message || JSON.stringify(d)).join(', ');
          errorMsg = `${errorMsg}: ${detailMsgs}`;
        } else if (result.details && typeof result.details === 'string') {
          errorMsg = `${errorMsg}: ${result.details}`;
        }
        
        // Sync updated cookies if returned in error response
        if (result.cookies) {
          handleUpdateCookies(result.cookies);
        }

        // If the session is expired or invalid (401), automatically clear credentials and redirect to login
        if (response.status === 401 || errorMsg.includes('sonlanmış') || errorMsg.includes('geçersiz') || errorMsg.includes('oturum')) {
          console.warn('[Fetch] Instagram session expired. Redirecting to login.');
          localStorage.removeItem('ig_cookies');
          localStorage.removeItem('ig_headers');
          localStorage.removeItem('ig_data');
          setCookies({});
          setHeaders(DEFAULT_HEADERS);
          setPostData(DEFAULT_DATA);
          setCookiesJson(JSON.stringify(DEFAULT_COOKIES, null, 2));
          setHeadersJson(JSON.stringify(DEFAULT_HEADERS, null, 2));
          setPostDataJson(JSON.stringify(DEFAULT_DATA, null, 2));
          setIsLoggedIn(false);
        }

        throw new Error(errorMsg);
      }

      // Sync updated cookies, headers, and postData on success (e.g. from self-healing)
      if (result.cookies) {
        handleUpdateCookies(result.cookies);
      }
      if (result.headers) {
        setHeaders(result.headers);
        setHeadersJson(JSON.stringify(result.headers, null, 2));
        localStorage.setItem('ig_headers', JSON.stringify(result.headers));
      }
      if (result.postData) {
        setPostData(result.postData);
        setPostDataJson(JSON.stringify(result.postData, null, 2));
        localStorage.setItem('ig_data', JSON.stringify(result.postData));
      }

      // Extract and save the latest sequence ID for the realtime MQTT bridge
      const subInfo = result.data?.get_slide_mailbox_for_iris_subscription || result.data?.fetch__SlideMailbox || {};
      const seqId = subInfo.iris_inactive_subscription_uq_seq_id;
      if (seqId && seqId !== seqIdRef.current) {
        console.log('[Fetch] Extracted new sequence ID:', seqId);
        const isFirstLoad = seqIdRef.current === null;
        seqIdRef.current = seqId;
        if (isFirstLoad) {
          // Restart connection to start the websocket with the correct seq_id
          setRealtimeConnectionTrigger(prev => prev + 1);
        }
      }

      const edges = subInfo.threads_by_folder?.edges || 
                    subInfo.threads_by_system_folder_and_ig_inbox_folder?.edges || 
                    [];
      if (edges.length === 0) {
        throw new Error('No threads returned. Check if your account is active and has messages.');
      }

      const liveThreads: InstagramThread[] = edges.map((edge: any) => {
        const node = edge.node;
        const threadDetails = node?.as_ig_direct_thread || {};

        // Extract seen status (read watermark) for the partner
        let partnerWatermark: string | null = null;
        try {
          const viewerId = String(threadDetails.viewer?.id || node?.viewer?.viewer_id || cookies['ds_user_id']);
          
          // Check last_read_watermarks.edges
          const watermarks = threadDetails.last_read_watermarks?.edges || [];
          const partnerNode = watermarks.find((w: any) => String(w.node?.member_id) !== viewerId);
          if (partnerNode?.node?.timestamp_ms) {
            partnerWatermark = String(partnerNode.node.timestamp_ms);
          }

          // Fallback to check under users array
          if (!partnerWatermark && threadDetails.users) {
            const partnerUser = threadDetails.users.find((u: any) => String(u.id || u.interop_messaging_user_fbid) !== viewerId);
            if (partnerUser?.last_read_watermark_timestamp_ms) {
              partnerWatermark = String(partnerUser.last_read_watermark_timestamp_ms);
            }
          }
        } catch (e) {}

        // Final fallback checks
        if (!partnerWatermark && threadDetails.last_read_watermark_timestamp_ms) {
          partnerWatermark = String(threadDetails.last_read_watermark_timestamp_ms);
        }

        // Normalize partnerWatermark to milliseconds (handling seconds, microseconds, milliseconds)
        if (partnerWatermark) {
          const num = Number(partnerWatermark);
          if (num > 10000000000000) {
            partnerWatermark = String(Math.floor(num / 1000));
          } else if (num < 10000000000) {
            partnerWatermark = String(num * 1000);
          } else {
            partnerWatermark = String(num);
          }
        }

        const rawEdges = threadDetails.slide_messages?.edges || [];
        const mappedEdges = rawEdges.map((edge: any) => {
          return {
            ...edge,
            node: normalizeGraphQLMessage(edge.node)
          };
        }).filter((edge: any) => edge.node !== null);

        return {
          id: node?.id || threadDetails.id,
          thread_fbid: threadDetails.thread_fbid || node?.id,
          thread_id: threadDetails.thread_id,
          thread_key: threadDetails.thread_key,
          thread_title: threadDetails.thread_title || 'Instagram User',
          folder: threadDetails.folder || node?.folder || folder,
          is_group: threadDetails.is_group || false,
          is_muted: threadDetails.is_muted || false,
          is_pin: threadDetails.is_pin || false,
          last_activity_timestamp_ms: threadDetails.last_activity_timestamp_ms,
          marked_as_unread: threadDetails.marked_as_unread || false,
          slide_messages: {
            ...(threadDetails.slide_messages || {}),
            edges: mappedEdges
          },
          users: threadDetails.users || [],
          viewer: threadDetails.viewer || node?.viewer || {},
          last_seen_watermark_ms: partnerWatermark ? String(partnerWatermark) : null,
          thread_image_url: threadDetails.thread_image_url || node?.thread_image_url || null,
          admin_user_ids: threadDetails.admin_user_ids || node?.admin_user_ids || []
        };
      });
      setThreads(prevThreads => {
        const mergedThreads = [...prevThreads];
        
        for (const newThread of liveThreads) {
          const idx = mergedThreads.findIndex(t => t.id === newThread.id);
          if (idx !== -1) {
            const existingThread = mergedThreads[idx];
            const existingEdges = existingThread.slide_messages?.edges || [];
            const newEdges = newThread.slide_messages?.edges || [];
            const uniqueEdges = deduplicateMessageEdges([...newEdges, ...existingEdges]);

            const isCurrentlyActive = activeThreadIdRef.current === newThread.id;
            const sortedEdges = [...uniqueEdges].sort((a, b) => {
              const tsA = parseInt(a.node?.timestamp_ms || '0', 10);
              const tsB = parseInt(b.node?.timestamp_ms || '0', 10);
              return tsA - tsB;
            });
            const lastMsg = sortedEdges[sortedEdges.length - 1]?.node;
            const viewerId = String(newThread.viewer?.id || newThread.viewer?.viewer_id || cookiesRef.current['ds_user_id'] || '');
            const isLastMsgFromPartner = lastMsg && String(lastMsg.sender_fbid) !== viewerId;
            
            let markedAsUnread = newThread.marked_as_unread;
            if (!isCurrentlyActive) {
              if (existingThread.marked_as_unread) {
                markedAsUnread = true;
              } else if (isLastMsgFromPartner) {
                const existingLastMsg = [...existingEdges].sort((a, b) => {
                  const tsA = parseInt(a.node?.timestamp_ms || '0', 10);
                  const tsB = parseInt(b.node?.timestamp_ms || '0', 10);
                  return tsA - tsB;
                })[existingEdges.length - 1]?.node;
                
                if (!existingLastMsg || parseInt(lastMsg.timestamp_ms || '0', 10) > parseInt(existingLastMsg.timestamp_ms || '0', 10)) {
                  markedAsUnread = true;
                }
              }
            } else {
              markedAsUnread = false;
            }

            mergedThreads[idx] = {
              ...newThread,
              users: mergeThreadUsers(existingThread.users || [], newThread.users || []),
              folder: newThread.folder || existingThread.folder || folder,
              last_seen_watermark_ms: newThread.last_seen_watermark_ms || existingThread.last_seen_watermark_ms,
              marked_as_unread: markedAsUnread,
              slide_messages: {
                ...newThread.slide_messages,
                edges: uniqueEdges
              }
            };
          } else {
            mergedThreads.push(newThread);
          }
        }
        // Sort threads by last activity timestamp (newest first)
        return [...mergedThreads].sort((a, b) => {
          const tsA = Number(a.last_activity_timestamp_ms || 0);
          const tsB = Number(b.last_activity_timestamp_ms || 0);
          return tsB - tsA;
        });
      });
      setActiveThreadId(currentId => {
        const exists = liveThreads.some(t => t.id === currentId);
        if (currentId && exists) return currentId;
        return liveThreads[0]?.id || null;
      });
      
      // If we have an active thread, also refresh its history to load rich media previews
      if (activeThreadIdRef.current) {
        const activeT = liveThreads.find(t => t.id === activeThreadIdRef.current);
        if (activeT) {
          fetchThreadHistory(activeT, true);
        }
      }

      setFetchSuccess(true);
      
      // Auto-clear success message
      setTimeout(() => setFetchSuccess(false), 4000);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown network error';
      console.error('Fetch error:', error);

      // Self-healing: If custom credentials failed with expired/redirected query, revert to working system defaults and open login settings
      const hasCustomCredentials = JSON.stringify(currentCookies) !== JSON.stringify(DEFAULT_COOKIES);
      const isSessionExpired = msg.includes('Unauthorized logged out query') || msg.includes('Oturumunuz sonlanmış') || msg.includes('fetch failed') || msg.includes('redirect count exceeded');
      if (isSessionExpired) {
        console.log('Detected expired credentials. Redirecting to login portal...');
        
        // Revert React states to defaults
        setCookies(DEFAULT_COOKIES);
        setHeaders(DEFAULT_HEADERS);
        setPostData(DEFAULT_DATA);
        setCookiesJson(JSON.stringify(DEFAULT_COOKIES, null, 2));
        setHeadersJson(JSON.stringify(DEFAULT_HEADERS, null, 2));
        setPostDataJson(JSON.stringify(DEFAULT_DATA, null, 2));

        // Clear expired local storage
        localStorage.removeItem('ig_cookies');
        localStorage.removeItem('ig_headers');
        localStorage.removeItem('ig_data');

        setIsLoggedIn(false);
        setLoginFeedback({
          type: 'error',
          message: 'Instagram oturumunuz sonlanmış. Lütfen tekrar giriş yapın.'
        });
        return;
      }

      setFetchError(msg);
      
      // Clear threads so we don't display mock data under Live Mode
      setThreads([]);
      setActiveThreadId(null);
    } finally {
      setIsFetching(false);
      fetchInProgressRef.current = false;
    }
  };

  // Import configuration from raw cURL command
  const handleCurlImport = (rawCurl: string) => {
    setCurlInput(rawCurl);
    if (!rawCurl.trim()) return;

    try {
      const parsed = parseCurlCommand(rawCurl);
      
      if (Object.keys(parsed.cookies).length > 0 || Object.keys(parsed.headers).length > 0) {
        setCookiesJson(JSON.stringify(parsed.cookies, null, 2));
        setHeadersJson(JSON.stringify(parsed.headers, null, 2));
        setPostDataJson(JSON.stringify(parsed.postData, null, 2));
        
        setSettingsFeedback({
          type: 'success',
          message: 'cURL komutu başarıyla ayrıştırıldı! Kimlik bilgileri otomatik yüklendi. Kaydetmek için en alttaki Kaydet butonuna basın.',
        });
      } else {
        setSettingsFeedback({
          type: 'error',
          message: 'cURL komutundan geçerli veriler ayrıştırılamadı. Lütfen doğru kopyaladığınızdan emin olun.',
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Bilinmeyen hata';
      setSettingsFeedback({
        type: 'error',
        message: `cURL ayrıştırma hatası: ${msg}`,
      });
    }
  };

  // Fetch Login Sessions/Activities from Instagram Accounts Center
  const fetchLoginSessions = async () => {
    setIsLoadingSessions(true);
    setSessionsError(null);
    try {
      const res = await fetch('/api/instagram/login-activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cookies,
          headers
        })
      });
      const result = await res.json();
      if (res.ok && result.success) {
        setLoginSessions(result.sessions || []);
      } else {
        throw new Error(result.error || 'Giriş hareketleri yüklenemedi.');
      }
    } catch (err: any) {
      console.error('[Sessions] Error fetching sessions:', err);
      setSessionsError(err.message || 'Giriş hareketleri yüklenemedi.');
    } finally {
      setIsLoadingSessions(false);
    }
  };

  // Remote logout session
  const handleLogoutSession = async (sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    
    const confirmMsg = sessionIds.length === 1 
      ? 'Bu cihazdaki oturumu kapatmak istediğine emin misin?'
      : 'Seçili tüm diğer cihazlardaki oturumları kapatmak istediğine emin misin?';
      
    if (!window.confirm(confirmMsg)) return;
    
    setIsLoggingOutSession(true);
    setSettingsFeedback(null);
    
    try {
      const res = await fetch('/api/instagram/login-activity/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cookies,
          headers,
          sessionIds
        })
      });
      
      const result = await res.json();
      if (res.ok && result.success) {
        setSettingsFeedback({
          type: 'success',
          message: result.message || 'Seçilen cihaz(lar)dan başarıyla çıkış yapıldı.'
        });
        // Refresh the sessions list
        fetchLoginSessions();
      } else {
        setSettingsFeedback({
          type: 'error',
          message: result.error || 'Cihazdan çıkış yaparken bir hata oluştu.'
        });
      }
    } catch (err: any) {
      console.error('[Sessions] Logout session error:', err);
      setSettingsFeedback({
        type: 'error',
        message: err.message || 'Cihazdan çıkış yapılamadı.'
      });
    } finally {
      setIsLoggingOutSession(false);
      // Auto clear feedback after 10 seconds
      setTimeout(() => {
        setSettingsFeedback(null);
      }, 10000);
    }
  };

  // Fetch sessions when switching to activities tab
  useEffect(() => {
    if (isSettingsOpen && settingsTab === 'activities') {
      fetchLoginSessions();
    }
  }, [isSettingsOpen, settingsTab]);

  // Reset settings tab to default when drawer closes
  useEffect(() => {
    if (!isSettingsOpen) {
      setSettingsTab('settings');
    }
  }, [isSettingsOpen]);

  // Save Settings
  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsFeedback(null);

    try {
      const parsedCookies = JSON.parse(cookiesJson);
      const parsedHeaders = JSON.parse(headersJson);
      const parsedData = JSON.parse(postDataJson);

      // Validate objects
      if (typeof parsedCookies !== 'object' || typeof parsedHeaders !== 'object' || typeof parsedData !== 'object') {
        throw new Error('All configurations must be valid JSON objects.');
      }

      // Save to React State
      setCookies(parsedCookies);
      setHeaders(parsedHeaders);
      setPostData(parsedData);

      // Save to LocalStorage
      localStorage.setItem('ig_cookies', JSON.stringify(parsedCookies));
      localStorage.setItem('ig_headers', JSON.stringify(parsedHeaders));
      localStorage.setItem('ig_data', JSON.stringify(parsedData));
      localStorage.setItem('ig_polling_enabled', String(isPollingEnabled));
      localStorage.setItem('ig_polling_interval', String(pollingInterval));

      setSettingsFeedback({
        type: 'success',
        message: 'Settings saved successfully! Loading new settings...',
      });

      // Increment trigger to reconnect WebSocket with new credentials
      setRealtimeConnectionTrigger(prev => prev + 1);

      // Fetch right away with new config
      fetchLiveInbox(parsedCookies, parsedHeaders, parsedData);

      setTimeout(() => {
        setIsSettingsOpen(false);
        setSettingsFeedback(null);
      }, 1500);

    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Invalid JSON format. Please verify braces and quotes.';
      setSettingsFeedback({
        type: 'error',
        message: `Failed to save: ${msg}`,
      });
    }
  };

  // Reset Settings to Initial defaults
  const handleResetSettings = () => {
    setCookies(DEFAULT_COOKIES);
    setHeaders(DEFAULT_HEADERS);
    setPostData(DEFAULT_DATA);

    setCookiesJson(JSON.stringify(DEFAULT_COOKIES, null, 2));
    setHeadersJson(JSON.stringify(DEFAULT_HEADERS, null, 2));
    setPostDataJson(JSON.stringify(DEFAULT_DATA, null, 2));

    setIsPollingEnabled(true);
    setPollingInterval(30000);

    localStorage.removeItem('ig_cookies');
    localStorage.removeItem('ig_headers');
    localStorage.removeItem('ig_data');
    localStorage.removeItem('ig_polling_enabled');
    localStorage.removeItem('ig_polling_interval');

    setSettingsFeedback({
      type: 'success',
      message: 'Restored system default parameters.',
    });
    
    // Increment trigger to reconnect WebSocket with default credentials
    setRealtimeConnectionTrigger(prev => prev + 1);
    setTimeout(() => setSettingsFeedback(null), 2000);
  };

  // Log out the user and clear settings
  const handleLogout = async () => {
    try {
      console.log('[Logout] Requesting Instagram session termination...');
      await fetch('/api/instagram/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies, headers, data: postData })
      });
    } catch (e) {
      console.warn('[Logout] Failed to terminate session on Instagram server:', e);
    }

    localStorage.removeItem('ig_cookies');
    localStorage.removeItem('ig_headers');
    localStorage.removeItem('ig_data');
    setCookies({});
    setHeaders(DEFAULT_HEADERS);
    setPostData(DEFAULT_DATA);
    setCookiesJson(JSON.stringify(DEFAULT_COOKIES, null, 2));
    setHeadersJson(JSON.stringify(DEFAULT_HEADERS, null, 2));
    setPostDataJson(JSON.stringify(DEFAULT_DATA, null, 2));
    setIsLoggedIn(false);
    setIsSettingsOpen(false);
    setLoginFeedback(null);
  };

  // Submit login data to server endpoint
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginFeedback(null);
    setIsLoggingIn(true);

    try {
      const response = await fetch('/api/instagram/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: loginMethod,
          curl: loginMethod === 'curl' ? loginCurl : undefined,
          username: loginMethod === 'credentials' ? loginUsername : undefined,
          password: loginMethod === 'credentials' ? loginPassword : undefined
        })
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Giriş yapılamadı.');
      }

      // Login success! Update state and localStorage
      setCookies(result.cookies);
      setHeaders(result.headers);
      setPostData(result.postData);

      setCookiesJson(JSON.stringify(result.cookies, null, 2));
      setHeadersJson(JSON.stringify(result.headers, null, 2));
      setPostDataJson(JSON.stringify(result.postData, null, 2));

      localStorage.setItem('ig_cookies', JSON.stringify(result.cookies));
      localStorage.setItem('ig_headers', JSON.stringify(result.headers));
      localStorage.setItem('ig_data', JSON.stringify(result.postData));

      setLoginFeedback({
        type: 'success',
        message: 'Giriş başarıyla tamamlandı! Bağlantı kuruluyor...'
      });

      // Restart live synchronization
      setRealtimeConnectionTrigger(prev => prev + 1);

      setTimeout(() => {
        setIsLoggedIn(true);
        setIsSettingsOpen(false);
        setLoginFeedback(null);
        setLoginCurl('');
        setLoginUsername('');
        setLoginPassword('');
      }, 2000);

    } catch (err: any) {
      setLoginFeedback({
        type: 'error',
        message: err.message || 'Giriş işlemi sırasında bir hata oluştu.'
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Simulated/Local message appending helper
  const appendLocalMessage = (threadId: string, text: string, messageId: string) => {
    setThreads(prevThreads => {
      const updated = prevThreads.map(thread => {
        if (thread.id !== threadId) return thread;

        const newMsgNode: InstagramMessage = {
          id: messageId,
          sender_fbid: thread.viewer?.interop_messaging_user_fbid || "17842376945110023",
          timestamp_ms: String(Date.now()),
          content: {
            __typename: "SlideMessageText",
            text_body: text
          },
          content_type: "TEXT",
          igd_snippet: `Sen: ${text}`,
          text_body: text
        };

        const updatedEdges = [...(thread.slide_messages?.edges || []), { node: newMsgNode }];

        return {
          ...thread,
          last_activity_timestamp_ms: String(Date.now()),
          slide_messages: {
            ...(thread.slide_messages || { edges: [], __typename: "SlideMessagesConnection" }),
            edges: updatedEdges
          }
        };
      });

      // Sort threads so the updated thread goes to the top!
      return [...updated].sort((a, b) => {
        const tsA = Number(a.last_activity_timestamp_ms || 0);
        const tsB = Number(b.last_activity_timestamp_ms || 0);
        return tsB - tsA;
      });
    });
  };

  // Sending a message (Live API call or Demo simulation)
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!typedMessage.trim() || !activeThreadId) return;

    const newMessageText = typedMessage.trim();



    setTypedMessage('');

    // Clear typing timeout and send typing = false immediately
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    sendTypingIndicatorToServer(false);
    lastTypingSentRef.current = 0;



    // Live Mode: Send to API
    try {
      lastActivityRef.current = Date.now();
      const response = await fetch('/api/instagram/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadId: activeThreadId,
          text: newMessageText,
          cookies,
          headers,
          data: postData,
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        let errorMsg = result.error || 'Mesaj gönderilemedi';
        if (result.details && Array.isArray(result.details)) {
          const detailMsgs = result.details.map((d: any) => d.message || JSON.stringify(d)).join(', ');
          errorMsg = `${errorMsg}: ${detailMsgs}`;
        } else if (result.details && typeof result.details === 'string') {
          errorMsg = `${errorMsg}: ${result.details}`;
        }
        if (result.cookies) {
          handleUpdateCookies(result.cookies);
        }
        throw new Error(errorMsg);
      }

      // Sync any updated cookies, headers, or postData returned on success (from self-healing)
      if (result.cookies) {
        handleUpdateCookies(result.cookies);
      }
      if (result.headers) {
        setHeaders(result.headers);
        setHeadersJson(JSON.stringify(result.headers, null, 2));
        localStorage.setItem('ig_headers', JSON.stringify(result.headers));
      }
      if (result.postData) {
        setPostData(result.postData);
        setPostDataJson(JSON.stringify(result.postData, null, 2));
        localStorage.setItem('ig_data', JSON.stringify(result.postData));
      }

      // Message sent successfully! Append to UI state
      const messageId = result.data?.ig_message_send?.message_id || `sent_${Date.now()}`;
      appendLocalMessage(activeThreadId, newMessageText, messageId);
      
      // Fetch fresh messages in background to sync read status and details
      fetchLiveInbox(cookies, headers, postData, true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Bilinmeyen hata';
      alert(`Mesaj Gönderilemedi: ${msg}`);
      setTypedMessage(newMessageText); // Restore typed message
    }
  };

  // Sends a read receipt mutation to Instagram API in Live Mode
  const sendReadReceipt = (threadIdString: string, messageId: string, timestampMs: string) => {
    
    console.log(`Sending read receipt for message: ${messageId} in thread ${threadIdString}`);
    fetch('/api/instagram/read', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        threadId: threadIdString,
        messageId,
        timestampMs,
        cookies: cookiesRef.current,
        headers: headersRef.current,
        data: postDataRef.current,
      }),
    })
    .then(res => res.json())
    .then(result => {
      if (result.cookies) {
        handleUpdateCookies(result.cookies);
      }
      if (result.success) {
        console.log(`Thread ${threadIdString} successfully marked as read on server.`);
      } else {
        console.warn('Failed to mark thread as read on server:', result.error || result.details);
      }
    })
    .catch(err => {
      console.error('Error sending read receipt:', err);
    });
  };

  // Load older messages for a specific thread (history pagination)
  const loadMoreMessages = async (thread: InstagramThread) => {
    const tState = threadCursors[thread.id] || { oldestCursor: null, hasOlder: true, isLoadingMore: false };
    
    if (threadCursors[thread.id]) {
      if (!tState.hasOlder || tState.isLoadingMore || tState.oldestCursor === null) {
        return;
      }
    } else {
      if (tState.isLoadingMore) return;
    }

    // Set loading status
    setThreadCursors(prev => ({
      ...prev,
      [thread.id]: { ...tState, isLoadingMore: true }
    }));

    console.log(`[History] Loading older messages for thread ${thread.id} (cursor: ${tState.oldestCursor})...`);

    try {
      const response = await fetch('/api/instagram/history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadId: thread.thread_id,
          cursor: tState.oldestCursor,
          cookies: cookiesRef.current,
          headers: headersRef.current,
        }),
      });

      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to fetch thread history');
      }

      if (result.cookies) {
        handleUpdateCookies(result.cookies);
      }

      const items = (result.items || []).filter((item: any) => {
        if (item.item_type === 'like' || item.item_type === 'reaction' || item.item_type === 'action_log' || item.hide_in_thread === 1) {
          return false;
        }
        return true;
      });
      if (items.length > 0) {
        // Map incoming REST items to InstagramMessage structure
        const mappedMessages: InstagramMessage[] = items.map((item: any) => {
          let text = item.text || '';
          let previewUrl: string | null = null;
          let videoUrl: string | null = null;
          let title: string | null = null;
          let author: string | null = null;
          let mediaType: string | null = null;
          
          // Unwrap nested wrappers dynamically (e.g. clip.clip, media_share.media_share)
          const clipObj = unwrapMedia(item.clip || item.xma_clip_share || item.xma_clip);
          const mediaShareObj = unwrapMedia(item.media_share || item.direct_media_share || item.xma_media_share || item.xma_media);
          const storyShareObj = unwrapMedia(item.story_share || item.xma_story_share || item.xma_story);
          const xmaObj = unwrapXma(item.xma || item.xma_share || item.xma_layout_data);

          let mediaId: string | null = null;
          let likeCount: number | null = null;
          let commentCount: number | null = null;

          if (clipObj) {
            mediaType = 'clip';
            previewUrl = extractPreviewUrl(clipObj);
            videoUrl = clipObj.video_versions?.[0]?.url || null;
            title = clipObj.caption?.text || 'Paylaşılan Reels videosu';
            author = clipObj.user?.username || null;
            mediaId = clipObj.pk || clipObj.id || null;
            likeCount = clipObj.like_count ?? null;
            commentCount = clipObj.comment_count ?? null;
            text = text || `Bir Reels videosu paylaştı: ${title}`;

            // Fallback to xmaObj preview if missing (restricted/private accounts)
            if (!previewUrl && xmaObj) {
              previewUrl = extractPreviewUrl(xmaObj);
              if (!mediaId) mediaId = xmaObj.target_id || null;
              if (!title) title = xmaObj.title || xmaObj.title_text || xmaObj.caption || null;
            }
          } else if (mediaShareObj) {
            mediaType = 'media_share';
            previewUrl = extractPreviewUrl(mediaShareObj);
            videoUrl = mediaShareObj.video_versions?.[0]?.url || 
                       mediaShareObj.carousel_media?.[0]?.video_versions?.[0]?.url || 
                       null;
            title = mediaShareObj.caption?.text || 'Paylaşılan gönderi';
            author = mediaShareObj.user?.username || null;
            mediaId = mediaShareObj.pk || mediaShareObj.id || null;
            likeCount = mediaShareObj.like_count ?? null;
            commentCount = mediaShareObj.comment_count ?? null;
            text = text || `Bir gönderi paylaştı: ${title}`;

            // Fallback to xmaObj preview if missing (restricted/private accounts)
            if (!previewUrl && xmaObj) {
              previewUrl = extractPreviewUrl(xmaObj);
              if (!mediaId) mediaId = xmaObj.target_id || null;
              if (!title) title = xmaObj.title || xmaObj.title_text || xmaObj.caption || null;
            }
          } else if (storyShareObj) {
            mediaType = 'story_share';
            const media = storyShareObj.media || storyShareObj;
            previewUrl = extractPreviewUrl(media) || extractPreviewUrl(storyShareObj);
            title = storyShareObj.title || storyShareObj.message || 'Paylaşılan hikaye';
            author = media.user?.username || storyShareObj.user?.username || null;
            text = text || `Bir hikaye paylaştı: ${title}`;

            // Fallback to xmaObj preview if missing (restricted/private accounts)
            if (!previewUrl && xmaObj) {
              previewUrl = extractPreviewUrl(xmaObj);
              if (!mediaId) mediaId = xmaObj.target_id || null;
              if (!title) title = xmaObj.title || xmaObj.title_text || xmaObj.caption || null;
            }
          } else if (xmaObj) {
            const isReel = xmaObj.target_url?.includes('/reel/') || xmaObj.target_url?.includes('/reels/') || xmaObj.title?.toLowerCase()?.includes('reels');
            mediaType = isReel ? 'clip' : 'media_share';
            previewUrl = extractPreviewUrl(xmaObj);
            title = xmaObj.title || xmaObj.title_text || xmaObj.caption || 'Paylaşılan içerik';
            author = xmaObj.header_title_text || xmaObj.subtitle_text || xmaObj.user?.username || null;
            mediaId = xmaObj.target_id || null;

            const innerMedia = xmaObj.media || xmaObj.xma_media || null;
            if (innerMedia) {
              likeCount = innerMedia.like_count || innerMedia.like_and_view_metadata_dict?.like_count || null;
              commentCount = innerMedia.comment_count || null;
            }
            
            text = text || `${isReel ? 'Bir Reels videosu' : 'Bir gönderi'} paylaştı: ${title}`;
          } else if (item.item_type === 'link' && item.link) {
            const linkContext = item.link.link_context || {};
            const linkUrl = item.link.text || linkContext.link_url || '';
            const isInstagramPost = linkUrl.includes('instagram.com/p/') || linkUrl.includes('instagram.com/reel/') || linkUrl.includes('instagram.com/reels/');
            
            const gotPreview = extractPreviewUrl(linkContext);
            if (isInstagramPost && gotPreview) {
              const isReel = linkUrl.includes('/reel/') || linkUrl.includes('/reels/');
              mediaType = isReel ? 'clip' : 'media_share';
              previewUrl = gotPreview;
              title = linkContext.link_title || 'Paylaşılan Gönderi Bağlantısı';
              author = linkContext.link_summary || null;
              
              const shortcodeMatch = linkUrl.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
              if (shortcodeMatch) {
                mediaId = shortcodeMatch[1];
              }
              
              text = text || linkUrl;
            } else {
              text = linkUrl;
            }
          } else if (item.item_type === 'voice_media' && item.voice_media) {
            mediaType = 'voice_media';
            text = text || 'Bir sesli mesaj gönderdi.';
          } else if (item.item_type === 'media' && item.media) {
            mediaType = 'photo';
            previewUrl = item.media.image_versions2?.candidates?.[0]?.url || null;
            videoUrl = item.media.video_versions?.[0]?.url || null;
            text = text || (item.media.video_versions ? 'Bir video gönderdi.' : 'Bir fotoğraf gönderdi.');
          }

          // Map REST reactions
          let mappedReactions: any[] = [];
          if (item.reactions) {
            if (Array.isArray(item.reactions)) {
              mappedReactions = item.reactions.map((r: any) => ({
                reaction: r.reaction || r.emoji || '❤️',
                sender_fbid: String(r.sender_id || r.sender_fbid || ''),
                reaction_timestamp_ms: r.timestamp ? String(Math.floor(Number(r.timestamp) / 1000)) : undefined
              }));
            } else if (typeof item.reactions === 'object') {
              const likes = item.reactions.likes || [];
              if (Array.isArray(likes)) {
                likes.forEach((r: any) => {
                  mappedReactions.push({
                    reaction: '❤️',
                    sender_fbid: String(r.sender_id || ''),
                    reaction_timestamp_ms: r.timestamp ? String(Math.floor(Number(r.timestamp) / 1000)) : undefined
                  });
                });
              }
              const emojis = item.reactions.emojis || item.reactions.reactions || [];
              if (Array.isArray(emojis)) {
                emojis.forEach((r: any) => {
                  mappedReactions.push({
                    reaction: r.emoji || r.reaction || '❤️',
                    sender_fbid: String(r.sender_id || r.sender_fbid || ''),
                    reaction_timestamp_ms: r.timestamp ? String(Math.floor(Number(r.timestamp) / 1000)) : undefined
                  });
                });
              }
            }
          }

          const fallbackText = text || item.igd_snippet || (item.item_type ? `[${item.item_type}]` : 'Ek içerik');

          return {
            id: item.message_id || item.item_id,
            item_id: item.item_id || undefined,
            sender_fbid: item.user_id,
            timestamp_ms: Math.floor(Number(item.timestamp) / 1000).toString(),
            content: {
              __typename: item.item_type === 'text' ? 'SlideMessageText' : 'SlideMessageAttachment',
              text_body: fallbackText
            },
            content_type: item.item_type === 'text' ? 'TEXT' : 'ATTACHMENT',
            igd_snippet: fallbackText,
            text_body: fallbackText,
            media_preview_url: previewUrl,
            media_video_url: videoUrl,
            media_title: title,
            media_author: author,
            media_type: mediaType as any,
            media_id: mediaId,
            like_count: likeCount,
            comment_count: commentCount,
            reactions: mappedReactions
          };
        });

        // Merge messages into threads state
        setThreads(prevThreads => {
          return prevThreads.map(t => {
            if (t.id === thread.id) {
              const existingEdges = t.slide_messages?.edges || [];
              const uniqueEdges = deduplicateMessageEdges([...mappedMessages.map(m => ({ node: m })), ...existingEdges]);

              return {
                ...t,
                users: mergeThreadUsers(t.users || [], result.users || []),
                admin_user_ids: result.admin_user_ids || t.admin_user_ids || [],
                slide_messages: {
                  ...t.slide_messages,
                  edges: uniqueEdges
                }
              };
            }
            return t;
          });
        });
      }

      // Update cursor state
      setThreadCursors(prev => ({
        ...prev,
        [thread.id]: {
          oldestCursor: result.oldestCursor,
          hasOlder: result.hasOlder,
          isLoadingMore: false
        }
      }));

    } catch (err) {
      console.error('[History] Failed to load older messages:', err);
      setThreadCursors(prev => ({
        ...prev,
        [thread.id]: { ...tState, isLoadingMore: false }
      }));
    }
  };

  // Scroll handler to detect when user scrolls to the top of the chat window
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    recordInteraction();
    const target = e.currentTarget;
    if (target.scrollTop < 50 && activeThread) {
      const tState = threadCursors[activeThread.id] || { oldestCursor: null, hasOlder: true, isLoadingMore: false };
      if (!tState.hasOlder || tState.isLoadingMore) return;

      const prevScrollHeight = target.scrollHeight;
      const prevScrollTop = target.scrollTop;

      loadMoreMessages(activeThread).then(() => {
        // Restore scroll position after prepending items to prevent jumps
        setTimeout(() => {
          if (messagesScrollRef.current) {
            const newScrollHeight = messagesScrollRef.current.scrollHeight;
            messagesScrollRef.current.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
          }
        }, 50);
      });
    }
  };

  // Triggered when a media preview (Reel/Post) is right-clicked (desktop) or double-clicked (mobile)
  const handleContextMenu = (e: React.MouseEvent, msg: InstagramMessage, triggerType: 'right-click' | 'double-click') => {
    const isMobileDevice = window.innerWidth <= 768;

    // Desktop only right click, Mobile only double click
    if (triggerType === 'double-click' && !isMobileDevice) return;
    if (triggerType === 'right-click' && isMobileDevice) return;

    if (msg.media_id && (msg.media_type === 'clip' || msg.media_type === 'media_share')) {
      e.preventDefault();
      const menuWidth = 185;
      const menuHeight = 90;
      let x = e.clientX;
      let y = e.clientY;

      if (x + menuWidth > window.innerWidth) {
        x = Math.max(10, e.clientX - menuWidth);
      }
      if (y + menuHeight > window.innerHeight) {
        y = Math.max(10, e.clientY - menuHeight);
      }

      setContextMenu({
        visible: true,
        x,
        y,
        mediaId: msg.media_id,
        mediaType: msg.media_type as any
      });
      contextMenuJustOpenedRef.current = true;
      setTimeout(() => {
        contextMenuJustOpenedRef.current = false;
      }, 200);
    }
  };

  // Reliable touch-based double-tap detection for mobile devices
  const handleTouchStart = (e: React.TouchEvent, msg: InstagramMessage) => {
    const isMobileDevice = window.innerWidth <= 768;
    if (!isMobileDevice) return;

    const now = Date.now();
    const msgId = msg.id || 'temp';
    const lastTouch = lastTouchTimeRef.current[msgId] || 0;

    if (now - lastTouch < 300) {
      // Double tap detected on mobile!
      if (e.cancelable) {
        e.preventDefault();
      }
      
      const touch = e.touches[0];
      if (msg.media_id && (msg.media_type === 'clip' || msg.media_type === 'media_share')) {
        const menuWidth = 185;
        const menuHeight = 90;
        let x = touch.clientX;
        let y = touch.clientY;

        if (x + menuWidth > window.innerWidth) {
          x = Math.max(10, touch.clientX - menuWidth);
        }
        if (y + menuHeight > window.innerHeight) {
          y = Math.max(10, touch.clientY - menuHeight);
        }

        setContextMenu({
          visible: true,
          x,
          y,
          mediaId: msg.media_id,
          mediaType: msg.media_type as any
        });
        contextMenuJustOpenedRef.current = true;
        setTimeout(() => {
          contextMenuJustOpenedRef.current = false;
        }, 200);
      } else {
        const fakeEvent = {
          preventDefault: () => {}
        } as any;
        handleMessageDoubleClick(fakeEvent, msg);
      }
      
      lastTouchTimeRef.current[msgId] = 0;
    } else {
      lastTouchTimeRef.current[msgId] = now;
    }
  };

  // Close context menu on document click
  useEffect(() => {
    const handleCloseMenu = () => {
      if (contextMenuJustOpenedRef.current || threadContextMenuJustOpenedRef.current || msgContextMenuJustOpenedRef.current) {
        return; // Ignore close trigger if it was just opened!
      }
      setContextMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
      setThreadContextMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
      setMsgContextMenu(prev => prev.visible ? { ...prev, visible: false } : prev);
    };
    window.addEventListener('click', handleCloseMenu);
    return () => window.removeEventListener('click', handleCloseMenu);
  }, []);

  // Fetch comments or likers for a media ID
  const handleFetchUserData = async (type: 'comments' | 'likers', sortOrder?: string, isLoadMore = false) => {
    const mediaId = contextMenu.mediaId || userListModal.mediaId;
    if (!mediaId) return;

    const selectedSort = sortOrder || commentsSortOrder;
    const cursor = isLoadMore ? userListModal.endCursor : null;

    if (isLoadMore) {
      setUserListModal(prev => ({
        ...prev,
        isLoadingMore: true
      }));
    } else {
      setUserListModal(prev => ({
        isOpen: true,
        type,
        mediaId,
        isLoading: true,
        users: prev.mediaId === mediaId && prev.type === type && sortOrder ? prev.users : [], // preserve previous list if changing sort to prevent flashing
        hasNextPage: false,
        endCursor: null,
        isLoadingMore: false
      }));
    }

    try {
      const response = await fetch(`/api/instagram/media/${type}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mediaId,
          sortOrder: selectedSort,
          cursor,
          cookies: cookiesRef.current,
          headers: headersRef.current,
          data: postData,
        }),
      });

      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || `Failed to fetch media ${type}`);
      }

      const fetchedUsers = type === 'comments' ? result.comments : result.likers;

      setUserListModal(prev => ({
        ...prev,
        isLoading: false,
        isLoadingMore: false,
        users: isLoadMore ? [...prev.users, ...fetchedUsers] : fetchedUsers,
        hasNextPage: result.hasNextPage || false,
        endCursor: result.endCursor || null
      }));
    } catch (err) {
      console.error(`[Modal-Fetch] Error fetching media ${type}:`, err);
      setUserListModal(prev => ({
        ...prev,
        isLoading: false,
        isLoadingMore: false,
        users: isLoadMore ? prev.users : [],
        hasNextPage: false,
        endCursor: null
      }));
    }
  };

  // Helper to extract group members who sent a shared post message yesterday (local time)
  const getYesterdaySenders = (): InstagramUser[] => {
    const yesterdaySendersMap = new Map<string, any>();
    const now = new Date();
    
    // Start and end of yesterday in local time
    const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
    const endOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
    
    const startMs = startOfYesterday.getTime();
    const endMs = endOfYesterday.getTime();

    const messages = activeThread?.slide_messages?.edges || [];
    messages.forEach((edge: any) => {
      const msg = edge.node;
      if (!msg) return;
      
      const ts = Number(msg.timestamp_ms);
      if (ts >= startMs && ts <= endMs) {
        const xmaContent = msg.content?.xma || msg.xma || null;
        const targetUrl = xmaContent?.target_url || '';
        const hasMedia = msg.media_id || msg.media_preview_url || targetUrl.includes('/reel/') || targetUrl.includes('/p/');
        
        if (hasMedia) {
          const senderId = msg.sender_fbid || msg.user_id || '';
          if (senderId) {
            const viewerId = activeThread?.viewer?.id || activeThread?.viewer?.interop_messaging_user_fbid || cookies['ds_user_id'];
            if (String(senderId) === String(viewerId) && activeThread?.viewer) {
              const viewerObj = activeThread.viewer as any;
              yesterdaySendersMap.set(String(viewerObj.username || 'ben').toLowerCase().trim(), {
                id: viewerId,
                username: viewerObj.username || 'Ben',
                full_name: viewerObj.full_name || 'Giriş Yapmış Kullanıcı',
                profile_pic_url: activeThread.viewer.profile_pic_url || '',
              } as any);
            } else {
              const senderUser = activeThread?.users?.find((u: any) => {
                const uId = String(u.id || '');
                const uPk = String(u.pk || '');
                const uFbid = String(u.interop_messaging_user_fbid || '');
                const sId = String(senderId);
                return sId !== '' && (uId === sId || uPk === sId || uFbid === sId);
              });
              if (senderUser && senderUser.username) {
                yesterdaySendersMap.set(senderUser.username.toLowerCase().trim(), senderUser);
              }
            }
          }
        }
      }
    });
    return Array.from(yesterdaySendersMap.values());
  };

  // Scan group comments and match with group member list
  const handleStartCommentMatchScan = async (type: 'all' | 'participation' = 'all') => {
    const mediaId = contextMenu.mediaId;
    if (!mediaId || !activeThread) return;
    
    // Close context menu
    setContextMenu(prev => ({ ...prev, visible: false }));
    
    // Initialize scan state
    setCommentScan({
      isOpen: true,
      isScanning: true,
      matched: [],
      unmatched: [],
      totalCommentsScanned: 0,
      mediaId,
      scanType: type
    });
    setCommentScanTab('matched');

    console.log(`[Scan] Starting comment match scan for mediaId: ${mediaId}, type: ${type}`);
    
    try {
      let allComments: any[] = [];
      const sortOrders = ['recent', 'ranked', 'meta_verified', 'popular'];

      for (const sortVal of sortOrders) {
        let hasNext = true;
        let cursor: string | null = null;
        let pageCount = 0;
        let currentSource: string | null = null;
        const maxPages = 10; // Scan up to 10 pages per sort order (1000 comments per filter, 2000 total)

        console.log(`[Scan] Starting scan for sort order: ${sortVal}`);
        
        while (hasNext && pageCount < maxPages) {
          pageCount++;
          
          const commentsRes: any = await fetch('/api/instagram/media/comments', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              mediaId,
              sortOrder: sortVal,
              cursor,
              source: currentSource,
              cookies: cookiesRef.current,
              headers: headersRef.current,
            }),
          });

          const result = await commentsRes.json();
          if (!commentsRes.ok || !result.success) {
            throw new Error(result.error || 'Failed to fetch comments');
          }

          const pageComments = result.comments || [];
          
          // Guard 1: Stop if 0 comments are returned (end of data)
          if (pageComments.length === 0) {
            console.log(`[Scan] 0 comments returned on page ${pageCount}. Stopping.`);
            break;
          }

          // Guard 2: Stop if cursor is identical to prevent infinite loop
          if (result.endCursor && result.endCursor === cursor) {
            console.log(`[Scan] Duplicate cursor returned (${result.endCursor}). Stopping.`);
            break;
          }

          // Guard 3: Deduplicate pageComments against themselves and allComments
          const uniqueNewComments = pageComments.filter((pc: any) => 
            !allComments.some((ac: any) => 
              String(ac.username).toLowerCase().trim() === String(pc.username).toLowerCase().trim() && 
              String(ac.text).trim() === String(pc.text).trim()
            )
          );

          if (uniqueNewComments.length === 0) {
            console.log(`[Scan] Page ${pageCount} has no new unique comments. Stopping.`);
            break;
          }

          allComments = [...allComments, ...uniqueNewComments];
          
          setCommentScan(prev => ({
            ...prev,
            totalCommentsScanned: allComments.length
          }));

          hasNext = result.hasNextPage || false;
          cursor = result.endCursor || null;
          currentSource = result.source || null;
          
          if (hasNext) {
            await new Promise(r => setTimeout(r, 300));
          }
        }
      }

      // Map comments by username (case-insensitive) for fast lookup
      const commentsMap = new Map<string, { text: string; timestamp: number }>();
      allComments.forEach(c => {
        const usernameLower = String(c.username).toLowerCase().trim();
        commentsMap.set(usernameLower, {
          text: c.text,
          timestamp: c.timestamp
        });
      });

      // Get group members including viewer (or just yesterday's post senders)
      let allMembers: InstagramUser[] = [];
      if (type === 'participation') {
        allMembers = getYesterdaySenders();
      } else {
        allMembers = [...(activeThread.users || [])];
        const viewerId = activeThread.viewer?.id || activeThread.viewer?.interop_messaging_user_fbid || cookies['ds_user_id'];
        const viewerExists = allMembers.some(u => String(u.id || u.interop_messaging_user_fbid) === String(viewerId));
        if (!viewerExists && activeThread.viewer) {
          const viewerObj = activeThread.viewer as any;
          allMembers.push({
            id: viewerId,
            username: viewerObj.username || 'Ben',
            full_name: viewerObj.full_name || 'Giriş Yapmış Kullanıcı',
            profile_pic_url: activeThread.viewer.profile_pic_url || '',
          } as any);
        }
      }

      // Filter out group admins from control check
      const adminIds = activeThread.admin_user_ids || [];
      allMembers = allMembers.filter(member => {
        const memberId = member.id || member.interop_messaging_user_fbid;
        const isAdmin = adminIds.some((adminId: any) => String(adminId) === String(memberId));
        return !isAdmin;
      });

      const matchedList: any[] = [];
      const unmatchedList: any[] = [];

      allMembers.forEach(member => {
        const usernameLower = String(member.username).toLowerCase().trim();
        if (commentsMap.has(usernameLower)) {
          const commentInfo = commentsMap.get(usernameLower)!;
          matchedList.push({
            member,
            comment: commentInfo.text,
            timestamp: commentInfo.timestamp
          });
        } else {
          unmatchedList.push(member);
        }
      });

      setCommentScan(prev => ({
        ...prev,
        isScanning: false,
        matched: matchedList,
        unmatched: unmatchedList
      }));

    } catch (err: any) {
      console.error('[Scan] Error during comment scan:', err);
      alert(`Tarama hatası: ${err.message || 'Bilinmeyen bir hata oluştu.'}`);
      setCommentScan(prev => ({
        ...prev,
        isScanning: false,
        isOpen: false
      }));
    }
  };

  const handleStartLikeMatchScan = async (type: 'all' | 'participation' = 'all') => {
    const mediaId = contextMenu.mediaId;
    if (!mediaId || !activeThread) return;
    
    // Close context menu
    setContextMenu(prev => ({ ...prev, visible: false }));

    // Find like count from linkPreviews if available
    let localLikeCount: number | null = null;
    for (const [shortcode, preview] of Object.entries(linkPreviews)) {
      if (preview && typeof preview === 'object' && (preview as any).mediaId === mediaId) {
        localLikeCount = (preview as any).likeCount ?? null;
        break;
      }
    }

    if (localLikeCount !== null && localLikeCount > 90) {
      alert(`Güvenlik Koruması: Bu gönderi 90'dan fazla beğeni aldığı için (${localLikeCount} beğeni) beğeni taraması güvenlik amacıyla durduruldu.`);
      return;
    }
    
    // Initialize scan state
    setLikeScan({
      isOpen: true,
      isScanning: true,
      matched: [],
      unmatched: [],
      totalLikesScanned: 0,
      mediaId,
      scanType: type
    });
    setLikeScanTab('matched');

    console.log(`[Scan] Starting likes match scan for mediaId: ${mediaId}, type: ${type}`);
    
    try {
      const likesRes: any = await fetch('/api/instagram/media/likers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mediaId,
          cookies: cookiesRef.current,
          headers: headersRef.current,
        }),
      });

      const result = await likesRes.json();
      if (!likesRes.ok || !result.success) {
        throw new Error(result.error || 'Failed to fetch likes');
      }

      const allLikes = result.likers || [];
      
      // Map likes by username (case-insensitive) for fast lookup
      const likesMap = new Set<string>();
      allLikes.forEach((l: any) => {
        const usernameLower = String(l.username).toLowerCase().trim();
        likesMap.add(usernameLower);
      });

      // Get group members including viewer (or just yesterday's post senders)
      let allMembers: InstagramUser[] = [];
      if (type === 'participation') {
        allMembers = getYesterdaySenders();
      } else {
        allMembers = [...(activeThread.users || [])];
        const viewerId = activeThread.viewer?.id || activeThread.viewer?.interop_messaging_user_fbid || cookies['ds_user_id'];
        const viewerExists = allMembers.some(u => String(u.id || u.interop_messaging_user_fbid) === String(viewerId));
        if (!viewerExists && activeThread.viewer) {
          const viewerObj = activeThread.viewer as any;
          allMembers.push({
            id: viewerId,
            username: viewerObj.username || 'Ben',
            full_name: viewerObj.full_name || 'Giriş Yapmış Kullanıcı',
            profile_pic_url: activeThread.viewer.profile_pic_url || '',
          } as any);
        }
      }

      // Filter out group admins from control check
      const adminIds = activeThread.admin_user_ids || [];
      allMembers = allMembers.filter(member => {
        const memberId = member.id || member.interop_messaging_user_fbid;
        const isAdmin = adminIds.some((adminId: any) => String(adminId) === String(memberId));
        return !isAdmin;
      });

      const matchedList: InstagramUser[] = [];
      const unmatchedList: InstagramUser[] = [];

      allMembers.forEach(member => {
        const usernameLower = String(member.username).toLowerCase().trim();
        if (likesMap.has(usernameLower)) {
          matchedList.push(member);
        } else {
          unmatchedList.push(member);
        }
      });

      setLikeScan(prev => ({
        ...prev,
        isScanning: false,
        matched: matchedList,
        unmatched: unmatchedList,
        totalLikesScanned: allLikes.length
      }));

    } catch (err: any) {
      console.error('[Scan] Error during likes scan:', err);
      alert(`Tarama hatası: ${err.message || 'Bilinmeyen bir hata oluştu.'}`);
      setLikeScan(prev => ({
        ...prev,
        isScanning: false,
        isOpen: false
      }));
    }
  };

  const handleStartBulkDm = (users: InstagramUser[]) => {
    const initialStatuses: Record<string, 'pending' | 'sending' | 'success' | 'error'> = {};
    users.forEach(u => {
      if (u.username) {
        initialStatuses[u.username] = 'pending';
      }
    });

    setBulkDm({
      isOpen: true,
      recipients: users,
      messageText: 'Merhaba @{username}, paylaşıma beğeni ve yorumlarınızı yapmanızı rica ederiz. Teşekkürler!',
      isSending: false,
      currentIndex: 0,
      statuses: initialStatuses,
      errorMessages: {},
      paused: false
    });
  };

  const executeBulkDm = async () => {
    if (bulkDmRef.current.isSending) return;

    setBulkDm(prev => ({ ...prev, isSending: true, paused: false }));
    
    // Give state a small frame to flush to ref
    await new Promise(r => setTimeout(r, 100));

    const recipients = bulkDmRef.current.recipients;
    const messageText = bulkDmRef.current.messageText;
    
    const activeStatuses = { ...bulkDmRef.current.statuses };
    const activeErrorMessages = { ...bulkDmRef.current.errorMessages };

    for (let i = bulkDmRef.current.currentIndex; i < recipients.length; i++) {
      // Check if paused or stopped
      if (!bulkDmRef.current.isSending || bulkDmRef.current.paused) {
        console.log('[BulkDM] Interrupted: isSending=', bulkDmRef.current.isSending, 'paused=', bulkDmRef.current.paused);
        break;
      }

      const recipient = recipients[i];
      const username = recipient.username;
      if (!username) continue;

      // Update current status to sending
      activeStatuses[username] = 'sending';
      setBulkDm(prev => ({
        ...prev,
        currentIndex: i,
        statuses: { ...activeStatuses }
      }));

      // Personalize message
      let personalizedText = messageText;
      personalizedText = personalizedText.replace(/\{username\}/g, recipient.username || '');
      personalizedText = personalizedText.replace(/\{name\}/g, recipient.full_name || recipient.username || '');

      try {
        const recipientId = recipient.id;
        if (!recipientId) throw new Error('Kullanıcı kimliği (ID) bulunamadı.');

        // Find if we already have a 1-to-1 thread with this recipient in our threads list
        const existingThread = threads.find(t => 
          !t.is_group && 
          t.users?.some((u: any) => String(u.id || u.interop_messaging_user_fbid) === String(recipientId))
        );
        const targetTypingThreadId = existingThread?.id || existingThread?.thread_id || null;

        // 1. Send read receipt (Seen) if there are existing messages from the partner
        if (targetTypingThreadId && existingThread) {
          const messages = existingThread.slide_messages?.edges || [];
          let latestMsg = null;
          if (messages.length > 0) {
            const sorted = [...messages].sort((a, b) => {
              return parseInt(a.node?.timestamp_ms || '0', 10) - parseInt(b.node?.timestamp_ms || '0', 10);
            });
            latestMsg = sorted[sorted.length - 1]?.node || null;
          }

          const viewerId = String(activeThread?.viewer?.id || activeThread?.viewer?.interop_messaging_user_fbid || cookies['ds_user_id']);
          const isPartnerMessage = latestMsg && String(latestMsg.sender_fbid) !== viewerId;

          if (latestMsg?.id && isPartnerMessage) {
            try {
              console.log(`[BulkDM] Simulating read receipt for ${username} on thread ${targetTypingThreadId} (Msg ID: ${latestMsg.id})`);
              await fetch('/api/instagram/read', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  threadId: targetTypingThreadId,
                  messageId: latestMsg.id,
                  timestampMs: latestMsg.timestamp_ms,
                  cookies: cookiesRef.current
                })
              });
            } catch (e) {
              console.warn('[BulkDM] Failed to send read receipt:', e);
            }
          }
        }

        // 2. Send typing indicator start (if 1-to-1 thread exists)
        if (targetTypingThreadId) {
          try {
            console.log(`[BulkDM] Simulating typing start for ${username} on thread ${targetTypingThreadId}`);
            await fetch('/api/instagram/typing', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                threadId: targetTypingThreadId,
                isActive: true,
                cookies: cookiesRef.current
              })
            });
          } catch (e) {
            console.warn('[BulkDM] Failed to send typing start indicator:', e);
          }
          
          // Wait a random duration between 6 and 10 seconds for realistic typing simulation
          const typingDelay = Math.floor(Math.random() * 4000) + 6000; // 6000ms to 10000ms
          console.log(`[BulkDM] Simulating typing for ${typingDelay}ms...`);
          await new Promise(r => setTimeout(r, typingDelay));
        }

        // 2. Send the actual DM message
        const res = await fetch('/api/instagram/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipientId: String(recipientId),
            text: personalizedText,
            cookies: cookiesRef.current,
            headers: headersRef.current,
            data: postDataRef.current
          })
        });

        const result = await res.json();
        if (!res.ok || !result.success) {
          throw new Error(result.error || 'Mesaj gönderilemedi.');
        }

        activeStatuses[username] = 'success';

        // 3. Send typing indicator stop (if 1-to-1 thread exists)
        if (targetTypingThreadId) {
          try {
            console.log(`[BulkDM] Simulating typing stop for ${username}`);
            await fetch('/api/instagram/typing', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                threadId: targetTypingThreadId,
                isActive: false,
                cookies: cookiesRef.current
              })
            });
          } catch (e) {}
        }
      } catch (err: any) {
        console.error(`[BulkDM] Failed to send DM to ${username}:`, err);
        activeStatuses[username] = 'error';
        activeErrorMessages[username] = err.message || 'Bilinmeyen bir hata oluştu.';
      }

      // Update state
      setBulkDm(prev => ({
        ...prev,
        currentIndex: i + 1,
        statuses: { ...activeStatuses },
        errorMessages: { ...activeErrorMessages }
      }));

      // Wait a safe randomized delay (e.g. 5-9 seconds) before the next message
      if (i + 1 < recipients.length) {
        const delayMs = Math.floor(Math.random() * 4000) + 5000; // 5000ms to 9000ms
        console.log(`[BulkDM] Waiting ${delayMs}ms before next message...`);
        
        let waited = 0;
        const interval = 500;
        while (waited < delayMs) {
          await new Promise(r => setTimeout(r, interval));
          waited += interval;
          // Check if paused while waiting
          if (!bulkDmRef.current.isSending || bulkDmRef.current.paused) {
            break;
          }
        }
      }
    }

    setBulkDm(prev => ({
      ...prev,
      isSending: false
    }));
  };

  const handleThreadContextMenu = (e: React.MouseEvent, thread: InstagramThread) => {
    e.preventDefault();
    threadContextMenuJustOpenedRef.current = true;
    setTimeout(() => {
      threadContextMenuJustOpenedRef.current = false;
    }, 200);

    const menuWidth = 180;
    const menuHeight = 50;
    let x = e.clientX;
    let y = e.clientY;

    if (x + menuWidth > window.innerWidth) {
      x = Math.max(10, e.clientX - menuWidth);
    }
    if (y + menuHeight > window.innerHeight) {
      y = Math.max(10, e.clientY - menuHeight);
    }

    setThreadContextMenu({
      visible: true,
      x,
      y,
      threadId: thread.id,
    });
  };

  const handleMoveThread = async (threadId: string, targetFolder: 'PRIMARY' | 'GENERAL') => {
    setThreads(prevThreads => 
      prevThreads.map(t => t.id === threadId ? { ...t, folder: targetFolder } : t)
    );

    if (activeThreadId === threadId) {
      setActiveThreadId(null);
    }

    try {
      const res = await fetch('/api/instagram/move', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadId,
          folder: targetFolder === 'PRIMARY' ? 'primary' : 'general',
          cookies: cookiesRef.current,
          headers: headersRef.current,
        })
      });

      const result = await res.json();
      if (!res.ok || !result.success) {
        throw new Error(result.error || 'Klasöre taşıma başarısız oldu.');
      }
    } catch (err: any) {
      console.error('[Move] Error moving thread:', err);
      alert(`Taşıma hatası: ${err.message || 'Bilinmeyen bir hata oluştu.'}`);
      
      setThreads(prevThreads => 
        prevThreads.map(t => t.id === threadId ? { ...t, folder: targetFolder === 'PRIMARY' ? 'GENERAL' : 'PRIMARY' } : t)
      );
    }
  };

  const handleMsgContextMenu = (e: React.MouseEvent, msg: InstagramMessage) => {
    if (msg.content_type !== 'TEXT') return;

    e.preventDefault();
    if (!activeThread) return;

    msgContextMenuJustOpenedRef.current = true;
    setTimeout(() => {
      msgContextMenuJustOpenedRef.current = false;
    }, 200);

    const sent = isSentByViewer(msg, activeThread);

    const menuWidth = 180;
    const menuHeight = sent ? 130 : 50;
    let x = e.clientX;
    let y = e.clientY;

    if (x + menuWidth > window.innerWidth) {
      x = Math.max(10, e.clientX - menuWidth);
    }
    if (y + menuHeight > window.innerHeight) {
      y = Math.max(10, e.clientY - menuHeight);
    }

    setMsgContextMenu({
      visible: true,
      x,
      y,
      messageId: msg.id,
      text: msg.text_body || msg.content?.text_body || '',
      isOwnMessage: sent,
    });
  };

  const handleMessageDoubleClick = async (e: React.MouseEvent, msg: InstagramMessage) => {
    e.preventDefault();

    if (!activeThreadId) return;
    const activeThread = threads.find(t => t.id === activeThreadId);
    if (!activeThread) return;

    const messageId = msg.id;
    if (!messageId) return;

    const emoji = "❤️";
    const viewerId = String(activeThread.viewer?.id || activeThread.viewer?.viewer_id || cookiesRef.current['ds_user_id'] || '');
    
    // Find the message in the thread to check if we already reacted
    const targetMsg = activeThread.slide_messages?.edges?.find((edge: any) => edge.node?.id === messageId)?.node;
    const currentReactions = targetMsg?.reactions || [];
    const hasReacted = currentReactions.some((r: any) => String(r.sender_fbid) === viewerId && r.reaction === emoji);
    const reactionStatus = hasReacted ? "deleted" : "created";

    // 1. Instantly update client UI state for snappy feedback!
    setThreads(prevThreads => 
      prevThreads.map(thread => {
        if (thread.id !== activeThreadId) return thread;
        const edges = thread.slide_messages?.edges || [];
        const updatedEdges = edges.map((edge: any) => {
          if (edge.node?.id !== messageId) return edge;
          
          let newReactions;
          if (hasReacted) {
            newReactions = currentReactions.filter((r: any) => !(String(r.sender_fbid) === viewerId && r.reaction === emoji));
          } else {
            newReactions = [...currentReactions, {
              reaction: emoji,
              reaction_timestamp_ms: String(Date.now()),
              sender_fbid: viewerId
            }];
          }
          
          return {
            ...edge,
            node: {
              ...edge.node,
              reactions: newReactions
            }
          };
        });
        
        return {
          ...thread,
          slide_messages: {
            ...thread.slide_messages,
            edges: updatedEdges
          }
        };
      })
    );

    // 2. Call backend API to record reaction
    try {
      const res = await fetch('/api/instagram/react', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadId: activeThreadId,
          thread_id: activeThread.thread_id,
          messageId,
          emoji,
          reactionStatus,
          cookies: cookiesRef.current,
          headers: headersRef.current,
          data: postDataRef.current
        })
      });

      const result = await res.json();
      if (!res.ok || !result.success) {
        console.error('[React] Backend returned error:', result.error);
      }
    } catch (err) {
      console.error('[React] Network error:', err);
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!activeThreadId) return;

    const activeThread = threads.find(t => t.id === activeThreadId);
    if (!activeThread) return;

    let backupEdges: any[] = [];
    setThreads(prevThreads => 
      prevThreads.map(thread => {
        if (thread.id !== activeThreadId) return thread;
        backupEdges = thread.slide_messages?.edges || [];
        const filteredEdges = (thread.slide_messages?.edges || []).filter(
          (edge: any) => edge.node?.id !== messageId
        );
        return {
          ...thread,
          slide_messages: {
            ...thread.slide_messages,
            edges: filteredEdges
          }
        };
      })
    );

    try {
      const res = await fetch('/api/instagram/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadId: activeThreadId,
          thread_id: activeThread.thread_id,
          messageId,
          cookies: cookiesRef.current,
          headers: headersRef.current,
          data: postDataRef.current,
        })
      });

      const result = await res.json();
      if (!res.ok || !result.success) {
        throw new Error(result.error || 'Mesaj geri alınamadı.');
      }
    } catch (err: any) {
      console.error('[Delete] Error deleting message:', err);
      alert(`Hata: ${err.message || 'Mesaj geri alınamadı.'}`);
      
      setThreads(prevThreads => 
        prevThreads.map(thread => {
          if (thread.id !== activeThreadId) return thread;
          return {
            ...thread,
            slide_messages: {
              ...thread.slide_messages,
              edges: backupEdges
            }
          };
        })
      );
    }
  };



  // Handles thread selection and marks thread as read on client and API
  const handleSelectThread = (threadId: string) => {
    setActiveThreadId(threadId);
    setPlayingVideoId(null); // Reset any playing video state when switching threads!
    lastTypingSentRef.current = 0; // Reset typing throttle to instantly send indicator on next keystroke

    const thread = threads.find(t => t.id === threadId);
    if (!thread) return;

    // Clear unread status locally for immediate visual response
    setThreads(prevThreads => 
      prevThreads.map(t => t.id === threadId ? { ...t, marked_as_unread: false } : t)
    );

    // Fetch initial REST history to populate rich media previews and fill the chat history
    fetchThreadHistory(thread);

    // Send the read mutations in the background
    const edges = thread.slide_messages?.edges || [];
      
      // Sort edges chronologically to ensure the last item is the absolute latest message
      const sortedEdges = [...edges].sort((a, b) => {
        const tsA = parseInt(a.node?.timestamp_ms || '0', 10);
        const tsB = parseInt(b.node?.timestamp_ms || '0', 10);
        return tsA - tsB;
      });

      const lastMsgEdge = sortedEdges[sortedEdges.length - 1];
      const lastMsg = lastMsgEdge?.node;
      
      if (lastMsg) {
        sendReadReceipt(thread.thread_id, lastMsg.id, lastMsg.timestamp_ms);
      }
  };

  // Filter threads by active folder and search query
  const filteredThreads = useMemo(() => {
    // First, filter by folder
    const folderThreads = threads.filter(thread => {
      const folderVal = thread.folder || 'PRIMARY';
      if (activeFolder === 'PRIMARY') {
        return folderVal === 'PRIMARY' || folderVal === 'INBOX';
      } else {
        return folderVal === 'GENERAL';
      }
    });

    if (!searchQuery.trim()) return folderThreads;
    
    const q = searchQuery.toLowerCase().trim();
    return folderThreads.filter(thread => {
      const titleMatch = thread.thread_title?.toLowerCase().includes(q) || false;
      const userMatch = thread.users?.some(
        u => u.username?.toLowerCase().includes(q) || u.full_name?.toLowerCase().includes(q)
      ) || false;
      return titleMatch || userMatch;
    });
  }, [threads, activeFolder, searchQuery]);

  // Format relative timestamp
  const formatTime = (timestampMs: string) => {
    if (!timestampMs) return '';
    const ts = parseInt(timestampMs, 10);
    if (isNaN(ts)) return '';
    
    // Normal Instagram dates might be 13-digit ms
    const diffMs = Date.now() - ts;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffSec < 60) return 'şimdi';
    if (diffMin < 60) return `${diffMin}d`;
    if (diffHr < 24) return `${diffHr}sa`;
    if (diffDay < 7) return `${diffDay}g`;
    
    const date = new Date(ts);
    return date.toLocaleDateString('tr-TR', { month: 'short', day: 'numeric' });
  };

  // Filter and format group members for detail modal
  const filteredMembers = useMemo(() => {
    if (!activeThread || !activeThread.users) return [];
    
    // Combine users and the viewer
    const allParticipants = [...activeThread.users];
    
    // Check if viewer exists, if not add them
    const viewerId = activeThread.viewer?.id || activeThread.viewer?.interop_messaging_user_fbid || cookies['ds_user_id'];
    const viewerExists = allParticipants.some(u => String(u.id || u.interop_messaging_user_fbid) === String(viewerId));
    if (!viewerExists && activeThread.viewer) {
      const viewerObj = activeThread.viewer as any;
      allParticipants.push({
        id: viewerId,
        username: viewerObj.username || 'Ben',
        full_name: viewerObj.full_name || 'Giriş Yapmış Kullanıcı',
        profile_pic_url: viewerObj.profile_pic_url || '',
        is_viewer: true
      } as any);
    }

    if (!memberSearchQuery.trim()) return allParticipants;
    const q = memberSearchQuery.toLowerCase().trim();
    return allParticipants.filter(u => 
      (u.username || '').toLowerCase().includes(q) || 
      (u.full_name || '').toLowerCase().includes(q)
    );
  }, [activeThread, memberSearchQuery, cookies]);

  // Check if sender is Viewer
  const isSentByViewer = (message: InstagramMessage, thread: InstagramThread) => {
    if (!message || !thread) return false;
    const viewerFbid = thread.viewer?.interop_messaging_user_fbid;
    const viewerId = thread.viewer?.id || thread.viewer?.viewer_id;
    const numericUserId = cookiesRef.current?.['ds_user_id'] || cookies['ds_user_id'];
    
    const sender = String(message.sender_fbid);
    return sender === String(viewerFbid) || 
           sender === String(viewerId) || 
           sender === String(numericUserId);
  };

  const handleMentionClick = (username: string) => {
    setTypedMessage((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) {
        return `${username} `;
      }
      if (prev.endsWith(' ')) {
        return `${prev}${username} `;
      } else {
        return `${prev} ${username} `;
      }
    });
    if (chatInputRef.current) {
      chatInputRef.current.focus();
    }
  };

  // Helper to render plain text and convert links and mentions into clickable elements
  const renderMessageText = (textStr: string) => {
    if (!textStr) return '';
    
    // Regular expression to detect URLs or @username mentions
    const mentionOrUrlRegex = /(https?:\/\/\S+|@[a-zA-Z0-9._]+)/g;
    const parts = textStr.split(mentionOrUrlRegex);
    
    return parts.map((part, index) => {
      if (/^https?:\/\/\S+$/.test(part)) {
        return (
          <a 
            key={index} 
            href={part} 
            target="_blank" 
            rel="noopener noreferrer" 
            style={{ 
              color: 'var(--accent-glow-primary, #0095f6)', 
              textDecoration: 'underline',
              wordBreak: 'break-all'
            }}
          >
            {part}
          </a>
        );
      }
      if (part.startsWith('@') && part.length > 1 && !/\s/.test(part)) {
        return (
          <span 
            key={index} 
            onClick={() => handleMentionClick(part)}
            style={{ 
              color: 'inherit', 
              fontWeight: 'inherit',
              cursor: 'pointer',
              textDecoration: 'none'
            }}
            onMouseOver={(e) => e.currentTarget.style.textDecoration = 'underline'}
            onMouseOut={(e) => e.currentTarget.style.textDecoration = 'none'}
          >
            {part}
          </span>
        );
      }
      return part;
    });
  };

  // Check if a message is the last message seen by the partner
  const isLastSeenMessage = (msg: InstagramMessage, thread: InstagramThread) => {
    if (!thread.last_seen_watermark_ms) return false;
    const sent = isSentByViewer(msg, thread);
    if (!sent) return false;

    const msgTime = parseInt(msg.timestamp_ms, 10);
    const seenTime = parseInt(thread.last_seen_watermark_ms, 10);

    // Is it seen?
    if (seenTime < msgTime) return false;

    // Is there any later message sent by the viewer that is also seen?
    const messages = thread.slide_messages?.edges || [];
    const hasLaterSeenMsg = messages.some(edge => {
      const otherMsg = edge.node;
      if (!otherMsg || otherMsg.id === msg.id) return false;
      const otherSent = isSentByViewer(otherMsg, thread);
      if (!otherSent) return false;
      const otherTime = parseInt(otherMsg.timestamp_ms, 10);
      return otherTime > msgTime && seenTime >= otherTime;
    });

    return !hasLaterSeenMsg;
  };

  // Active chat participant information
  const chatPartner = useMemo(() => {
    if (!activeThread) return null;
    return activeThread.users?.[0] || {
      username: 'instagram_user',
      full_name: activeThread.thread_title || 'Instagram User',
      profile_pic_url: '/default-avatar.png',
      is_verified: false
    };
  }, [activeThread]);

  const chatHeaderTitle = useMemo(() => {
    if (!activeThread) return '';
    if (activeThread.is_group) {
      return activeThread.thread_title && activeThread.thread_title !== 'Instagram User' 
        ? activeThread.thread_title 
        : activeThread.users?.map(u => u.full_name || u.username).slice(0, 3).join(', ');
    }
    return chatPartner ? (chatPartner.full_name || chatPartner.username) : 'Instagram User';
  }, [activeThread, chatPartner]);

  const chatHeaderAvatar = useMemo(() => {
    if (!activeThread) return null;
    if (activeThread.is_group) {
      return activeThread.thread_image_url || null;
    }
    return chatPartner ? chatPartner.profile_pic_url : null;
  }, [activeThread, chatPartner]);

  if (!isMounted) {
    return (
      <div style={{
        height: '100vh',
        width: '100vw',
        background: '#050505',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        {/* Loading Spinner */}
        <svg className="refresh-spinning" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2.5">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
        </svg>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="login-overlay-container">
        <div className="login-card">
          <div className="login-logo-container">
            <div className="login-logo-circle">
              {/* Instagram Direct Logo (Paper Plane styled white outline) */}
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </div>
            <h1 className="login-logo-text">Instagram Direct</h1>
            <p className="login-logo-tagline">Web tabanlı gerçek zamanlı mesajlaşma portalı</p>
          </div>

          {loginFeedback && (
            <div className={`alert-message ${loginFeedback.type}`} style={{ marginBottom: '20px' }}>
              {loginFeedback.message}
            </div>
          )}

          <form onSubmit={handleLoginSubmit}>
            <div className="login-form-group">
              <label className="login-form-label">Kullanıcı Adı veya E-posta</label>
              <input
                type="text"
                className="login-form-input"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                placeholder="Kullanıcı adı, telefon veya e-posta"
                required
              />
            </div>
            <div className="login-form-group" style={{ marginBottom: '24px' }}>
              <label className="login-form-label">Şifre</label>
              <input
                type="password"
                className="login-form-input"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="Instagram şifreniz"
                required
              />
            </div>

            <button
              type="submit"
              className="login-btn-submit"
              disabled={isLoggingIn}
            >
              {isLoggingIn ? (
                <>
                  <svg className="refresh-spinning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                  </svg>
                  <span>Giriş Yapılıyor...</span>
                </>
              ) : (
                <span>Doğrula ve Giriş Yap</span>
              )}
            </button>
          </form>

          <p className="login-disclaimer">
            Giriş bilgileriniz hiçbir üçüncü şahısa iletilmez ve doğrudan Instagram resmi API sunucuları üzerinden sorgulanır.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-container ${activeThreadId ? 'chat-active' : ''}`}>

      {/* Toast Notification Container */}
      <div className="toast-notifications-container" style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        maxWidth: '360px',
        width: 'calc(100% - 48px)',
        pointerEvents: 'none'
      }}>
        {toasts.map(toast => (
          <div 
            key={toast.id}
            onClick={() => {
              handleSelectThread(toast.threadId);
              setToasts(prev => prev.filter(t => t.id !== toast.id));
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              background: 'rgba(18, 18, 18, 0.85)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '12px 16px',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
              cursor: 'pointer',
              pointerEvents: 'auto',
              animation: 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              transition: 'all 0.2s ease',
            }}
          >
            {toast.avatarUrl ? (
              <img 
                src={toast.avatarUrl} 
                alt="" 
                style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover', border: '1px solid rgba(255,255,255,0.1)' }} 
              />
            ) : (
              <div style={{
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                background: 'linear-gradient(45deg, #f09433 0%, #e6683c 50%, #bc1888 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                  <circle cx="12" cy="7" r="4"></circle>
                </svg>
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {toast.title}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {toast.message}
              </div>
            </div>
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setToasts(prev => prev.filter(t => t.id !== toast.id));
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '4px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        ))}
      </div>
      
      {/* SIDEBAR */}
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="sidebar-title-container">
            <span className="sidebar-title">Gelen Kutusu</span>
            <span className="badge-live">Live</span>
          </div>
          
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button 
              className="icon-btn" 
              onClick={() => fetchLiveInbox()} 
              disabled={isFetching}
              title="Yenile"
            >
              <svg 
                className={isFetching ? 'refresh-spinning' : ''} 
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
              </svg>
            </button>
            
            <button 
              className="icon-btn" 
              title="Ayarlar ve Çerezler" 
              onClick={() => setIsSettingsOpen(true)}
            >
              {/* Cog Icon */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
          </div>
        </header>

        {/* Inbox Folder Tabs */}
        <div style={{
          display: 'flex',
          borderBottom: '1px solid var(--border-color)',
          background: 'var(--bg-pure)'
        }}>
          {[
            { id: 'PRIMARY', label: 'Birincil' },
            { id: 'GENERAL', label: 'Genel' }
          ].map(tab => {
            const isActive = activeFolder === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  const targetFolder = tab.id as 'PRIMARY' | 'GENERAL';
                  setActiveFolder(targetFolder);
                  
                  // Set active thread to the first local thread in this folder if we have one
                  const localThreadsInFolder = threads.filter(t => {
                    const folderVal = t.folder || 'PRIMARY';
                    if (targetFolder === 'PRIMARY') {
                      return folderVal === 'PRIMARY' || folderVal === 'INBOX';
                    } else {
                      return folderVal === 'GENERAL';
                    }
                  });
                  if (localThreadsInFolder.length > 0) {
                    setActiveThreadId(localThreadsInFolder[0].id);
                  }
                  
                  fetchLiveInbox(cookies, headers, postData, false, targetFolder);
                }}
                style={{
                  flex: 1,
                  padding: '12px 0',
                  background: 'none',
                  border: 'none',
                  borderBottom: isActive ? '2px solid #fff' : '2px solid transparent',
                  color: isActive ? '#fff' : 'rgba(255, 255, 255, 0.4)',
                  fontSize: '13px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  textAlign: 'center'
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Search bar */}
        <div className="search-container">
          <div className="search-box">
            <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input 
              type="text" 
              className="search-input" 
              placeholder="Ara..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Error or Success notification */}
        {fetchError && (
          <div style={{ padding: '10px 20px' }}>
            <div className="status-pill error" style={{ width: '100%', justifyContent: 'center' }}>
              <span>Hata: {fetchError.substring(0, 30)}{fetchError.length > 30 ? '...' : ''}</span>
              <button 
                style={{ background: 'none', border: 'none', color: 'inherit', marginLeft: '8px', cursor: 'pointer', fontWeight: 'bold' }}
                onClick={() => setIsSettingsOpen(true)}
              >
                Düzenle
              </button>
            </div>
          </div>
        )}



        {/* Threads List */}
        <div className="threads-list">
          {isFetching ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <div className="status-pill loading" style={{ margin: '0 auto', display: 'inline-flex' }}>
                <svg className="refresh-spinning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                </svg>
                <span>Yükleniyor...</span>
              </div>
            </div>
          ) : filteredThreads.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              {fetchError ? 'Canlı veriler alınamadı. Çerezlerinizi kontrol etmek için Ayarlar butonunu kullanın.' : 'Sohbet bulunamadı.'}
            </div>
          ) : (
            filteredThreads.map((thread) => {
              const active = thread.id === activeThreadId;
              const edges = thread.slide_messages?.edges || [];
              const lastMsgEdge = edges[edges.length - 1];
              const snippet = lastMsgEdge?.node?.igd_snippet || 'Mesaj yok';
              const partner = thread.users?.[0] || { full_name: thread.thread_title, username: '', profile_pic_url: '' };
              
              const isGroup = thread.is_group;
              const displayName = isGroup
                ? (thread.thread_title && thread.thread_title !== 'Instagram User' ? thread.thread_title : thread.users?.map(u => u.full_name || u.username).slice(0, 3).join(', '))
                : (partner.full_name || partner.username);
              
              const displayAvatar = isGroup
                ? (thread.thread_image_url || null)
                : (partner.profile_pic_url || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80");

              return (
                <div 
                  key={thread.id} 
                  className={`thread-item ${active ? 'active' : ''} ${thread.marked_as_unread ? 'unread' : ''}`}
                  onClick={() => handleSelectThread(thread.id)}
                  onContextMenu={(e) => handleThreadContextMenu(e, thread)}
                >

                  <div className="thread-avatar-container">
                    {isGroup && !displayAvatar ? (
                      <div style={{
                        width: '56px',
                        height: '56px',
                        borderRadius: '50%',
                        background: 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'rgba(255,255,255,0.6)'
                      }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                          <circle cx="9" cy="7" r="4"></circle>
                          <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                          <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                        </svg>
                      </div>
                    ) : (
                      <img 
                        src={displayAvatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"} 
                        alt={displayName} 
                        className="thread-avatar"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80";
                        }}
                      />
                    )}
                    {!thread.is_muted && <div className="online-dot"></div>}
                  </div>
                  
                  <div className="thread-details">
                    <div className="thread-header-line">
                      <span className="thread-name">
                        {displayName}
                        {!isGroup && partner.is_verified && (
                          <span className="verified-badge" title="Onaylı Hesap">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"></path>
                            </svg>
                          </span>
                        )}
                      </span>
                      <span className="thread-time">
                        {formatTime(thread.last_activity_timestamp_ms)}
                      </span>
                    </div>
                    
                    <div className="thread-message-line">
                      {getThreadTypingText(thread) ? (
                        <span className="thread-snippet" style={{ color: 'var(--accent-glow-primary, #10B981)', fontWeight: 'bold' }}>
                          {getThreadTypingText(thread)}
                        </span>
                      ) : (
                        <span className="thread-snippet">{snippet}</span>
                      )}
                      {thread.marked_as_unread && (
                        <div className="unread-dot-right" style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          backgroundColor: '#0095f6',
                          boxShadow: '0 0 8px rgba(0, 149, 246, 0.8)',
                          marginLeft: '8px',
                          flexShrink: 0
                        }}></div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* CHAT CONTAINER */}
      <main className="chat-container">
        {activeThread && chatPartner ? (
          <>
            {/* Chat header */}
            <header className="header-bar">
              <div 
                className="chat-user-info"
                onClick={() => {
                  if (activeThread.is_group) {
                    setIsGroupDetailsModalOpen(true);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  cursor: activeThread.is_group ? 'pointer' : 'default',
                  padding: '4px 8px',
                  borderRadius: '8px',
                  transition: 'background 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  if (activeThread.is_group) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                {/* Back button for mobile */}
                <button 
                  className="icon-btn" 
                  style={{ marginRight: '8px', display: 'none' }} /* Show conditionally in media query */
                  id="mobile-back-btn"
                  onClick={() => setActiveThreadId(null)}
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="19" y1="12" x2="5" y2="12"></line>
                    <polyline points="12 19 5 12 12 5"></polyline>
                  </svg>
                </button>
                
                {activeThread.is_group && !chatHeaderAvatar ? (
                  <div style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'rgba(255,255,255,0.6)',
                    marginRight: '12px'
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                      <circle cx="9" cy="7" r="4"></circle>
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                    </svg>
                  </div>
                ) : (
                  <img 
                    src={chatHeaderAvatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"} 
                    alt={chatHeaderTitle} 
                    className="chat-user-avatar"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80";
                    }}
                  />
                )}
                
                <div className="chat-user-details">
                  <span className="chat-user-name">
                    {chatHeaderTitle}
                    {!activeThread.is_group && chatPartner?.is_verified && (
                      <span className="verified-badge">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"></path>
                        </svg>
                      </span>
                    )}
                  </span>
                  <span className="chat-user-status">
                    {activeThread.is_group ? (
                      getThreadTypingText(activeThread) ? (
                        <span style={{ color: 'var(--accent-glow-primary, #10B981)', fontWeight: 'bold' }}>
                          {getThreadTypingText(activeThread)}
                        </span>
                      ) : (
                        <span>{activeThread.users?.length || 0} üye</span>
                      )
                    ) : isPartnerTyping ? (
                      <span style={{ color: 'var(--accent-glow-primary, #10B981)', fontWeight: 'bold' }}>yazıyor...</span>
                    ) : (
                      <span>@{chatPartner?.username || 'instagram_user'}</span>
                    )}
                  </span>
                </div>
              </div>

              <div className="chat-actions">
                <button className="icon-btn" title="Sesli Arama">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                  </svg>
                </button>
                <button className="icon-btn" title="Görüntülü Arama">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="23 7 16 12 23 17 23 7"></polygon>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                  </svg>
                </button>
                <button className="icon-btn" title="Detaylar">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                  </svg>
                </button>
              </div>
            </header>

            <div 
              className="messages-scrollarea" 
              ref={messagesScrollRef} 
              onScroll={handleScroll}
              onMouseMove={recordInteraction}
              onMouseDown={recordInteraction}
              onTouchStart={recordInteraction}
            >
              {/* Manual click-to-load history button at the top of the chat */}
              {(!activeThread.slide_messages?.edges || activeThread.slide_messages.edges.length > 0) && 
               (threadCursors[activeThread.id]?.hasOlder !== false) && (
                <div style={{ width: '100%', textAlign: 'center', padding: '10px 0' }}>
                  <button 
                    onClick={() => {
                      const container = messagesScrollRef.current;
                      const prevScrollHeight = container ? container.scrollHeight : 0;
                      const prevScrollTop = container ? container.scrollTop : 0;
                      
                      loadMoreMessages(activeThread).then(() => {
                        setTimeout(() => {
                          if (messagesScrollRef.current) {
                            const newScrollHeight = messagesScrollRef.current.scrollHeight;
                            messagesScrollRef.current.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
                          }
                        }, 50);
                      });
                    }}
                    className="status-pill loading"
                    style={{ 
                      margin: '0 auto', 
                      background: 'rgba(255, 255, 255, 0.05)', 
                      border: '1px solid rgba(255, 255, 255, 0.1)', 
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                      padding: '6px 12px',
                      borderRadius: '16px',
                      fontSize: '12px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      transition: 'background 0.2s'
                    }}
                    disabled={threadCursors[activeThread.id]?.isLoadingMore}
                  >
                    {threadCursors[activeThread.id]?.isLoadingMore ? (
                      <>
                        <svg className="refresh-spinning" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                        </svg>
                        <span>Eski mesajlar yükleniyor...</span>
                      </>
                    ) : (
                      <>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="12" y1="5" x2="12" y2="19"></line>
                          <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        <span>Daha Eski Mesajları Yükle</span>
                      </>
                    )}
                  </button>
                </div>
              )}
              {(!activeThread.slide_messages?.edges || activeThread.slide_messages.edges.length === 0) ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                  Henüz mesaj yok.
                </div>
              ) : (
                [...(activeThread.slide_messages?.edges || [])]
                  .sort((a, b) => {
                    const tsA = parseInt(a.node?.timestamp_ms || '0', 10);
                    const tsB = parseInt(b.node?.timestamp_ms || '0', 10);
                    return tsA - tsB;
                  })
                  .map((edge, index) => {
                  if (!edge.node) return null;
                  
                  // Clone message node locally so we can safely enrich it with fetched preview data
                  const msg = { ...edge.node };
                  
                  let text = (msg.text_body || msg.content?.text_body || '').trim();
                  const shortcode = getShortcodeFromUrl(text);
                  const isInstagramLinkOnly = shortcode && (text.includes('instagram.com') && !text.includes(' '));
                  
                  if (isInstagramLinkOnly && !msg.media_preview_url) {
                    const previewData = linkPreviews[shortcode];
                    if (previewData && typeof previewData === 'object') {
                      msg.media_preview_url = previewData.previewUrl;
                      msg.media_video_url = previewData.videoUrl;
                      msg.media_title = previewData.title;
                      msg.media_author = previewData.author;
                      msg.media_type = previewData.mediaType;
                      msg.media_id = previewData.mediaId;
                      msg.like_count = previewData.likeCount;
                      msg.comment_count = previewData.commentCount;
                    } else if (previewData === undefined) {
                      // Trigger dynamic background preview fetch
                      fetchLinkPreview(shortcode);
                    }
                  }

                  const isMediaMessage = ['clip', 'media_share', 'story_share'].includes(msg.media_type || '');
                  const hasMediaPreview = !!msg.media_preview_url;
                  const isExpiredMedia = isMediaMessage && !hasMediaPreview;
                  let isMediaShare = isMediaMessage || (isInstagramLinkOnly && linkPreviews[shortcode] === 'loading');
                  
                  if (text === '') {
                    // Fall back to Instagram's official snippet for stories, reels, posts, etc.
                    text = (msg.igd_snippet || '').trim();
                    if (text === '') {
                      text = msg.media_type === 'story_share' ? 'Paylaşılan hikaye' : 'Gönderi, Hikaye veya Reels paylaşıldı';
                    }
                    isMediaShare = true;
                  }

                  const sent = isSentByViewer(msg, activeThread);
                  const seen = isLastSeenMessage(msg, activeThread);

                  const senderId = (msg as any).user_id || msg.sender_fbid || (msg as any).sender_id || '';
                  const senderUser = !sent ? (activeThread.users?.find((u: any) => {
                    const uId = String(u.id || '');
                    const uPk = String(u.pk || '');
                    const uFbid = String(u.interop_messaging_user_fbid || '');
                    const sId = String(senderId);
                    return sId !== '' && (uId === sId || uPk === sId || uFbid === sId);
                  }) || activeThread.users?.[0] || null) : null;
                  
                  return (
                    <div 
                      key={msg.id || index} 
                      className={`message-group ${sent ? 'sent' : 'received'}`}
                      style={{ display: 'flex', flexDirection: 'column', gap: '2px', maxWidth: '85%' }}
                    >
                      {activeThread.is_group && !sent && (
                        <span style={{ 
                          fontSize: '11px', 
                          fontWeight: '700', 
                          color: 'rgba(255,255,255,0.5)', 
                          marginLeft: '36px', 
                          marginBottom: '2px' 
                        }}>
                          {senderUser?.username || 'Bilinmeyen Üye'}
                        </span>
                      )}

                      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-end', justifyContent: sent ? 'flex-end' : 'flex-start', gap: '8px' }}>
                        {!sent && (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '2px', flexShrink: 0 }}>
                            <img 
                              src={senderUser?.profile_pic_url || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"} 
                              alt="Sender" 
                              style={{
                                width: '28px',
                                height: '28px',
                                borderRadius: '50%',
                                objectFit: 'cover',
                                border: '1px solid rgba(255,255,255,0.08)'
                              }}
                              onError={(e) => {
                                (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80";
                              }}
                            />
                          </div>
                        )}

                        <div 
                          onContextMenu={(e) => {
                            if (msg.content_type === 'TEXT') {
                              handleMsgContextMenu(e, msg);
                            } else {
                              handleContextMenu(e, msg, 'right-click');
                            }
                          }}
                          onDoubleClick={(e) => handleMessageDoubleClick(e, msg)}
                          onTouchStart={(e) => handleTouchStart(e, msg)}
                          className={`message-bubble ${hasMediaPreview ? 'media-preview-bubble' : (isMediaShare ? 'media-share-bubble' : '')}`}
                          style={{ position: 'relative' }}
                        >
                          {hasMediaPreview ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '200px' }}>
                              {/* Author row */}
                              {msg.media_author && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: '700', color: 'rgba(255, 255, 255, 0.8)' }}>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="12" cy="7" r="4"></circle>
                                  </svg>
                                  <span>@{msg.media_author}</span>
                                  <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 'normal' }}>• {msg.media_type === 'story_share' ? 'Hikaye' : (msg.media_type === 'clip' ? 'Reels' : 'Gönderi')}</span>
                                </div>
                              )}
                              
                              {/* Image/Video Preview container */}
                              <div 
                                 onClick={() => {
                                   if (msg.media_video_url) {
                                     setPlayingVideoId(playingVideoId === msg.id ? null : msg.id);
                                   }
                                 }}
                                 style={{ 
                                   cursor: msg.media_video_url ? 'pointer' : 'default', 
                                   position: 'relative', 
                                   borderRadius: '10px', 
                                   overflow: 'hidden', 
                                   border: '1px solid rgba(255,255,255,0.1)', 
                                   background: '#121212', 
                                   aspectRatio: msg.media_type === 'clip' ? '9/16' : '1' 
                                 }}
                               >
                                 {playingVideoId === msg.id && msg.media_video_url ? (
                                   <video 
                                     src={msg.media_video_url} 
                                     controls 
                                     autoPlay 
                                     loop
                                     style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                     onClick={(e) => {
                                       // Prevent toggling video playing status when clicking controls
                                       e.stopPropagation();
                                     }}
                                   />
                                 ) : (
                                   <>
                                     <img 
                                       src={msg.media_preview_url || undefined} 
                                       alt={msg.media_title || ''} 
                                       style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
                                     />
                                     
                                     {/* Reels Play Overlay Icon */}
                                     {msg.media_type === 'clip' && msg.media_video_url && (
                                       <div 
                                         style={{
                                           position: 'absolute',
                                           top: '50%',
                                           left: '50%',
                                           transform: 'translate(-50%, -50%)',
                                           width: '46px',
                                           height: '46px',
                                           borderRadius: '50%',
                                           background: 'rgba(0,0,0,0.6)',
                                           display: 'flex',
                                           alignItems: 'center',
                                           justifyContent: 'center',
                                           border: '1px solid rgba(255,255,255,0.2)',
                                           transition: 'transform 0.2s ease, background 0.2s ease'
                                         }}
                                         className="play-btn-overlay"
                                       >
                                         <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" stroke="#fff">
                                           <polygon points="5 3 19 12 5 21 5 3"></polygon>
                                         </svg>
                                       </div>
                                     )}
                                   </>
                                 )}
  
                                 {/* Likes & Comments Hover Overlay */}
                                 {((msg.like_count !== undefined && msg.like_count !== null) || (msg.comment_count !== undefined && msg.comment_count !== null)) && (
                                   <div style={{
                                     position: 'absolute',
                                     top: 0,
                                     left: 0,
                                     right: 0,
                                     bottom: 0,
                                     background: 'rgba(0, 0, 0, 0.45)',
                                     display: 'flex',
                                     alignItems: 'center',
                                     justifyContent: 'center',
                                     gap: '16px',
                                     opacity: 0,
                                     transition: 'opacity 0.2s ease',
                                     pointerEvents: 'none',
                                     zIndex: 2,
                                   }} className="media-stats-overlay">
                                     {typeof msg.like_count === 'number' && (
                                       <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#fff', fontSize: '12px', fontWeight: '700' }}>
                                         <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" stroke="#fff">
                                           <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                                         </svg>
                                         <span>{msg.like_count >= 1000 ? `${(msg.like_count / 1000).toFixed(1)}k` : msg.like_count}</span>
                                       </div>
                                     )}
                                     
                                     {typeof msg.comment_count === 'number' && (
                                       <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#fff', fontSize: '12px', fontWeight: '700' }}>
                                         <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" stroke="#fff">
                                           <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                                         </svg>
                                         <span>{msg.comment_count >= 1000 ? `${(msg.comment_count / 1000).toFixed(1)}k` : msg.comment_count}</span>
                                       </div>
                                     )}
                                   </div>
                                 )}
                               </div>
                               
                               {/* Caption/Title */}
                               {msg.media_title && (
                                 <div style={{ 
                                   fontSize: '11px', 
                                   color: 'var(--text-primary)', 
                                   lineHeight: '1.4', 
                                   overflow: 'hidden', 
                                   textOverflow: 'ellipsis', 
                                   display: '-webkit-box', 
                                   WebkitLineClamp: 2, 
                                   WebkitBoxOrient: 'vertical' 
                                 }}>
                                   {msg.media_title}
                                 </div>
                               )}
  
                               {/* Likes and Comments Row - Always Visible inside the card */}
                               {((typeof msg.like_count === 'number') || (typeof msg.comment_count === 'number')) && (
                                 <div style={{
                                   display: 'flex',
                                   alignItems: 'center',
                                   gap: '12px',
                                   fontSize: '11px',
                                   fontWeight: '700',
                                   color: 'rgba(255, 255, 255, 0.5)',
                                   marginTop: '4px',
                                   padding: '2px 0',
                                   borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                                   paddingTop: '6px'
                                 }}>
                                   {typeof msg.like_count === 'number' && (
                                     <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                       <svg width="12" height="12" viewBox="0 0 24 24" fill="rgba(255, 255, 255, 0.5)" stroke="none">
                                         <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                                       </svg>
                                       <span>{msg.like_count.toLocaleString()}</span>
                                     </div>
                                   )}
                                   
                                   {typeof msg.comment_count === 'number' && (
                                     <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                       <svg width="12" height="12" viewBox="0 0 24 24" fill="rgba(255, 255, 255, 0.5)" stroke="none">
                                         <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                                       </svg>
                                       <span>{msg.comment_count.toLocaleString()}</span>
                                     </div>
                                   )}
                                 </div>
                               )}
                             </div>
                          ) : (
                            <>
                              {isExpiredMedia ? (
                                <div style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '8px',
                                  width: '220px',
                                  padding: '12px',
                                  background: 'rgba(255, 255, 255, 0.03)',
                                  border: '1px solid rgba(255, 255, 255, 0.08)',
                                  borderRadius: '14px',
                                  color: 'rgba(255, 255, 255, 0.6)',
                                  textAlign: 'left'
                                }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <div style={{
                                      width: '32px',
                                      height: '32px',
                                      borderRadius: '50%',
                                      background: 'rgba(255, 255, 255, 0.05)',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      color: 'rgba(255, 255, 255, 0.4)'
                                    }}>
                                      {msg.media_type === 'story_share' ? (
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                          <circle cx="12" cy="12" r="10"></circle>
                                          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
                                        </svg>
                                      ) : (
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                          <line x1="3" y1="21" x2="21" y2="3"></line>
                                        </svg>
                                      )}
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                                      <span style={{ fontSize: '12px', fontWeight: '700', color: 'rgba(255, 255, 255, 0.8)' }}>
                                        {msg.media_type === 'story_share' ? 'Hikayeye ulaşılamıyor' : 'Gönderiye ulaşılamıyor'}
                                      </span>
                                      {msg.media_author && (
                                        <span style={{ fontSize: '10px', color: 'rgba(255, 255, 255, 0.4)' }}>
                                          @{msg.media_author}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div style={{ fontSize: '11px', color: 'rgba(255, 255, 255, 0.4)', lineHeight: '1.4' }}>
                                    {msg.media_type === 'story_share' 
                                      ? 'Bu hikayenin süresi dolmuş veya sahibi tarafından silinmiş.' 
                                      : 'Bu paylaşıma artık ulaşılamıyor.'}
                                  </div>
                                </div>
                              ) : (
                                <>
                                  {isMediaShare && (
                                    <div style={{ 
                                      display: 'flex', 
                                      alignItems: 'center', 
                                      gap: '6px', 
                                      marginBottom: '4px',
                                      fontSize: '11px',
                                      color: 'rgba(255, 255, 255, 0.6)',
                                      fontWeight: '600'
                                    }}>
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                        <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
                                        <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path>
                                        <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line>
                                      </svg>
                                      <span>Paylaşılan Medya</span>
                                    </div>
                                  )}
                                  <span style={{ fontStyle: isMediaShare ? 'italic' : 'normal' }}>
                                    {renderMessageText(text)}
                                  </span>
                                </>
                              )}
                            </>
                          )}
                          {/* Message Reactions rendering */}
                          {msg.reactions && msg.reactions.length > 0 && (
                            <div style={{
                              position: 'absolute',
                              bottom: '-10px',
                              right: sent ? '12px' : 'auto',
                              left: !sent ? '12px' : 'auto',
                              background: 'rgba(30, 30, 30, 0.95)',
                              border: '1px solid rgba(255, 255, 255, 0.12)',
                              borderRadius: '10px',
                              padding: '2px 6px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '3px',
                              boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
                              zIndex: 10,
                              userSelect: 'none',
                              pointerEvents: 'none'
                            }}>
                              {Array.from(new Set(msg.reactions.map((r: any) => r.reaction))).map((emoji: any, idx) => (
                                <span key={idx} style={{ fontSize: '12px' }}>{emoji}</span>
                              ))}
                              {msg.reactions.length > 1 && (
                                <span style={{ fontSize: '9px', fontWeight: 'bold', color: 'rgba(255, 255, 255, 0.6)', marginLeft: '1px' }}>
                                  {msg.reactions.length}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="message-metadata" style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: sent ? 'flex-end' : 'flex-start',
                        gap: '6px',
                        marginTop: '2px',
                        marginLeft: !sent ? '36px' : '0'
                      }}>
                        <span className="message-timestamp">
                          {formatTime(msg.timestamp_ms)}
                        </span>
                        {seen && (
                          <span style={{
                            fontSize: '11px',
                            color: 'var(--success-color)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '3px',
                            fontWeight: '600'
                          }}>
                            {/* Tiny checkmark svg */}
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                            <span>Görüldü</span>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              {isPartnerTyping && (() => {
                let avatarUrl = null;
                let memberName = '';
                if (activeThread && activeThread.is_group) {
                  // Find first typing user ID
                  const typingUserIds: string[] = [];
                  Object.entries(typingRegistry).forEach(([key, val]) => {
                    if (!val) return;
                    const [tid, uid] = key.split('_');
                    if (tid === activeThread.id || tid === activeThread.thread_id || tid === activeThread.thread_fbid) {
                      const isViewer = uid === activeThread.viewer?.interop_messaging_user_fbid || 
                                       uid === activeThread.viewer?.id || 
                                       uid === activeThread.viewer?.viewer_id;
                      if (!isViewer) {
                        typingUserIds.push(uid);
                      }
                    }
                  });
                  if (typingUserIds.length > 0) {
                    const firstUser = activeThread.users?.find(u => String(u.id || u.interop_messaging_user_fbid) === String(typingUserIds[0]));
                    if (firstUser) {
                      avatarUrl = firstUser.profile_pic_url;
                      memberName = firstUser.username;
                    }
                  }
                }
                
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                    <div className="message-group received" style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
                      {avatarUrl ? (
                        <img 
                          src={avatarUrl} 
                          alt="Typing User" 
                          style={{
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            objectFit: 'cover',
                            border: '1px solid rgba(255,255,255,0.08)'
                          }}
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80";
                          }}
                        />
                      ) : activeThread?.is_group ? (
                        <div style={{
                          width: '28px',
                          height: '28px',
                          borderRadius: '50%',
                          background: 'rgba(255,255,255,0.1)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '10px',
                          color: 'rgba(255,255,255,0.6)'
                        }}>
                          G
                        </div>
                      ) : (
                        <img 
                          src={chatPartner?.profile_pic_url || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"} 
                          alt="Partner" 
                          style={{
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            objectFit: 'cover'
                          }}
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80";
                          }}
                        />
                      )}
                      
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        {activeThread?.is_group && memberName && (
                          <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginLeft: '4px' }}>
                            @{memberName}
                          </span>
                        )}
                        <div className="message-bubble typing-bubble">
                          <span className="dot"></span>
                          <span className="dot"></span>
                          <span className="dot"></span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Message Area */}
            <form className="chat-input-bar" onSubmit={handleSendMessage} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>

              <div className="chat-input-container">
                <input 
                  ref={chatInputRef}
                  type="text" 
                  className="chat-input" 
                  placeholder="Mesaj yaz..." 
                  value={typedMessage}
                  onChange={(e) => {
                    setTypedMessage(e.target.value);
                    handleUserTyping();
                    recordInteraction();
                  }}
                />
                
                <div className="chat-input-buttons">
                  {typedMessage.trim() ? (
                    <button type="submit" className="send-btn">Gönder</button>
                  ) : (
                    <>
                      <button type="button" className="icon-btn" title="Resim Ekle">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                          <circle cx="8.5" cy="8.5" r="1.5"></circle>
                          <polyline points="21 15 16 10 5 21"></polyline>
                        </svg>
                      </button>
                      <button 
                        type="button" 
                        className="icon-btn" 
                        title="Beğeni" 
                        onClick={() => {
                          setTypedMessage('❤️');
                        }}
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              </div>
            </form>
          </>
        ) : (
          <div className="empty-chat">
            <div className="empty-chat-icon-container">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
              </svg>
            </div>
            <h2 className="empty-chat-title">Mesajlarınız</h2>
            <p className="empty-chat-subtitle">
              Sohbetlerinizi görmek için sol taraftaki listeden bir kullanıcı seçin veya arama yapın.
            </p>
          </div>
        )}
      </main>

      {/* MOBILE STYLES INJECTOR */}
      <style jsx global>{`
        @media (max-width: 768px) {
          #mobile-back-btn {
            display: flex !important;
          }
        }
      `}</style>

      {/* SETTINGS DRAWER MODAL */}
      {isSettingsOpen && (
        <div className="modal-backdrop" onClick={() => setIsSettingsOpen(false)}>
          <div className="modal-drawer" onClick={(e) => e.stopPropagation()}>
            
            <header className="modal-header">
              <span className="modal-title">API Çerezleri ve İstek Ayarları</span>
              <button className="icon-btn" onClick={() => setIsSettingsOpen(false)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </header>

            <div className="modal-body">
              {settingsFeedback && (
                <div className={`alert-message ${settingsFeedback.type}`} style={{ marginBottom: '20px' }}>
                  {settingsFeedback.message}
                </div>
              )}

              {/* Tab Navigation */}
              <div style={{
                display: 'flex',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                marginBottom: '20px',
                gap: '16px'
              }}>
                <button
                  type="button"
                  onClick={() => setSettingsTab('settings')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: settingsTab === 'settings' ? 'var(--accent-color)' : 'var(--text-muted)',
                    padding: '8px 4px 12px 4px',
                    fontSize: '13px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    position: 'relative',
                    transition: 'all 0.2s ease',
                    outline: 'none'
                  }}
                >
                  Bağlantı Ayarları
                  {settingsTab === 'settings' && (
                    <div style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: '2px',
                      background: 'var(--accent-color)',
                      borderRadius: '2px'
                    }} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab('activities')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: settingsTab === 'activities' ? 'var(--accent-color)' : 'var(--text-muted)',
                    padding: '8px 4px 12px 4px',
                    fontSize: '13px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    position: 'relative',
                    transition: 'all 0.2s ease',
                    outline: 'none'
                  }}
                >
                  Giriş Hareketleri
                  {settingsTab === 'activities' && (
                    <div style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: '2px',
                      background: 'var(--accent-color)',
                      borderRadius: '2px'
                    }} />
                  )}
                </button>
              </div>

              {settingsTab === 'settings' ? (
                <>
                  {/* 1. OTURUM DURUM KARTI */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.05)',
                    borderRadius: '16px',
                    padding: '16px',
                    marginBottom: '20px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '14px'
                  }}>
                    <div style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '50%',
                      background: 'linear-gradient(45deg, #f09433 0%, #e6683c 50%, #bc1888 100%)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: '0 4px 12px rgba(220, 39, 67, 0.2)'
                    }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                        <circle cx="12" cy="7" r="4"></circle>
                      </svg>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span>Aktif Oturum</span>
                        <span style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          background: '#00f600',
                          boxShadow: '0 0 8px #00f600',
                          display: 'inline-block'
                        }}></span>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        Kullanıcı ID: <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{cookies.ds_user_id || '33205094022'}</span>
                      </div>
                    </div>
                  </div>

                  <form onSubmit={handleSaveSettings} id="settings-form">
                    
                    {/* 2. SENKRONIZASYON TERCIHLERI */}
                    <div className="form-section" style={{ marginBottom: '24px' }}>
                      <h3 className="form-section-title" style={{ fontSize: '12px', color: 'var(--accent-color)', letterSpacing: '1px', marginBottom: '16px' }}>Bağlantı Tercihleri</h3>
                      
                      {/* WebSocket Switch */}
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: 'rgba(255, 255, 255, 0.01)',
                        border: '1px solid rgba(255, 255, 255, 0.04)',
                        padding: '14px 16px',
                        borderRadius: '12px',
                        marginBottom: '16px'
                      }}>
                        <div style={{ flex: 1, paddingRight: '12px' }}>
                          <label htmlFor="polling-enabled" style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)', cursor: 'pointer', display: 'block' }}>
                            Arka Plan WebSocket Bağlantısı
                          </label>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginTop: '2px', lineHeight: '1.4' }}>
                            Instagram soket köprüsü üzerinden anlık gerçek zamanlı mesajlaşma sağlar.
                          </span>
                        </div>
                        <div style={{ position: 'relative', display: 'inline-block', width: '48px', height: '26px', flexShrink: 0 }}>
                          <input 
                            type="checkbox" 
                            id="polling-enabled"
                            checked={isPollingEnabled} 
                            onChange={(e) => setIsPollingEnabled(e.target.checked)}
                            style={{ opacity: 0, width: 0, height: 0 }}
                          />
                          <label htmlFor="polling-enabled" style={{
                            position: 'absolute',
                            cursor: 'pointer',
                            top: 0, left: 0, right: 0, bottom: 0,
                            backgroundColor: isPollingEnabled ? 'var(--accent-color)' : '#333',
                            transition: '.3s',
                            borderRadius: '34px'
                          }}>
                            <span style={{
                              position: 'absolute',
                              content: '""',
                              height: '18px', width: '18px',
                              left: isPollingEnabled ? '26px' : '4px',
                              bottom: '4px',
                              backgroundColor: 'white',
                              transition: '.3s',
                              borderRadius: '50%'
                            }}></span>
                          </label>
                        </div>
                      </div>

                      {/* Advanced Settings Toggle Link */}
                      <div style={{ textAlign: 'right', marginBottom: '16px' }}>
                        <button
                          type="button"
                          onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--accent-color)',
                            fontSize: '12px',
                            cursor: 'pointer',
                            fontWeight: '600',
                            padding: 0
                          }}
                        >
                          {showAdvancedSettings ? 'Gelişmiş Ayarları Gizle' : 'Gelişmiş Ayarları Göster'}
                        </button>
                      </div>

                      {showAdvancedSettings && (
                        <div style={{
                          background: 'rgba(255, 255, 255, 0.01)',
                          border: '1px solid rgba(255, 255, 255, 0.04)',
                          padding: '16px',
                          borderRadius: '12px',
                          marginBottom: '16px'
                        }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <label htmlFor="polling-interval" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Yedek Sorgu Aralığı (Saniye)</label>
                            <select
                              id="polling-interval"
                              value={pollingInterval}
                              onChange={(e) => setPollingInterval(parseInt(e.target.value, 10))}
                              style={{
                                width: '100%',
                                height: '36px',
                                background: 'rgba(255, 255, 255, 0.04)',
                                border: '1px solid rgba(255, 255, 255, 0.08)',
                                borderRadius: '8px',
                                color: '#fff',
                                fontSize: '13px',
                                cursor: 'pointer',
                                padding: '0 12px',
                                outline: 'none'
                              }}
                            >
                              <option value={15000} style={{ background: '#121212' }}>15 Saniye (Hızlı)</option>
                              <option value={30000} style={{ background: '#121212' }}>30 Saniye (Standart)</option>
                              <option value={60000} style={{ background: '#121212' }}>1 Dakika (Dengeli)</option>
                            </select>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 3. VERI GIRISI / LOGIN SECENEKLERI */}
                    <div className="form-section" style={{ marginBottom: '24px' }}>
                      <h3 className="form-section-title" style={{ fontSize: '12px', color: 'var(--accent-color)', letterSpacing: '1px', marginBottom: '16px' }}>Kimlik Bilgileri</h3>
                      
                      <div style={{
                        display: 'flex',
                        background: 'rgba(255, 255, 255, 0.02)',
                        padding: '4px',
                        borderRadius: '10px',
                        border: '1px solid rgba(255, 255, 255, 0.05)',
                        marginBottom: '16px'
                      }}>
                        <button
                          type="button"
                          onClick={() => setLoginMethod('credentials')}
                          style={{
                            flex: 1,
                            background: loginMethod === 'credentials' ? 'rgba(255, 255, 255, 0.06)' : 'transparent',
                            border: 'none',
                            color: loginMethod === 'credentials' ? '#fff' : 'var(--text-muted)',
                            padding: '8px',
                            borderRadius: '8px',
                            fontSize: '12px',
                            fontWeight: '600',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                          }}
                        >
                          Giriş Bilgileri
                        </button>
                        <button
                          type="button"
                          onClick={() => setLoginMethod('curl')}
                          style={{
                            flex: 1,
                            background: loginMethod === 'curl' ? 'rgba(255, 255, 255, 0.06)' : 'transparent',
                            border: 'none',
                            color: loginMethod === 'curl' ? '#fff' : 'var(--text-muted)',
                            padding: '8px',
                            borderRadius: '8px',
                            fontSize: '12px',
                            fontWeight: '600',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                          }}
                        >
                          cURL ile Güncelle
                        </button>
                      </div>

                      {loginMethod === 'credentials' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                          <div>
                            <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Instagram Cookie Header Değeri</label>
                            <textarea
                              value={cookiesJson}
                              onChange={(e) => setCookiesJson(e.target.value)}
                              placeholder="mid=...; sessionid=...; ds_user_id=...;"
                              style={{
                                width: '100%',
                                height: '100px',
                                background: 'rgba(255, 255, 255, 0.02)',
                                border: '1px solid rgba(255, 255, 255, 0.06)',
                                borderRadius: '10px',
                                color: '#fff',
                                padding: '12px',
                                fontSize: '12px',
                                fontFamily: 'monospace',
                                outline: 'none',
                                resize: 'vertical'
                              }}
                            />
                          </div>

                          <div>
                            <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Özel HTTP Headers JSON (İsteğe Bağlı)</label>
                            <textarea
                              value={headersJson}
                              onChange={(e) => setHeadersJson(e.target.value)}
                              placeholder='{ "user-agent": "...", "x-ig-app-id": "..." }'
                              style={{
                                width: '100%',
                                height: '100px',
                                background: 'rgba(255, 255, 255, 0.02)',
                                border: '1px solid rgba(255, 255, 255, 0.06)',
                                borderRadius: '10px',
                                color: '#fff',
                                padding: '12px',
                                fontSize: '12px',
                                fontFamily: 'monospace',
                                outline: 'none',
                                resize: 'vertical'
                              }}
                            />
                          </div>
                        </div>
                      ) : (
                        <div>
                          <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Instagram cURL Komutu</label>
                          <textarea
                            value={loginCurl}
                            onChange={(e) => setLoginCurl(e.target.value)}
                            placeholder="curl 'https://www.instagram.com/api/v1/direct_v2/inbox/' -H 'cookie: ...' ..."
                            style={{
                              width: '100%',
                              height: '180px',
                              background: 'rgba(255, 255, 255, 0.02)',
                              border: '1px solid rgba(255, 255, 255, 0.06)',
                              borderRadius: '10px',
                              color: '#fff',
                              padding: '12px',
                              fontSize: '12px',
                              fontFamily: 'monospace',
                              outline: 'none',
                              resize: 'vertical'
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => handleCurlImport(loginCurl)}
                            style={{
                              marginTop: '12px',
                              width: '100%',
                              height: '38px',
                              background: 'rgba(255, 255, 255, 0.06)',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              borderRadius: '8px',
                              color: '#fff',
                              fontSize: '13px',
                              fontWeight: '600',
                              cursor: 'pointer',
                              transition: 'all 0.2s'
                            }}
                          >
                            cURL Analiz Et ve Doldur
                          </button>
                        </div>
                      )}
                    </div>
                  </form>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '8px' }}>
                    Hesabına giriş yapmak için hangi cihazların kullanıldığını gör ve aktif oturumlarını denetle.
                  </div>

                  {isLoadingSessions ? (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '40px 0',
                      gap: '12px'
                    }}>
                      <div className="spinner" style={{
                        width: '28px',
                        height: '28px',
                        border: '3px solid rgba(255, 255, 255, 0.1)',
                        borderTopColor: 'var(--accent-color)',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite'
                      }}></div>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Oturumlar sorgulanıyor...</span>
                    </div>
                  ) : sessionsError ? (
                    <div style={{
                      padding: '16px',
                      background: 'rgba(237, 73, 86, 0.08)',
                      border: '1px solid rgba(237, 73, 86, 0.15)',
                      borderRadius: '12px',
                      color: '#ff858d',
                      fontSize: '12px',
                      lineHeight: '1.4'
                    }}>
                      Hata: {sessionsError}
                      <button
                        onClick={fetchLoginSessions}
                        style={{
                          display: 'block',
                          marginTop: '8px',
                          background: 'rgba(255, 255, 255, 0.08)',
                          border: 'none',
                          color: '#fff',
                          padding: '6px 12px',
                          borderRadius: '6px',
                          fontSize: '11px',
                          fontWeight: '600',
                          cursor: 'pointer'
                        }}
                      >
                        Yeniden Dene
                      </button>
                    </div>
                  ) : loginSessions.length === 0 ? (
                    <div style={{
                      padding: '32px 0',
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                      fontSize: '13px'
                    }}>
                      Giriş hareketi bulunamadı.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {/* Bulk Logout Button */}
                      {!isLoadingSessions && !sessionsError && loginSessions.filter(s => !s.is_active).length > 0 && (
                        <button
                          type="button"
                          disabled={isLoggingOutSession}
                          onClick={() => {
                            const ids = loginSessions.filter(s => !s.is_active).map(s => s.id).filter(Boolean);
                            handleLogoutSession(ids);
                          }}
                          style={{
                            background: 'rgba(237, 73, 86, 0.12)',
                            border: '1px solid rgba(237, 73, 86, 0.25)',
                            color: '#ff858d',
                            width: '100%',
                            height: '38px',
                            borderRadius: '10px',
                            fontSize: '12px',
                            fontWeight: '600',
                            cursor: isLoggingOutSession ? 'not-allowed' : 'pointer',
                            transition: 'all 0.2s ease',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '6px',
                            marginBottom: '8px',
                            opacity: isLoggingOutSession ? 0.6 : 1
                          }}
                          onMouseEnter={(e) => {
                            if (!isLoggingOutSession) {
                              e.currentTarget.style.background = 'rgba(237, 73, 86, 0.2)';
                              e.currentTarget.style.borderColor = 'rgba(237, 73, 86, 0.4)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isLoggingOutSession) {
                              e.currentTarget.style.background = 'rgba(237, 73, 86, 0.12)';
                              e.currentTarget.style.borderColor = 'rgba(237, 73, 86, 0.25)';
                            }
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                            <polyline points="16 17 21 12 16 7"></polyline>
                            <line x1="21" y1="12" x2="9" y2="12"></line>
                          </svg>
                          Diğer Tüm Cihazlardan Çıkış Yap
                        </button>
                      )}

                      {loginSessions.map((session, index) => {
                        const isWindows = session.user_session_info_icon === 'DEVICE_WINDOWS';
                        const isAndroid = session.user_session_info_icon === 'DEVICE_ANDROID';
                        const isIOS = session.user_session_info_icon === 'DEVICE_IPHONE' || session.user_session_info_icon === 'DEVICE_IPAD';
                        
                        return (
                          <div 
                            key={session.id || index}
                            style={{
                              background: 'rgba(255, 255, 255, 0.015)',
                              border: '1px solid rgba(255, 255, 255, 0.05)',
                              borderRadius: '14px',
                              padding: '14px 16px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '14px',
                              transition: 'all 0.2s ease',
                              cursor: 'default'
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.015)';
                              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.05)';
                            }}
                          >
                            {/* Device Icon */}
                            <div style={{
                              width: '42px',
                              height: '42px',
                              borderRadius: '10px',
                              background: 'rgba(255, 255, 255, 0.03)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0
                            }}>
                              {isWindows ? (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2">
                                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                                  <line x1="8" y1="21" x2="16" y2="21"></line>
                                  <line x1="12" y1="17" x2="12" y2="21"></line>
                                </svg>
                              ) : isIOS ? (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2">
                                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
                                  <line x1="12" y1="18" x2="12.01" y2="18"></line>
                                </svg>
                              ) : (
                                // Default/Android
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2">
                                  <rect x="7" y="3" width="10" height="18" rx="2" ry="2"></rect>
                                  <line x1="11" y1="18" x2="13" y2="18"></line>
                                </svg>
                              )}
                            </div>

                            {/* Device Details */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {session.device_name || 'Bilinmeyen Cihaz'}
                                </span>
                                {session.is_active && (
                                  <span style={{
                                    fontSize: '10px',
                                    fontWeight: '700',
                                    color: '#00f600',
                                    background: 'rgba(0, 246, 0, 0.08)',
                                    padding: '2px 6px',
                                    borderRadius: '4px',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px'
                                  }}>
                                    Bu cihaz
                                  </span>
                                )}
                              </div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginTop: '2px', fontSize: '11px', color: 'var(--text-muted)' }}>
                                <span>{session.location || 'Bilinmeyen Konum'}</span>
                                <span>•</span>
                                <span style={{ color: session.is_active ? '#00f600' : 'var(--text-muted)' }}>
                                  {session.is_active ? 'Çevrimiçi' : session.last_active}
                                </span>
                              </div>
                            </div>

                            {/* Logout Button */}
                            {!session.is_active && (
                              <button
                                type="button"
                                disabled={isLoggingOutSession}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleLogoutSession([session.id]);
                                }}
                                style={{
                                  background: 'rgba(237, 73, 86, 0.08)',
                                  border: '1px solid rgba(237, 73, 86, 0.15)',
                                  color: '#ff858d',
                                  padding: '6px 12px',
                                  borderRadius: '8px',
                                  fontSize: '11px',
                                  fontWeight: '600',
                                  cursor: isLoggingOutSession ? 'not-allowed' : 'pointer',
                                  transition: 'all 0.2s ease',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  flexShrink: 0,
                                  opacity: isLoggingOutSession ? 0.6 : 1
                                }}
                                onMouseEnter={(e) => {
                                  if (!isLoggingOutSession) {
                                    e.currentTarget.style.background = 'rgba(237, 73, 86, 0.15)';
                                    e.currentTarget.style.borderColor = 'rgba(237, 73, 86, 0.3)';
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (!isLoggingOutSession) {
                                    e.currentTarget.style.background = 'rgba(237, 73, 86, 0.08)';
                                    e.currentTarget.style.borderColor = 'rgba(237, 73, 86, 0.15)';
                                  }
                                }}
                              >
                                Çıkış Yap
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <footer className="modal-footer">
              {settingsTab === 'settings' ? (
                <>
                  <button 
                    type="button" 
                    className="header-btn" 
                    style={{ marginRight: 'auto' }}
                    onClick={handleResetSettings}
                  >
                    Sıfırla
                  </button>
                  
                  <button 
                    type="button" 
                    className="header-btn"
                    style={{ 
                      backgroundColor: 'rgba(237, 73, 86, 0.1)', 
                      color: '#ff858d', 
                      border: '1px solid rgba(237, 73, 86, 0.2)' 
                    }}
                    onClick={handleLogout}
                  >
                    Çıkış Yap
                  </button>

                  <button 
                    type="button" 
                    className="header-btn" 
                    onClick={() => setIsSettingsOpen(false)}
                  >
                    İptal
                  </button>
                  
                  <button 
                    type="submit" 
                    form="settings-form" 
                    className="header-btn primary"
                  >
                    Kaydet
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="header-btn"
                    style={{ marginRight: 'auto' }}
                    onClick={fetchLoginSessions}
                  >
                    Yenile
                  </button>
                  <button 
                    type="button" 
                    className="header-btn primary" 
                    onClick={() => setIsSettingsOpen(false)}
                  >
                    Kapat
                  </button>
                </>
              )}
            </footer>

          </div>
        </div>
      )}

      {/* Context Menu Dropdown */}
      {contextMenu.visible && (
        <div style={{
          position: 'fixed',
          top: `${contextMenu.y}px`,
          left: `${contextMenu.x}px`,
          zIndex: 10000,
          background: 'rgba(20, 20, 20, 0.95)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '8px',
          boxShadow: '0 8px 30px rgba(0, 0, 0, 0.5)',
          padding: '4px',
          minWidth: '180px',
        }}>
          <button 
            onClick={() => handleFetchUserData('comments')}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              background: 'none',
              border: 'none',
              color: '#fff',
              fontSize: '13px',
              cursor: 'pointer',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'background 0.2s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            Yorumları Getir
          </button>
          
          <button 
            onClick={() => handleFetchUserData('likers')}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              background: 'none',
              border: 'none',
              color: '#fff',
              fontSize: '13px',
              cursor: 'pointer',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'background 0.2s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
            </svg>
            Beğenen Kişileri Getir
          </button>

          {activeThread && activeThread.is_group && (
            <>
              <button 
                onClick={() => handleStartCommentMatchScan()}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: 'none',
                  border: 'none',
                  color: '#10B981',
                  fontSize: '13px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  transition: 'background 0.2s',
                  borderTop: '1px solid rgba(255,255,255,0.06)',
                  marginTop: '4px',
                  paddingTop: '14px'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(16, 185, 129, 0.08)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M22 12h-4"></path>
                  <path d="M6 12H2"></path>
                  <path d="M12 6V2"></path>
                  <path d="M12 22v-4"></path>
                </svg>
                Grup Yorumlarını Tara
              </button>

              <button 
                onClick={() => handleStartLikeMatchScan()}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: 'none',
                  border: 'none',
                  color: '#EC4899',
                  fontSize: '13px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  transition: 'background 0.2s',
                  marginTop: '2px',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(236, 72, 153, 0.08)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                </svg>
                Grup Beğenilerini Tara
              </button>

              <button 
                onClick={() => handleStartCommentMatchScan('participation')}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: 'none',
                  border: 'none',
                  color: '#10B981',
                  fontSize: '13px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  transition: 'background 0.2s',
                  marginTop: '2px',
                  borderTop: '1px solid rgba(255,255,255,0.06)',
                  paddingTop: '10px'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(16, 185, 129, 0.08)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
                Sadece Katılım Yorumları
              </button>

              <button 
                onClick={() => handleStartLikeMatchScan('participation')}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: 'none',
                  border: 'none',
                  color: '#EC4899',
                  fontSize: '13px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  transition: 'background 0.2s',
                  marginTop: '2px',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(236, 72, 153, 0.08)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
                Sadece Katılım Beğeniler
              </button>
            </>
          )}
        </div>
      )}

      {/* Thread Context Menu Dropdown */}
      {threadContextMenu.visible && (
        <div style={{
          position: 'fixed',
          top: `${threadContextMenu.y}px`,
          left: `${threadContextMenu.x}px`,
          zIndex: 10000,
          background: 'rgba(20, 20, 20, 0.95)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '8px',
          boxShadow: '0 8px 30px rgba(0, 0, 0, 0.5)',
          padding: '4px',
          minWidth: '180px',
        }}>
          <button 
            onClick={() => handleMoveThread(threadContextMenu.threadId, 'PRIMARY')}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              background: 'none',
              border: 'none',
              color: '#fff',
              fontSize: '13px',
              cursor: 'pointer',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'background 0.2s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
            Birincil (Primary) Klasöre Taşı
          </button>

          <button 
            onClick={() => handleMoveThread(threadContextMenu.threadId, 'GENERAL')}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              background: 'none',
              border: 'none',
              color: '#fff',
              fontSize: '13px',
              cursor: 'pointer',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'background 0.2s',
              marginTop: '2px'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            Genel (General) Klasöre Taşı
          </button>
        </div>
      )}

      {/* Message Context Menu Dropdown */}
      {msgContextMenu.visible && (
        <div style={{
          position: 'fixed',
          top: `${msgContextMenu.y}px`,
          left: `${msgContextMenu.x}px`,
          zIndex: 10000,
          background: 'rgba(20, 20, 20, 0.95)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '8px',
          boxShadow: '0 8px 30px rgba(0, 0, 0, 0.5)',
          padding: '4px',
          minWidth: '180px',
        }}>
          <button 
            onClick={() => {
              navigator.clipboard.writeText(msgContextMenu.text);
              setMsgContextMenu(prev => ({ ...prev, visible: false }));
            }}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              background: 'none',
              border: 'none',
              color: '#fff',
              fontSize: '13px',
              cursor: 'pointer',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'background 0.2s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Kopyala
          </button>

          {msgContextMenu.isOwnMessage && (
            <>


              <button 
                onClick={() => {
                  if (confirm('Bu mesajı geri almak istediğinize emin misiniz?')) {
                    handleDeleteMessage(msgContextMenu.messageId);
                  }
                  setMsgContextMenu(prev => ({ ...prev, visible: false }));
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: 'none',
                  border: 'none',
                  color: '#ef4444',
                  fontSize: '13px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  transition: 'background 0.2s',
                  marginTop: '2px'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(239,68,68,0.08)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  <line x1="10" y1="11" x2="10" y2="17"></line>
                  <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
                Geri Al (Unsend)
              </button>
            </>
          )}
        </div>
      )}

      {/* Bulk DM Modal */}
      {bulkDm.isOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 20000,
          padding: '20px'
        }}>
          <div style={{
            background: 'linear-gradient(135deg, #1e1e1e 0%, #121212 100%)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            width: '100%',
            maxWidth: '520px',
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
          }}>
            {/* Header */}
            <div style={{
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'rgba(255,255,255,0.02)'
            }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                </svg>
                Toplu DM Gönderimi
              </h3>
              {!bulkDm.isSending && (
                <button
                  onClick={() => setBulkDm(prev => ({ ...prev, isOpen: false }))}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'rgba(255,255,255,0.5)',
                    fontSize: '20px',
                    cursor: 'pointer',
                    padding: '4px',
                    lineHeight: 1
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = '#fff'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255,255,255,0.5)'}
                >
                  &times;
                </button>
              )}
            </div>

            {/* Content Area */}
            <div style={{ padding: '20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Spam Warning */}
              <div style={{
                background: 'rgba(16, 185, 129, 0.06)',
                border: '1px solid rgba(16, 185, 129, 0.15)',
                borderRadius: '8px',
                padding: '12px 14px',
                fontSize: '12px',
                color: '#10b981',
                lineHeight: '1.5',
                display: 'flex',
                gap: '8px',
                alignItems: 'flex-start'
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: '2px' }}>
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="16" x2="12" y2="12"></line>
                  <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                <span>
                  <strong>Güvenli Gönderim Modu:</strong> Hesabınızın spama girmemesi için mesajlar arasına <strong>5-9 saniye arası rastgele gecikme</strong> eklenir. Lütfen tarayıcı sekmesini kapatmayın.
                </span>
              </div>

              {/* Message Input Template */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: '600', color: 'rgba(255,255,255,0.6)' }}>
                  Mesaj Şablonu:
                </label>
                <textarea
                  value={bulkDm.messageText}
                  onChange={(e) => setBulkDm(prev => ({ ...prev, messageText: e.target.value }))}
                  disabled={bulkDm.isSending}
                  placeholder="Mesajınızı yazın..."
                  style={{
                    background: 'rgba(0, 0, 0, 0.2)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '8px',
                    color: '#fff',
                    padding: '10px',
                    fontSize: '13px',
                    minHeight: '80px',
                    resize: 'vertical',
                    outline: 'none',
                    fontFamily: 'inherit',
                    lineHeight: '1.4'
                  }}
                />
                <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.4)', lineHeight: '1.4' }}>
                  * İpuçları: Dinamik veri için <strong>{'{username}'}</strong> ve <strong>{'{name}'}</strong> etiketlerini kullanabilirsiniz. (Örn: Merhaba @{'{username}'}...)
                </div>
              </div>

              {/* Progress Tracker */}
              {bulkDm.isSending || bulkDm.currentIndex > 0 ? (
                <div style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                  borderRadius: '10px',
                  padding: '12px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', fontSize: '12px' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>Gönderim Durumu</span>
                    <span style={{ fontWeight: '700', color: '#fff' }}>
                      {bulkDm.currentIndex} / {bulkDm.recipients.length}
                    </span>
                  </div>
                  
                  {/* Progress Bar */}
                  <div style={{
                    width: '100%',
                    height: '6px',
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: '3px',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      width: `${(bulkDm.currentIndex / bulkDm.recipients.length) * 100}%`,
                      height: '100%',
                      background: '#10b981',
                      transition: 'width 0.3s ease'
                    }} />
                  </div>
                </div>
              ) : null}

              {/* Recipient List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                <label style={{ fontSize: '12px', fontWeight: '600', color: 'rgba(255,255,255,0.6)' }}>
                  Alıcı Listesi ({bulkDm.recipients.length} Kişi):
                </label>
                <div style={{
                  background: 'rgba(0,0,0,0.15)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '10px',
                  maxHeight: '220px',
                  overflowY: 'auto',
                  padding: '6px'
                }}>
                  {bulkDm.recipients.map((user, idx) => {
                    const status = bulkDm.statuses[user.username || ''] || 'pending';
                    const errorMsg = bulkDm.errorMessages[user.username || ''];
                    
                    return (
                      <div
                        key={user.username || idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 10px',
                          borderRadius: '6px',
                          background: idx === bulkDm.currentIndex && bulkDm.isSending ? 'rgba(255,255,255,0.03)' : 'transparent',
                          borderBottom: idx < bulkDm.recipients.length - 1 ? '1px solid rgba(255,255,255,0.02)' : 'none'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <img
                            src={user.profile_pic_url || 'https://www.instagram.com/static/images/anonymousUser.jpg/f0ae99e61c84.jpg'}
                            alt=""
                            style={{ width: '28px', height: '28px', borderRadius: '50%', border: '1px solid rgba(255,255,255,0.1)' }}
                            onError={(e) => {
                              e.currentTarget.src = 'https://www.instagram.com/static/images/anonymousUser.jpg/f0ae99e61c84.jpg';
                            }}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: '13px', fontWeight: '600', color: '#fff' }}>@{user.username}</span>
                            <span style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.4)' }}>{user.full_name || 'Instagram Kullanıcısı'}</span>
                          </div>
                        </div>

                        {/* Status Badge */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {status === 'pending' && (
                            <span style={{ fontSize: '10px', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)', padding: '2px 6px', borderRadius: '12px' }}>
                              Bekliyor
                            </span>
                          )}
                          {status === 'sending' && (
                            <span style={{ fontSize: '10px', background: 'rgba(245,158,11,0.15)', color: '#fbbf24', padding: '2px 6px', borderRadius: '12px', animation: 'pulse 1.5s infinite' }}>
                              Gönderiliyor
                            </span>
                          )}
                          {status === 'success' && (
                            <span style={{ fontSize: '10px', background: 'rgba(16,185,129,0.15)', color: '#34d399', padding: '2px 6px', borderRadius: '12px' }}>
                              Başarılı
                            </span>
                          )}
                          {status === 'error' && (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                              <span style={{ fontSize: '10px', background: 'rgba(239,68,68,0.15)', color: '#f87171', padding: '2px 6px', borderRadius: '12px' }}>
                                Hata
                              </span>
                              {errorMsg && (
                                <span style={{ fontSize: '9px', color: '#f87171', marginTop: '2px', maxWidth: '150px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={errorMsg}>
                                  {errorMsg}
                                </span>
                              )}
                            </div>
                          )}

                          {/* Remove button (only if not sending) */}
                          {!bulkDm.isSending && (
                            <button
                              onClick={() => {
                                setBulkDm(prev => {
                                  const updatedRecipients = prev.recipients.filter((_, i) => i !== idx);
                                  const updatedStatuses = { ...prev.statuses };
                                  if (user.username) {
                                    delete updatedStatuses[user.username];
                                  }
                                  let newIndex = prev.currentIndex;
                                  if (idx <= prev.currentIndex && prev.currentIndex > 0) {
                                    newIndex = prev.currentIndex - 1;
                                  }
                                  return {
                                    ...prev,
                                    recipients: updatedRecipients,
                                    statuses: updatedStatuses,
                                    currentIndex: newIndex
                                  };
                                });
                              }}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: 'rgba(239, 68, 68, 0.6)',
                                cursor: 'pointer',
                                padding: '4px',
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'color 0.2s, background 0.2s',
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.color = '#ef4444';
                                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.color = 'rgba(239, 68, 68, 0.6)';
                                e.currentTarget.style.background = 'none';
                              }}
                              title="Alıcıyı Listeden Kaldır"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Footer Actions */}
            <div style={{
              padding: '16px 20px',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '12px',
              background: 'rgba(255,255,255,0.01)'
            }}>
              {bulkDm.isSending ? (
                /* Pausing/Stopping Actions */
                <button
                  onClick={() => setBulkDm(prev => ({ ...prev, paused: true, isSending: false }))}
                  style={{
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.2)',
                    color: '#ef4444',
                    borderRadius: '8px',
                    padding: '8px 16px',
                    fontSize: '13px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                >
                  Gönderimi Durdur
                </button>
              ) : (
                /* Start / Close / Resume Actions */
                <>
                  <button
                    onClick={() => setBulkDm(prev => ({ ...prev, isOpen: false }))}
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: 'rgba(255,255,255,0.8)',
                      borderRadius: '8px',
                      padding: '8px 16px',
                      fontSize: '13px',
                      fontWeight: '700',
                      cursor: 'pointer',
                      transition: 'background 0.2s'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                  >
                    Kapat
                  </button>

                  <button
                    onClick={executeBulkDm}
                    disabled={bulkDm.recipients.length === 0 || bulkDm.currentIndex >= bulkDm.recipients.length}
                    style={{
                      background: bulkDm.recipients.length === 0 || bulkDm.currentIndex >= bulkDm.recipients.length
                        ? 'rgba(255,255,255,0.05)'
                        : 'linear-gradient(135deg, #10B981 0%, #059669 100%)',
                      border: 'none',
                      color: bulkDm.recipients.length === 0 || bulkDm.currentIndex >= bulkDm.recipients.length
                        ? 'rgba(255,255,255,0.3)'
                        : '#fff',
                      borderRadius: '8px',
                      padding: '8px 18px',
                      fontSize: '13px',
                      fontWeight: '700',
                      cursor: bulkDm.recipients.length === 0 || bulkDm.currentIndex >= bulkDm.recipients.length
                        ? 'not-allowed'
                        : 'pointer',
                      boxShadow: bulkDm.recipients.length === 0 || bulkDm.currentIndex >= bulkDm.recipients.length
                        ? 'none'
                        : '0 4px 12px rgba(16, 185, 129, 0.2)'
                    }}
                  >
                    {bulkDm.paused ? 'Devam Et' : 'Gönderimi Başlat'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Comment Scan Modal */}
      {commentScan.isOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10001,
        }} onClick={() => {
          if (!commentScan.isScanning) {
            setCommentScan(prev => ({ ...prev, isOpen: false }));
          }
        }}>
          
          <div style={{
            background: '#1c1c1e',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            width: '480px',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
            overflow: 'hidden'
          }} onClick={(e) => e.stopPropagation()}>
            
            {/* Modal Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <span style={{ fontSize: '16px', fontWeight: '700', color: '#fff' }}>
                {commentScan.scanType === 'participation' ? 'Grup Yorum Katılım Analizi (Dün Paylaşanlar)' : 'Grup Yorum Eşleşme Analizi'}
              </span>
              {!commentScan.isScanning && (
                <button 
                  onClick={() => setCommentScan(prev => ({ ...prev, isOpen: false }))}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'rgba(255, 255, 255, 0.6)',
                    cursor: 'pointer',
                    padding: '4px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              )}
            </div>

            {/* Modal Body */}
            {commentScan.isScanning ? (
              <div style={{
                padding: '40px 20px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '20px',
                flex: 1
              }}>
                <div className="refresh-spinning" style={{ color: '#10B981', display: 'flex', alignItems: 'center' }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M12 6V2"></path>
                    <path d="M12 22v-4"></path>
                    <path d="M6 12H2"></path>
                    <path d="M22 12h-4"></path>
                  </svg>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <h4 style={{ margin: 0, color: '#fff', fontSize: '15px', fontWeight: '700' }}>Gönderi Yorumları Taranıyor...</h4>
                  <p style={{ margin: '6px 0 0 0', color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>
                    Taranan yorum sayısı: <strong style={{ color: '#10B981' }}>{commentScan.totalCommentsScanned}</strong>
                  </p>
                  <p style={{ margin: '4px 0 0 0', color: 'rgba(255,255,255,0.3)', fontSize: '11px' }}>
                    Lütfen pencereyi kapatmayın, tarama biraz sürebilir.
                  </p>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                {/* Stats overview */}
                <div style={{
                  padding: '14px 20px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)' }}>
                    Toplam Taranan Yorum: <strong style={{ color: '#fff' }}>{commentScan.totalCommentsScanned}</strong>
                  </span>
                  
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {commentScanTab === 'unmatched' && commentScan.unmatched.length > 0 && (
                      <>
                        <button
                          onClick={() => {
                            const usernames = commentScan.unmatched.map(u => `@${u.username}`).join('\n');
                            navigator.clipboard.writeText(usernames);
                            alert('Yorum yapmayanların kullanıcı adları kopyalandı!');
                          }}
                          style={{
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '6px',
                            color: '#fff',
                            padding: '4px 8px',
                            fontSize: '11px',
                            fontWeight: '700',
                            cursor: 'pointer',
                            transition: 'background 0.2s'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'}
                        >
                          Kullanıcı Adlarını Kopyala
                        </button>

                        <button
                          onClick={() => handleStartBulkDm(commentScan.unmatched)}
                          style={{
                            background: 'rgba(16, 185, 129, 0.1)',
                            border: '1px solid rgba(16, 185, 129, 0.2)',
                            borderRadius: '6px',
                            color: '#10B981',
                            padding: '4px 8px',
                            fontSize: '11px',
                            fontWeight: '700',
                            cursor: 'pointer',
                            transition: 'background 0.2s'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(16, 185, 129, 0.2)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(16, 185, 129, 0.1)'}
                        >
                          Eksik Kişilere DM At
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Tabs selection */}
                <div style={{
                  display: 'flex',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                  background: 'rgba(0, 0, 0, 0.1)'
                }}>
                  <button
                    onClick={() => setCommentScanTab('matched')}
                    style={{
                      flex: 1,
                      padding: '12px 0',
                      background: 'none',
                      border: 'none',
                      borderBottom: commentScanTab === 'matched' ? '2px solid #10B981' : '2px solid transparent',
                      color: commentScanTab === 'matched' ? '#10B981' : 'rgba(255, 255, 255, 0.4)',
                      fontSize: '13px',
                      fontWeight: '700',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    Yorum Yapanlar ({commentScan.matched.length})
                  </button>
                  <button
                    onClick={() => setCommentScanTab('unmatched')}
                    style={{
                      flex: 1,
                      padding: '12px 0',
                      background: 'none',
                      border: 'none',
                      borderBottom: commentScanTab === 'unmatched' ? '2px solid #EF4444' : '2px solid transparent',
                      color: commentScanTab === 'unmatched' ? '#EF4444' : 'rgba(255, 255, 255, 0.4)',
                      fontSize: '13px',
                      fontWeight: '700',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    Yorum Yapmayanlar ({commentScan.unmatched.length})
                  </button>
                </div>

                {/* Results list */}
                <div style={{
                  padding: '16px 20px',
                  overflowY: 'auto',
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  minHeight: '200px',
                  maxHeight: '350px'
                }} className="custom-scrollbox">
                  {commentScanTab === 'matched' ? (
                    commentScan.matched.map((item, idx) => (
                      <div 
                        key={item.member.id || idx}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '8px',
                          padding: '12px',
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                          borderRadius: '10px'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <img
                              src={item.member.profile_pic_url || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"}
                              alt={item.member.username}
                              style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover' }}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontSize: '12px', fontWeight: '700', color: '#fff' }}>
                                {item.member.full_name || item.member.username}
                              </span>
                              <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)' }}>
                                @{item.member.username}
                              </span>
                            </div>
                          </div>
                          <a
                            href={`https://instagram.com/${item.member.username}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: '11px', color: '#10B981', textDecoration: 'none', fontWeight: '700' }}
                          >
                            Profile Git
                          </a>
                        </div>
                        <div style={{
                          background: 'rgba(16, 185, 129, 0.08)',
                          border: '1px solid rgba(16, 185, 129, 0.15)',
                          padding: '8px 10px',
                          borderRadius: '8px',
                          fontSize: '12px',
                          color: 'rgba(255, 255, 255, 0.95)',
                          lineHeight: '1.4'
                        }}>
                          {item.comment}
                        </div>
                      </div>
                    ))
                  ) : (
                    commentScan.unmatched.map((member, idx) => (
                      <div 
                        key={member.id || idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 12px',
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                          borderRadius: '10px'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <img
                            src={member.profile_pic_url || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"}
                            alt={member.username}
                            style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: '12px', fontWeight: '700', color: '#fff' }}>
                              {member.full_name || member.username}
                            </span>
                            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)' }}>
                              @{member.username}
                            </span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{
                            fontSize: '9px',
                            background: 'rgba(239, 68, 68, 0.15)',
                            color: '#EF4444',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontWeight: '700'
                          }}>
                            Yorum Yapmadı
                          </span>
                          <a
                            href={`https://instagram.com/${member.username}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: '11px',
                              color: 'rgba(255,255,255,0.5)',
                              textDecoration: 'none',
                              fontWeight: '700',
                              padding: '4px 8px',
                              background: 'rgba(255,255,255,0.05)',
                              borderRadius: '4px'
                            }}
                          >
                            Profile Git
                          </a>
                        </div>
                      </div>
                    ))
                  )}

                  {commentScanTab === 'matched' && commentScan.matched.length === 0 && (
                    <div style={{ padding: '30px 0', textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '13px' }}>
                      Gruptan yorum yapan üye bulunamadı.
                    </div>
                  )}
                  {commentScanTab === 'unmatched' && commentScan.unmatched.length === 0 && (
                    <div style={{ padding: '30px 0', textAlign: 'center', color: '#10B981', fontSize: '13px', fontWeight: '700' }}>
                      Harika! Gruptaki herkes yorum yapmış. 🎉
                    </div>
                  )}
                </div>

                {/* Modal Footer */}
                <div style={{
                  padding: '16px 20px',
                  borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  justifyContent: 'flex-end',
                  background: 'rgba(0, 0, 0, 0.1)'
                }}>
                  <button
                    onClick={() => setCommentScan(prev => ({ ...prev, isOpen: false }))}
                    style={{
                      background: 'var(--accent-glow-primary, #10B981)',
                      border: 'none',
                      borderRadius: '8px',
                      color: '#fff',
                      padding: '8px 16px',
                      fontSize: '13px',
                      fontWeight: '700',
                      cursor: 'pointer',
                      transition: 'opacity 0.2s'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                    onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                  >
                    Kapat
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* Likes Scan Modal */}
      {likeScan.isOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10001,
        }} onClick={() => {
          if (!likeScan.isScanning) {
            setLikeScan(prev => ({ ...prev, isOpen: false }));
          }
        }}>
          
          <div style={{
            background: '#1c1c1e',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            width: '480px',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
            overflow: 'hidden'
          }} onClick={(e) => e.stopPropagation()}>
            
            {/* Modal Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <span style={{ fontSize: '16px', fontWeight: '700', color: '#fff' }}>
                {likeScan.scanType === 'participation' ? 'Grup Beğeni Katılım Analizi (Dün Paylaşanlar)' : 'Grup Beğeni Eşleşme Analizi'}
              </span>
              {!likeScan.isScanning && (
                <button 
                  onClick={() => setLikeScan(prev => ({ ...prev, isOpen: false }))}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'rgba(255, 255, 255, 0.6)',
                    cursor: 'pointer',
                    padding: '4px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              )}
            </div>

            {/* Modal Body */}
            {likeScan.isScanning ? (
              <div style={{
                padding: '40px 20px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '20px',
                flex: 1
              }}>
                <div className="refresh-spinning" style={{ color: '#EC4899', display: 'flex', alignItems: 'center' }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M12 6V2"></path>
                    <path d="M12 22v-4"></path>
                    <path d="M6 12H2"></path>
                    <path d="M22 12h-4"></path>
                  </svg>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <h4 style={{ margin: 0, color: '#fff', fontSize: '15px', fontWeight: '700' }}>Gönderiyi Beğenenler Taranıyor...</h4>
                  <p style={{ margin: '6px 0 0 0', color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>
                    Lütfen pencereyi kapatmayın, tarama biraz sürebilir.
                  </p>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                {/* Stats overview */}
                <div style={{
                  padding: '14px 20px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)' }}>
                    Toplam Beğenen Sayısı: <strong style={{ color: '#fff' }}>{likeScan.totalLikesScanned}</strong>
                  </span>
                  
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {likeScanTab === 'unmatched' && likeScan.unmatched.length > 0 && (
                      <>
                        <button
                          onClick={() => {
                            const usernames = likeScan.unmatched.map(u => `@${u.username}`).join('\n');
                            navigator.clipboard.writeText(usernames);
                            alert('Beğenmeyenlerin kullanıcı adları kopyalandı!');
                          }}
                          style={{
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '6px',
                            color: '#fff',
                            padding: '4px 8px',
                            fontSize: '11px',
                            fontWeight: '700',
                            cursor: 'pointer',
                            transition: 'background 0.2s'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'}
                        >
                          Kullanıcı Adlarını Kopyala
                        </button>

                        <button
                          onClick={() => handleStartBulkDm(likeScan.unmatched)}
                          style={{
                            background: 'rgba(16, 185, 129, 0.1)',
                            border: '1px solid rgba(16, 185, 129, 0.2)',
                            borderRadius: '6px',
                            color: '#10B981',
                            padding: '4px 8px',
                            fontSize: '11px',
                            fontWeight: '700',
                            cursor: 'pointer',
                            transition: 'background 0.2s'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(16, 185, 129, 0.2)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(16, 185, 129, 0.1)'}
                        >
                          Eksik Kişilere DM At
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Tabs selection */}
                <div style={{
                  display: 'flex',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                  background: 'rgba(0, 0, 0, 0.1)'
                }}>
                  <button
                    onClick={() => setLikeScanTab('matched')}
                    style={{
                      flex: 1,
                      padding: '12px 0',
                      background: 'none',
                      border: 'none',
                      borderBottom: likeScanTab === 'matched' ? '2px solid #EC4899' : '2px solid transparent',
                      color: likeScanTab === 'matched' ? '#EC4899' : 'rgba(255, 255, 255, 0.4)',
                      fontSize: '13px',
                      fontWeight: '700',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    Beğenenler ({likeScan.matched.length})
                  </button>
                  <button
                    onClick={() => setLikeScanTab('unmatched')}
                    style={{
                      flex: 1,
                      padding: '12px 0',
                      background: 'none',
                      border: 'none',
                      borderBottom: likeScanTab === 'unmatched' ? '2px solid #EF4444' : '2px solid transparent',
                      color: likeScanTab === 'unmatched' ? '#EF4444' : 'rgba(255, 255, 255, 0.4)',
                      fontSize: '13px',
                      fontWeight: '700',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    Beğenmeyenler ({likeScan.unmatched.length})
                  </button>
                </div>

                {/* Results list */}
                <div style={{
                  padding: '16px 20px',
                  overflowY: 'auto',
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  minHeight: '200px',
                  maxHeight: '350px'
                }} className="custom-scrollbox">
                  {likeScanTab === 'matched' ? (
                    likeScan.matched.map((member, idx) => (
                      <div 
                        key={member.id || idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 12px',
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                          borderRadius: '10px'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <img
                            src={member.profile_pic_url || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"}
                            alt={member.username}
                            style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: '12px', fontWeight: '700', color: '#fff' }}>
                              {member.full_name || member.username}
                            </span>
                            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)' }}>
                              @{member.username}
                            </span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{
                            fontSize: '9px',
                            background: 'rgba(236, 72, 153, 0.15)',
                            color: '#EC4899',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontWeight: '700'
                          }}>
                            Beğendi ❤️
                          </span>
                          <a
                            href={`https://instagram.com/${member.username}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: '11px',
                              color: 'rgba(255,255,255,0.5)',
                              textDecoration: 'none',
                              fontWeight: '700',
                              padding: '4px 8px',
                              background: 'rgba(255,255,255,0.05)',
                              borderRadius: '4px'
                            }}
                          >
                            Profile Git
                          </a>
                        </div>
                      </div>
                    ))
                  ) : (
                    likeScan.unmatched.map((member, idx) => (
                      <div 
                        key={member.id || idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 12px',
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                          borderRadius: '10px'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <img
                            src={member.profile_pic_url || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"}
                            alt={member.username}
                            style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: '12px', fontWeight: '700', color: '#fff' }}>
                              {member.full_name || member.username}
                            </span>
                            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)' }}>
                              @{member.username}
                            </span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{
                            fontSize: '9px',
                            background: 'rgba(239, 68, 68, 0.15)',
                            color: '#EF4444',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontWeight: '700'
                          }}>
                            Beğenmedi ❌
                          </span>
                          <a
                            href={`https://instagram.com/${member.username}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: '11px',
                              color: 'rgba(255,255,255,0.5)',
                              textDecoration: 'none',
                              fontWeight: '700',
                              padding: '4px 8px',
                              background: 'rgba(255,255,255,0.05)',
                              borderRadius: '4px'
                            }}
                          >
                            Profile Git
                          </a>
                        </div>
                      </div>
                    ))
                  )}

                  {likeScanTab === 'matched' && likeScan.matched.length === 0 && (
                    <div style={{ padding: '30px 0', textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '13px' }}>
                      Gruptan beğenen üye bulunamadı.
                    </div>
                  )}
                  {likeScanTab === 'unmatched' && likeScan.unmatched.length === 0 && (
                    <div style={{ padding: '30px 0', textAlign: 'center', color: '#EC4899', fontSize: '13px', fontWeight: '700' }}>
                      Harika! Gruptaki herkes gönderiyi beğenmiş. 🎉
                    </div>
                  )}
                </div>

                {/* Modal Footer */}
                <div style={{
                  padding: '16px 20px',
                  borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  justifyContent: 'flex-end',
                  background: 'rgba(0, 0, 0, 0.1)'
                }}>
                  <button
                    onClick={() => setLikeScan(prev => ({ ...prev, isOpen: false }))}
                    style={{
                      background: '#EC4899',
                      border: 'none',
                      borderRadius: '8px',
                      color: '#fff',
                      padding: '8px 16px',
                      fontSize: '13px',
                      fontWeight: '700',
                      cursor: 'pointer',
                      transition: 'opacity 0.2s'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                    onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                  >
                    Kapat
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* Group Details Modal */}
      {isGroupDetailsModalOpen && activeThread && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
        }} onClick={() => setIsGroupDetailsModalOpen(false)}>
          
          <div style={{
            background: '#1c1c1e',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            width: '450px',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
            overflow: 'hidden'
          }} onClick={(e) => e.stopPropagation()}>
            
            {/* Modal Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <span style={{ fontSize: '16px', fontWeight: '700', color: '#fff' }}>Grup Detayları</span>
              <button 
                onClick={() => setIsGroupDetailsModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255, 255, 255, 0.6)',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            {/* Modal Content */}
            <div style={{ padding: '20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              {/* Avatar and Group Name */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                {chatHeaderAvatar ? (
                  <img
                    src={chatHeaderAvatar}
                    alt={activeThread.thread_title}
                    style={{
                      width: '80px',
                      height: '80px',
                      borderRadius: '50%',
                      objectFit: 'cover',
                      border: '1px solid rgba(255,255,255,0.15)',
                      boxShadow: '0 8px 16px rgba(0,0,0,0.3)'
                    }}
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80";
                    }}
                  />
                ) : (
                  <div style={{
                    width: '80px',
                    height: '80px',
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'rgba(255,255,255,0.8)',
                    boxShadow: '0 8px 16px rgba(0,0,0,0.3)'
                  }}>
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                      <circle cx="9" cy="7" r="4"></circle>
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                    </svg>
                  </div>
                )}
                
                <div style={{ textAlign: 'center' }}>
                  <h3 style={{ margin: 0, fontSize: '20px', fontWeight: '800', color: '#fff' }}>{activeThread.thread_title}</h3>
                  <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'rgba(255,255,255,0.5)' }}>{activeThread.users?.length || 0} üye</p>
                </div>
              </div>

              {/* Group Metadata Info Card */}
              <div style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.05)',
                borderRadius: '12px',
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', fontWeight: '600' }}>GRUP ID</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '12px', fontFamily: 'monospace', color: 'rgba(255,255,255,0.8)' }}>
                      {activeThread.id || activeThread.thread_fbid || activeThread.thread_id}
                    </span>
                    <button 
                      onClick={() => {
                        const idStr = String(activeThread.id || activeThread.thread_fbid || activeThread.thread_id);
                        navigator.clipboard.writeText(idStr);
                        alert('Grup ID kopyalandı!');
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#0095f6',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: '700',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0, 149, 246, 0.1)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                    >
                      Kopyala
                    </button>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '10px' }}>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', fontWeight: '600' }}>AÇIKLAMA</span>
                  <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', fontStyle: 'italic' }}>
                    Bu bir Instagram Grup Sohbetidir.
                  </span>
                </div>
              </div>

              {/* Members Search & List Section */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '13px', fontWeight: '700', color: 'rgba(255,255,255,0.8)' }}>Grup Üyeleri</span>
                </div>

                {/* Search Input */}
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    placeholder="Üyelerde ara..."
                    value={memberSearchQuery}
                    onChange={(e) => setMemberSearchQuery(e.target.value)}
                    style={{
                      width: '100%',
                      background: '#262628',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '8px',
                      padding: '8px 12px 8px 34px',
                      color: '#fff',
                      fontSize: '13px',
                      outline: 'none'
                    }}
                  />
                  <svg 
                    style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.3)' }}
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  >
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                  </svg>
                </div>

                {/* Members List Scrollbox */}
                <div style={{
                  maxHeight: '260px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  paddingRight: '4px'
                }} className="custom-scrollbox">
                  {filteredMembers.map((member, idx) => {
                    const isViewer = !!(member as any).is_viewer;
                    const memberId = member.id || member.interop_messaging_user_fbid;
                    const isAdmin = activeThread.admin_user_ids?.some(
                      (adminId: any) => String(adminId) === String(memberId)
                    ) || false;
                    return (
                      <div 
                        key={member.id || idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 10px',
                          borderRadius: '8px',
                          transition: 'background 0.2s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <img
                            src={member.profile_pic_url || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"}
                            alt={member.username}
                            style={{
                              width: '36px',
                              height: '36px',
                              borderRadius: '50%',
                              objectFit: 'cover',
                              border: '1px solid rgba(255,255,255,0.08)'
                            }}
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80";
                            }}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <span style={{ fontSize: '13px', fontWeight: '700', color: '#fff' }}>
                                {member.full_name || member.username}
                              </span>
                              {!isViewer && member.is_verified && (
                                <span style={{ color: '#0095f6', display: 'flex', alignItems: 'center' }}>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"></path>
                                  </svg>
                                </span>
                              )}
                               {isViewer && (
                                <span style={{
                                  fontSize: '10px',
                                  background: 'rgba(255, 255, 255, 0.1)',
                                  color: 'rgba(255, 255, 255, 0.6)',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  fontWeight: '600'
                                }}>
                                  Sen
                                </span>
                              )}
                              {isAdmin && (
                                <span style={{
                                  fontSize: '10px',
                                  background: 'rgba(243, 156, 18, 0.15)',
                                  color: '#f39c12',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  fontWeight: '700',
                                  display: 'inline-flex',
                                  alignItems: 'center'
                                }}>
                                  Yönetici
                                </span>
                              )}
                            </div>
                            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
                              @{member.username}
                            </span>
                          </div>
                        </div>

                        {!isViewer && member.username && (
                          <a
                            href={`https://instagram.com/${member.username}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: '12px',
                              color: '#0095f6',
                              textDecoration: 'none',
                              fontWeight: '700',
                              padding: '4px 10px',
                              borderRadius: '4px',
                              background: 'rgba(0, 149, 246, 0.08)',
                              transition: 'all 0.2s'
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = 'rgba(0, 149, 246, 0.15)';
                              e.currentTarget.style.color = '#3897f0';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = 'rgba(0, 149, 246, 0.08)';
                              e.currentTarget.style.color = '#0095f6';
                            }}
                          >
                            Profile Git
                          </a>
                        )}
                      </div>
                    );
                  })}
                  {filteredMembers.length === 0 && (
                    <div style={{ padding: '20px 0', textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '13px' }}>
                      Üye bulunamadı.
                    </div>
                  )}
                </div>
              </div>

            </div>

          </div>
        </div>
      )}

      {/* User List Modal */}
      {userListModal.isOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10001,
          background: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            width: '420px',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          }}>
            {/* Modal Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#fff' }}>
                {userListModal.type === 'comments' ? 'Yorum Yapanlar' : 'Beğenenler'}
              </h3>
              <button 
                onClick={() => setUserListModal(prev => ({ ...prev, isOpen: false }))}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255,255,255,0.5)',
                  fontSize: '20px',
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                &times;
              </button>
            </div>

            {/* Sort Options Pill Bar for Comments */}
            {userListModal.type === 'comments' && (
              <div style={{
                display: 'flex',
                gap: '8px',
                padding: '10px 20px',
                borderBottom: '1px solid rgba(255,255,255,0.05)',
                background: 'rgba(0,0,0,0.08)'
              }}>
                {[
                  { value: 'recent', label: 'En Yeniler' },
                  { value: 'meta_verified', label: 'Mavi Tikliler' },
                  { value: 'default', label: 'Popülerler' }
                ].map(opt => {
                  const isActive = commentsSortOrder === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setCommentsSortOrder(opt.value);
                        handleFetchUserData('comments', opt.value);
                      }}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '20px',
                        fontSize: '11px',
                        fontWeight: '700',
                        border: 'none',
                        cursor: 'pointer',
                        background: isActive ? '#fff' : 'rgba(255,255,255,0.05)',
                        color: isActive ? '#000' : 'rgba(255,255,255,0.6)',
                        transition: 'all 0.2s'
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Modal Content */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              padding: '12px 20px',
              minHeight: '200px',
              display: 'flex',
              flexDirection: 'column',
            }}>
              {userListModal.isLoading ? (
                <div style={{ display: 'flex', flex: 1, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', color: 'rgba(255,255,255,0.5)', margin: 'auto 0' }}>
                  <div style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,0.1)',
                    borderTopColor: '#fff',
                    animation: 'spin 1s linear infinite'
                  }}></div>
                  <span style={{ fontSize: '13px' }}>Veriler yükleniyor...</span>
                </div>
              ) : userListModal.users.length === 0 ? (
                <div style={{ display: 'flex', flex: 1, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.4)', margin: 'auto 0' }}>
                  <span style={{ fontSize: '13px' }}>Herhangi bir veri bulunamadı.</span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' }}>
                  {userListModal.users.map((user: any, index: number) => (
                    <div key={index} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '8px 10px',
                      borderRadius: '8px',
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.03)'
                    }}>
                      {/* Avatar with fallback background */}
                      <div style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '50%',
                        background: 'rgba(255, 255, 255, 0.1)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        flexShrink: 0,
                        border: '1px solid rgba(255,255,255,0.1)',
                        position: 'relative'
                      }}>
                        {/* Default user SVG icon shown as fallback */}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" style={{ position: 'absolute' }}>
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                          <circle cx="12" cy="7" r="4"></circle>
                        </svg>
                        
                        {user.profilePicUrl && (
                          <img 
                            src={user.profilePicUrl} 
                            alt=""
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                              position: 'relative',
                              zIndex: 1
                            }}
                          />
                        )}
                      </div>
                      
                      {/* User Info & Text */}
                      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: '700', fontSize: '13px', color: '#fff' }}>
                          @{user.username}
                        </span>
                        {userListModal.type === 'comments' ? (
                          <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: '2px' }}>
                            {user.text}
                          </span>
                        ) : (
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
                            {user.fullName || 'Instagram Kullanıcısı'}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  
                  {/* Load More Button for Pagination */}
                  {userListModal.hasNextPage && (
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '12px', paddingBottom: '8px' }}>
                      {userListModal.isLoadingMore ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'rgba(255,255,255,0.4)', fontSize: '12px' }}>
                          <div style={{
                            width: '16px',
                            height: '16px',
                            borderRadius: '50%',
                            border: '2px solid rgba(255,255,255,0.1)',
                            borderTopColor: '#fff',
                            animation: 'spin 1s linear infinite'
                          }}></div>
                          <span>Daha fazlası yükleniyor...</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleFetchUserData(userListModal.type, undefined, true)}
                          style={{
                            padding: '6px 16px',
                            borderRadius: '15px',
                            background: 'rgba(255,255,255,0.06)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            color: '#fff',
                            fontSize: '11px',
                            fontWeight: '600',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(255,255,255,0.12)';
                            e.currentTarget.style.transform = 'scale(1.02)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                            e.currentTarget.style.transform = 'scale(1)';
                          }}
                        >
                          Daha Fazla Yükle
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            
            {/* Modal Footer */}
            <div style={{
              padding: '12px 20px',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              justifyContent: 'flex-end',
              background: 'rgba(0,0,0,0.1)'
            }}>
              <button 
                onClick={() => setUserListModal(prev => ({ ...prev, isOpen: false }))}
                style={{
                  padding: '8px 16px',
                  background: 'rgba(255,255,255,0.08)',
                  border: 'none',
                  color: '#fff',
                  fontSize: '12px',
                  fontWeight: '600',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.12)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
              >
                Kapat
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
