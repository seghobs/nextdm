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
          },
          // PRESERVE REPLY ATTRIBUTES
          reply_to_message: eNode.reply_to_message || node.reply_to_message || null,
          client_context: eNode.client_context || node.client_context || null
        };
        foundDuplicate = true;
        break;
      }
      
      // If one is temporary and they have the same/very close timestamp and text
      const timeDiff = Math.abs(eTs - nodeTs);
      if (timeDiff < 2000 && eText === nodeText) {
        // If the existing one is temporary, and current is official, upgrade the existing one to official ID
        if (!eNode.id.startsWith('mid.$') && node.id.startsWith('mid.$')) {
          existingEdge.node = {
            ...node,
            // PRESERVE REPLY ATTRIBUTES
            reply_to_message: eNode.reply_to_message || node.reply_to_message || null,
            client_context: eNode.client_context || node.client_context || null
          };
        }
        foundDuplicate = true;
        break;
      }

      // If they have different IDs but same sender and close timestamp, check if one is media share and other is link/fallback text
      if (String(eNode.sender_fbid) === String(node.sender_fbid) && timeDiff < 6000) {
        const nodeHasMedia = !!node.media_preview_url || (node.media_type && node.media_type !== 'text') || ['clip', 'media_share', 'story_share'].includes(node.media_type || '');
        const eNodeHasMedia = !!eNode.media_preview_url || (eNode.media_type && eNode.media_type !== 'text') || ['clip', 'media_share', 'story_share'].includes(eNode.media_type || '');
        
        const isOneLinkOrFallback = eText.includes('instagram.com') || eText === 'Yeni bir mesaj' || eText === 'Yeni bir mesaj gönderildi.' || eText === '';
        const isOtherLinkOrFallback = nodeText.includes('instagram.com') || nodeText === 'Yeni bir mesaj' || nodeText === 'Yeni bir mesaj gönderildi.' || nodeText === '';

        if ((nodeHasMedia && isOneLinkOrFallback) || (eNodeHasMedia && isOtherLinkOrFallback)) {
          const preferredForMedia = nodeHasMedia ? node : eNode;
          const fallbackForMedia = nodeHasMedia ? eNode : node;

          existingEdge.node = {
            ...fallbackForMedia,
            ...preferredForMedia,
            id: preferredForMedia.id || fallbackForMedia.id,
            text_body: (preferredForMedia.text_body || '').trim() === 'Yeni bir mesaj' || (preferredForMedia.text_body || '').trim() === 'Yeni bir mesaj gönderildi.' ? '' : (preferredForMedia.text_body || ''),
            igd_snippet: (preferredForMedia.igd_snippet || '').trim() === 'Yeni bir mesaj' || (preferredForMedia.igd_snippet || '').trim() === 'Yeni bir mesaj gönderildi.' ? '' : (preferredForMedia.igd_snippet || ''),
            reactions: eNode.reactions || node.reactions || null,
            reply_to_message: eNode.reply_to_message || node.reply_to_message || null,
            client_context: eNode.client_context || node.client_context || null
          };
          foundDuplicate = true;
          break;
        }
      }
    }

    if (!foundDuplicate) {
      result.push(edge);
    }
  }

  return result;
};

// Helper to normalize emojis by removing variation selectors for stable comparison
const normalizeEmoji = (emoji: string) => {
  if (!emoji) return '';
  return emoji.replace(/[\ufe00-\ufe0f]/g, '').trim();
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

const VoiceMessagePlayer = ({ audioUrl, sent }: { audioUrl: string; sent: boolean }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0 to 100
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const getPlayableUrl = () => {
    if (!audioUrl) return '';
    if (audioUrl.startsWith('blob:') || audioUrl.startsWith('data:')) {
      return audioUrl;
    }
    const params = new URLSearchParams();
    params.append('url', audioUrl);
    if (typeof window !== 'undefined') {
      const savedCookies = localStorage.getItem('ig_cookies');
      const savedHeaders = localStorage.getItem('ig_headers');
      if (savedCookies) params.append('cookies', savedCookies);
      if (savedHeaders) params.append('headers', savedHeaders);
    }
    return `/api/instagram/proxy_audio?${params.toString()}`;
  };

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, [audioUrl]);

  const handlePlayPause = () => {
    if (!audioRef.current) {
      const playable = getPlayableUrl();
      const audio = new Audio(playable);
      audio.addEventListener('timeupdate', () => {
        setCurrentTime(audio.currentTime);
        setProgress((audio.currentTime / (audio.duration || 1)) * 100);
      });
      audio.addEventListener('loadedmetadata', () => {
        setDuration(audio.duration);
      });
      audio.addEventListener('ended', () => {
        setIsPlaying(false);
        setProgress(0);
        setCurrentTime(0);
      });
      audioRef.current = audio;
    }

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(err => console.error('Audio play error:', err));
      setIsPlaying(true);
    }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Generate 25 visual bars for the waveform
  const barHeights = [
    30, 50, 40, 60, 30, 70, 80, 50, 40, 60,
    90, 40, 30, 50, 70, 60, 40, 80, 50, 30,
    60, 40, 70, 50, 30
  ];

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '8px 12px',
      borderRadius: '16px',
      background: sent ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,255,255,0.08)',
      minWidth: '240px',
      maxWidth: '300px',
      userSelect: 'none',
      margin: '4px 0'
    }}>
      {/* Play/Pause Button */}
      <button 
        type="button"
        onClick={handlePlayPause}
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '50%',
          backgroundColor: '#fff',
          color: '#000',
          border: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
          boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
          transition: 'transform 0.1s ease'
        }}
        onMouseDown={e => e.currentTarget.style.transform = 'scale(0.95)'}
        onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
      >
        {isPlaying ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="4" height="16"></rect>
            <rect x="16" y="4" width="4" height="16"></rect>
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: '2px' }}>
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        )}
      </button>

      {/* Waveform Visualization & Timer */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '4px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', height: '24px', width: '100%' }}>
          {barHeights.map((h, i) => {
            const barProgress = (i / barHeights.length) * 100;
            const isActive = progress > barProgress;
            return (
              <div 
                key={i} 
                style={{
                  flex: 1,
                  height: `${h * 0.2}px`,
                  borderRadius: '1.5px',
                  backgroundColor: isActive 
                    ? '#fff' 
                    : 'rgba(255,255,255,0.25)',
                  transition: 'background-color 0.15s ease'
                }}
              />
            );
          })}
        </div>
        
        {/* Timer display */}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'rgba(255,255,255,0.5)' }}>
          <span>{formatTime(currentTime)}</span>
          <span>{duration ? formatTime(duration) : '0:00'}</span>
        </div>
      </div>
    </div>
  );
};

const getSeenUsersForMessage = (msg: InstagramMessage, thread: InstagramThread) => {
  if (!thread.users || thread.users.length === 0) return [];
  if (!thread.participant_watermarks) return [];

  const messages = thread.slide_messages?.edges?.map(e => e.node) || [];
  if (messages.length === 0) return [];

  const sortedMsgs = [...messages].sort((a, b) => Number(a.timestamp_ms) - Number(b.timestamp_ms));
  const msgId = msg.id;
  
  const seenUsers = thread.users.filter(u => {
    const uId = String(u.id || u.pk || u.interop_messaging_user_fbid);
    const watermarkStr = thread.participant_watermarks?.[uId];
    if (!watermarkStr) return false;

    const watermark = Number(watermarkStr);
    
    let lastReadMsg: InstagramMessage | null = null;
    for (let i = sortedMsgs.length - 1; i >= 0; i--) {
      const m = sortedMsgs[i];
      if (Number(m.timestamp_ms) <= watermark) {
        lastReadMsg = m;
        break;
      }
    }

    return lastReadMsg && lastReadMsg.id === msgId;
  });

  return seenUsers;
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
  const [seenListModal, setSeenListModal] = useState<{ visible: boolean; users: InstagramUser[] }>({ visible: false, users: [] });
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
    message: InstagramMessage | null;
  }
  const [msgContextMenu, setMsgContextMenu] = useState<MsgContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    messageId: '',
    text: '',
    isOwnMessage: false,
    message: null,
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
  const [activeFolder, setActiveFolder] = useState<'PRIMARY' | 'GENERAL' | 'PENDING'>('PRIMARY');
  const [threadErrors, setThreadErrors] = useState<Record<string, string>>({});
  const contextMenuJustOpenedRef = useRef<boolean>(false);

  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchSuccess, setFetchSuccess] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [loginMethod, setLoginMethod] = useState<'curl' | 'credentials' | 'magic_link'>('credentials');
  const [loginCurl, setLoginCurl] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginMagicLink, setLoginMagicLink] = useState('');
  const [isSendingMagicEmail, setIsSendingMagicEmail] = useState(false);
  const [magicEmailFeedback, setMagicEmailFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginFeedback, setLoginFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [typedMessage, setTypedMessage] = useState('');
  const [isForwardModalOpen, setIsForwardModalOpen] = useState(false);
  const [forwardMessageText, setForwardMessageText] = useState('');
  const [forwardSelectedRecipients, setForwardSelectedRecipients] = useState<Record<string, { id: string, name: string, avatar?: string }>>({});
  const [forwardSearchQuery, setForwardSearchQuery] = useState('');
  const [isForwardingInProgress, setIsForwardingInProgress] = useState(false);
  const [forwardSearchResults, setForwardSearchResults] = useState<{ users: any[], threads: any[] }>({ users: [], threads: [] });
  const [isForwardSearching, setIsForwardSearching] = useState(false);
  const [suggestedContacts, setSuggestedContacts] = useState<any[]>([]);
  const [isFetchingSuggested, setIsFetchingSuggested] = useState(false);
  const [isNewMessageModalOpen, setIsNewMessageModalOpen] = useState(false);
  const [newMessageSearchQuery, setNewMessageSearchQuery] = useState('');
  const [newMessageSearchResults, setNewMessageSearchResults] = useState<any[]>([]);
  const [isNewMessageSearching, setIsNewMessageSearching] = useState(false);
  const [isUserProfileModalOpen, setIsUserProfileModalOpen] = useState(false);
  const [userProfileData, setUserProfileData] = useState<any>(null);
  const [isFetchingUserProfile, setIsFetchingUserProfile] = useState(false);
  const [errorModal, setErrorModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: 'error' | 'warning' | 'info';
  }>({
    isOpen: false,
    title: '',
    message: '',
    type: 'error'
  });

  useEffect(() => {
    if (isForwardModalOpen || isNewMessageModalOpen) {
      const fetchSuggested = async () => {
        setIsFetchingSuggested(true);
        try {
          const res = await fetch('/api/instagram/suggested_contacts', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              cookies: cookiesRef.current,
              headers: headersRef.current,
              data: postDataRef.current
            })
          });
          const result = await res.json();
          if (res.ok && result.success) {
            setSuggestedContacts(result.users || []);
          }
        } catch (err) {
          console.error('Error fetching suggested contacts:', err);
        } finally {
          setIsFetchingSuggested(false);
        }
      };
      fetchSuggested();
    }
  }, [isForwardModalOpen, isNewMessageModalOpen]);

  // Debounced Instagram new message search
  useEffect(() => {
    if (!newMessageSearchQuery.trim()) {
      setNewMessageSearchResults([]);
      setIsNewMessageSearching(false);
      return;
    }

    setIsNewMessageSearching(true);

    const delayDebounceFn = setTimeout(async () => {
      try {
        const res = await fetch('/api/instagram/search_forwarding', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            searchText: newMessageSearchQuery,
            cookies: cookiesRef.current,
            headers: headersRef.current,
            data: postDataRef.current
          })
        });

        const result = await res.json();
        if (res.ok && result.success) {
          setNewMessageSearchResults(result.users || []);
        }
      } catch (err) {
        console.error('Error fetching new message search results:', err);
      } finally {
        setIsNewMessageSearching(false);
      }
    }, 400);

    return () => clearTimeout(delayDebounceFn);
  }, [newMessageSearchQuery]);
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
  const [settingsTab, setSettingsTab] = useState<'settings' | 'activities' | 'automation' | 'ai'>('settings');
  const [loginSessions, setLoginSessions] = useState<any[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [isLoggingOutSession, setIsLoggingOutSession] = useState(false);

  // Automation Panel states
  const [autoSettings, setAutoSettings] = useState<{
    enabled: boolean;
    threads: string[];
    check_hours: string[];
    dm_template: string;
    group_report_template: string;
    break_minutes: number;
    dm_delay_seconds: number;
    comment_check_enabled: boolean;
    like_check_enabled: boolean;
    auto_dm_enabled: boolean;
    auto_group_report_enabled: boolean;
    scan_mode: string;
    target_username: string;
    admin_report_enabled: boolean;
    admin_username: string;
    scan_date: string;
    dm_bulk_template: string;
    ai_assistant_enabled: boolean;
    ai_api_key: string;
    ai_model: string;
    ai_system_prompt: string;
    ai_delay_seconds: number;
    exempt_usernames: string;
    threads_config: Record<string, { comment_check_enabled: boolean; like_check_enabled: boolean; admin_report_enabled: boolean; admin_username: string; scan_mode: string }>;
  }>({
    enabled: false,
    threads: [],
    check_hours: ['09:00', '13:00', '17:00', '21:00'],
    dm_template: '',
    group_report_template: '',
    break_minutes: 5,
    dm_delay_seconds: 30,
    comment_check_enabled: true,
    like_check_enabled: true,
    auto_dm_enabled: true,
    auto_group_report_enabled: true,
    scan_mode: 'all',
    target_username: '',
    admin_report_enabled: false,
    admin_username: '',
    scan_date: 'yesterday',
    dm_bulk_template: 'Merhaba {grup_ismi} grubunda eksiğiniz var dönüş yapmanız gerekiyor',
    ai_assistant_enabled: false,
    ai_api_key: '',
    ai_model: 'openrouter/free',
    ai_system_prompt: 'Sen bir Instagram grup otomasyon asistanısın. Üyelerin eksik bildirimlerine ve sorularına nazikçe ve Türkçe cevap ver.',
    ai_delay_seconds: 30,
    exempt_usernames: '',
    threads_config: {}
  });
  const [automationLogs, setAutomationLogs] = useState<any[]>([]);
  const [isLogsLoading, setIsLogsLoading] = useState(false);
  const [isSavingAutomation, setIsSavingAutomation] = useState(false);
  const [isResettingAutomation, setIsResettingAutomation] = useState(false);
  const [isUndoingAutomation, setIsUndoingAutomation] = useState(false);
  const [isTriggeringAutomation, setIsTriggeringAutomation] = useState(false);

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

  // Periodic background inbox sync as a safety fallback in case MQTT drops or lags
  useEffect(() => {
    if (!isLoggedIn) return;

    const interval = setInterval(() => {
      console.log('[Fallback-Sync] Running periodic inbox update...');
      fetchLiveInbox(cookiesRef.current, headersRef.current, postDataRef.current || postData, true);
    }, 25000); // Poll every 25 seconds

    return () => clearInterval(interval);
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

  const getThreadSnippet = (thread: InstagramThread) => {
    const edges = thread.slide_messages?.edges || [];
    if (edges.length === 0) return 'Mesaj yok';

    const sortedEdges = [...edges].sort((a, b) => Number(a.node?.timestamp_ms || 0) - Number(b.node?.timestamp_ms || 0));
    const lastMsgEdge = sortedEdges[sortedEdges.length - 1];
    const lastMsg = lastMsgEdge?.node;
    if (!lastMsg) return 'Mesaj yok';

    let snippet = lastMsg.igd_snippet || lastMsg.text_body || '';

    const senderId = String(lastMsg.sender_fbid || '');
    const viewerId = String(cookies['ds_user_id'] || '');
    const isMe = senderId === viewerId;

    if (thread.is_group) {
      if (isMe) {
        if (!snippet.toLowerCase().startsWith('sen:')) {
          snippet = `Sen: ${snippet}`;
        }
      } else {
        const senderUser = thread.users?.find(u => String(u.id || u.pk || u.interop_messaging_user_fbid) === senderId);
        const displayName = senderUser ? (senderUser.full_name || senderUser.username) : null;
        if (displayName) {
          const startsWithDisplayName = snippet.toLowerCase().startsWith(displayName.toLowerCase());
          const startsWithUsername = senderUser?.username && snippet.toLowerCase().startsWith(senderUser.username.toLowerCase());
          
          if (!startsWithDisplayName && !startsWithUsername) {
            snippet = `${displayName}: ${snippet}`;
          }
        } else if (senderUser?.username) {
          if (!snippet.toLowerCase().startsWith(senderUser.username.toLowerCase())) {
            snippet = `${senderUser.username}: ${snippet}`;
          }
        }
      }
    } else {
      if (isMe && !snippet.toLowerCase().startsWith('sen:')) {
        snippet = `Sen: ${snippet}`;
      }
    }

    return snippet;
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

  // Load thread history when activeThreadId changes
  useEffect(() => {
    if (activeThreadId) {
      const activeT = threads.find(t => t.id === activeThreadId);
      if (activeT) {
        fetchThreadHistory(activeT);
      }
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
  const lastFocusTimeRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep refs updated with current state values
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  // Debounced Instagram forwarding search
  useEffect(() => {
    if (!forwardSearchQuery.trim()) {
      setForwardSearchResults({ users: [], threads: [] });
      setIsForwardSearching(false);
      return;
    }

    setIsForwardSearching(true);

    const delayDebounceFn = setTimeout(async () => {
      try {
        const res = await fetch('/api/instagram/search_forwarding', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            searchText: forwardSearchQuery,
            cookies: cookiesRef.current,
            headers: headersRef.current,
            data: postDataRef.current
          })
        });

        const result = await res.json();
        if (res.ok && result.success) {
          setForwardSearchResults({
            users: result.users || [],
            threads: result.threads || []
          });
        }
      } catch (err) {
        console.error('Error fetching forwarding search results:', err);
      } finally {
        setIsForwardSearching(false);
      }
    }, 400);

    return () => clearTimeout(delayDebounceFn);
  }, [forwardSearchQuery]);

  // Track window focus time to ignore double-clicks that occur to focus the window
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleFocus = () => {
      lastFocusTimeRef.current = Date.now();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Dynamically update document title with unread badge count (IGDBadgeCount simulation)
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const totalUnread = threads.filter(t => t.marked_as_unread).length;
    if (totalUnread > 0) {
      document.title = `(${totalUnread}) Gelen Kutusu • Direct`;
    } else {
      document.title = 'Gelen Kutusu • Direct';
    }
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
            // Trigger instant seen check on backend if message is from partner
            const viewerId = String(cookiesRef.current?.['ds_user_id'] || '');
            const isSentByViewer = String(payload.message.sender_fbid) === viewerId;
            if (!isSentByViewer) {
              fetch('/api/instagram/automation/trigger_seen_instant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threadId: payload.threadId })
              }).catch(err => {
                console.log('[Realtime] Failed to trigger instant auto-seen:', err);
              });
            }

            // Fallback text if both text_body and igd_snippet are empty (e.g., media/link shares)
            const msgText = payload.message.text_body || payload.message.igd_snippet || 'Yeni bir mesaj';
            
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
                    text_body: msgText,
                    igd_snippet: msgText,
                    content_type: payload.message.content_type || 'TEXT',
                    content: {
                      __typename: 'SlideMessageText',
                      text_body: msgText,
                    }
                  };

                  const viewerId = String(thread.viewer?.id || thread.viewer?.viewer_id || cookiesRef.current['ds_user_id'] || '');
                  const isSentByViewer = String(payload.message.sender_fbid) === viewerId;
                  const isCurrentlyActive = activeThreadIdRef.current === thread.id;
                  const markedAsUnread = (isSentByViewer || isCurrentlyActive) ? false : true;

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

          if (payload.threadId) {
            if (fetchTimeoutRef.current) {
              clearTimeout(fetchTimeoutRef.current);
            }

            fetchTimeoutRef.current = setTimeout(() => {
              const activeT = threadsRef.current.find(t => t.id === payload.threadId || t.thread_id === payload.threadId || t.thread_fbid === payload.threadId);
              if (activeT) {
                console.log(`[Realtime] Syncing history only for thread: ${payload.threadId}`);
                fetchThreadHistory(activeT, true);
              } else {
                console.log('[Realtime] New thread received. Refreshing inbox...');
                fetchLiveInbox(cookiesRef.current, headersRef.current, postDataRef.current || postData, true);
              }
            }, 1000);
          }
        } else if (payload.type === 'seen') {
          console.log('[Realtime] Seen receipt received:', payload);
          const rawWatermark = payload.watermark;
          let watermarkMs = '';
          if (rawWatermark) {
            const num = Number(rawWatermark);
            if (num > 10000000000000) {
              watermarkMs = String(Math.floor(num / 1000));
            } else if (num < 10000000000) {
              watermarkMs = String(num * 1000);
            } else {
              watermarkMs = String(num);
            }
          }

          setThreads(prevThreads => {
            return prevThreads.map(thread => {
              const isMatch = thread.id === payload.threadId || 
                              thread.thread_id === payload.threadId || 
                              thread.thread_fbid === payload.threadId;
              if (isMatch) {
                const viewerId = String(cookiesRef.current?.['ds_user_id'] || '');
                const isFromPartner = !payload.userId || String(payload.userId) !== viewerId;
                
                const existingWatermarks = thread.participant_watermarks || {};
                const updatedWatermarks = {
                  ...existingWatermarks,
                  [String(payload.userId || '')]: watermarkMs
                };

                return {
                  ...thread,
                  last_seen_watermark_ms: isFromPartner ? (watermarkMs || thread.last_seen_watermark_ms) : thread.last_seen_watermark_ms,
                  participant_watermarks: updatedWatermarks
                };
              }
              return thread;
            });
          });
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
                  const exists = currentReactions.some((r: any) => String(r.sender_fbid) === String(userId) && normalizeEmoji(r.reaction) === normalizeEmoji(reaction));
                  if (exists) return edge;
                  newReactions = [...currentReactions, {
                    reaction,
                    reaction_timestamp_ms: String(Date.now()),
                    sender_fbid: String(userId)
                  }];
                } else {
                  newReactions = currentReactions.filter((r: any) => !(String(r.sender_fbid) === String(userId) && normalizeEmoji(r.reaction) === normalizeEmoji(reaction)));
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
          console.log('[Realtime] Legacy raw message trigger received. Skipping full inbox sync.');
        } else if (event.data === 'connected') {
          console.log('[Realtime] Live socket bridge connection established.');
        }
      }
    };

    eventSource.onerror = (err) => {
      console.warn('[Realtime] EventSource connection issue. Browser is automatically reconnecting...');
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

    if (threadId.startsWith('temp_')) {
      // Temporary thread has no remote history
      setThreadCursors(prev => ({
        ...prev,
        [threadId]: { oldestCursor: null, hasOlder: false, isLoadingMore: false }
      }));
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
        const errorMsg = result.error || 'Failed to fetch thread history';
        setThreadErrors(prev => ({ ...prev, [threadId]: errorMsg }));
        throw new Error(errorMsg);
      }

      setThreadErrors(prev => {
        const copy = { ...prev };
        delete copy[threadId];
        return copy;
      });

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
          videoUrl = item.voice_media.media?.audio?.audio_src || 
                     item.voice_media.media?.video_versions?.[0]?.url || 
                     null;
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

        let fallbackText = text || item.igd_snippet || (item.item_type ? `[${item.item_type}]` : 'Ek içerik');

        // Rewrite generic "dosya eki" snippets
        if (fallbackText && fallbackText.includes('dosya eki')) {
          const isSentByMe = fallbackText.includes('gönderdin');
          if (mediaType === 'clip') {
            fallbackText = isSentByMe ? fallbackText.replace('bir dosya eki gönderdin.', 'bir reels videosu paylaştın.') 
                                      : fallbackText.replace('bir dosya eki gönderdi.', 'bir reels videosu paylaştı.');
          } else if (mediaType === 'story_share') {
            fallbackText = isSentByMe ? fallbackText.replace('bir dosya eki gönderdin.', 'bir hikaye paylaştın.') 
                                      : fallbackText.replace('bir dosya eki gönderdi.', 'bir hikaye paylaştı.');
          } else {
            fallbackText = isSentByMe ? fallbackText.replace('bir dosya eki gönderdin.', 'bir gönderi paylaştın.') 
                                      : fallbackText.replace('bir dosya eki gönderdi.', 'bir gönderi paylaştı.');
          }
        }

        const rawReplied = item.replied_to_message || item.reply_to_message;
        const repliedMessage = rawReplied ? {
          id: rawReplied.item_id || rawReplied.message_id || '',
          text_body: rawReplied.text || 'Mesaj',
          sender_fbid: rawReplied.user_id,
          content_type: rawReplied.item_type === 'text' ? 'TEXT' : 'ATTACHMENT'
        } : null;

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
          reactions: mappedReactions,
          reply_to_message: repliedMessage,
          client_context: item.client_context || null
        };
      });

      // Merge messages into threads state
      setThreads(prevThreads => {
        return prevThreads.map(t => {
          if (t.id === threadId) {
            const existingEdges = force ? [] : (t.slide_messages?.edges || []);
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

            const participantWatermarks: Record<string, string> = {};
            if (result.last_seen_at && typeof result.last_seen_at === 'object') {
              Object.entries(result.last_seen_at).forEach(([uId, seenObj]: [string, any]) => {
                if (seenObj?.timestamp) {
                  const num = Number(seenObj.timestamp);
                  let ms = String(num);
                  if (num > 10000000000000) {
                    ms = String(Math.floor(num / 1000));
                  } else if (num < 10000000000) {
                    ms = String(num * 1000);
                  }
                  participantWatermarks[uId] = ms;
                }
              });
            }

            return {
              ...t,
              users: mergeThreadUsers(t.users || [], result.users || []),
              admin_user_ids: result.admin_user_ids || t.admin_user_ids || [],
              last_seen_watermark_ms: partnerWatermark || t.last_seen_watermark_ms,
              participant_watermarks: {
                ...(t.participant_watermarks || {}),
                ...participantWatermarks
              },
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
      const targetUrl = xmaContent.target_url || '';
      const isReel = targetUrl.includes('/reel/') || targetUrl.includes('/reels/');
      const isStory = targetUrl.includes('/stories/') || targetUrl.includes('/story/');
      const isPost = targetUrl.includes('/p/') || targetUrl.includes('/tv/');
      
      if (isReel) {
        mediaType = 'clip';
      } else if (isStory) {
        mediaType = 'story_share';
      } else if (isPost) {
        mediaType = 'media_share';
      } else {
        const textLower = (xmaContent.title_text || xmaContent.xmaTitle || '').toLowerCase();
        if (textLower.includes('reels') || textLower.includes('reel')) {
          mediaType = 'clip';
        } else if (textLower.includes('story') || textLower.includes('hikaye')) {
          mediaType = 'story_share';
        } else {
          mediaType = 'media_share';
        }
      }

      previewUrl = xmaContent.preview_image?.url || 
                   xmaContent.xmaPreviewImage?.url || 
                   xmaContent.preview_url || 
                   xmaContent.image_url || 
                   null;
                   
      title = xmaContent.title_text || xmaContent.xmaTitle || xmaContent.caption || null;
      author = xmaContent.header_title_text || xmaContent.xmaHeaderTitle || xmaContent.subtitle_text || null;
      mediaId = xmaContent.target_id || null;
      
      const innerMedia = xmaContent.media || xmaContent.xma_media || null;
      if (innerMedia) {
        likeCount = innerMedia.like_count || innerMedia.like_and_view_metadata_dict?.like_count || null;
        commentCount = innerMedia.comment_count || null;
      }
      
      if (!text) {
        const typeLabel = mediaType === 'story_share' ? 'Hikaye' : (mediaType === 'clip' ? 'Reels videosu' : 'Gönderi');
        text = `${typeLabel} paylaştı: ${title || ''}`;
      }
    }

    const cleanSnippetText = (tStr: string, mType: string) => {
      if (!tStr) return tStr;
      if (tStr.includes('dosya eki')) {
        const isSentByMe = tStr.includes('gönderdin');
        if (mType === 'clip') {
          return isSentByMe ? tStr.replace('bir dosya eki gönderdin.', 'bir reels videosu paylaştın.') 
                            : tStr.replace('bir dosya eki gönderdi.', 'bir reels videosu paylaştı.');
        } else if (mType === 'story_share') {
          return isSentByMe ? tStr.replace('bir dosya eki gönderdin.', 'bir hikaye paylaştın.') 
                            : tStr.replace('bir dosya eki gönderdi.', 'bir hikaye paylaştı.');
        } else {
          return isSentByMe ? tStr.replace('bir dosya eki gönderdin.', 'bir gönderi paylaştın.') 
                            : tStr.replace('bir dosya eki gönderdi.', 'bir gönderi paylaştı.');
        }
      }
      return tStr;
    };

    text = cleanSnippetText(text, mediaType);
    const finalIgdSnippet = cleanSnippetText(node.igd_snippet || text, mediaType);

    const repliedMessage = (node.replied_to_message || node.reply_to_message) ? {
      id: (node.replied_to_message || node.reply_to_message).id || (node.replied_to_message || node.reply_to_message).message_id || '',
      text_body: (node.replied_to_message || node.reply_to_message).text_body || (node.replied_to_message || node.reply_to_message).text || 'Mesaj',
      sender_fbid: (node.replied_to_message || node.reply_to_message).sender_fbid,
      content_type: (node.replied_to_message || node.reply_to_message).content_type || 'TEXT'
    } : null;

    return {
      id: node.id || node.message_id,
      sender_fbid: node.sender_fbid,
      timestamp_ms: node.timestamp_ms ? String(node.timestamp_ms) : Date.now().toString(),
      content: {
        __typename: node.content?.__typename || 'SlideMessageText',
        text_body: text
      },
      content_type: node.content_type || 'TEXT',
      igd_snippet: finalIgdSnippet || text,
      text_body: text,
      media_preview_url: previewUrl,
      media_video_url: videoUrl,
      media_title: title,
      media_author: author,
      media_type: mediaType as any,
      media_id: mediaId,
      like_count: likeCount,
      comment_count: commentCount,
      reactions: node.reactions || null,
      reply_to_message: repliedMessage,
      client_context: node.client_context || node.offline_threading_id || null
    };
  };

  // Handle live data fetch
  const fetchLiveInbox = async (
    currentCookies = cookies, 
    currentHeaders = headers, 
    currentData = postData,
    background = false,
    folderOverride?: 'PRIMARY' | 'GENERAL' | 'PENDING'
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
        setThreads([]);
        setFetchError(null);
        setIsFetching(false);
        fetchInProgressRef.current = false;
        return;
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

        const participantWatermarks: Record<string, string> = {};
        try {
          const watermarks = threadDetails.last_read_watermarks?.edges || [];
          watermarks.forEach((w: any) => {
            const memberId = String(w.node?.member_id);
            const ts = w.node?.timestamp_ms;
            if (memberId && ts) {
              const num = Number(ts);
              let ms = String(ts);
              if (num > 10000000000000) {
                ms = String(Math.floor(num / 1000));
              } else if (num < 10000000000) {
                ms = String(num * 1000);
              }
              participantWatermarks[memberId] = ms;
            }
          });
          
          if (threadDetails.users) {
            threadDetails.users.forEach((u: any) => {
              const uId = String(u.id || u.pk || u.interop_messaging_user_fbid);
              if (uId && u.last_read_watermark_timestamp_ms) {
                const ts = u.last_read_watermark_timestamp_ms;
                const num = Number(ts);
                let ms = String(ts);
                if (num > 10000000000000) {
                  ms = String(Math.floor(num / 1000));
                } else if (num < 10000000000) {
                  ms = String(num * 1000);
                }
                if (!participantWatermarks[uId]) {
                  participantWatermarks[uId] = ms;
                }
              }
            });
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
          folder: (threadDetails.system_folder === 'PENDING' || threadDetails.messaging_folder_tag === 'PENDING' || node?.system_folder === 'PENDING' || node?.messaging_folder_tag === 'PENDING') ? 'PENDING' : (threadDetails.folder || node?.folder || folder),
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
          participant_watermarks: participantWatermarks,
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
            if (isCurrentlyActive) {
              markedAsUnread = false;
            } else if (!isLastMsgFromPartner) {
              // If the last message was sent by the viewer, the thread cannot be unread for us
              markedAsUnread = false;
            } else {
              // If the last message is from the partner and it is a new message, mark it as unread
              const existingLastMsg = [...existingEdges].sort((a, b) => {
                const tsA = parseInt(a.node?.timestamp_ms || '0', 10);
                const tsB = parseInt(b.node?.timestamp_ms || '0', 10);
                return tsA - tsB;
              })[existingEdges.length - 1]?.node;
              
              const isNewMessage = !existingLastMsg || parseInt(lastMsg.timestamp_ms || '0', 10) > parseInt(existingLastMsg.timestamp_ms || '0', 10);
              
              if (isNewMessage) {
                markedAsUnread = true;
              } else {
                // Otherwise trust the server's read state
                markedAsUnread = newThread.marked_as_unread;
              }
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
        if (currentId && currentId.startsWith('temp_')) {
          return currentId;
        }
        const exists = liveThreads.some(t => t.id === currentId);
        if (currentId && exists) return currentId;
        return liveThreads[0]?.id || null;
      });
      
      // If we have an active thread, also refresh its history to load rich media previews
      if (activeThreadIdRef.current) {
        const activeT = liveThreads.find(t => t.id === activeThreadIdRef.current);
        if (activeT) {
          const existingActiveT = threadsRef.current.find(t => t.id === activeThreadIdRef.current);
          const hasNewActivity = !existingActiveT || activeT.last_activity_timestamp_ms !== existingActiveT.last_activity_timestamp_ms;
          if (!background || hasNewActivity) {
            fetchThreadHistory(activeT, true);
          }
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

  const fetchAutomationSettings = async () => {
    try {
      const res = await fetch('/api/instagram/automation/settings');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.settings) {
          const s = data.settings;
          const configsDict: Record<string, { comment_check_enabled: boolean, like_check_enabled: boolean, admin_report_enabled: boolean, admin_username: string, scan_mode: string }> = {};
          if (data.threads_config && Array.isArray(data.threads_config)) {
            data.threads_config.forEach((cfg: any) => {
              configsDict[cfg.thread_id] = {
                comment_check_enabled: cfg.comment_check_enabled === 1,
                like_check_enabled: cfg.like_check_enabled === 1,
                admin_report_enabled: cfg.admin_report_enabled === 1,
                admin_username: cfg.admin_username || '',
                scan_mode: cfg.scan_mode || 'all'
              };
            });
          }

          setAutoSettings({
            enabled: s.enabled === 1,
            threads: s.threads ? s.threads.split(',') : [],
            check_hours: s.check_hours ? s.check_hours.split(',') : ['09:00', '13:00', '17:00', '21:00'],
            dm_template: s.dm_template || '',
            group_report_template: s.group_report_template || '',
            break_minutes: s.break_minutes ?? 5,
            dm_delay_seconds: s.dm_delay_seconds ?? 30,
            comment_check_enabled: s.comment_check_enabled !== 0,
            like_check_enabled: s.like_check_enabled !== 0,
            auto_dm_enabled: s.auto_dm_enabled !== 0,
            auto_group_report_enabled: s.auto_group_report_enabled !== 0,
            scan_mode: s.scan_mode || 'all',
            target_username: s.target_username || '',
            admin_report_enabled: s.admin_report_enabled === 1,
            admin_username: s.admin_username || '',
            scan_date: s.scan_date || 'yesterday',
            dm_bulk_template: s.dm_bulk_template || 'Merhaba {grup_ismi} grubunda eksiğiniz var dönüş yapmanız gerekiyor',
            ai_assistant_enabled: s.ai_assistant_enabled === 1,
            ai_api_key: s.ai_api_key || '',
            ai_model: s.ai_model || 'openrouter/free',
            ai_system_prompt: s.ai_system_prompt || 'Sen bir Instagram grup otomasyon asistanısın. Üyelerin eksik bildirimlerine ve sorularına nazikçe ve Türkçe cevap ver.',
            ai_delay_seconds: s.ai_delay_seconds ?? 30,
            exempt_usernames: s.exempt_usernames || '',
            threads_config: configsDict
          });
        }
      }
    } catch (e) {
      console.error('Error fetching automation settings:', e);
    }
  };

  const fetchAutomationLogs = async () => {
    setIsLogsLoading(true);
    try {
      const res = await fetch('/api/instagram/automation/logs');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.logs) {
          setAutomationLogs(data.logs);
        }
      }
    } catch (e) {
      console.error('Error fetching automation logs:', e);
    } finally {
      setIsLogsLoading(false);
    }
  };

  const handleSaveAutomationSettings = async (customConfig?: Partial<typeof autoSettings>) => {
    setIsSavingAutomation(true);
    setSettingsFeedback(null);
    try {
      const config = { ...autoSettings, ...customConfig };
      const threadsConfigArray = Object.entries(config.threads_config).map(([tid, cfg]) => ({
        thread_id: tid,
        comment_check_enabled: cfg.comment_check_enabled,
        like_check_enabled: cfg.like_check_enabled,
        admin_report_enabled: cfg.admin_report_enabled,
        admin_username: cfg.admin_username || '',
        scan_mode: cfg.scan_mode || 'all'
      }));

      const payload = {
        enabled: config.enabled,
        threads: config.threads.join(','),
        check_hours: config.check_hours.join(','),
        dm_template: config.dm_template,
        group_report_template: config.group_report_template,
        break_minutes: config.break_minutes,
        dm_delay_seconds: config.dm_delay_seconds,
        comment_check_enabled: config.comment_check_enabled,
        like_check_enabled: config.like_check_enabled,
        auto_dm_enabled: config.auto_dm_enabled,
        auto_group_report_enabled: config.auto_group_report_enabled,
        cookies: cookiesRef.current,
        headers: headersRef.current,
        post_data: postDataRef.current,
        scan_mode: config.scan_mode,
        target_username: config.target_username,
        admin_report_enabled: config.admin_report_enabled,
        admin_username: config.admin_username,
        scan_date: config.scan_date,
        dm_bulk_template: config.dm_bulk_template,
        ai_assistant_enabled: config.ai_assistant_enabled,
        ai_api_key: config.ai_api_key,
        ai_model: config.ai_model,
        ai_system_prompt: config.ai_system_prompt,
        ai_delay_seconds: config.ai_delay_seconds,
        exempt_usernames: config.exempt_usernames,
        threads_config: threadsConfigArray
      };

      const res = await fetch('/api/instagram/automation/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setSettingsFeedback({
          type: 'success',
          message: 'Otomasyon ayarları başarıyla kaydedildi.'
        });
      } else {
        setSettingsFeedback({
          type: 'error',
          message: data.error || 'Ayarlar kaydedilirken hata oluştu.'
        });
      }
    } catch (err: any) {
      setSettingsFeedback({
        type: 'error',
        message: err.message || 'Bir hata oluştu.'
      });
    } finally {
      setIsSavingAutomation(false);
      setTimeout(() => setSettingsFeedback(null), 8000);
    }
  };

  const handleResetAutomation = async () => {
    if (!window.confirm('Otomasyon geçmişi, kilitli gönderiler ve gönderilen DM kayıtları sıfırlanacak. Emin misiniz?')) {
      return;
    }
    setIsResettingAutomation(true);
    setSettingsFeedback(null);
    try {
      const res = await fetch('/api/instagram/automation/reset', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        alert('Otomasyon geçmişi ve kilitli gönderiler başarıyla sıfırlandı!');
        setSettingsFeedback({
          type: 'success',
          message: 'Otomasyon geçmişi ve kilitli gönderiler başarıyla sıfırlandı!'
        });
        fetchAutomationLogs();
      } else {
        alert(data.error || 'Sıfırlama sırasında hata oluştu.');
        setSettingsFeedback({
          type: 'error',
          message: data.error || 'Sıfırlama sırasında hata oluştu.'
        });
      }
    } catch (e: any) {
      alert(e.message || 'Sıfırlama sırasında hata oluştu.');
      setSettingsFeedback({
        type: 'error',
        message: e.message || 'Sıfırlama sırasında hata oluştu.'
      });
    } finally {
      setIsResettingAutomation(false);
      setTimeout(() => setSettingsFeedback(null), 8000);
    }
  };

  const handleUndoAutomation = async () => {
    if (!window.confirm('Son çalışmada gönderilen tüm otomasyon DM mesajları geri alınacak (silinecek). Emin misiniz?')) {
      return;
    }
    setIsUndoingAutomation(true);
    setSettingsFeedback(null);
    try {
      const res = await fetch('/api/instagram/automation/undo', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        alert(data.message || 'Gönderilen mesajlar başarıyla geri alındı (silindi)!');
        setSettingsFeedback({
          type: 'success',
          message: data.message || 'Gönderilen mesajlar başarıyla geri alındı (silindi)!'
        });
        fetchAutomationLogs();
        // Clear all thread cursors and local message edges to force a clean, live reload
        setThreadCursors({});
        setThreads([]);
        
        // Reset the fetch lock to guarantee the new request is not ignored
        fetchInProgressRef.current = false;
        
        // Immediately fetch the live inbox (updates the left-pane thread list and snippets)
        fetchLiveInbox(cookiesRef.current, headersRef.current, postDataRef.current || postData, true);
        
        // If there's an active thread open, force-refresh its chat history panel
        if (activeThread) {
          fetchThreadHistory(activeThread, true);
        }
      } else {
        alert(data.error || 'Geri alınacak herhangi bir otomasyon mesajı kaydı bulunamadı.');
        setSettingsFeedback({
          type: 'error',
          message: data.error || 'Geri alma işlemi sırasında hata oluştu.'
        });
      }
    } catch (e: any) {
      alert(e.message || 'Geri alma işlemi sırasında hata oluştu.');
      setSettingsFeedback({
        type: 'error',
        message: e.message || 'Geri alma işlemi sırasında hata oluştu.'
      });
    } finally {
      setIsUndoingAutomation(false);
      setTimeout(() => setSettingsFeedback(null), 8000);
    }
  };

  const handleTriggerAutomationManual = async () => {
    if (isTriggeringAutomation) return;
    setIsTriggeringAutomation(true);
    setSettingsFeedback(null);
    try {
      const res = await fetch('/api/instagram/automation/trigger', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        setSettingsFeedback({
          type: 'success',
          message: 'Otomasyon taraması arka planda manuel olarak başlatıldı. Log listesinden takip edebilirsiniz.'
        });
        // Reload logs after 2 seconds
        setTimeout(fetchAutomationLogs, 2000);
      } else {
        setSettingsFeedback({
          type: 'error',
          message: data.error || 'Tarama başlatılamadı.'
        });
      }
    } catch (err: any) {
      setSettingsFeedback({
        type: 'error',
        message: err.message || 'Hata oluştu.'
      });
    } finally {
      setIsTriggeringAutomation(false);
      setTimeout(() => setSettingsFeedback(null), 8000);
    }
  };

  useEffect(() => {
    if (isSettingsOpen) {
      fetchAutomationSettings();
      if (settingsTab === 'automation') {
        fetchAutomationLogs();
      }
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
    setLoginFeedback(null);
  };

  const handleSendMagicEmail = async () => {
    if (!loginUsername) {
      setMagicEmailFeedback({ type: 'error', message: 'Lütfen kullanıcı adınızı girin.' });
      return;
    }
    setMagicEmailFeedback(null);
    setIsSendingMagicEmail(true);
    try {
      const response = await fetch('/api/instagram/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'send_magic_link_email',
          username: loginUsername
        })
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'E-posta gönderimi başarısız oldu.');
      }
      setMagicEmailFeedback({
        type: 'success',
        message: result.message || 'Giriş bağlantısı e-postanıza gönderildi!'
      });
    } catch (err: any) {
      setMagicEmailFeedback({
        type: 'error',
        message: err.message || 'Bir hata oluştu.'
      });
    } finally {
      setIsSendingMagicEmail(false);
    }
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
          password: loginMethod === 'credentials' ? loginPassword : undefined,
          magicLink: loginMethod === 'magic_link' ? loginMagicLink : undefined
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
        setLoginMagicLink('');
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

  const appendLocalMessage = (
    threadId: string, 
    text: string, 
    messageId: string, 
    mediaPreviewUrl?: string,
    replyToMessage?: InstagramMessage | null,
    clientContext?: string,
    mediaVideoUrl?: string,
    mediaType?: 'media_share' | 'voice_media' | 'photo' | 'video'
  ) => {
    setThreads(prevThreads => {
      const updated = prevThreads.map(thread => {
        if (thread.id !== threadId) return thread;

        const isAttachment = !!mediaPreviewUrl || !!mediaVideoUrl;
        const mappedMediaType = mediaType || (mediaPreviewUrl ? 'media_share' : undefined);

        const newMsgNode: InstagramMessage = {
          id: messageId,
          item_id: messageId,
          sender_fbid: thread.viewer?.interop_messaging_user_fbid || "17842376945110023",
          timestamp_ms: String(Date.now()),
          content: {
            __typename: isAttachment ? "SlideMessageAttachment" : "SlideMessageText",
            text_body: text
          },
          content_type: isAttachment ? "ATTACHMENT" : "TEXT",
          igd_snippet: isAttachment ? (mappedMediaType === 'voice_media' ? "Sen: Bir sesli mesaj gönderdi." : "Sen: Bir fotoğraf gönderdi.") : `Sen: ${text}`,
          text_body: text,
          media_preview_url: mediaPreviewUrl || null,
          media_video_url: mediaVideoUrl || null,
          media_type: mappedMediaType as any,
          reply_to_message: replyToMessage ? {
            id: replyToMessage.id,
            text_body: replyToMessage.text_body || replyToMessage.content?.text_body || 'Mesaj',
            sender_fbid: replyToMessage.sender_fbid,
            content_type: replyToMessage.content_type || 'TEXT'
          } : null,
          client_context: clientContext || messageId
        };

        const updatedEdges = [...(thread.slide_messages?.edges || []), { node: newMsgNode }];

        return {
          ...thread,
          last_activity_timestamp_ms: String(Date.now()),
          marked_as_unread: false,
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

  const getReplyHeaderLabel = (msg: InstagramMessage, sent: boolean, senderUser: any) => {
    if (!msg.reply_to_message) return null;
    const activeThread = threads.find(t => t.id === activeThreadId);
    const viewerFbid = activeThread?.viewer?.interop_messaging_user_fbid || "17842376945110023";
    const isTargetOwnMessage = msg.reply_to_message.sender_fbid === viewerFbid;

    if (sent) {
      return isTargetOwnMessage ? "Kendine yanıt verdin" : `${activeThread?.thread_title || 'Alıcıya'} yanıt verdin`;
    } else {
      return isTargetOwnMessage ? "Sana yanıt verdi" : `${senderUser?.username || 'Bilinmeyen'} kendine yanıt verdi`;
    }
  };

  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [selectedImagePreviewUrl, setSelectedImagePreviewUrl] = useState<string | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<InstagramMessage | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [isUploadingVoice, setIsUploadingVoice] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const voiceFileInputRef = useRef<HTMLInputElement | null>(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      
      const options = { mimeType: 'audio/webm' };
      let recorder;
      try {
        recorder = new MediaRecorder(stream, options);
      } catch (e) {
        recorder = new MediaRecorder(stream);
      }
      
      mediaRecorderRef.current = recorder;
      
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach(track => track.stop());
        await sendVoiceMessage(audioBlob, 'recorded_voice.m4a');
      };
      
      recorder.start();
      setIsRecording(true);
      setRecordingDuration(0);
      
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);
      
    } catch (err) {
      console.error('Mikrofon izni alınamadı:', err);
      alert('Mikrofon izni alınamadı. Lütfen tarayıcı ayarlarından mikrofon iznini kontrol edin.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.stop();
      const stream = mediaRecorderRef.current.stream;
      stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      setRecordingDuration(0);
    }
  };

  const sendVoiceMessage = async (audioBlob: Blob, filename: string) => {
    if (!activeThreadId) return;
    
    setIsUploadingVoice(true);
    
    const threadObj = threads.find(t => t.id === activeThreadId);
    const targetThreadId = threadObj?.thread_id || activeThreadId;
    
    const tempMsgId = `temp_voice_${Date.now()}`;
    const localVoiceUrl = URL.createObjectURL(audioBlob);
    appendLocalMessage(activeThreadId, 'Bir sesli mesaj gönderdi.', tempMsgId, undefined, undefined, undefined, localVoiceUrl, 'voice_media');
    
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, filename);
      formData.append('threadId', targetThreadId);
      formData.append('cookies', JSON.stringify(cookiesRef.current || cookies));
      formData.append('headers', JSON.stringify(headersRef.current || headers));
      formData.append('data', JSON.stringify(postDataRef.current || postData));
      
      const res = await fetch('/api/instagram/send_voice', {
        method: 'POST',
        body: formData
      });
      
      const result = await res.json();
      if (!res.ok || !result.success) {
        console.error('[Voice-Send] Server returned error details:', result.details);
        throw new Error((result.error || 'Sesli mesaj gönderilemedi.') + (result.details ? ` (Detay: ${result.details})` : ''));
      }
      
      if (result.cookies) {
        handleUpdateCookies(result.cookies);
      }
      
      if (activeThread) {
        fetchThreadHistory(activeThread);
      }
      
    } catch (err: any) {
      console.error('[Voice-Send] Failed to send voice message:', err);
      alert(err.message || 'Bilinmeyen hata');
    } finally {
      setIsUploadingVoice(false);
    }
  };

  const handleVoiceFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    sendVoiceMessage(file, file.name);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so user can upload the same file again if desired
    e.target.value = '';

    if (selectedImagePreviewUrl) {
      URL.revokeObjectURL(selectedImagePreviewUrl);
    }

    setSelectedImageFile(file);
    setSelectedImagePreviewUrl(URL.createObjectURL(file));
  };

  // Sending a message (Live API call or Demo simulation)
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeThreadId) return;

    const hasImage = !!selectedImageFile;
    const hasText = !!typedMessage.trim();

    if (!hasImage && !hasText) return;

    const newMessageText = typedMessage.trim();
    
    // Clear input field immediately
    setTypedMessage('');

    // Capture and clear reply state immediately so preview goes away
    const currentReplyToMessage = replyToMessage;
    setReplyToMessage(null);

    // Clear typing timeout and send typing = false immediately
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    sendTypingIndicatorToServer(false);
    lastTypingSentRef.current = 0;

    const threadObj = threads.find(t => t.id === activeThreadId);
    const targetThreadId = threadObj?.thread_id || activeThreadId;

    if (hasImage && selectedImageFile) {
      const fileToUpload = selectedImageFile;
      const previewUrl = selectedImagePreviewUrl;

      // Reset selected image states so preview goes away immediately
      setSelectedImageFile(null);
      setSelectedImagePreviewUrl(null);
      setIsUploadingImage(true);

      // Optimistic local preview
      const tempMsgId = `temp_media_${Date.now()}`;
      if (previewUrl) {
        appendLocalMessage(activeThreadId, 'Bir fotoğraf gönderdi.', tempMsgId, previewUrl);
      }

      try {
        // Step 1: Upload to mercury upload.php proxy
        const formData = new FormData();
        formData.append('file', fileToUpload);
        formData.append('cookies', JSON.stringify(cookiesRef.current || cookies));
        formData.append('headers', JSON.stringify(headersRef.current || headers));
        formData.append('data', JSON.stringify(postDataRef.current || postData));

        const uploadRes = await fetch('/api/instagram/upload_media', {
          method: 'POST',
          body: formData,
        });

        const uploadResult = await uploadRes.json();
        if (!uploadRes.ok || !uploadResult.success) {
          throw new Error(uploadResult.error || 'Resim yükleme sunucuda başarısız oldu');
        }

        if (uploadResult.cookies) {
          handleUpdateCookies(uploadResult.cookies);
        }

        const attachmentFbid = uploadResult.fbid;

        // Step 2: Send media mutation proxy
        const sendRes = await fetch('/api/instagram/send_media', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            attachmentFbid,
            threadId: targetThreadId,
            cookies: cookiesRef.current || cookies,
            headers: headersRef.current || headers,
            data: postDataRef.current || postData,
          }),
        });

        const sendResult = await sendRes.json();
        if (!sendRes.ok || !sendResult.success) {
          throw new Error(sendResult.error || 'Resim gönderilemedi');
        }

        if (sendResult.cookies) {
          handleUpdateCookies(sendResult.cookies);
        }
        if (sendResult.headers) {
          setHeaders(sendResult.headers);
          setHeadersJson(JSON.stringify(sendResult.headers, null, 2));
          localStorage.setItem('ig_headers', JSON.stringify(sendResult.headers));
        }
        if (sendResult.postData) {
          setPostData(sendResult.postData);
          setPostDataJson(JSON.stringify(sendResult.postData, null, 2));
          localStorage.setItem('ig_postData', JSON.stringify(sendResult.postData));
        }

        console.log('Successfully uploaded and sent image attachment!');
      } catch (err: any) {
        console.error('Error sending image:', err);
        alert(`Resim gönderilirken hata oluştu: ${err.message}`);
      } finally {
        setIsUploadingImage(false);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
      }
    }

    // Now send the text message if present
    if (hasText) {
      try {
        lastActivityRef.current = Date.now();
        const replyParams = currentReplyToMessage ? {
          replyToMessageId: currentReplyToMessage.id,
          repliedToItemId: currentReplyToMessage.item_id || currentReplyToMessage.id,
          repliedToClientContext: currentReplyToMessage.client_context || currentReplyToMessage.id
        } : {};

        const isTemporary = activeThreadId.startsWith('temp_');
        const recipientId = isTemporary ? activeThreadId.replace('temp_', '') : undefined;

        const response = await fetch('/api/instagram/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            threadId: isTemporary ? undefined : activeThreadId,
            recipientId,
            text: newMessageText,
            cookies: cookiesRef.current || cookies,
            headers: headersRef.current || headers,
            data: postDataRef.current || postData,
            ...replyParams
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

        const messageId = result.data?.ig_message_send?.message_id || `sent_${Date.now()}`;
        appendLocalMessage(activeThreadId, newMessageText, messageId, undefined, currentReplyToMessage, result.offlineThreadingId);

        if (isTemporary && recipientId) {
          // Immediately fetch inbox to get the real thread ID created by Instagram
          setTimeout(async () => {
            await fetchLiveInbox();
            // Now check the updated threadsRef.current
            const newThread = threadsRef.current.find(t => 
              !t.is_group && t.users?.some(u => String(u.pk) === String(recipientId))
            );
            if (newThread) {
              console.log(`[NewMessage] Found newly created thread ${newThread.id} for recipient ${recipientId}. Switching...`);
              setActiveThreadId(newThread.id);
              // Remove the temp thread from list
              setThreads(prev => prev.filter(t => t.id !== activeThreadId));
            }
          }, 2000);
        }

      } catch (err: any) {
        console.error('Error sending text:', err);
        alert(`Mesaj gönderilirken hata oluştu: ${err.message}`);
        setTypedMessage(newMessageText); // Restore typed message
      }
    }

    // Finally sync live inbox in background
    fetchLiveInbox(cookiesRef.current || cookies, headersRef.current || headers, postDataRef.current || postData, true);
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
    if (thread.id.startsWith('temp_')) {
      return;
    }
    
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
            videoUrl = item.voice_media.media?.audio?.audio_src || 
                       item.voice_media.media?.video_versions?.[0]?.url || 
                       null;
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

          let fallbackText = text || item.igd_snippet || (item.item_type ? `[${item.item_type}]` : 'Ek içerik');

          // Rewrite generic "dosya eki" snippets
          if (fallbackText && fallbackText.includes('dosya eki')) {
            const isSentByMe = fallbackText.includes('gönderdin');
            if (mediaType === 'clip') {
              fallbackText = isSentByMe ? fallbackText.replace('bir dosya eki gönderdin.', 'bir reels videosu paylaştın.') 
                                        : fallbackText.replace('bir dosya eki gönderdi.', 'bir reels videosu paylaştı.');
            } else if (mediaType === 'story_share') {
              fallbackText = isSentByMe ? fallbackText.replace('bir dosya eki gönderdin.', 'bir hikaye paylaştın.') 
                                        : fallbackText.replace('bir dosya eki gönderdi.', 'bir hikaye paylaştı.');
            } else {
              fallbackText = isSentByMe ? fallbackText.replace('bir dosya eki gönderdin.', 'bir gönderi paylaştın.') 
                                        : fallbackText.replace('bir dosya eki gönderdi.', 'bir gönderi paylaştı.');
            }
          }

          const rawReplied = item.replied_to_message || item.reply_to_message;
          const repliedMessage = rawReplied ? {
            id: rawReplied.item_id || rawReplied.message_id || '',
            text_body: rawReplied.text || 'Mesaj',
            sender_fbid: rawReplied.user_id,
            content_type: rawReplied.item_type === 'text' ? 'TEXT' : 'ATTACHMENT'
          } : null;

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
            reactions: mappedReactions,
            reply_to_message: repliedMessage,
            client_context: item.client_context || null
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
          
          if (result.success && result.commentsDisabled) {
            setErrorModal({
              isOpen: true,
              title: 'Yorumlar Gizli',
              message: 'Bu gönderinin yorumları sahibi tarafından gizlenmiş veya kapatılmıştır. Yorum taraması yapılamaz.',
              type: 'warning'
            });
            setCommentScan(prev => ({
              ...prev,
              isScanning: false,
              isOpen: false
            }));
            return;
          }

          if (!commentsRes.ok || !result.success) {
            setErrorModal({
              isOpen: true,
              title: 'Tarama Hatası',
              message: result.error || 'Yorumlar yüklenemedi.',
              type: 'error'
            });
            setCommentScan(prev => ({
              ...prev,
              isScanning: false,
              isOpen: false
            }));
            return;
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
      setErrorModal({
        isOpen: true,
        title: 'Tarama Hatası',
        message: err.message || 'Bilinmeyen bir hata oluştu.',
        type: 'error'
      });
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
    let resolvedShortcode: string | null = null;
    for (const [shortcode, preview] of Object.entries(linkPreviews)) {
      if (preview && typeof preview === 'object' && (preview as any).mediaId === mediaId) {
        localLikeCount = (preview as any).likeCount ?? null;
        resolvedShortcode = shortcode;
        break;
      }
    }

    if (localLikeCount !== null && localLikeCount > 90) {
      setErrorModal({
        isOpen: true,
        title: 'Güvenlik Koruması',
        message: `Bu gönderi 90'dan fazla beğeni aldığı için (${localLikeCount} beğeni) beğeni taraması güvenlik amacıyla durduruldu.`,
        type: 'warning'
      });
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
          shortcode: resolvedShortcode,
          cookies: cookiesRef.current,
          headers: headersRef.current,
        }),
      });

      const result = await likesRes.json();
      if (!likesRes.ok || !result.success) {
        setErrorModal({
          isOpen: true,
          title: result.error?.includes('90\'dan fazla') ? 'Güvenlik Koruması' : 'Tarama Hatası',
          message: result.error || 'Beğeniler yüklenemedi.',
          type: result.error?.includes('90\'dan fazla') ? 'warning' : 'error'
        });
        setLikeScan(prev => ({
          ...prev,
          isScanning: false,
          isOpen: false
        }));
        return;
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
      setErrorModal({
        isOpen: true,
        title: 'Tarama Hatası',
        message: err.message || 'Bilinmeyen bir hata oluştu.',
        type: 'error'
      });
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

  const handleMoveThread = async (threadId: string, targetFolder: 'PRIMARY' | 'GENERAL', isPending?: boolean) => {
    const isPendingThread = isPending ?? (threads.find(t => t.id === threadId)?.folder === 'PENDING');
    
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
          isPending: isPendingThread,
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

  const handleDeleteThread = async (threadId: string) => {
    // Find the thread to get its thread_fbid
    const thread = threads.find(t => t.id === threadId);
    if (!thread) return;

    const threadFbid = thread.thread_fbid || thread.id;

    if (!confirm('Bu sohbeti silmek/gizlemek istediğinizden emin misiniz?')) {
      return;
    }

    // Instantly remove from local threads state
    setThreads(prevThreads => prevThreads.filter(t => t.id !== threadId));

    if (activeThreadId === threadId) {
      setActiveThreadId(null);
    }

    try {
      const res = await fetch('/api/instagram/delete_thread', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadFbid,
          cookies: cookiesRef.current,
          headers: headersRef.current,
          data: postDataRef.current
        })
      });

      const result = await res.json();
      if (!res.ok || !result.success) {
        console.error('Failed to delete thread on Instagram:', result.error || 'Unknown error');
      } else {
        console.log('Successfully hid/deleted thread on Instagram:', threadFbid);
      }
    } catch (err) {
      console.error('Network error deleting thread:', err);
    }
  };

  const handlePinThread = async (threadId: string, shouldPin: boolean) => {
    // Find the thread to get its thread_fbid
    const thread = threads.find(t => t.id === threadId);
    if (!thread) return;

    const threadFbid = thread.thread_fbid || thread.id;

    // Instantly update local thread's is_pin state in UI
    setThreads(prevThreads => 
      prevThreads.map(t => t.id === threadId ? { ...t, is_pin: shouldPin } : t)
    );

    try {
      const res = await fetch('/api/instagram/pin_thread', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadFbid,
          pin: shouldPin,
          cookies: cookiesRef.current,
          headers: headersRef.current,
          data: postDataRef.current
        })
      });

      const result = await res.json();
      if (!res.ok || !result.success) {
        console.error('Failed to pin/unpin thread on Instagram:', result.error || 'Unknown error');
        // Rollback state on error
        setThreads(prevThreads => 
          prevThreads.map(t => t.id === threadId ? { ...t, is_pin: !shouldPin } : t)
        );
      } else {
        console.log(`Successfully ${shouldPin ? 'pinned' : 'unpinned'} thread on Instagram:`, threadFbid);
      }
    } catch (err) {
      console.error('Network error pinning thread:', err);
      // Rollback state on error
      setThreads(prevThreads => 
        prevThreads.map(t => t.id === threadId ? { ...t, is_pin: !shouldPin } : t)
      );
    }
  };

  const handleMarkUnread = async (threadId: string, shouldMarkUnread: boolean) => {
    // Find the thread to get its thread_fbid
    const thread = threads.find(t => t.id === threadId);
    if (!thread) return;

    const threadFbid = thread.thread_fbid || thread.id;

    // Instantly update local thread's marked_as_unread state in UI
    setThreads(prevThreads => 
      prevThreads.map(t => t.id === threadId ? { ...t, marked_as_unread: shouldMarkUnread } : t)
    );

    try {
      const res = await fetch('/api/instagram/mark_unread', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadFbid,
          unread: shouldMarkUnread,
          cookies: cookiesRef.current,
          headers: headersRef.current,
          data: postDataRef.current
        })
      });

      const result = await res.json();
      if (!res.ok || !result.success) {
        console.error('Failed to mark thread unread/read on Instagram:', result.error || 'Unknown error');
        // Rollback state on error
        setThreads(prevThreads => 
          prevThreads.map(t => t.id === threadId ? { ...t, marked_as_unread: !shouldMarkUnread } : t)
        );
      } else {
        console.log(`Successfully marked thread ${shouldMarkUnread ? 'unread' : 'read'} on Instagram:`, threadFbid);
      }
    } catch (err) {
      console.error('Network error marking thread unread:', err);
      // Rollback state on error
      setThreads(prevThreads => 
        prevThreads.map(t => t.id === threadId ? { ...t, marked_as_unread: !shouldMarkUnread } : t)
      );
    }
  };

  const handleMuteThread = async (threadId: string, muteSeconds: number) => {
    // Find the thread to get its thread_fbid
    const thread = threads.find(t => t.id === threadId);
    if (!thread) return;

    const threadFbid = thread.thread_fbid || thread.id;
    const shouldMute = muteSeconds !== 0;

    // Instantly update local thread's is_muted state in UI
    setThreads(prevThreads => 
      prevThreads.map(t => t.id === threadId ? { ...t, is_muted: shouldMute } : t)
    );

    try {
      const res = await fetch('/api/instagram/mute_thread', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadFbid,
          muteSeconds,
          cookies: cookiesRef.current,
          headers: headersRef.current,
          data: postDataRef.current
        })
      });

      const result = await res.json();
      if (!res.ok || !result.success) {
        console.error('Failed to mute/unmute thread on Instagram:', result.error || 'Unknown error');
        // Rollback state on error
        setThreads(prevThreads => 
          prevThreads.map(t => t.id === threadId ? { ...t, is_muted: !shouldMute } : t)
        );
      } else {
        console.log(`Successfully ${shouldMute ? 'muted' : 'unmuted'} thread on Instagram:`, threadFbid);
      }
    } catch (err) {
      console.error('Network error muting thread:', err);
      // Rollback state on error
      setThreads(prevThreads => 
        prevThreads.map(t => t.id === threadId ? { ...t, is_muted: !shouldMute } : t)
      );
    }
  };

  const fetchUserProfile = async (userId: string) => {
    setIsFetchingUserProfile(true);
    setUserProfileData(null);
    setIsUserProfileModalOpen(true);
    try {
      const res = await fetch('/api/instagram/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          cookies: cookiesRef.current,
          headers: headersRef.current,
          data: postDataRef.current
        })
      });
      const result = await res.json();
      if (res.ok && result.success) {
        setUserProfileData(result.user);
      } else {
        console.error('Failed to fetch user profile:', result.error || 'Unknown error');
      }
    } catch (err) {
      console.error('Error fetching user profile:', err);
    } finally {
      setIsFetchingUserProfile(false);
    }
  };

  const handleForwardMessage = async () => {
    const selectedIds = Object.keys(forwardSelectedRecipients);
    if (selectedIds.length === 0 || !forwardMessageText.trim()) return;

    if (selectedIds.length > 5) {
      alert('Aynı anda en fazla 5 kişiye mesaj yönlendirebilirsiniz.');
      return;
    }

    setIsForwardingInProgress(true);

    try {
      const promises = selectedIds.map(async (threadId) => {
        const thread = threads.find(t => t.id === threadId);
        const targetThreadId = thread?.thread_id || threadId;

        // Optimistically append the sent message to the active thread if it's currently open
        if (activeThreadId === threadId) {
          const tempMsgId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          appendLocalMessage(threadId, forwardMessageText, tempMsgId);
        }

        const res = await fetch('/api/instagram/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            threadId: targetThreadId,
            text: forwardMessageText,
            cookies: cookiesRef.current,
            headers: headersRef.current,
            data: postDataRef.current
          })
        });

        const result = await res.json();
        if (!res.ok || !result.success) {
          console.error(`Failed to forward to recipient ${threadId}:`, result.error || 'Unknown error');
        }
      });

      await Promise.all(promises);
      console.log('Successfully forwarded message to select recipients!');
      setIsForwardModalOpen(false);
      setForwardSelectedRecipients({});
      setForwardMessageText('');
    } catch (err) {
      console.error('Error forwarding message:', err);
      alert('Mesaj yönlendirilirken bir hata oluştu.');
    } finally {
      setIsForwardingInProgress(false);
    }
  };

  const handleMsgContextMenu = (e: React.MouseEvent, msg: InstagramMessage) => {

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
      message: msg,
    });
  };

  const handleMessageDoubleClick = async (e: React.MouseEvent, msg: InstagramMessage) => {
    e.preventDefault();

    // Ignore double clicks that occur immediately after the window gains focus
    // (prevents liking/unliking messages when the user double-clicks to focus the browser window)
    if (Date.now() - lastFocusTimeRef.current < 500) {
      console.log('[React] Ignored double-click focus trigger');
      return;
    }

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
    const hasReacted = currentReactions.some((r: any) => String(r.sender_fbid) === viewerId && normalizeEmoji(r.reaction) === normalizeEmoji(emoji));
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
            newReactions = currentReactions.filter((r: any) => !(String(r.sender_fbid) === viewerId && normalizeEmoji(r.reaction) === normalizeEmoji(emoji)));
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
          itemId: msg.item_id || (!msg.id.startsWith('mid.$') ? msg.id : ''),
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
    if (thread.marked_as_unread) {
      fetch('/api/instagram/mark_unread', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadFbid: thread.thread_fbid || thread.id,
          unread: false,
          cookies: cookiesRef.current || cookies,
          headers: headersRef.current || headers,
          data: postDataRef.current || postData
        })
      }).catch(err => console.error('Failed to mark read on click:', err));
    }

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
    // First, filter by folder and empty threads
    const folderThreads = threads.filter(thread => {
      const folderVal = thread.folder || 'PRIMARY';
      
      // Filter out empty non-temporary threads
      const hasMessages = (thread.slide_messages?.edges?.length || 0) > 0 || String(thread.id).startsWith('temp_');
      if (!hasMessages) return false;

      if (activeFolder === 'PRIMARY') {
        return folderVal === 'PRIMARY' || folderVal === 'INBOX';
      } else if (activeFolder === 'GENERAL') {
        return folderVal === 'GENERAL';
      } else {
        return folderVal === 'PENDING';
      }
    });

    // Sort: pinned threads first, then by last_activity_timestamp_ms descending
    const sortedFolderThreads = [...folderThreads].sort((a, b) => {
      const pinA = a.is_pin ? 1 : 0;
      const pinB = b.is_pin ? 1 : 0;
      if (pinB !== pinA) {
        return pinB - pinA;
      }
      const timeA = Number(a.last_activity_timestamp_ms || 0);
      const timeB = Number(b.last_activity_timestamp_ms || 0);
      return timeB - timeA;
    });

    if (!searchQuery.trim()) return sortedFolderThreads;
    
    const q = searchQuery.toLowerCase().trim();
    return sortedFolderThreads.filter(thread => {
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

  const getSeenTimeLabel = (thread: InstagramThread) => {
    if (!thread.last_seen_watermark_ms) return 'Görüldü';
    const ts = parseInt(thread.last_seen_watermark_ms, 10);
    if (isNaN(ts)) return 'Görüldü';

    const diffMs = Date.now() - ts;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffSec < 60) return 'Görüldü (şimdi)';
    if (diffMin < 60) return `Görüldü (${diffMin}d önce)`;
    if (diffHr < 24) return `Görüldü (${diffHr}sa önce)`;
    if (diffDay < 7) return `Görüldü (${diffDay}g önce)`;

    const date = new Date(ts);
    return `Görüldü (${date.toLocaleDateString('tr-TR', { month: 'short', day: 'numeric' })})`;
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
            <div style={{
              display: 'flex',
              background: 'rgba(255, 255, 255, 0.02)',
              padding: '4px',
              borderRadius: '10px',
              border: '1px solid rgba(255, 255, 255, 0.05)',
              marginBottom: '20px'
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
                onClick={() => setLoginMethod('magic_link')}
                style={{
                  flex: 1,
                  background: loginMethod === 'magic_link' ? 'rgba(255, 255, 255, 0.06)' : 'transparent',
                  border: 'none',
                  color: loginMethod === 'magic_link' ? '#fff' : 'var(--text-muted)',
                  padding: '8px',
                  borderRadius: '8px',
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
              >
                E-posta Linki
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
                cURL ile Giriş
              </button>
            </div>

            {loginMethod === 'credentials' ? (
              <>
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
              </>
            ) : loginMethod === 'magic_link' ? (
              <>
                <div className="login-form-group">
                  <label className="login-form-label">Kullanıcı Adı</label>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <input
                      type="text"
                      className="login-form-input"
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      placeholder="Instagram kullanıcı adınız"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={handleSendMagicEmail}
                      disabled={isSendingMagicEmail}
                      style={{
                        padding: '0 16px',
                        fontSize: '12px',
                        fontWeight: '600',
                        borderRadius: '8px',
                        background: 'rgba(255, 255, 255, 0.08)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        color: '#fff',
                        cursor: isSendingMagicEmail ? 'not-allowed' : 'pointer',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {isSendingMagicEmail ? 'Gönderiliyor...' : 'Linki Gönder'}
                    </button>
                  </div>
                </div>

                {magicEmailFeedback && (
                  <div style={{
                    fontSize: '12px',
                    marginTop: '8px',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    background: magicEmailFeedback.type === 'success' ? 'rgba(46, 204, 113, 0.1)' : 'rgba(231, 76, 60, 0.1)',
                    border: `1px solid ${magicEmailFeedback.type === 'success' ? 'rgba(46, 204, 113, 0.2)' : 'rgba(231, 76, 60, 0.2)'}`,
                    color: magicEmailFeedback.type === 'success' ? '#2ecc71' : '#e74c3c'
                  }}>
                    {magicEmailFeedback.message}
                  </div>
                )}

                <div className="login-form-group" style={{ marginTop: '16px', marginBottom: '24px' }}>
                  <label className="login-form-label">E-posta Giriş Bağlantısı (Magic Link)</label>
                  <textarea
                    className="login-form-input"
                    value={loginMagicLink}
                    onChange={(e) => setLoginMagicLink(e.target.value)}
                    placeholder="https://www.instagram.com/_n/web_emaillogin?uid=...&token=..."
                    style={{
                      height: '100px',
                      resize: 'vertical',
                      fontSize: '12px',
                      padding: '10px',
                      lineHeight: '1.4',
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '8px',
                      color: '#fff',
                      outline: 'none'
                    }}
                    required={loginMethod === 'magic_link'}
                  />
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', display: 'block', lineHeight: '1.4' }}>
                    Instagram'dan gelen e-postadaki "Giriş Yap" butonunun bağlantısını kopyalayıp buraya yapıştırın.
                  </span>
                </div>
              </>
            ) : (
              <div className="login-form-group" style={{ marginBottom: '24px' }}>
                <label className="login-form-label">cURL Komutu (bash formatında)</label>
                <textarea
                  className="login-form-input"
                  value={loginCurl}
                  onChange={(e) => setLoginCurl(e.target.value)}
                  placeholder="curl 'https://www.instagram.com/api/v1/...' -H 'cookie: ...'"
                  style={{
                    height: '120px',
                    resize: 'vertical',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    padding: '10px',
                    lineHeight: '1.4',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '8px',
                    color: '#fff',
                    outline: 'none'
                  }}
                  required
                />
              </div>
            )}

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
              title="Yeni Mesaj Başlat" 
              onClick={() => setIsNewMessageModalOpen(true)}
            >
              {/* Square-edit / New Message Icon */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4z"></path>
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
            { id: 'GENERAL', label: 'Genel' },
            { id: 'PENDING', label: 'İstekler' }
          ].map(tab => {
            const isActive = activeFolder === tab.id;
            const unreadCount = threads.filter(t => {
              const folderVal = t.folder || 'PRIMARY';
              if (tab.id === 'PRIMARY') {
                return (folderVal === 'PRIMARY' || folderVal === 'INBOX');
              } else if (tab.id === 'GENERAL') {
                return folderVal === 'GENERAL';
              } else {
                return folderVal === 'PENDING';
              }
            }).filter(t => t.marked_as_unread).length;

            return (
              <button
                key={tab.id}
                onClick={() => {
                  const targetFolder = tab.id as 'PRIMARY' | 'GENERAL' | 'PENDING';
                  setActiveFolder(targetFolder);
                  
                  // Set active thread to the first local thread in this folder if we have one
                  const localThreadsInFolder = threads.filter(t => {
                    const folderVal = t.folder || 'PRIMARY';
                    if (targetFolder === 'PRIMARY') {
                      return folderVal === 'PRIMARY' || folderVal === 'INBOX';
                    } else if (targetFolder === 'GENERAL') {
                      return folderVal === 'GENERAL';
                    } else {
                      return folderVal === 'PENDING';
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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <span>{tab.label}</span>
                  {unreadCount > 0 && (
                    <span style={{
                      background: '#FF3040',
                      color: '#fff',
                      fontSize: '10px',
                      fontWeight: 'bold',
                      borderRadius: '50%',
                      minWidth: '16px',
                      height: '16px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 4px',
                      lineHeight: '1'
                    }}>
                      {unreadCount}
                    </span>
                  )}
                </div>
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
              const snippet = getThreadSnippet(thread);
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
                      <span className="thread-name" style={thread.marked_as_unread ? { fontWeight: '700', color: '#ffffff' } : undefined}>
                        {displayName}
                        {!isGroup && partner.is_verified && (
                          <span className="verified-badge" title="Onaylı Hesap">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"></path>
                            </svg>
                          </span>
                        )}
                        {thread.is_pin && (
                          <span title="Sabitlenmiş" style={{ marginLeft: '6px', display: 'inline-flex', alignItems: 'center', color: '#a8a8a8' }}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ transform: 'rotate(45deg)' }}>
                              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"></path>
                            </svg>
                          </span>
                        )}
                        {thread.is_muted && (
                          <span title="Sessize Alınmış" style={{ marginLeft: '6px', display: 'inline-flex', alignItems: 'center', color: 'rgba(255,255,255,0.4)' }}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
                              <line x1="23" y1="9" x2="17" y2="15"></line>
                              <line x1="17" y1="9" x2="23" y2="15"></line>
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
                        <span className="thread-snippet" style={{ color: '#ffffff', fontWeight: 'bold' }}>
                          {getThreadTypingText(thread)}
                        </span>
                      ) : (
                        <span className="thread-snippet" style={thread.marked_as_unread ? { fontWeight: '700', color: '#ffffff' } : undefined}>{snippet}</span>
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
                  } else {
                    const partner = activeThread.users?.[0];
                    if (partner?.pk || partner?.id) {
                      fetchUserProfile(partner.pk || partner.id);
                    }
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: '8px',
                  transition: 'background 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
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
                        <span style={{ color: '#ffffff', fontWeight: 'bold' }}>
                          {getThreadTypingText(activeThread)}
                        </span>
                      ) : (
                        <span>{activeThread.users?.length || 0} üye</span>
                      )
                    ) : isPartnerTyping ? (
                      <span style={{ color: '#ffffff', fontWeight: 'bold' }}>yazıyor...</span>
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
              {threadErrors[activeThread.id] ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', padding: '20px', textAlign: 'center' }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: '12px', color: '#ff4d4f' }}>
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                  </svg>
                  <span style={{ fontWeight: '600', color: 'var(--text-primary)', marginBottom: '4px' }}>Sohbet Geçmişi Alınamadı</span>
                  <span style={{ fontSize: '13px' }}>{threadErrors[activeThread.id]}</span>
                  <span style={{ fontSize: '11px', marginTop: '8px', opacity: 0.7 }}>Bu sohbet Instagram'da silinmiş veya erişilemez olabilir.</span>
                </div>
              ) : (!activeThread.slide_messages?.edges || activeThread.slide_messages.edges.length === 0) ? (
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

                      {msg.reply_to_message && (
                        <span style={{ 
                          fontSize: '11px', 
                          color: 'rgba(255,255,255,0.4)', 
                          marginLeft: sent ? 'auto' : '36px', 
                          marginRight: sent ? '4px' : 'auto',
                          marginBottom: '2px',
                          display: 'block'
                        }}>
                          {getReplyHeaderLabel(msg, sent, senderUser)}
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

                        <div className={`message-bubble-row ${sent ? 'sent' : 'received'}`}>
                          
                          {/* Hover actions menu next to bubble */}
                          <div className="quick-actions">
                            <button 
                              type="button" 
                              className="quick-action-btn" 
                              title="Beğen"
                              onClick={(e) => handleMessageDoubleClick(e, msg)}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                              </svg>
                            </button>
                            <button 
                              type="button" 
                              className="quick-action-btn" 
                              title="Yanıtla"
                              onClick={() => setReplyToMessage(msg)}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="9 17 4 12 9 7"></polyline>
                                <path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>
                              </svg>
                            </button>
                            <button 
                              type="button" 
                              className="quick-action-btn" 
                              title="Daha fazla"
                              onClick={(e) => {
                                e.preventDefault();
                                if (msg.media_type === 'clip' || msg.media_type === 'media_share') {
                                  handleContextMenu(e, msg, 'right-click');
                                } else {
                                  handleMsgContextMenu(e, msg);
                                }
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <circle cx="12" cy="12" r="1.5"></circle>
                                <circle cx="12" cy="5" r="1.5"></circle>
                                <circle cx="12" cy="19" r="1.5"></circle>
                              </svg>
                            </button>
                          </div>

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
                          {/* Replied Message Quote bubble decoration */}
                          {msg.reply_to_message && (
                            <div style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              padding: '6px 10px',
                              background: 'rgba(255, 255, 255, 0.08)',
                              borderRadius: '6px',
                              marginBottom: '6px',
                              borderLeft: '3px solid #0095f6',
                              fontSize: '11px',
                              color: 'rgba(255, 255, 255, 0.6)',
                              maxWidth: '100%',
                              width: 'fit-content'
                            }}>
                              <span style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                              }}>
                                {msg.reply_to_message.text_body || 'Ek içerik'}
                              </span>
                            </div>
                          )}

                          {msg.media_type === 'voice_media' ? (
                            <VoiceMessagePlayer audioUrl={msg.media_video_url || ''} sent={sent} />
                          ) : hasMediaPreview ? (
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
                      </div>

                      {/* Seen Avatars */}
                      {(() => {
                        const seenUsers = getSeenUsersForMessage(msg, activeThread);
                        if (seenUsers.length === 0) return null;
                        
                        return (
                          <div 
                            onClick={() => setSeenListModal({ visible: true, users: seenUsers })}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: sent ? 'flex-end' : 'flex-start',
                              gap: '2px',
                              marginTop: '4px',
                              marginBottom: '2px',
                              marginLeft: !sent ? '36px' : '0',
                              cursor: 'pointer',
                              width: 'fit-content',
                              alignSelf: sent ? 'flex-end' : 'flex-start',
                              flexWrap: 'wrap',
                              maxWidth: '120px'
                            }}
                            title={`${seenUsers.map(u => u.username).join(', ')} gördü`}
                          >
                            {seenUsers.map((u, i) => (
                              <img 
                                key={u.id || u.pk}
                                src={u.profile_pic_url || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"}
                                alt={u.username}
                                style={{
                                  width: '14px',
                                  height: '14px',
                                  borderRadius: '50%',
                                  objectFit: 'cover',
                                  border: '1.5px solid #000',
                                  marginLeft: i > 0 ? '-4px' : '0',
                                  zIndex: 10 - i,
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                                }}
                              />
                            ))}
                          </div>
                        );
                      })()}

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
                            color: 'rgba(255, 255, 255, 0.45)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            fontWeight: 'normal'
                          }}>
                            <span>{getSeenTimeLabel(activeThread)}</span>
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
            {activeThread && activeThread.folder === 'PENDING' ? (
              <div style={{
                background: 'rgba(20, 20, 20, 0.95)',
                borderTop: '1px solid var(--border-color)',
                padding: '16px 20px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px',
                textAlign: 'center'
              }}>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)', lineHeight: '1.4' }}>
                  Bu kullanıcı size bir mesaj isteği gönderdi. Kabul edene kadar size yeni mesaj gönderemezler ve siz de yanıtlayamazsınız.
                </div>
                <div style={{ display: 'flex', gap: '12px', width: '100%', maxWidth: '320px' }}>
                  <button 
                    onClick={() => handleDeleteThread(activeThread.id)}
                    style={{
                      flex: 1,
                      padding: '10px 0',
                      background: 'rgba(255, 255, 255, 0.08)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: '8px',
                      color: '#ef4444',
                      fontSize: '13px',
                      fontWeight: '600',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.12)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'}
                  >
                    Sil / Yoksay
                  </button>
                  <button 
                    onClick={async () => {
                      await handleMoveThread(activeThread.id, 'PRIMARY');
                      // Locally update the folder of the active thread to PRIMARY so it unlocks immediately
                      setThreads(prev => prev.map(t => t.id === activeThread.id ? { ...t, folder: 'PRIMARY' } : t));
                    }}
                    style={{
                      flex: 1,
                      padding: '10px 0',
                      background: '#0095f6',
                      border: 'none',
                      borderRadius: '8px',
                      color: '#fff',
                      fontSize: '13px',
                      fontWeight: '600',
                      cursor: 'pointer',
                      transition: 'background 0.2s'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#1877f2'}
                    onMouseLeave={(e) => e.currentTarget.style.background = '#0095f6'}
                  >
                    Kabul Et
                  </button>
                </div>
              </div>
            ) : (
              <form className="chat-input-bar" onSubmit={handleSendMessage} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                
                {/* Selected Image Preview panel */}
                {selectedImagePreviewUrl && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '8px 12px',
                    background: 'rgba(255, 255, 255, 0.04)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '8px',
                    marginBottom: '4px',
                    position: 'relative'
                  }}>
                    <div style={{ position: 'relative', width: '50px', height: '50px', borderRadius: '6px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}>
                      <img src={selectedImagePreviewUrl} alt="Preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontSize: '12px', fontWeight: '600', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {selectedImageFile?.name}
                      </span>
                      <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)' }}>
                        {selectedImageFile ? `${(selectedImageFile.size / 1024).toFixed(1)} KB` : ''}
                      </span>
                    </div>
                    <button 
                      type="button" 
                      onClick={() => {
                        if (selectedImagePreviewUrl) URL.revokeObjectURL(selectedImagePreviewUrl);
                        setSelectedImageFile(null);
                        setSelectedImagePreviewUrl(null);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'rgba(255,255,255,0.6)',
                        cursor: 'pointer',
                        padding: '4px',
                        fontSize: '18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'color 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.color = '#fff'}
                      onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)'}
                    >
                      &times;
                    </button>
                  </div>
                )}

                {/* Reply Message Preview panel */}
                {replyToMessage && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '8px 12px',
                    background: 'rgba(255, 255, 255, 0.04)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '8px',
                    marginBottom: '4px',
                    position: 'relative'
                  }}>
                    <div style={{
                      width: '4px',
                      height: '32px',
                      background: '#0095f6',
                      borderRadius: '2px'
                    }} />
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontSize: '11px', fontWeight: '700', color: '#0095f6' }}>
                        Yanıtlanan Mesaj
                      </span>
                      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {replyToMessage.text_body || replyToMessage.content?.text_body || (replyToMessage.media_preview_url ? 'Fotoğraf' : 'Ek içerik')}
                      </span>
                    </div>
                    <button 
                      type="button" 
                      onClick={() => setReplyToMessage(null)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'rgba(255,255,255,0.6)',
                        cursor: 'pointer',
                        padding: '4px',
                        fontSize: '18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'color 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.color = '#fff'}
                      onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)'}
                    >
                      &times;
                    </button>
                  </div>
                )}

                <div className="chat-input-container">
                  {isRecording ? (
                    <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: '12px', padding: '0 8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                        <span className="recording-dot" style={{
                          width: '10px',
                          height: '10px',
                          borderRadius: '50%',
                          backgroundColor: '#ff4d4d',
                          animation: 'pulse 1.5s infinite'
                        }}></span>
                        <span style={{ fontSize: '14px', fontWeight: '500', color: '#fff' }}>
                          Ses Kaydediliyor... {Math.floor(recordingDuration / 60).toString().padStart(2, '0')}:{(recordingDuration % 60).toString().padStart(2, '0')}
                        </span>
                      </div>
                      
                      <button 
                        type="button" 
                        onClick={cancelRecording}
                        className="icon-btn"
                        title="İptal Et"
                        style={{ color: '#ff4d4d' }}
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                      </button>

                      <button 
                        type="button" 
                        onClick={stopRecording}
                        className="send-btn"
                        title="Kaydı Bitir ve Gönder"
                        style={{ backgroundColor: '#25D366', border: 'none', color: '#fff', padding: '6px 12px', borderRadius: '20px', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}
                      >
                        Gönder
                      </button>
                    </div>
                  ) : (
                    <>
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
                        {(typedMessage.trim() || selectedImageFile || replyToMessage) ? (
                          <button type="submit" className="send-btn">Gönder</button>
                        ) : (
                          <>
                            <input 
                              type="file" 
                              ref={fileInputRef} 
                              style={{ display: 'none' }} 
                              accept="image/*" 
                              onChange={handleImageUpload} 
                            />
                            <input 
                              type="file" 
                              ref={voiceFileInputRef} 
                              style={{ display: 'none' }} 
                              accept="audio/*" 
                              onChange={handleVoiceFileUpload} 
                            />
                            
                            <button 
                              type="button" 
                              className="icon-btn" 
                              title="Resim Ekle" 
                              disabled={isUploadingImage}
                              onClick={() => fileInputRef.current?.click()}
                              style={{ position: 'relative' }}
                            >
                              {isUploadingImage ? (
                                <svg className="refresh-spinning" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                                </svg>
                              ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                  <circle cx="8.5" cy="8.5" r="1.5"></circle>
                                  <polyline points="21 15 16 10 5 21"></polyline>
                                </svg>
                              )}
                            </button>

                            <button 
                              type="button" 
                              className="icon-btn" 
                              title="Ses Dosyası Yükle" 
                              disabled={isUploadingVoice}
                              onClick={() => voiceFileInputRef.current?.click()}
                              style={{ position: 'relative' }}
                            >
                              {isUploadingVoice ? (
                                <svg className="refresh-spinning" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                                </svg>
                              ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M9 18V5l12-2v13"></path>
                                  <circle cx="6" cy="18" r="3"></circle>
                                  <circle cx="18" cy="16" r="3"></circle>
                                </svg>
                              )}
                            </button>

                            <button 
                              type="button" 
                              className="icon-btn" 
                              title="Ses Kaydet" 
                              onClick={startRecording}
                            >
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>
                                <path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
                                <line x1="12" y1="19" x2="12" y2="23"></line>
                                <line x1="8" y1="23" x2="16" y2="23"></line>
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
                    </>
                  )}
                </div>
              </form>
            )}
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

      {/* MOBILE & VOICE RECORDING STYLES INJECTOR */}
      <style jsx global>{`
        @media (max-width: 768px) {
          #mobile-back-btn {
            display: flex !important;
          }
        }
        @keyframes pulse {
          0% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.2); opacity: 0.5; }
          100% { transform: scale(1); opacity: 1; }
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
                <button
                  type="button"
                  onClick={() => setSettingsTab('automation')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: settingsTab === 'automation' ? 'var(--accent-color)' : 'var(--text-muted)',
                    padding: '8px 4px 12px 4px',
                    fontSize: '13px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    position: 'relative',
                    transition: 'all 0.2s ease',
                    outline: 'none'
                  }}
                >
                  Otomasyon Ayarları
                  {settingsTab === 'automation' && (
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
                  onClick={() => setSettingsTab('ai')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: settingsTab === 'ai' ? 'var(--accent-color)' : 'var(--text-muted)',
                    padding: '8px 4px 12px 4px',
                    fontSize: '13px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    position: 'relative',
                    transition: 'all 0.2s ease',
                    outline: 'none'
                  }}
                >
                  Yapay Zeka (AI)
                  {settingsTab === 'ai' && (
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
                          background: '#38bdf8',
                          boxShadow: '0 0 8px rgba(56, 189, 248, 0.6)',
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
              ) : settingsTab === 'activities' ? (
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
                            background: 'rgba(0, 168, 255, 0.12)',
                            border: '1px solid rgba(0, 168, 255, 0.25)',
                            color: '#38bdf8',
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
                              e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                              e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isLoggingOutSession) {
                              e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                              e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
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
                                    color: '#fff',
                                    background: 'rgba(255, 255, 255, 0.08)',
                                    border: '1px solid rgba(255, 255, 255, 0.15)',
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
                                <span style={{ color: session.is_active ? '#fff' : 'var(--text-muted)' }}>
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
                                  background: 'rgba(0, 168, 255, 0.12)',
                                  border: '1px solid rgba(0, 168, 255, 0.25)',
                                  color: '#38bdf8',
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
                                    e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                                    e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (!isLoggingOutSession) {
                                    e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                                    e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
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
              ) : settingsTab === 'ai' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', paddingBottom: '20px' }}>
                  {/* Bilgi Kartı */}
                  <div style={{
                    background: 'rgba(56, 189, 248, 0.05)',
                    border: '1px solid rgba(56, 189, 248, 0.15)',
                    borderRadius: '16px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                  }}>
                    <h4 style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      🤖 Yapay Zeka (AI) Asistanı
                    </h4>
                    <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                      Gelen Instagram DM'lerine OpenRouter üzerinden otomatik ve akıllı yanıtlar yazılmasını sağlar. 
                      Bu asistan, <strong>insansı görüldü (seen) simulation</strong> tamamlandıktan sonra devreye girer; 
                      önce görüldü atar, ardından 6-10 saniye boyunca "yazıyor..." ibaresini gösterir ve mesajı gönderir.
                    </p>
                  </div>

                  {/* Asistan Aktif mi? */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}>
                    <div>
                      <h4 style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#fff' }}>Asistanı Etkinleştir</h4>
                      <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: 'var(--text-muted)' }}>
                        Aktif edildiğinde gelen doğrudan mesajlar yapay zeka tarafından cevaplanır (Sadece 1-1 sohbetler).
                      </p>
                    </div>
                    <label style={{
                      position: 'relative',
                      display: 'inline-block',
                      width: '46px',
                      height: '24px',
                      cursor: 'pointer'
                    }}>
                      <input 
                        type="checkbox" 
                        checked={autoSettings.ai_assistant_enabled}
                        onChange={(e) => setAutoSettings({ ...autoSettings, ai_assistant_enabled: e.target.checked })}
                        style={{ opacity: 0, width: 0, height: 0 }}
                      />
                      <span style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        borderRadius: '34px',
                        transition: '0.3s',
                        backgroundColor: autoSettings.ai_assistant_enabled ? '#38bdf8' : 'rgba(255, 255, 255, 0.1)'
                      }}>
                        <span style={{
                          position: 'absolute',
                          content: '""',
                          height: '18px',
                          width: '18px',
                          left: '3px',
                          bottom: '3px',
                          backgroundColor: '#fff',
                          borderRadius: '50%',
                          transition: '0.3s',
                          transform: autoSettings.ai_assistant_enabled ? 'translateX(22px)' : 'translateX(0)'
                        }} />
                      </span>
                    </label>
                  </div>

                  {/* API Anahtarı ve Model */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '14px'
                  }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: '#fff', marginBottom: '6px' }}>
                        OpenRouter API Key
                      </label>
                      <input
                        type="password"
                        placeholder="sk-or-v1-..."
                        value={autoSettings.ai_api_key}
                        onChange={(e) => setAutoSettings({ ...autoSettings, ai_api_key: e.target.value })}
                        style={{
                          width: '100%',
                          height: '38px',
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                          borderRadius: '8px',
                          color: '#fff',
                          padding: '0 12px',
                          fontSize: '12px',
                          outline: 'none'
                        }}
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: '#fff', marginBottom: '6px' }}>
                        Model Kimliği (Model ID)
                      </label>
                      <input
                        type="text"
                        placeholder="openrouter/free"
                        value={autoSettings.ai_model}
                        onChange={(e) => setAutoSettings({ ...autoSettings, ai_model: e.target.value })}
                        style={{
                          width: '100%',
                          height: '38px',
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                          borderRadius: '8px',
                          color: '#fff',
                          padding: '0 12px',
                          fontSize: '12px',
                          outline: 'none',
                          fontFamily: 'monospace'
                        }}
                      />
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                        {[
                          { label: 'Otomatik Ücretsiz Model (Önerilen)', id: 'openrouter/free' },
                          { label: 'Llama 3.3 70B (Ücretsiz)', id: 'meta-llama/llama-3.3-70b-instruct:free' },
                          { label: 'Hermes 3 405B (En Zeki)', id: 'nousresearch/hermes-3-llama-3.1-405b:free' },
                          { label: 'Llama 3.2 3B (Hızlı)', id: 'meta-llama/llama-3.2-3b-instruct:free' }
                        ].map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => setAutoSettings({ ...autoSettings, ai_model: m.id })}
                            style={{
                              background: autoSettings.ai_model === m.id ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                              border: autoSettings.ai_model === m.id ? '1px solid #38bdf8' : '1px solid rgba(255, 255, 255, 0.06)',
                              borderRadius: '6px',
                              color: autoSettings.ai_model === m.id ? '#38bdf8' : 'var(--text-muted)',
                              padding: '4px 8px',
                              fontSize: '10px',
                              cursor: 'pointer',
                              transition: 'all 0.15s'
                            }}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {/* Yapay Zeka Yanıt Gecikmesi */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                  }}>
                    <div>
                      <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: '700', color: '#fff', marginBottom: '6px' }}>
                        <span>Yapay Zeka Yanıt Gecikmesi (Saniye)</span>
                        <span style={{ color: '#38bdf8', fontFamily: 'monospace' }}>{autoSettings.ai_delay_seconds} Saniye</span>
                      </label>
                      <input
                        type="range"
                        min="0"
                        max="180"
                        step="5"
                        value={autoSettings.ai_delay_seconds}
                        onChange={(e) => setAutoSettings({ ...autoSettings, ai_delay_seconds: Number(e.target.value) })}
                        style={{
                          width: '100%',
                          accentColor: '#38bdf8',
                          cursor: 'pointer'
                        }}
                      />
                      <p style={{ margin: '6px 0 0 0', fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                        Mesaj geldikten sonra görüldü atıp AI cevabı yazılana kadar beklenecek süre. 
                        <strong>Test için 10-20 saniye</strong>, normal kullanımda ise spam koruması için <strong>60 saniye veya daha yüksek</strong> önerilir.
                      </p>
                    </div>
                  </div>

                  {/* Sistem Rolü */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px'
                  }}>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: '#fff' }}>
                      Asistan Rolü ve Talimatları (System Prompt)
                    </label>
                    <p style={{ margin: '0 0 8px 0', fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                      Yapay zekanın üyelerle nasıl konuşacağını belirleyin. Ne söylemesi (veya söylememesi) gerektiğini buraya yazın.
                    </p>
                    <textarea
                      value={autoSettings.ai_system_prompt}
                      onChange={(e) => setAutoSettings({ ...autoSettings, ai_system_prompt: e.target.value })}
                      placeholder="Örn: Sen bir Instagram grup otomasyon asistanısın..."
                      style={{
                        width: '100%',
                        height: '110px',
                        background: 'rgba(255, 255, 255, 0.02)',
                        border: '1px solid rgba(255, 255, 255, 0.06)',
                        borderRadius: '8px',
                        color: '#fff',
                        padding: '10px',
                        fontSize: '12px',
                        lineHeight: '1.4',
                        outline: 'none',
                        resize: 'vertical'
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', paddingBottom: '20px' }}>
                  
                  {/* 1. Main Toggle & Status */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div>
                        <h4 style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#fff' }}>Otomasyonu Etkinleştir</h4>
                        <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: 'var(--text-muted)' }}>
                          Etkinleştirilmediği sürece zamanlanmış arka plan görevleri çalışmaz.
                        </p>
                      </div>
                      <label style={{
                        position: 'relative',
                        display: 'inline-block',
                        width: '46px',
                        height: '24px',
                        cursor: 'pointer'
                      }}>
                        <input 
                          type="checkbox" 
                          checked={autoSettings.enabled}
                          onChange={(e) => {
                            const newEnabled = e.target.checked;
                            setAutoSettings(prev => ({ ...prev, enabled: newEnabled }));
                            handleSaveAutomationSettings({ ...autoSettings, enabled: newEnabled });
                          }}
                          style={{ opacity: 0, width: 0, height: 0 }}
                        />
                        <span style={{
                          position: 'absolute',
                          top: 0, left: 0, right: 0, bottom: 0,
                          backgroundColor: autoSettings.enabled ? 'var(--accent-color)' : 'rgba(255, 255, 255, 0.1)',
                          transition: '.3s',
                          borderRadius: '24px'
                        }}>
                          <span style={{
                            position: 'absolute',
                            content: '""',
                            height: '18px',
                            width: '18px',
                            left: '3px',
                            bottom: '3px',
                            backgroundColor: 'white',
                            transition: '.3s',
                            borderRadius: '50%',
                            transform: autoSettings.enabled ? 'translateX(22px)' : 'translateX(0)'
                          }} />
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* 2. Automatic Actions Card */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}>
                    <h5 style={{ margin: 0, fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>OTOMATİK EYLEMLER</h5>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#fff', cursor: 'pointer' }}>
                      <input 
                        type="checkbox"
                        checked={autoSettings.auto_dm_enabled}
                        onChange={(e) => setAutoSettings(prev => ({ ...prev, auto_dm_enabled: e.target.checked }))}
                      />
                      Eksiklere Otomatik DM At
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#fff', cursor: 'pointer' }}>
                      <input 
                        type="checkbox"
                        checked={autoSettings.auto_group_report_enabled}
                        onChange={(e) => setAutoSettings(prev => ({ ...prev, auto_group_report_enabled: e.target.checked }))}
                      />
                      Gruba Eksikler Listesini At
                    </label>
                  </div>

                  {/* Öncelikli Paylaşım Yapan Üye Seçimi */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}>
                    <h5 style={{ margin: 0, fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>ÖNCELİKLİ PAYLAŞIM YAPAN ÜYE (OPSİYONEL)</h5>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <input 
                        type="text"
                        placeholder="Örn: kullanıcı_adı"
                        value={autoSettings.target_username}
                        onChange={(e) => setAutoSettings(prev => ({ ...prev, target_username: e.target.value }))}
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '8px',
                          padding: '8px 12px',
                          color: '#fff',
                          fontSize: '13px'
                        }}
                      />
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        Eğer bu üye belirlenen günde paylaşım yaptıysa, tarama için öncelikle onun paylaşımı seçilir.
                      </span>
                    </div>
                  </div>
                  {/* Muaf Tutulacak Sabit Kişiler */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}>
                    <h5 style={{ margin: 0, fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>MUAF TUTULACAK SABİT ÜYELER (OPSİYONEL)</h5>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <input 
                        type="text"
                        placeholder="Örn: muaf_kullanici1, muaf_kullanici2"
                        value={autoSettings.exempt_usernames}
                        onChange={(e) => setAutoSettings(prev => ({ ...prev, exempt_usernames: e.target.value }))}
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '8px',
                          padding: '8px 12px',
                          color: '#fff',
                          fontSize: '13px'
                        }}
                      />
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        Virgülle ayırarak muaf tutmak istediğiniz kullanıcı adlarını yazın. Bu kullanıcılar eksik kontrollerinde taranmaz ve uyarılmaz.
                      </span>
                    </div>
                  </div>

                  {/* Tarama Tarihi Seçimi (Dün / Bugün) */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}>
                    <h5 style={{ margin: 0, fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>TARAMA YAPILACAK TARİH (DÜN / BUGÜN)</h5>
                    <div style={{ display: 'flex', gap: '24px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#fff', cursor: 'pointer' }}>
                        <input 
                          type="radio" 
                          name="scan_date" 
                          value="yesterday"
                          checked={autoSettings.scan_date === 'yesterday'}
                          onChange={() => setAutoSettings(prev => ({ ...prev, scan_date: 'yesterday' }))}
                        />
                        Dünün Paylaşımlarını Denetle
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#fff', cursor: 'pointer' }}>
                        <input 
                          type="radio" 
                          name="scan_date" 
                          value="today"
                          checked={autoSettings.scan_date === 'today'}
                          onChange={() => setAutoSettings(prev => ({ ...prev, scan_date: 'today' }))}
                        />
                        Bugünün Paylaşımlarını Denetle
                      </label>
                    </div>
                  </div>

                  {/* 3. Scheduling Times (GMT+3 Turkey Time) */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}>
                    <h5 style={{ margin: 0, fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>
                      TARAMA SAATLERİ (GMT+3 TÜRKİYE SAATİ)
                    </h5>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(4, 1fr)',
                      gap: '10px'
                    }}>
                      {autoSettings.check_hours.map((hour, idx) => (
                        <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{idx + 1}. Saat</span>
                          <input 
                            type="time"
                            value={hour}
                            onChange={(e) => {
                              const newHours = [...autoSettings.check_hours];
                              newHours[idx] = e.target.value;
                              setAutoSettings(prev => ({ ...prev, check_hours: newHours }));
                            }}
                            style={{
                              background: 'rgba(255, 255, 255, 0.05)',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '8px',
                              padding: '8px',
                              color: '#fff',
                              fontSize: '13px',
                              textAlign: 'center'
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 4. Delays and Cooldowns settings */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '16px'
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>
                        GRUP MOLA SÜRESİ (DAKİKA)
                      </label>
                      <input 
                        type="number"
                        min="1"
                        max="60"
                        value={autoSettings.break_minutes}
                        onChange={(e) => setAutoSettings(prev => ({ ...prev, break_minutes: parseInt(e.target.value) || 5 }))}
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '8px',
                          padding: '8px',
                          color: '#fff',
                          fontSize: '13px'
                        }}
                      />
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Grup taramaları arası mola (4-5 dk önerilir).</span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>
                        DM GÖNDERİM ARALIĞI (SANİYE)
                      </label>
                      <input 
                        type="number"
                        min="5"
                        max="300"
                        value={autoSettings.dm_delay_seconds}
                        onChange={(e) => setAutoSettings(prev => ({ ...prev, dm_delay_seconds: parseInt(e.target.value) || 30 }))}
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '8px',
                          padding: '8px',
                          color: '#fff',
                          fontSize: '13px'
                        }}
                      />
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Spama düşmemek için her DM arası gecikme.</span>
                    </div>
                  </div>

                  {/* 5. Group Thread Selection */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                  }}>
                    <h5 style={{ margin: 0, fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>
                      OTOMASYONUN AKTİF OLACAĞI GRUPLAR
                    </h5>
                    <div style={{
                      maxHeight: '220px',
                      overflowY: 'auto',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                      borderRadius: '8px',
                      padding: '8px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      background: 'rgba(0,0,0,0.1)'
                    }}>
                      {threads.filter(t => t.is_group || t.thread_title).length === 0 ? (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px' }}>
                          Hiçbir grup sohbeti bulunamadı.
                        </div>
                      ) : (
                        threads.filter(t => t.is_group || t.thread_title).map(thread => {
                          const isThreadActive = autoSettings.threads.includes(thread.id);
                          const threadCfg = autoSettings.threads_config[thread.id] || { comment_check_enabled: true, like_check_enabled: true, admin_report_enabled: false, admin_username: '', scan_mode: 'all' };
                          
                          return (
                            <div 
                              key={thread.id}
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                padding: '12px 14px',
                                borderRadius: '10px',
                                background: isThreadActive ? 'rgba(255, 255, 255, 0.02)' : 'transparent',
                                border: '1px solid ' + (isThreadActive ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)'),
                                gap: '10px',
                                transition: 'all 0.2s ease-in-out'
                              }}
                            >
                              {/* Main Row: Group Title & Checkbox */}
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#fff', cursor: 'pointer', flex: 1, minWidth: 0 }}>
                                  <input 
                                    type="checkbox"
                                    checked={isThreadActive}
                                    onChange={(e) => {
                                      const checked = e.target.checked;
                                      setAutoSettings(prev => {
                                        const list = [...prev.threads];
                                        if (checked) {
                                          if (!list.includes(thread.id)) list.push(thread.id);
                                        } else {
                                          const idx = list.indexOf(thread.id);
                                          if (idx !== -1) list.splice(idx, 1);
                                        }
                                        return { ...prev, threads: list };
                                      });
                                    }}
                                    style={{
                                      cursor: 'pointer',
                                      width: '15px',
                                      height: '15px',
                                      accentColor: 'var(--accent-color)'
                                    }}
                                  />
                                  <span style={{ 
                                    fontWeight: isThreadActive ? '600' : 'normal', 
                                    color: isThreadActive ? '#fff' : 'rgba(255, 255, 255, 0.7)',
                                    fontSize: '13.5px',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                  }}>
                                    {thread.thread_title || 'İsimsiz Grup'}
                                  </span>
                                </label>
                                
                                {isThreadActive && (
                                  <span style={{
                                    fontSize: '10px',
                                    padding: '3px 8px',
                                    borderRadius: '20px',
                                    background: 'rgba(0, 168, 255, 0.1)',
                                    color: 'var(--accent-color)',
                                    fontWeight: '600',
                                    border: '1px solid rgba(0, 168, 255, 0.2)'
                                  }}>
                                    Aktif
                                  </span>
                                )}
                              </div>

                              {/* Expanded Sub-panel with Settings */}
                              {isThreadActive && (
                                <div style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '10px',
                                  paddingLeft: '25px',
                                  borderLeft: '2px solid rgba(255, 255, 255, 0.08)',
                                  marginTop: '2px',
                                  paddingBottom: '4px'
                                }}>
                                  
                                  {/* Row 1: Checkbox selections (Yorum, Beğeni) + Scan Mode dropdown */}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
                                        <input 
                                          type="checkbox"
                                          checked={threadCfg.comment_check_enabled}
                                          onChange={(e) => {
                                            const val = e.target.checked;
                                            setAutoSettings(prev => {
                                              const nextConfigs = { ...prev.threads_config };
                                              const current = nextConfigs[thread.id] || { comment_check_enabled: true, like_check_enabled: true, admin_report_enabled: false, admin_username: '', scan_mode: 'all' };
                                              nextConfigs[thread.id] = { ...current, comment_check_enabled: val };
                                              return { ...prev, threads_config: nextConfigs };
                                            });
                                          }}
                                          style={{ accentColor: 'var(--accent-color)' }}
                                        />
                                        Yorum Kontrolü
                                      </label>
                                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
                                        <input 
                                          type="checkbox"
                                          checked={threadCfg.like_check_enabled}
                                          onChange={(e) => {
                                            const val = e.target.checked;
                                            setAutoSettings(prev => {
                                              const nextConfigs = { ...prev.threads_config };
                                              const current = nextConfigs[thread.id] || { comment_check_enabled: true, like_check_enabled: true, admin_report_enabled: false, admin_username: '', scan_mode: 'all' };
                                              nextConfigs[thread.id] = { ...current, like_check_enabled: val };
                                              return { ...prev, threads_config: nextConfigs };
                                            });
                                          }}
                                          style={{ accentColor: 'var(--accent-color)' }}
                                        />
                                        Beğeni Kontrolü
                                      </label>
                                    </div>

                                    {/* Scan Mode Dropdown */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', fontWeight: '600' }}>MOD:</span>
                                      <select
                                        value={threadCfg.scan_mode || 'all'}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          setAutoSettings(prev => {
                                            const nextConfigs = { ...prev.threads_config };
                                            const current = nextConfigs[thread.id] || { comment_check_enabled: true, like_check_enabled: true, admin_report_enabled: false, admin_username: '', scan_mode: 'all' };
                                            nextConfigs[thread.id] = { ...current, scan_mode: val };
                                            return { ...prev, threads_config: nextConfigs };
                                          });
                                        }}
                                        style={{
                                          background: 'rgba(255, 255, 255, 0.05)',
                                          border: '1px solid rgba(255, 255, 255, 0.1)',
                                          borderRadius: '6px',
                                          color: '#fff',
                                          fontSize: '11px',
                                          padding: '3px 8px',
                                          outline: 'none',
                                          cursor: 'pointer'
                                        }}
                                      >
                                        <option value="all" style={{ background: '#1c1c1e', color: '#fff' }}>Tüm Üyeler</option>
                                        <option value="participation" style={{ background: '#1c1c1e', color: '#fff' }}>Sadece Katılım</option>
                                      </select>
                                    </div>
                                  </div>

                                  {/* Row 2: Admin Report settings */}
                                  <div style={{ 
                                    display: 'flex', 
                                    alignItems: 'center', 
                                    gap: '8px', 
                                    borderTop: '1px solid rgba(255,255,255,0.04)', 
                                    paddingTop: '8px',
                                    flexWrap: 'wrap'
                                  }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
                                      <input 
                                        type="checkbox"
                                        checked={!!threadCfg.admin_report_enabled}
                                        onChange={(e) => {
                                          const val = e.target.checked;
                                          setAutoSettings(prev => {
                                            const nextConfigs = { ...prev.threads_config };
                                            const current = nextConfigs[thread.id] || { comment_check_enabled: true, like_check_enabled: true, admin_report_enabled: false, admin_username: '', scan_mode: 'all' };
                                            nextConfigs[thread.id] = { ...current, admin_report_enabled: val };
                                            return { ...prev, threads_config: nextConfigs };
                                          });
                                        }}
                                        style={{ accentColor: 'var(--accent-color)' }}
                                      />
                                      Admine Raporla
                                    </label>
                                    {threadCfg.admin_report_enabled && (
                                      <input 
                                        type="text"
                                        placeholder="@admin_kullanici_adi"
                                        value={threadCfg.admin_username || ''}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          setAutoSettings(prev => {
                                            const nextConfigs = { ...prev.threads_config };
                                            const current = nextConfigs[thread.id] || { comment_check_enabled: true, like_check_enabled: true, admin_report_enabled: false, admin_username: '', scan_mode: 'all' };
                                            nextConfigs[thread.id] = { ...current, admin_username: val };
                                            return { ...prev, threads_config: nextConfigs };
                                          });
                                        }}
                                        style={{
                                          background: 'rgba(255, 255, 255, 0.05)',
                                          border: '1px solid rgba(255, 255, 255, 0.1)',
                                          borderRadius: '6px',
                                          padding: '3px 8px',
                                          color: '#fff',
                                          fontSize: '11px',
                                          width: '140px',
                                          outline: 'none'
                                        }}
                                      />
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* 6. Message Templates */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '14px'
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>
                        EKSİKLERE ATILACAK DM KALIBI
                      </label>
                      <textarea
                        rows={3}
                        value={autoSettings.dm_template}
                        onChange={(e) => setAutoSettings(prev => ({ ...prev, dm_template: e.target.value }))}
                        placeholder="Merhaba @{username}, paylaşılan gönderiye beğeni/yorumlarınızı rica ederiz: {link}"
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '8px',
                          padding: '10px',
                          color: '#fff',
                          fontSize: '13px',
                          resize: 'vertical',
                          fontFamily: 'inherit'
                        }}
                      />
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        Değişkenler: <strong>{"{username}"}</strong> (kullanıcı adı), <strong>{"{link}"}</strong> (gönderi linki), <strong>{"{grup_ismi}"}</strong> (grup adı).
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>
                        EKSİĞİ %50'DEN FAZLA OLANLARA ATILACAK DM KALIBI (LİNK OLMADAN)
                      </label>
                      <textarea
                        rows={2}
                        value={autoSettings.dm_bulk_template}
                        onChange={(e) => setAutoSettings(prev => ({ ...prev, dm_bulk_template: e.target.value }))}
                        placeholder="Merhaba {grup_ismi} grubunda eksiğiniz var dönüş yapmanız gerekiyor"
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '8px',
                          padding: '10px',
                          color: '#fff',
                          fontSize: '13px',
                          resize: 'vertical',
                          fontFamily: 'inherit'
                        }}
                      />
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        Değişkenler: <strong>{"{username}"}</strong>, <strong>{"{grup_ismi}"}</strong> (grup adı). Bu mesaj, eksik oranı %50'den fazla olan üyelere link listesi yerine tek parça gönderilir.
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>
                        GRUBA GÖNDERİLECEK EKSİK LİSTESİ KALIBI
                      </label>
                      <textarea
                        rows={3}
                        value={autoSettings.group_report_template}
                        onChange={(e) => setAutoSettings(prev => ({ ...prev, group_report_template: e.target.value }))}
                        placeholder="Beğeni/Yorum yapmayan üyeler:\n{missing_users}"
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '8px',
                          padding: '10px',
                          color: '#fff',
                          fontSize: '13px',
                          resize: 'vertical',
                          fontFamily: 'inherit'
                        }}
                      />
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        Değişkenler: <strong>{"{missing_users}"}</strong> (etiketlenmiş eksik üyeler).
                      </span>
                    </div>
                  </div>

                  {/* 7. Trigger Now Panel */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: '16px'
                  }}>
                    <div>
                      <h4 style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#fff' }}>Test Taraması Başlat</h4>
                      <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>
                        Zamanlama saatini beklemeden otomasyon kontrolünü şu an manuel tetikler.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleTriggerAutomationManual}
                      disabled={isTriggeringAutomation || !autoSettings.enabled}
                      style={{
                        background: 'rgba(0, 168, 255, 0.12)',
                        border: '1px solid rgba(0, 168, 255, 0.25)',
                        color: '#38bdf8',
                        fontSize: '12px',
                        fontWeight: '700',
                        padding: '10px 16px',
                        borderRadius: '8px',
                        cursor: (!autoSettings.enabled || isTriggeringAutomation) ? 'not-allowed' : 'pointer',
                        opacity: (!autoSettings.enabled || isTriggeringAutomation) ? 0.6 : 1,
                        transition: 'all 0.2s'
                      }}
                      onMouseEnter={(e) => {
                        if (autoSettings.enabled && !isTriggeringAutomation) {
                          e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                          e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (autoSettings.enabled && !isTriggeringAutomation) {
                          e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                          e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                        }
                      }}
                    >
                      {isTriggeringAutomation ? 'Başlatılıyor...' : 'Şimdi Çalıştır'}
                    </button>
                  </div>

                  {/* 8. Reset States Panel */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: '16px',
                    marginBottom: '16px'
                  }}>
                    <div>
                      <h4 style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#fff' }}>Otomasyon Hareketlerini Sıfırla</h4>
                      <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>
                        Kilitli gönderileri, dünün DM gönderim kayıtlarını ve log geçmişini temizler.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleResetAutomation}
                      disabled={isResettingAutomation}
                      style={{
                        background: 'rgba(0, 168, 255, 0.12)',
                        border: '1px solid rgba(0, 168, 255, 0.25)',
                        color: '#38bdf8',
                        fontSize: '12px',
                        fontWeight: '700',
                        padding: '10px 16px',
                        borderRadius: '8px',
                        cursor: isResettingAutomation ? 'not-allowed' : 'pointer',
                        opacity: isResettingAutomation ? 0.6 : 1,
                        transition: 'all 0.2s'
                      }}
                      onMouseEnter={(e) => {
                        if (!isResettingAutomation) {
                          e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                          e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isResettingAutomation) {
                          e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                          e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                        }
                      }}
                    >
                      {isResettingAutomation ? 'Sıfırlanıyor...' : 'Geçmişi Sıfırla'}
                    </button>
                  </div>

                  {/* 8b. Undo Actions Panel */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: '16px',
                    marginBottom: '16px'
                  }}>
                    <div>
                      <h4 style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#fff' }}>Son İşlemleri Geri Al (Mesajları Sil)</h4>
                      <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>
                        Son çalışmada gönderilen tüm DM linklerini, uyarıları ve grup raporunu karşı taraftan geri alır (mesajları siler).
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleUndoAutomation}
                      disabled={isUndoingAutomation}
                      style={{
                        background: 'rgba(0, 168, 255, 0.12)',
                        border: '1px solid rgba(0, 168, 255, 0.25)',
                        color: '#38bdf8',
                        fontSize: '12px',
                        fontWeight: '700',
                        padding: '10px 16px',
                        borderRadius: '8px',
                        cursor: isUndoingAutomation ? 'not-allowed' : 'pointer',
                        opacity: isUndoingAutomation ? 0.6 : 1,
                        transition: 'all 0.2s'
                      }}
                      onMouseEnter={(e) => {
                        if (!isUndoingAutomation) {
                          e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                          e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isUndoingAutomation) {
                          e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                          e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                        }
                      }}
                    >
                      {isUndoingAutomation ? 'Geri Alınıyor...' : 'İşlemleri Geri Al'}
                    </button>
                  </div>

                  {/* 9. Execution Logs List */}
                  <div style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <h5 style={{ margin: 0, fontSize: '12px', fontWeight: '700', color: 'var(--accent-color)' }}>
                        OTOMASYON HAREKET LOGLARI (SON 100)
                      </h5>
                      <button
                        type="button"
                        onClick={fetchAutomationLogs}
                        disabled={isLogsLoading}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#0095f6',
                          fontSize: '11px',
                          fontWeight: '700',
                          cursor: 'pointer',
                          padding: '2px 6px'
                        }}
                      >
                        {isLogsLoading ? 'Güncelleniyor...' : 'Yenile'}
                      </button>
                    </div>

                    <div style={{
                      maxHeight: '260px',
                      overflowY: 'auto',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '12px',
                      background: 'rgba(0, 0, 0, 0.25)',
                      padding: '12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.2)'
                    }}>
                      {automationLogs.length === 0 ? (
                        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                          Henüz hiçbir hareket logu bulunmuyor.
                        </div>
                      ) : (
                        automationLogs.map((log: any) => {
                          let badgeBg = 'rgba(0, 168, 255, 0.1)';
                          let badgeBorder = 'rgba(0, 168, 255, 0.2)';
                          let badgeColor = '#38bdf8';
                          let badgeIcon = 'ℹ';
                          let messageColor = 'rgba(255, 255, 255, 0.8)';

                          if (log.type === 'success') {
                            badgeIcon = '✓';
                          } else if (log.type === 'warning') {
                            badgeIcon = '⚠';
                          } else if (log.type === 'error') {
                            badgeIcon = '✗';
                          } else if (log.type === 'info') {
                            badgeIcon = 'ℹ';
                          }

                          let formattedTime = '';
                          try {
                            formattedTime = new Date(log.timestamp).toLocaleString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                          } catch (e) {
                            formattedTime = String(log.timestamp).split(' ')[1] || '';
                          }

                          return (
                            <div 
                              key={log.id} 
                              style={{ 
                                display: 'flex', 
                                alignItems: 'flex-start',
                                justifyContent: 'space-between',
                                gap: '12px', 
                                padding: '8px 10px',
                                borderRadius: '8px',
                                background: 'rgba(255, 255, 255, 0.02)',
                                border: '1px solid rgba(255, 255, 255, 0.04)',
                                transition: 'all 0.15s ease'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.04)';
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', flex: 1, minWidth: 0 }}>
                                <div style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: '20px',
                                  height: '20px',
                                  borderRadius: '6px',
                                  fontSize: '11px',
                                  fontWeight: 'bold',
                                  flexShrink: 0,
                                  background: badgeBg,
                                  border: '1px solid ' + badgeBorder,
                                  color: badgeColor
                                }}>
                                  {badgeIcon}
                                </div>
                                <span style={{ 
                                  color: messageColor, 
                                  fontSize: '12px',
                                  lineHeight: '1.4',
                                  wordBreak: 'break-word',
                                  fontFamily: 'system-ui, -apple-system, sans-serif'
                                }}>
                                  {log.message}
                                </span>
                              </div>
                              <span style={{ 
                                color: 'rgba(255,255,255,0.3)', 
                                fontSize: '10.5px',
                                fontFamily: 'monospace',
                                flexShrink: 0,
                                marginTop: '2px'
                              }}>
                                {formattedTime}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                </div>
              )}
            </div>

            <footer className="modal-footer" style={{ display: 'flex', gap: '8px', padding: '16px' }}>
              {settingsTab === 'settings' ? (
                <>
                  <button 
                    type="button" 
                    className="header-btn" 
                    style={{ 
                      background: 'rgba(0, 168, 255, 0.12)',
                      border: '1px solid rgba(0, 168, 255, 0.25)',
                      color: '#38bdf8',
                      fontSize: '12px',
                      fontWeight: '700',
                      padding: '8px 16px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      outline: 'none',
                      marginRight: 'auto'
                    }}
                    onClick={handleResetSettings}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                    }}
                  >
                    Sıfırla
                  </button>
                  
                  <button 
                    type="button" 
                    className="header-btn"
                    style={{ 
                      background: 'rgba(0, 168, 255, 0.12)',
                      border: '1px solid rgba(0, 168, 255, 0.25)',
                      color: '#38bdf8',
                      fontSize: '12px',
                      fontWeight: '700',
                      padding: '8px 16px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      outline: 'none'
                    }}
                    onClick={handleLogout}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                    }}
                  >
                    Çıkış Yap
                  </button>

                  <button 
                    type="button" 
                    className="header-btn" 
                    style={{ 
                      background: 'rgba(0, 168, 255, 0.12)',
                      border: '1px solid rgba(0, 168, 255, 0.25)',
                      color: '#38bdf8',
                      fontSize: '12px',
                      fontWeight: '700',
                      padding: '8px 16px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      outline: 'none'
                    }}
                    onClick={() => setIsSettingsOpen(false)}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                    }}
                  >
                    İptal
                  </button>
                  
                  <button 
                    type="submit" 
                    form="settings-form" 
                    className="header-btn primary"
                    style={{ 
                      background: 'rgba(0, 168, 255, 0.12)',
                      border: '1px solid rgba(0, 168, 255, 0.25)',
                      color: '#38bdf8',
                      fontSize: '12px',
                      fontWeight: '700',
                      padding: '8px 16px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      outline: 'none'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                    }}
                  >
                    Kaydet
                  </button>
                </>
              ) : settingsTab === 'activities' ? (
                <>
                  <button
                    type="button"
                    className="header-btn"
                    style={{ 
                      background: 'rgba(0, 168, 255, 0.12)',
                      border: '1px solid rgba(0, 168, 255, 0.25)',
                      color: '#38bdf8',
                      fontSize: '12px',
                      fontWeight: '700',
                      padding: '8px 16px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      outline: 'none',
                      marginRight: 'auto'
                    }}
                    onClick={fetchLoginSessions}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                    }}
                  >
                    Yenile
                  </button>
                  <button 
                    type="button" 
                    className="header-btn primary" 
                    style={{ 
                      background: 'rgba(0, 168, 255, 0.12)',
                      border: '1px solid rgba(0, 168, 255, 0.25)',
                      color: '#38bdf8',
                      fontSize: '12px',
                      fontWeight: '700',
                      padding: '8px 16px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      outline: 'none'
                    }}
                    onClick={() => setIsSettingsOpen(false)}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                    }}
                  >
                    Kapat
                  </button>
                </>
              ) : (
                <>
                  {settingsTab === 'automation' && (
                    <button
                      type="button"
                      className="header-btn"
                      style={{ 
                        background: 'rgba(0, 168, 255, 0.12)',
                        border: '1px solid rgba(0, 168, 255, 0.25)',
                        color: '#38bdf8',
                        fontSize: '12px',
                        fontWeight: '700',
                        padding: '8px 16px',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        outline: 'none',
                        marginRight: 'auto'
                      }}
                      onClick={fetchAutomationLogs}
                      disabled={isLogsLoading}
                      onMouseEnter={(e) => {
                        if (!isLogsLoading) {
                          e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                          e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isLogsLoading) {
                          e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                          e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                        }
                      }}
                    >
                      Logları Yenile
                    </button>
                  )}
                  {settingsTab === 'ai' && <div style={{ marginRight: 'auto' }} />}
                  <button 
                    type="button" 
                    className="header-btn" 
                    style={{ 
                      background: 'rgba(0, 168, 255, 0.12)',
                      border: '1px solid rgba(0, 168, 255, 0.25)',
                      color: '#38bdf8',
                      fontSize: '12px',
                      fontWeight: '700',
                      padding: '8px 16px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      outline: 'none'
                    }}
                    onClick={() => setIsSettingsOpen(false)}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                      e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                    }}
                  >
                    İptal
                  </button>
                  <button
                    type="button"
                    className="header-btn primary"
                    style={{ 
                      background: 'rgba(0, 168, 255, 0.12)',
                      border: '1px solid rgba(0, 168, 255, 0.25)',
                      color: '#38bdf8',
                      fontSize: '12px',
                      fontWeight: '700',
                      padding: '8px 16px',
                      borderRadius: '8px',
                      cursor: isSavingAutomation ? 'not-allowed' : 'pointer',
                      opacity: isSavingAutomation ? 0.6 : 1,
                      transition: 'all 0.2s',
                      outline: 'none'
                    }}
                    onClick={() => handleSaveAutomationSettings()}
                    disabled={isSavingAutomation}
                    onMouseEnter={(e) => {
                      if (!isSavingAutomation) {
                        e.currentTarget.style.background = 'rgba(0, 168, 255, 0.22)';
                        e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.4)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isSavingAutomation) {
                        e.currentTarget.style.background = 'rgba(0, 168, 255, 0.12)';
                        e.currentTarget.style.borderColor = 'rgba(0, 168, 255, 0.25)';
                      }
                    }}
                  >
                    {isSavingAutomation ? 'Kaydediliyor...' : 'Otomasyonu Kaydet'}
                  </button>
                </>
              )}
            </footer>

          </div>
        </div>
      )}

      {/* NEW MESSAGE MODAL */}
      {isNewMessageModalOpen && (
        <div className="modal-backdrop" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10100 }} onClick={() => setIsNewMessageModalOpen(false)}>
          <div style={{
            background: 'rgba(30, 30, 30, 0.96)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '12px',
            width: '440px',
            height: '560px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 20px 40px rgba(0,0,0,0.6)'
          }} onClick={(e) => e.stopPropagation()}>
            
            {/* Header */}
            <header style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <span style={{ fontSize: '16px', fontWeight: '700', color: '#fff' }}>Yeni Mesaj</span>
              <button 
                onClick={() => setIsNewMessageModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255,255,255,0.6)',
                  cursor: 'pointer',
                  padding: '4px'
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </header>

            {/* Search Input */}
            <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
              <input 
                type="text"
                value={newMessageSearchQuery}
                onChange={(e) => setNewMessageSearchQuery(e.target.value)}
                placeholder="Kişi Ara..."
                style={{
                  width: '100%',
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '10px 14px',
                  color: '#fff',
                  fontSize: '13px',
                  outline: 'none'
                }}
              />
            </div>

            {/* Results Area */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }} className="custom-scrollbar">
              {(() => {
                if (isNewMessageSearching) {
                  return (
                    <div style={{ padding: '40px 20px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.4)' }}>
                      <svg className="refresh-spinning" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ margin: '0 auto' }}>
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                      </svg>
                      <div style={{ marginTop: '8px', fontSize: '13px' }}>Aranıyor...</div>
                    </div>
                  );
                }

                // If searching, render searched users
                if (newMessageSearchQuery.trim()) {
                  if (newMessageSearchResults.length === 0) {
                    return (
                      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.4)', fontSize: '13px' }}>
                        Sonuç bulunamadı.
                      </div>
                    );
                  }

                  return newMessageSearchResults.map(user => {
                    const id = user.pk || user.share_sheet_item_id;
                    const displayName = user.full_name || user.username;
                    const avatar = user.profile_pic_url;

                    return (
                      <div 
                        key={id}
                        onClick={() => {
                          const existingThread = threads.find(t => 
                            !t.is_group && t.users?.some(u => String(u.pk || u.id) === String(user.pk))
                          );
                          if (existingThread) {
                            setActiveThreadId(existingThread.id);
                          } else {
                            // Create temporary optimistic thread
                            const tempThreadId = `temp_${user.pk}`;
                            const tempThread: InstagramThread = {
                              id: tempThreadId,
                              thread_fbid: tempThreadId,
                              thread_id: tempThreadId,
                              thread_key: tempThreadId,
                              thread_title: displayName,
                              is_group: false,
                              is_pin: false,
                              is_muted: false,
                              marked_as_unread: false,
                              last_activity_timestamp_ms: String(Date.now()),
                              folder: 'PRIMARY',
                              users: [{
                                id: String(user.pk),
                                interop_messaging_user_fbid: String(user.pk),
                                pk: String(user.pk),
                                username: user.username,
                                full_name: user.full_name,
                                profile_pic_url: user.profile_pic_url || '',
                                is_verified: user.is_verified || false
                              }],
                              viewer: {
                                id: cookiesRef.current['ds_user_id'] || '',
                                interop_messaging_user_fbid: cookiesRef.current['ds_user_id'] || '',
                                profile_pic_url: '',
                                viewer_id: cookiesRef.current['ds_user_id'] || ''
                              },
                              slide_messages: { edges: [] }
                            };
                            setThreads(prev => [tempThread, ...prev]);
                            setActiveThreadId(tempThreadId);
                          }
                          setIsNewMessageModalOpen(false);
                          setNewMessageSearchQuery('');
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          padding: '10px 20px',
                          cursor: 'pointer',
                          transition: 'background 0.2s'
                        }}
                        className="new-message-item"
                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <img 
                          src={avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80"}
                          alt={displayName}
                          style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }}
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80";
                          }}
                        />
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ fontSize: '13px', fontWeight: '600', color: '#fff' }}>{displayName}</span>
                            {user.is_verified && (
                              <span style={{ color: '#0095f6', display: 'flex', alignItems: 'center' }} title="Onaylı Hesap">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"></path>
                                </svg>
                              </span>
                            )}
                          </div>
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>@{user.username}</span>
                        </div>
                      </div>
                    );
                  });
                }

                // If not searching, render Null State suggested contacts list
                return (
                  <>
                    {isFetchingSuggested ? (
                      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.4)' }}>
                        <svg className="refresh-spinning" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ margin: '0 auto' }}>
                          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                        </svg>
                        <div style={{ marginTop: '8px', fontSize: '12px' }}>Öneriler yükleniyor...</div>
                      </div>
                    ) : suggestedContacts.length > 0 ? (
                      <>
                        <div style={{ padding: '6px 20px 8px 20px', fontSize: '11px', fontWeight: '700', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          Önerilen Kişiler
                        </div>
                        {suggestedContacts.map(user => {
                          const id = user.pk || user.share_sheet_item_id;
                          const displayName = user.full_name || user.username;
                          const avatar = user.profile_pic_url;

                          return (
                            <div 
                              key={id}
                              onClick={() => {
                                const existingThread = threads.find(t => 
                                  !t.is_group && t.users?.some(u => String(u.pk || u.id) === String(user.pk))
                                );
                                if (existingThread) {
                                  setActiveThreadId(existingThread.id);
                                } else {
                                  // Create temporary optimistic thread
                                  const tempThreadId = `temp_${user.pk}`;
                                  const tempThread: InstagramThread = {
                                    id: tempThreadId,
                                    thread_fbid: tempThreadId,
                                    thread_id: tempThreadId,
                                    thread_key: tempThreadId,
                                    thread_title: displayName,
                                    is_group: false,
                                    is_pin: false,
                                    is_muted: false,
                                    marked_as_unread: false,
                                    last_activity_timestamp_ms: String(Date.now()),
                                    folder: 'PRIMARY',
                                    users: [{
                                      id: String(user.pk),
                                      interop_messaging_user_fbid: String(user.pk),
                                      pk: String(user.pk),
                                      username: user.username,
                                      full_name: user.full_name,
                                      profile_pic_url: user.profile_pic_url || '',
                                      is_verified: user.is_verified || false
                                    }],
                                    viewer: {
                                      id: cookiesRef.current['ds_user_id'] || '',
                                      interop_messaging_user_fbid: cookiesRef.current['ds_user_id'] || '',
                                      profile_pic_url: '',
                                      viewer_id: cookiesRef.current['ds_user_id'] || ''
                                    },
                                    slide_messages: { edges: [] }
                                  };
                                  setThreads(prev => [tempThread, ...prev]);
                                  setActiveThreadId(tempThreadId);
                                }
                                setIsNewMessageModalOpen(false);
                                setNewMessageSearchQuery('');
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '12px',
                                padding: '10px 20px',
                                cursor: 'pointer',
                                transition: 'background 0.2s'
                              }}
                              className="new-message-item"
                              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)'}
                              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                              <img 
                                src={avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80"}
                                child-src=""
                                alt={displayName}
                                style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }}
                                onError={(e) => {
                                  (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80";
                                }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                  <span style={{ fontSize: '13px', fontWeight: '600', color: '#fff' }}>{displayName}</span>
                                  {user.is_verified && (
                                    <span style={{ color: '#0095f6', display: 'flex', alignItems: 'center' }} title="Onaylı Hesap">
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"></path>
                                      </svg>
                                    </span>
                                  )}
                                </div>
                                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>@{user.username}</span>
                              </div>
                            </div>
                          );
                        })}
                      </>
                    ) : (
                      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.4)', fontSize: '13px' }}>
                        Önerilen kişi bulunamadı.
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

          </div>
        </div>
      )}

      {/* FORWARD MESSAGE MODAL */}
      {isForwardModalOpen && (
        <div className="modal-backdrop" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10100 }} onClick={() => setIsForwardModalOpen(false)}>
          <div style={{
            background: 'rgba(30, 30, 30, 0.96)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '12px',
            width: '440px',
            height: '560px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 20px 40px rgba(0,0,0,0.6)'
          }} onClick={(e) => e.stopPropagation()}>
            
            {/* Header */}
            <header style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <span style={{ fontSize: '16px', fontWeight: '700', color: '#fff' }}>Yönlendir</span>
              <button 
                onClick={() => setIsForwardModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255, 255, 255, 0.6)',
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'color 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.color = '#fff'}
                onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)'}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </header>

            {/* Token Field / Search */}
            <div style={{
              padding: '12px 20px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: '600', color: '#fff' }}>Kime:</span>
                <input 
                  type="text"
                  placeholder="Ara..."
                  value={forwardSearchQuery}
                  onChange={(e) => setForwardSearchQuery(e.target.value)}
                  style={{
                    flex: 1,
                    background: 'none',
                    border: 'none',
                    color: '#fff',
                    fontSize: '13px',
                    outline: 'none',
                    padding: '4px 0'
                  }}
                />
              </div>
              
              {/* Selected recipient tokens list */}
              {Object.keys(forwardSelectedRecipients).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '72px', overflowY: 'auto', paddingBottom: '4px' }}>
                  {Object.values(forwardSelectedRecipients).map(recipient => {
                    return (
                      <div 
                        key={recipient.id}
                        style={{
                          background: 'rgba(0, 149, 246, 0.15)',
                          border: '1px solid rgba(0, 149, 246, 0.3)',
                          borderRadius: '16px',
                          padding: '3px 10px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          fontSize: '12px',
                          color: '#38bdf8'
                        }}
                      >
                        <span>{recipient.name}</span>
                        <button 
                          onClick={() => {
                            setForwardSelectedRecipients(prev => {
                              const copy = { ...prev };
                              delete copy[recipient.id];
                              return copy;
                            });
                          }}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#38bdf8',
                            cursor: 'pointer',
                            padding: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '14px',
                            lineHeight: 1
                          }}
                        >
                          &times;
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Message Preview */}
            <div style={{
              background: 'rgba(0, 0, 0, 0.2)',
              padding: '10px 20px',
              fontSize: '12px',
              color: 'rgba(255, 255, 255, 0.5)',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <span style={{ fontWeight: '600' }}>Yönlendirilen Mesaj:</span>
              <span style={{
                color: '#fff',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1
              }} title={forwardMessageText}>
                {forwardMessageText}
              </span>
            </div>

            {/* Recipient list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }}>
              {(() => {
                if (isForwardSearching) {
                  return (
                    <div style={{ padding: '40px 20px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.4)' }}>
                      <svg className="refresh-spinning" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ margin: '0 auto' }}>
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                      </svg>
                      <div style={{ marginTop: '8px', fontSize: '13px' }}>Aranıyor...</div>
                    </div>
                  );
                }

                // If searching, render results from the API
                if (forwardSearchQuery.trim()) {
                  const users = forwardSearchResults.users || [];
                  const threadsFromSearch = forwardSearchResults.threads || [];

                  if (users.length === 0 && threadsFromSearch.length === 0) {
                    return (
                      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.4)', fontSize: '13px' }}>
                        Sonuç bulunamadı.
                      </div>
                    );
                  }

                  return (
                    <>
                      {/* Threads section */}
                      {threadsFromSearch.map(thread => {
                        const id = thread.thread_id || thread.share_sheet_item_id;
                        const displayName = thread.thread_title || 'Grup Sohbeti';
                        const avatar = thread.thread_image_url || thread.users?.[0]?.profile_pic_url;
                        const isSelected = !!forwardSelectedRecipients[id];

                        return (
                          <div 
                            key={id}
                            onClick={() => {
                              setForwardSelectedRecipients(prev => {
                                const copy = { ...prev };
                                if (copy[id]) {
                                  delete copy[id];
                                } else {
                                  if (Object.keys(copy).length >= 5) {
                                    alert('Aynı anda en fazla 5 kişiye mesaj yönlendirebilirsiniz.');
                                    return prev;
                                  }
                                  copy[id] = { id, name: displayName, avatar: avatar || undefined };
                                }
                                return copy;
                              });
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '8px 20px',
                              cursor: 'pointer',
                              background: isSelected ? 'rgba(255, 255, 255, 0.03)' : 'transparent',
                              transition: 'background 0.2s'
                            }}
                            onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.015)'; }}
                            onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <img 
                                src={avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80"}
                                alt={displayName}
                                style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }}
                                onError={(e) => {
                                  (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80";
                                }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ fontSize: '13px', fontWeight: '600', color: '#fff' }}>{displayName}</span>
                                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>Grup Sohbeti</span>
                              </div>
                            </div>

                            <div style={{
                              width: '20px',
                              height: '20px',
                              borderRadius: '50%',
                              border: isSelected ? 'none' : '2.5px solid rgba(255, 255, 255, 0.2)',
                              background: isSelected ? '#0095f6' : 'transparent',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              transition: 'all 0.2s'
                            }}>
                              {isSelected && (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12"></polyline>
                                </svg>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {/* Users section */}
                      {users.map(user => {
                        const id = user.share_sheet_item_id || user.pk;
                        const displayName = user.full_name || user.username;
                        const avatar = user.profile_pic_url;
                        const isSelected = !!forwardSelectedRecipients[id];

                        return (
                          <div 
                            key={id}
                            onClick={() => {
                              setForwardSelectedRecipients(prev => {
                                const copy = { ...prev };
                                if (copy[id]) {
                                  delete copy[id];
                                } else {
                                  if (Object.keys(copy).length >= 5) {
                                    alert('Aynı anda en fazla 5 kişiye mesaj yönlendirebilirsiniz.');
                                    return prev;
                                  }
                                  copy[id] = { id, name: displayName, avatar: avatar || undefined };
                                }
                                return copy;
                              });
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '8px 20px',
                              cursor: 'pointer',
                              background: isSelected ? 'rgba(255, 255, 255, 0.03)' : 'transparent',
                              transition: 'background 0.2s'
                            }}
                            onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.015)'; }}
                            onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <img 
                                src={avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80"}
                                alt={displayName}
                                style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }}
                                onError={(e) => {
                                  (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80";
                                }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                  <span style={{ fontSize: '13px', fontWeight: '600', color: '#fff' }}>{displayName}</span>
                                  {user.is_verified && (
                                    <span style={{ color: '#0095f6', display: 'flex', alignItems: 'center' }} title="Onaylı Hesap">
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"></path>
                                      </svg>
                                    </span>
                                  )}
                                </div>
                                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>@{user.username}</span>
                              </div>
                            </div>

                            <div style={{
                              width: '20px',
                              height: '20px',
                              borderRadius: '50%',
                              border: isSelected ? 'none' : '2.5px solid rgba(255, 255, 255, 0.2)',
                              background: isSelected ? '#0095f6' : 'transparent',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              transition: 'all 0.2s'
                            }}>
                              {isSelected && (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12"></polyline>
                                </svg>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </>
                  );
                }

                // Default local list with suggested contacts support
                const eligibleThreads = threads.filter(t => t.folder !== 'PENDING');
                
                return (
                  <>
                    {/* Recent Chats Section */}
                    {eligibleThreads.length > 0 && (
                      <>
                        <div style={{ padding: '12px 20px 6px 20px', fontSize: '11px', fontWeight: '700', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          Son Sohbetler
                        </div>
                        {eligibleThreads.map(thread => {
                          const partner = thread.users?.[0] || { full_name: thread.thread_title, username: '', profile_pic_url: '' };
                          const displayName = thread.is_group
                            ? (thread.thread_title || 'Grup Sohbeti')
                            : (partner.full_name || partner.username);
                          const isSelected = !!forwardSelectedRecipients[thread.id];
                          const avatar = thread.is_group ? thread.thread_image_url : partner.profile_pic_url;

                          return (
                            <div 
                              key={thread.id}
                              onClick={() => {
                                setForwardSelectedRecipients(prev => {
                                  const copy = { ...prev };
                                  if (copy[thread.id]) {
                                    delete copy[thread.id];
                                  } else {
                                    if (Object.keys(copy).length >= 5) {
                                      alert('Aynı anda en fazla 5 kişiye mesaj yönlendirebilirsiniz.');
                                      return prev;
                                    }
                                    copy[thread.id] = { id: thread.id, name: displayName, avatar: avatar || undefined };
                                  }
                                  return copy;
                                });
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '8px 20px',
                                cursor: 'pointer',
                                background: isSelected ? 'rgba(255, 255, 255, 0.03)' : 'transparent',
                                transition: 'background 0.2s'
                              }}
                              onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.015)'; }}
                              onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <img 
                                  src={avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80"}
                                  alt={displayName}
                                  style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }}
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80";
                                  }}
                                />
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <span style={{ fontSize: '13px', fontWeight: '600', color: '#fff' }}>{displayName}</span>
                                  <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
                                    {thread.is_group ? 'Grup Sohbeti' : `@${partner.username || 'user'}`}
                                  </span>
                                </div>
                              </div>

                              <div style={{
                                width: '20px',
                                height: '20px',
                                borderRadius: '50%',
                                border: isSelected ? 'none' : '2.5px solid rgba(255, 255, 255, 0.2)',
                                background: isSelected ? '#0095f6' : 'transparent',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'all 0.2s'
                              }}>
                                {isSelected && (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12"></polyline>
                                  </svg>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </>
                    )}

                    {/* Suggested Contacts Section */}
                    {isFetchingSuggested ? (
                      <div style={{ padding: '20px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.3)' }}>
                        <svg className="refresh-spinning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ margin: '0 auto' }}>
                          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                        </svg>
                        <div style={{ marginTop: '6px', fontSize: '11px' }}>Öneriler yükleniyor...</div>
                      </div>
                    ) : suggestedContacts.length > 0 && (
                      <>
                        <div style={{ padding: '16px 20px 6px 20px', fontSize: '11px', fontWeight: '700', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          Önerilen Kişiler
                        </div>
                        {suggestedContacts.map(user => {
                          const id = user.share_sheet_item_id || user.pk;
                          const displayName = user.full_name || user.username;
                          const avatar = user.profile_pic_url;
                          const isSelected = !!forwardSelectedRecipients[id];

                          return (
                            <div 
                              key={id}
                              onClick={() => {
                                setForwardSelectedRecipients(prev => {
                                  const copy = { ...prev };
                                  if (copy[id]) {
                                    delete copy[id];
                                  } else {
                                    if (Object.keys(copy).length >= 5) {
                                      alert('Aynı anda en fazla 5 kişiye mesaj yönlendirebilirsiniz.');
                                      return prev;
                                    }
                                    copy[id] = { id, name: displayName, avatar: avatar || undefined };
                                  }
                                  return copy;
                                });
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '8px 20px',
                                cursor: 'pointer',
                                background: isSelected ? 'rgba(255, 255, 255, 0.03)' : 'transparent',
                                transition: 'background 0.2s'
                              }}
                              onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.015)'; }}
                              onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <img 
                                  src={avatar || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80"}
                                  alt={displayName}
                                  style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }}
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=80&h=80&fit=crop&q=80";
                                  }}
                                />
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <span style={{ fontSize: '13px', fontWeight: '600', color: '#fff' }}>{displayName}</span>
                                    {user.is_verified && (
                                      <span style={{ color: '#0095f6', display: 'flex', alignItems: 'center' }} title="Onaylı Hesap">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"></path>
                                        </svg>
                                      </span>
                                    )}
                                  </div>
                                  <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>@{user.username}</span>
                                </div>
                              </div>

                              <div style={{
                                width: '20px',
                                height: '20px',
                                borderRadius: '50%',
                                border: isSelected ? 'none' : '2.5px solid rgba(255, 255, 255, 0.2)',
                                background: isSelected ? '#0095f6' : 'transparent',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'all 0.2s'
                              }}>
                                {isSelected && (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12"></polyline>
                                  </svg>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </>
                    )}

                    {eligibleThreads.length === 0 && suggestedContacts.length === 0 && !isFetchingSuggested && (
                      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'rgba(255, 255, 255, 0.4)', fontSize: '13px' }}>
                        Sohbet bulunamadı.
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* Send Bar */}
            <div style={{
              padding: '16px 20px',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              justifyContent: 'flex-end'
            }}>
              <button 
                disabled={Object.keys(forwardSelectedRecipients).length === 0 || isForwardingInProgress}
                onClick={handleForwardMessage}
                style={{
                  width: '100%',
                  padding: '10px 0',
                  background: Object.keys(forwardSelectedRecipients).length === 0 ? 'rgba(0, 149, 246, 0.4)' : '#0095f6',
                  color: Object.keys(forwardSelectedRecipients).length === 0 ? 'rgba(255, 255, 255, 0.5)' : '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: Object.keys(forwardSelectedRecipients).length === 0 || isForwardingInProgress ? 'not-allowed' : 'pointer',
                  transition: 'background 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px'
                }}
                onMouseEnter={(e) => {
                  if (Object.keys(forwardSelectedRecipients).length > 0 && !isForwardingInProgress) {
                    e.currentTarget.style.background = '#1877f2';
                  }
                }}
                onMouseLeave={(e) => {
                  if (Object.keys(forwardSelectedRecipients).length > 0 && !isForwardingInProgress) {
                    e.currentTarget.style.background = '#0095f6';
                  }
                }}
              >
                {isForwardingInProgress ? (
                  <>
                    <svg className="refresh-spinning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                    </svg>
                    <span>Yönlendiriliyor...</span>
                  </>
                ) : (
                  <span>Gönder ({Object.keys(forwardSelectedRecipients).length})</span>
                )}
              </button>
            </div>

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

          {(() => {
            const isPinned = threads.find(t => t.id === threadContextMenu.threadId)?.is_pin || false;
            return (
              <button 
                onClick={() => {
                  handlePinThread(threadContextMenu.threadId, !isPinned);
                  setThreadContextMenu(prev => ({ ...prev, visible: false }));
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
                  transition: 'background 0.2s',
                  marginTop: '2px'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a8a8a8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(45deg)' }}>
                  <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"></path>
                </svg>
                {isPinned ? 'Sabitlemeyi Kaldır' : 'Sohbeti Sabitle'}
              </button>
            );
          })()}

          {(() => {
            const thread = threads.find(t => t.id === threadContextMenu.threadId);
            const isUnread = thread?.marked_as_unread || false;
            return (
              <button 
                onClick={() => {
                  handleMarkUnread(threadContextMenu.threadId, !isUnread);
                  setThreadContextMenu(prev => ({ ...prev, visible: false }));
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
                  transition: 'background 0.2s',
                  marginTop: '2px'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  {isUnread ? null : <circle cx="12" cy="12" r="3" fill="#60a5fa"></circle>}
                </svg>
                {isUnread ? 'Okundu Olarak İşaretle' : 'Okunmadı Olarak İşaretle'}
              </button>
            );
          })()}

          {(() => {
            const thread = threads.find(t => t.id === threadContextMenu.threadId);
            const isMuted = thread?.is_muted || false;
            return (
              <button 
                onClick={() => {
                  handleMuteThread(threadContextMenu.threadId, isMuted ? 0 : -1);
                  setThreadContextMenu(prev => ({ ...prev, visible: false }));
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
                  transition: 'background 0.2s',
                  marginTop: '2px'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a8a8a8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  {isMuted ? (
                    <>
                      <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
                      <line x1="23" y1="9" x2="17" y2="15"></line>
                      <line x1="17" y1="9" x2="23" y2="15"></line>
                    </>
                  ) : (
                    <>
                      <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                    </>
                  )}
                </svg>
                {isMuted ? 'Sohbetin Sesini Aç' : 'Sohbeti Sessize Al'}
              </button>
            );
          })()}

          <button 
            onClick={() => {
              handleDeleteThread(threadContextMenu.threadId);
              setThreadContextMenu(prev => ({ ...prev, visible: false }));
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
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.12)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
            Sohbeti Sil / Gizle
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
          {msgContextMenu.message?.content_type === 'TEXT' && (
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
          )}

          <button 
            onClick={() => {
              if (msgContextMenu.message) {
                setReplyToMessage(msgContextMenu.message);
              }
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
              <polyline points="9 17 4 12 9 7"></polyline>
              <path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>
            </svg>
            Yanıtla
          </button>

          {msgContextMenu.message?.content_type === 'TEXT' && (
            <button 
              onClick={() => {
                setForwardMessageText(msgContextMenu.text);
                setForwardSelectedRecipients({});
                setForwardSearchQuery('');
                setIsForwardModalOpen(true);
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
                transition: 'background 0.2s',
                marginTop: '2px'
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
              Yönlendir...
            </button>
          )}

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

      {/* User Profile Details Modal */}
      {isUserProfileModalOpen && (
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
        }} onClick={() => setIsUserProfileModalOpen(false)}>
          
          <div style={{
            background: '#1c1c1e',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            width: '400px',
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
              <span style={{ fontSize: '15px', fontWeight: '700', color: '#fff' }}>Kişi Bilgileri</span>
              <button 
                onClick={() => setIsUserProfileModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255,255,255,0.5)',
                  cursor: 'pointer',
                  padding: '4px'
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            {/* Modal Content */}
            <div style={{ padding: '24px 20px', overflowY: 'auto' }} className="custom-scrollbar">
              {isFetchingUserProfile ? (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'rgba(255,255,255,0.4)' }}>
                  <svg className="refresh-spinning" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ margin: '0 auto' }}>
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                  </svg>
                  <div style={{ marginTop: '12px', fontSize: '13px' }}>Profil detayları yükleniyor...</div>
                </div>
              ) : userProfileData ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
                  {/* Avatar */}
                  <img 
                    src={userProfileData.hd_profile_pic_url_info?.url || userProfileData.profile_pic_url}
                    alt={userProfileData.username}
                    style={{
                      width: '90px',
                      height: '90px',
                      borderRadius: '50%',
                      border: '2px solid rgba(255,255,255,0.1)',
                      marginBottom: '16px',
                      objectFit: 'cover'
                    }}
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&h=150&fit=crop&q=80";
                    }}
                  />

                  {/* Name & Username */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <span style={{ fontSize: '18px', fontWeight: '700', color: '#fff' }}>
                      {userProfileData.full_name || userProfileData.username}
                    </span>
                    {userProfileData.is_verified && (
                      <span style={{ color: '#0095f6', display: 'flex', alignItems: 'center' }} title="Onaylı Hesap">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"></path>
                        </svg>
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)', marginBottom: '16px' }}>
                    @{userProfileData.username}
                  </span>

                  {/* Stats Grid */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-around',
                    width: '100%',
                    background: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: '12px',
                    padding: '12px 8px',
                    marginBottom: '20px',
                    border: '1px solid rgba(255, 255, 255, 0.05)'
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: '15px', fontWeight: '800', color: '#fff' }}>
                        {userProfileData.media_count?.toLocaleString('tr-TR') || 0}
                      </span>
                      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>Gönderi</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: '15px', fontWeight: '800', color: '#fff' }}>
                        {userProfileData.follower_count?.toLocaleString('tr-TR') || 0}
                      </span>
                      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>Takipçi</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: '15px', fontWeight: '800', color: '#fff' }}>
                        {userProfileData.following_count?.toLocaleString('tr-TR') || 0}
                      </span>
                      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>Takip</span>
                    </div>
                  </div>

                  {/* Bio & Category */}
                  {userProfileData.category && (
                    <span style={{
                      fontSize: '11px',
                      color: 'rgba(255, 255, 255, 0.4)',
                      background: 'rgba(255, 255, 255, 0.06)',
                      padding: '3px 8px',
                      borderRadius: '4px',
                      marginBottom: '10px',
                      fontWeight: '600'
                    }}>
                      {userProfileData.category}
                    </span>
                  )}

                  {userProfileData.biography && (
                    <p style={{
                      fontSize: '13px',
                      color: 'rgba(255,255,255,0.85)',
                      lineHeight: '1.5',
                      whiteSpace: 'pre-wrap',
                      marginBottom: '24px',
                      textAlign: 'center'
                    }}>
                      {userProfileData.biography}
                    </p>
                  )}

                  {/* Buttons */}
                  <div style={{ display: 'flex', gap: '10px', width: '100%' }}>
                    <a
                      href={`https://instagram.com/${userProfileData.username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        flex: 1,
                        background: 'rgba(255, 255, 255, 0.1)',
                        border: '1px solid rgba(255, 255, 255, 0.15)',
                        borderRadius: '8px',
                        color: '#fff',
                        padding: '10px 0',
                        fontSize: '13px',
                        fontWeight: '700',
                        textDecoration: 'none',
                        transition: 'background 0.2s',
                        display: 'inline-block',
                        lineHeight: '36px',
                        height: '38px'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
                    >
                      Profili Aç
                    </a>
                    <button
                      onClick={() => setIsUserProfileModalOpen(false)}
                      style={{
                        flex: 1,
                        background: '#0095f6',
                        border: 'none',
                        borderRadius: '8px',
                        color: '#fff',
                        padding: '10px 0',
                        fontSize: '13px',
                        fontWeight: '700',
                        cursor: 'pointer',
                        transition: 'opacity 0.2s',
                        height: '38px'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                      onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                    >
                      Kapat
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '13px' }}>
                  Profil bilgileri yüklenemedi.
                </div>
              )}
            </div>

          </div>
        </div>
      )}

      {/* Seen Users Modal */}
      {seenListModal.visible && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 11000,
          userSelect: 'none'
        }} onClick={() => setSeenListModal({ visible: false, users: [] })}>
          <div style={{
            background: '#1c1c1e',
            borderRadius: '16px',
            border: '1px solid rgba(255,255,255,0.1)',
            width: '90%',
            maxWidth: '340px',
            padding: '20px',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '16px', fontWeight: '700', color: '#fff' }}>Görenler ({seenListModal.users.length})</span>
              <button 
                onClick={() => setSeenListModal({ visible: false, users: [] })}
                style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: '18px' }}
              >
                ✕
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '300px', overflowY: 'auto' }}>
              {seenListModal.users.map(u => (
                <div key={u.id || u.pk} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <img 
                    src={u.profile_pic_url || "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&q=80"} 
                    alt={u.username}
                    style={{ width: '36px', height: '36px', borderRadius: '50%', objectFit: 'cover' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '14px', fontWeight: '600', color: '#fff' }}>@{u.username}</span>
                    {u.full_name && <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>{u.full_name}</span>}
                  </div>
                </div>
              ))}
            </div>
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

      {/* Error / Alert Modal */}
      {errorModal.isOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10500,
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }} onClick={() => setErrorModal(prev => ({ ...prev, isOpen: false }))}>
          <div style={{
            background: '#1c1c1e',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            width: '400px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          }} onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {errorModal.type === 'error' && (
                  <span style={{ color: '#ff3b30', fontSize: '18px', display: 'flex', alignItems: 'center' }}>
                    ⚠️
                  </span>
                )}
                {errorModal.type === 'warning' && (
                  <span style={{ color: '#ffcc00', fontSize: '18px', display: 'flex', alignItems: 'center' }}>
                    🛡️
                  </span>
                )}
                {errorModal.type === 'info' && (
                  <span style={{ color: '#007aff', fontSize: '18px', display: 'flex', alignItems: 'center' }}>
                    ℹ️
                  </span>
                )}
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#fff' }}>
                  {errorModal.title}
                </h3>
              </div>
              <button 
                onClick={() => setErrorModal(prev => ({ ...prev, isOpen: false }))}
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

            {/* Message Body */}
            <div style={{
              padding: '24px 20px',
              color: 'rgba(255,255,255,0.9)',
              fontSize: '14px',
              lineHeight: '1.5',
            }}>
              {errorModal.message}
            </div>

            {/* Footer */}
            <div style={{
              padding: '12px 20px',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              justifyContent: 'flex-end',
              background: 'rgba(0,0,0,0.1)'
            }}>
              <button 
                onClick={() => setErrorModal(prev => ({ ...prev, isOpen: false }))}
                style={{
                  padding: '8px 24px',
                  background: errorModal.type === 'error' ? '#ff3b30' : (errorModal.type === 'warning' ? '#ff9500' : '#0095f6'),
                  border: 'none',
                  color: '#fff',
                  fontSize: '12px',
                  fontWeight: '700',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.filter = 'brightness(1.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.filter = 'brightness(1)';
                }}
              >
                Tamam
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
