export interface InstagramUser {
  id: string;
  interop_messaging_user_fbid: string;
  full_name: string;
  username: string;
  profile_pic_url: string;
  is_verified?: boolean;
  pk?: string;
}

export interface InstagramMessage {
  id: string;
  item_id?: string;
  sender_fbid: string;
  timestamp_ms: string;
  content: {
    __typename: string;
    text_body: string;
  };
  content_type: string;
  igd_snippet: string;
  text_body: string;
  media_preview_url?: string | null;
  media_video_url?: string | null;
  media_title?: string | null;
  media_author?: string | null;
  media_type?: 'clip' | 'media_share' | 'story_share' | 'voice_media' | 'photo' | 'video' | 'link' | null;
  media_id?: string | null;
  like_count?: number | null;
  comment_count?: number | null;
  reactions?: {
    reaction: string;
    sender_fbid: string;
    reaction_timestamp_ms?: string;
  }[] | null;
  reply_to_message?: {
    id: string;
    text_body: string;
    sender_fbid?: string;
    content_type?: string;
  } | null;
  client_context?: string | null;
}

export interface InstagramThread {
  id: string;
  thread_fbid: string;
  thread_id: string;
  thread_key: string;
  thread_title: string;
  folder: string;
  is_group: boolean;
  is_muted: boolean;
  is_pin: boolean;
  last_activity_timestamp_ms: string;
  marked_as_unread: boolean;
  slide_messages: {
    edges: Array<{
      node: InstagramMessage;
    }>;
  };
  users: InstagramUser[];
  viewer: {
    id: string;
    interop_messaging_user_fbid: string;
    profile_pic_url: string;
    viewer_id: string;
  };
  last_seen_watermark_ms?: string | null;
  thread_image_url?: string | null;
  admin_user_ids?: string[];
}

export const MOCK_RESPONSE = {
  data: {
    get_slide_mailbox_for_iris_subscription: {
      id: "17842376945110023",
      iris_inactive_subscription_uq_seq_id: "351325",
      pinned_threads_v2: [],
      threads_by_folder: {
        edges: [
          {
            cursor: "AQHS2iAJ9R...",
            node: {
              id: "1048269596575956",
              thread_fbid: "1048269596575956",
              thread_id: "340282366841710301244259223287173662932",
              thread_key: "102801404456118",
              thread_title: "Doğadan Kadrajlar",
              folder: "PRIMARY",
              is_group: false,
              is_muted: false,
              is_pin: false,
              last_activity_timestamp_ms: "1783078650779",
              marked_as_unread: false,
              slide_messages: {
                edges: [
                  {
                    node: {
                      id: "mid.$cAD8-80ry4LGlWQpLm2fJ8T-YsOHC",
                      sender_fbid: "17842376945110023", // Viewer
                      timestamp_ms: "1783078650779",
                      content: {
                        __typename: "SlideMessageText",
                        text_body: "merhaba mesaj 2"
                      },
                      content_type: "TEXT",
                      igd_snippet: "Sen: merhaba mesaj 2",
                      text_body: "merhaba mesaj 2"
                    }
                  },
                  {
                    node: {
                      id: "mid.$cAD8-80ry4LGlWQpLm2fJ8T-YsOHB",
                      sender_fbid: "17842376945110023", // Viewer
                      timestamp_ms: "1783078627355",
                      content: {
                        __typename: "SlideMessageText",
                        text_body: "merhaba"
                      },
                      content_type: "TEXT",
                      igd_snippet: "Sen: merhaba",
                      text_body: "merhaba"
                    }
                  },
                  {
                    node: {
                      id: "mid.$cAD8-80ry4LGlWQpLm2fJ8T-YsOHA",
                      sender_fbid: "102801404456118", // User
                      timestamp_ms: "1779208457497",
                      content: {
                        __typename: "SlideMessageText",
                        text_body: "Harika fotoğraflar paylaşıyorsunuz! Tebrikler."
                      },
                      content_type: "TEXT",
                      igd_snippet: "Harika fotoğraflar paylaşıyorsunuz!",
                      text_body: "Harika fotoğraflar paylaşıyorsunuz! Tebrikler."
                    }
                  }
                ].reverse() // Show in order of time (oldest first for rendering, or we can sort them in code)
              },
              users: [
                {
                  id: "1477991204",
                  interop_messaging_user_fbid: "102801404456118",
                  full_name: "Doğadan Kadrajlar",
                  username: "seghob",
                  profile_pic_url: "https://images.unsplash.com/photo-1542224566-6e85f2e6772f?w=150&h=150&fit=crop&q=80",
                  is_verified: false
                }
              ],
              viewer: {
                id: "33205094022",
                interop_messaging_user_fbid: "17842376945110023",
                profile_pic_url: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&h=150&fit=crop&q=80",
                viewer_id: "33205094022"
              }
            } as InstagramThread
          },
          {
            cursor: "AQHS2iAJ9R_mock2",
            node: {
              id: "1048269596575957",
              thread_fbid: "1048269596575957",
              thread_id: "340282366841710301244259223287173662933",
              thread_key: "102801404456119",
              thread_title: "Melisa Yalçın",
              folder: "PRIMARY",
              is_group: false,
              is_muted: false,
              is_pin: true,
              last_activity_timestamp_ms: "1783082531000",
              marked_as_unread: true,
              slide_messages: {
                edges: [
                  {
                    node: {
                      id: "mid.$cAD8-80ry4LGlWQpLm2fJ8T-YsOHD",
                      sender_fbid: "102801404456119",
                      timestamp_ms: "1783082531000",
                      content: {
                        __typename: "SlideMessageText",
                        text_body: "Son paylaştığın projeyi çok beğendim, kodlarına bakabilir miyim?"
                      },
                      content_type: "TEXT",
                      igd_snippet: "Melisa: Son paylaştığın projeyi...",
                      text_body: "Son paylaştığın projeyi çok beğendim, kodlarına bakabilir miyim?"
                    }
                  }
                ]
              },
              users: [
                {
                  id: "1477991205",
                  interop_messaging_user_fbid: "102801404456119",
                  full_name: "Melisa Yalçın",
                  username: "melisaylcn",
                  profile_pic_url: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&h=150&fit=crop&q=80",
                  is_verified: false
                }
              ],
              viewer: {
                id: "33205094022",
                interop_messaging_user_fbid: "17842376945110023",
                profile_pic_url: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&h=150&fit=crop&q=80",
                viewer_id: "33205094022"
              }
            } as InstagramThread
          },
          {
            cursor: "AQHS2iAJ9R_mock3",
            node: {
              id: "1048269596575958",
              thread_fbid: "1048269596575958",
              thread_id: "340282366841710301244259223287173662934",
              thread_key: "102801404456120",
              thread_title: "Tech Inside",
              folder: "PRIMARY",
              is_group: false,
              is_muted: false,
              is_pin: false,
              last_activity_timestamp_ms: "1783061200000",
              marked_as_unread: false,
              slide_messages: {
                edges: [
                  {
                    node: {
                      id: "mid.$cAD8-80ry4LGlWQpLm2fJ8T-YsOHE",
                      sender_fbid: "17842376945110023",
                      timestamp_ms: "1783061100000",
                      content: {
                        __typename: "SlideMessageText",
                        text_body: "Harika, davetiniz için teşekkür ederim!"
                      },
                      content_type: "TEXT",
                      igd_snippet: "Sen: Harika, davetiniz için teşekkür...",
                      text_body: "Harika, davetiniz için teşekkür ederim!"
                    }
                  },
                  {
                    node: {
                      id: "mid.$cAD8-80ry4LGlWQpLm2fJ8T-YsOHF",
                      sender_fbid: "102801404456120",
                      timestamp_ms: "1783061200000",
                      content: {
                        __typename: "SlideMessageText",
                        text_body: "Merhaba! Önümüzdeki hafta düzenleyeceğimiz yapay zeka paneline konuşmacı olarak katılmak ister misiniz?"
                      },
                      content_type: "TEXT",
                      igd_snippet: "Tech Inside: Merhaba! Önümüzdeki hafta...",
                      text_body: "Merhaba! Önümüzdeki hafta düzenleyeceğimiz yapay zeka paneline konuşmacı olarak katılmak ister misiniz?"
                    }
                  }
                ].reverse()
              },
              users: [
                {
                  id: "1477991206",
                  interop_messaging_user_fbid: "102801404456120",
                  full_name: "Tech Inside",
                  username: "techinside",
                  profile_pic_url: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150&h=150&fit=crop&q=80",
                  is_verified: true
                }
              ],
              viewer: {
                id: "33205094022",
                interop_messaging_user_fbid: "17842376945110023",
                profile_pic_url: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&h=150&fit=crop&q=80",
                viewer_id: "33205094022"
              }
            } as InstagramThread
          }
        ]
      }
    }
  }
};
