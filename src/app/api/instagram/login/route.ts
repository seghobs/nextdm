import { NextRequest, NextResponse } from 'next/server';
import { IgApiClientExt } from 'instagram_mqtt';
import { parseCurlCommand } from '@/lib/curl-parser';
import { DEFAULT_COOKIES, DEFAULT_HEADERS, DEFAULT_DATA } from '@/lib/instagram-defaults';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { method, curl, username, password } = body;

    if (method === 'curl') {
      if (!curl) {
        return NextResponse.json({
          success: false,
          error: 'Lütfen curl komutunu yapıştırın.'
        }, { status: 400 });
      }

      // 1. Parse the pasted curl command
      const parsed = parseCurlCommand(curl);
      if (!parsed.cookies || !parsed.headers) {
        return NextResponse.json({
          success: false,
          error: 'Curl komutu ayrıştırılamadı. Lütfen geçerli bir curl yapıştırın.'
        }, { status: 400 });
      }
      // 1.5. If the cURL already contains an active sessionid, import it directly!
      if (parsed.cookies.sessionid) {
        console.log('[Login-API] Paste contains active sessionid. Importing immediately without network check.');
        return NextResponse.json({
          success: true,
          message: 'Oturum bilgileri cURL komutundan başarıyla alındı!',
          cookies: parsed.cookies,
          headers: {
            ...DEFAULT_HEADERS,
            ...parsed.headers,
            'cookie': Object.entries(parsed.cookies).map(([n, v]) => `${n}=${v}`).join('; ')
          },
          postData: {
            ...DEFAULT_DATA,
            ...parsed.postData
          }
        });
      }
      // 2. Prepare headers and body for execution
      const cookieHeaderStr = Object.entries(parsed.cookies)
        .map(([name, val]) => `${name}=${val}`)
        .join('; ');

      const headersToSend: Record<string, string> = {
        ...DEFAULT_HEADERS,
        ...parsed.headers,
        'cookie': cookieHeaderStr,
        'content-type': 'application/x-www-form-urlencoded',
      };

      const formBody = new URLSearchParams();
      Object.entries({ ...DEFAULT_DATA, ...parsed.postData }).forEach(([key, val]) => {
        formBody.append(key, String(val));
      });

      console.log('[Login-API] Executing parsed login mutation against Instagram...');

      // 3. Make the login POST request
      const response = await fetch('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: headersToSend,
        body: formBody.toString(),
        cache: 'no-store'
      });

      const responseText = await response.text();
      const cleanResponseText = responseText.startsWith('for (;;);') ? responseText.substring('for (;;);'.length) : responseText;
      let jsonResponse: any;
      try {
        jsonResponse = JSON.parse(cleanResponseText);
      } catch (e) {
        console.error('Failed to parse Instagram login response:', responseText);
        return NextResponse.json({
          success: false,
          error: 'Instagram sunucusundan geçersiz yanıt alındı.',
          details: responseText.slice(0, 500)
        }, { status: 502 });
      }

      const caaLoginWeb = jsonResponse?.data?.caa_login_web;
      
      // 4. Validate login status
      if (caaLoginWeb && caaLoginWeb.error_message) {
        const errorText = caaLoginWeb.error_message.text || 'Giriş bilgileri hatalı.';
        return NextResponse.json({
          success: false,
          error: errorText,
          details: caaLoginWeb
        });
      }

      const isAuthenticated = caaLoginWeb?.ig_authenticated === true || response.headers.getSetCookie().some(c => c.includes('sessionid'));

      if (!isAuthenticated) {
        return NextResponse.json({
          success: false,
          error: 'Giriş yapılamadı. Lütfen bilgilerinizi kontrol edip tekrar deneyin.'
        });
      }

      // 5. Extract updated cookies from set-cookie headers
      const setCookieHeaders = response.headers.getSetCookie();
      const updatedCookies = { ...parsed.cookies };
      if (setCookieHeaders && setCookieHeaders.length > 0) {
        setCookieHeaders.forEach(cookieStr => {
          const parts = cookieStr.split(';')[0].split('=');
          if (parts.length >= 2) {
            const name = parts[0].trim();
            const val = parts.slice(1).join('=').trim();
            updatedCookies[name] = val;
          }
        });
      }

      return NextResponse.json({
        success: true,
        message: 'Giriş başarıyla yapıldı!',
        cookies: updatedCookies,
        headers: {
          ...DEFAULT_HEADERS,
          ...parsed.headers,
          'cookie': Object.entries(updatedCookies).map(([n, v]) => `${n}=${v}`).join('; ')
        },
        postData: {
          ...DEFAULT_DATA,
          ...parsed.postData
        }
      });

    } else if (method === 'magic_link') {
      const { magicLink } = body;
      if (!magicLink) {
        return NextResponse.json({
          success: false,
          error: 'Lütfen e-posta giriş bağlantısını yapıştırın.'
        }, { status: 400 });
      }

      console.log(`[Login-API] Attempting Magic Link login...`);

      // 1. Parse uid and token from magicLink
      let uid: string | null = null;
      let token: string | null = null;
      try {
        const urlObj = new URL(magicLink.trim());
        uid = urlObj.searchParams.get('uid');
        token = urlObj.searchParams.get('token');
      } catch (err) {
        // Fallback search if URL parsing fails
        const uidMatch = magicLink.match(/[?&]uid=([^&]+)/);
        const tokenMatch = magicLink.match(/[?&]token=([^&]+)/);
        if (uidMatch) uid = uidMatch[1];
        if (tokenMatch) token = tokenMatch[1];
      }

      if (!uid || !token) {
        return NextResponse.json({
          success: false,
          error: 'Geçersiz giriş bağlantısı. Linkin "uid" ve "token" parametrelerini içerdiğinden emin olun.'
        }, { status: 400 });
      }

      // 2. Fetch Homepage to get initial cookies (ig_did, mid, datr, csrftoken)
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
      const igDid = 'CB6D1686-1E70-420E-8619-955BC0CE7CD7';
      const cookiesMap: Record<string, string> = {
        'ig_did': igDid,
        'mid': 'aefKkQALAAFkyvwqfRF61FrLpNa1',
        'datr': 'kcrnaWmnpEbqRjmZX5EY4wpA',
        'csrftoken': 'kbZXiCsoRBYFNUKX37EJufhInXmfwfqN'
      };

      try {
        console.log('[Login-API] Fetching Instagram homepage to extract initial cookies...');
        const homeRes = await fetch('https://www.instagram.com/', {
          headers: { 'user-agent': userAgent },
          cache: 'no-store'
        });
        const setCookies = homeRes.headers.getSetCookie();
        setCookies.forEach(cookieStr => {
          const parts = cookieStr.split(';')[0].split('=');
          if (parts.length >= 2) {
            cookiesMap[parts[0].trim()] = parts.slice(1).join('=').trim();
          }
        });
      } catch (e) {
        console.warn('[Login-API] Failed to fetch homepage. Using default tokens:', e);
      }

      // 3. Make POST request to one_click_login/
      const cookieHeaderStr = Object.entries(cookiesMap)
        .map(([n, v]) => `${n}=${v}`)
        .join('; ');

      const formBody = new URLSearchParams();
      formBody.append('afv', 'pre_mt_behavior');
      formBody.append('auto_send', '0');
      formBody.append('is_caa', '1');
      formBody.append('landing_site', 'web_emaillogin');
      formBody.append('token', token);
      formBody.append('trustedDeviceRecords', '{}');
      formBody.append('uid', uid);
      formBody.append('jazoest', '22758');

      console.log(`[Login-API] Sending one_click_login request for uid: ${uid}...`);
      const response = await fetch('https://www.instagram.com/api/v1/ig_notifications/one_click_login/', {
        method: 'POST',
        headers: {
          'user-agent': userAgent,
          'accept': '*/*',
          'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrftoken': cookiesMap['csrftoken'],
          'origin': 'https://www.instagram.com',
          'referer': magicLink,
          'cookie': cookieHeaderStr
        },
        body: formBody.toString(),
        cache: 'no-store'
      });

      const responseText = await response.text();
      let jsonResponse: any = null;
      try {
        jsonResponse = JSON.parse(responseText);
      } catch (e) {
        console.error('Failed to parse magic link login response:', responseText);
        return NextResponse.json({
          success: false,
          error: 'Instagram sunucusundan geçersiz yanıt alındı.',
          details: responseText.slice(0, 500)
        }, { status: 502 });
      }

      if (jsonResponse.status !== 'ok') {
        return NextResponse.json({
          success: false,
          error: jsonResponse.message || 'Giriş bağlantısı geçersiz veya süresi dolmuş.',
          details: jsonResponse
        });
      }

      // Extract updated cookies from response headers
      const setCookieHeaders = response.headers.getSetCookie();
      const updatedCookies = { ...cookiesMap };
      if (setCookieHeaders && setCookieHeaders.length > 0) {
        setCookieHeaders.forEach(cookieStr => {
          const parts = cookieStr.split(';')[0].split('=');
          if (parts.length >= 2) {
            const name = parts[0].trim();
            const val = parts.slice(1).join('=').trim();
            updatedCookies[name] = val;
          }
        });
      }

      const isAuthenticated = updatedCookies['sessionid'] ? true : false;
      if (!isAuthenticated) {
        return NextResponse.json({
          success: false,
          error: 'Giriş yapılamadı. Bağlantı geçerli fakat oturum anahtarı alınamadı.'
        });
      }

      // Optional: Visit landing to record session completely
      if (jsonResponse.redirect_url) {
        try {
          const redirectCookieHeader = Object.entries(updatedCookies)
            .map(([n, v]) => `${n}=${v}`)
            .join('; ');
          const landingRes = await fetch(`https://www.instagram.com${jsonResponse.redirect_url}`, {
            headers: {
              'user-agent': userAgent,
              'cookie': redirectCookieHeader
            },
            cache: 'no-store'
          });
          const landingSetCookies = landingRes.headers.getSetCookie();
          landingSetCookies.forEach(cookieStr => {
            const parts = cookieStr.split(';')[0].split('=');
            if (parts.length >= 2) {
              updatedCookies[parts[0].trim()] = parts.slice(1).join('=').trim();
            }
          });
        } catch (e) {
          console.warn('[Login-API] Landing visit failed, skipping:', e);
        }
      }

      return NextResponse.json({
        success: true,
        message: 'Giriş bağlantısı ile başarıyla giriş yapıldı!',
        cookies: updatedCookies,
        headers: {
          ...DEFAULT_HEADERS,
          'cookie': Object.entries(updatedCookies).map(([n, v]) => `${n}=${v}`).join('; ')
        },
        postData: {
          ...DEFAULT_DATA
        }
      });

    } else if (method === 'send_magic_link_email') {
      const { username } = body;
      if (!username) {
        return NextResponse.json({
          success: false,
          error: 'Lütfen kullanıcı adınızı girin.'
        }, { status: 400 });
      }

      console.log(`[Login-API] Requesting Magic Link email via Python curl_cffi for: ${username}...`);

      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const path = await import('path');
        const execFilePromise = promisify(execFile);

        const scriptPath = path.resolve(process.cwd(), 'src', 'lib', 'send_magic_link.py');
        
        // Execute python script
        const { stdout, stderr } = await execFilePromise('python', [scriptPath, username], {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });

        if (stderr) {
          console.warn('[Login-API][Python-stderr]:', stderr);
        }

        const result = JSON.parse(stdout.trim());
        return NextResponse.json(result);
      } catch (err: any) {
        console.error('[Login-API] Python exec error:', err);
        return NextResponse.json({
          success: false,
          error: `Giriş e-postası gönderilemedi: ${err.message || 'Instagram sunucusuna bağlanılamadı.'}`
        });
      }

    } else if (method === 'credentials') {
      if (!username || !password) {
        return NextResponse.json({
          success: false,
          error: 'Lütfen kullanıcı adı ve şifrenizi girin.'
        }, { status: 400 });
      }

      console.log(`[Login-API] Attempting credentials login for user: ${username}`);
      
      // 1. Fetch Instagram Homepage to get initial cookies (csrftoken, mid, ig_did, datr) and tokens (lsd, fb_dtsg)
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
      const igDid = 'CB6D1686-1E70-420E-8619-955BC0CE7CD7';
      
      let lsd = '';
      let fbDtsg = '';
      const cookiesMap: Record<string, string> = {
        'ig_did': igDid,
        'mid': 'aefKkQALAAFkyvwqfRF61FrLpNa1',
        'datr': 'kcrnaWmnpEbqRjmZX5EY4wpA',
        'csrftoken': 'HBN6ZNnObi3Ce3iLS6ebqLyv6tNrhTW0'
      };

      try {
        console.log('[Login-API] Fetching Instagram homepage to extract tokens...');
        const homeRes = await fetch('https://www.instagram.com/?flo=true', {
          headers: {
            'user-agent': userAgent,
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7,de;q=0.6',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1'
          },
          cache: 'no-store'
        });

        const setCookies = homeRes.headers.getSetCookie();
        setCookies.forEach(cookieStr => {
          const parts = cookieStr.split(';')[0].split('=');
          if (parts.length >= 2) {
            cookiesMap[parts[0].trim()] = parts.slice(1).join('=').trim();
          }
        });

        if (homeRes.ok) {
          const html = await homeRes.text();
          const dtsgMatch = html.match(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) || html.match(/"token"\s*:\s*"([^"]+)"/);
          if (dtsgMatch) fbDtsg = dtsgMatch[1];
          
          const lsdMatch = html.match(/"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) || html.match(/"lsd"\s*:\s*"([^"]+)"/);
          if (lsdMatch) lsd = lsdMatch[1];
        }
      } catch (e) {
        console.warn('[Login-API] Failed to fetch homepage. Using default tokens:', e);
      }

      if (!lsd) lsd = 'AdTIm2Y1wQH2Tf1IgzzWbHHy1zs'; // fallback

      // 2. Prepare enc_password
      const timestamp = Math.floor(Date.now() / 1000);
      const encPassword = `#PWD_BROWSER:0:${timestamp}:${password}`;

      // 3. Prepare variables for useCDSWebLoginMutation
      const variables = {
        input: {
          actor_id: "0",
          client_mutation_id: "1",
          access_flow_version: "pre_mt_behavior",
          app: "instagram",
          auth_domain_data_key: null,
          caa_login_request_extra_info: {
            ab_test_data: "",
            shared_prefs_data: "",
            cuid: "",
            guid: "f7dc1e38b42cd908c",
            jazoest: "",
            lgndim: "",
            lgnjs: String(timestamp),
            lgnrnd: "",
            locale: "",
            login_source: "caa_login",
            next: "",
            prefill_contact_point: "",
            prefill_source: "",
            prefill_type: "",
            skstamp: "",
            timezone: "",
            lsd: ""
          },
          credential_type: "password",
          dyi_job_id: "",
          enc_password: {
            sensitive_string_value: encPassword
          },
          event_request_id: "b7d7a717-2355-4c14-a083-9b14dd8fe21e",
          identifier: username,
          ig_web_device_id: cookiesMap['ig_did'],
          initial_request_id: "1",
          lids: null,
          login_source: "DEVICE_BASED_LOGIN",
          next: null,
          password: {
            sensitive_string_value: encPassword
          },
          persistent: true,
          query_params: "{\"flo\":\"true\"}",
          trusted_device_records: "{}",
          use_uid_to_login: true,
          waterfall_id: "54821232-b1a1-4742-8dec-346ae6f784ac"
        },
        scale: 1
      };

      // 4. Send GraphQL Login request
      let webLoginSuccess = false;
      let webLoginCookies: Record<string, string> = {};
      let webLoginHeaders: Record<string, string> = {};

      try {
        console.log(`[Login-API] Attempting browser GraphQL login for user: ${username}`);
        const cookieHeaderStr = Object.entries(cookiesMap)
          .map(([n, v]) => `${n}=${v}`)
          .join('; ');

        const formBody = new URLSearchParams();
        formBody.append('av', '0');
        formBody.append('__d', 'www');
        formBody.append('__user', '0');
        formBody.append('__a', '1');
        formBody.append('__req', 'f');
        formBody.append('__hs', '20646.HYP:instagram_web_pkg.2.1...0');
        formBody.append('dpr', '1');
        formBody.append('__ccg', 'GOOD');
        formBody.append('__rev', '1043037336');
        formBody.append('__s', '4tw2l3:6avxx4:sn1bx6');
        formBody.append('__hsi', '7661745395876667517');
        formBody.append('__comet_req', '7');
        formBody.append('lsd', lsd);
        formBody.append('jazoest', '22332');
        formBody.append('__spin_r', '1043037336');
        formBody.append('__spin_b', 'trunk');
        formBody.append('__spin_t', String(timestamp));
        formBody.append('__crn', 'comet.igweb.PolarisCAAIGLoginHomepageRoute');
        formBody.append('qpl_active_flow_ids', '516759801');
        formBody.append('fb_api_caller_class', 'RelayModern');
        formBody.append('fb_api_req_friendly_name', 'useCDSWebLoginMutation');
        formBody.append('server_timestamps', 'true');
        formBody.append('variables', JSON.stringify(variables));
        formBody.append('doc_id', '9807605492696448');

        const loginRes = await fetch('https://www.instagram.com/api/graphql', {
          method: 'POST',
          headers: {
            'user-agent': userAgent,
            'accept': '*/*',
            'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
            'content-type': 'application/x-www-form-urlencoded',
            'x-fb-friendly-name': 'useCDSWebLoginMutation',
            'x-fb-lsd': lsd,
            'x-ig-app-id': '936619743392459',
            'x-csrftoken': cookiesMap['csrftoken'],
            'origin': 'https://www.instagram.com',
            'referer': 'https://www.instagram.com/?flo=true',
            'cookie': cookieHeaderStr
          },
          body: formBody.toString(),
          cache: 'no-store'
        });

        if (loginRes.ok) {
          const rawText = await loginRes.text();
          const cleanText = rawText.startsWith('for (;;);') ? rawText.substring('for (;;);'.length) : rawText;
          let resJson: any = null;
          try {
            resJson = JSON.parse(cleanText);
          } catch (e) {
            console.error('[Login-API] Failed to parse browser login JSON:', e);
          }
          const caaLoginWeb = resJson?.data?.caa_login_web;
          const setCookiesHeader = loginRes.headers.getSetCookie();
          
          const responseCookies = { ...cookiesMap };
          setCookiesHeader.forEach(cookieStr => {
            const parts = cookieStr.split(';')[0].split('=');
            if (parts.length >= 2) {
              responseCookies[parts[0].trim()] = parts.slice(1).join('=').trim();
            }
          });

          if (caaLoginWeb) {
            if (caaLoginWeb.ig_authenticated === true && responseCookies['sessionid']) {
              webLoginSuccess = true;
              webLoginCookies = responseCookies;
              webLoginHeaders = {
                ...DEFAULT_HEADERS,
                'cookie': Object.entries(responseCookies).map(([n, v]) => `${n}=${v}`).join('; ')
              };
              if (lsd) webLoginHeaders['x-fb-lsd'] = lsd;
              console.log('[Login-API] Browser GraphQL login succeeded! sessionid captured.');
            } else if (caaLoginWeb.error_message) {
              const errMsg = caaLoginWeb.error_message.text || 'Giriş bilgileri hatalı veya bu hesap için güvenlik doğrulaması gerekiyor.';
              console.warn('[Login-API] Browser GraphQL login failed with error:', errMsg);
              return NextResponse.json({
                success: false,
                error: `Instagram Hatası: ${errMsg}`,
                details: caaLoginWeb
              });
            } else if (caaLoginWeb.two_factor_result) {
              console.warn('[Login-API] Browser GraphQL login requires 2FA.');
              return NextResponse.json({
                success: false,
                error: 'Hesabınızda İki Adımlı Doğrulama aktif. Lütfen cURL yöntemiyle giriş yapın.',
                details: caaLoginWeb
              });
            } else {
              console.warn('[Login-API] Browser GraphQL login failed. Response JSON:', resJson);
            }
          } else {
            console.warn('[Login-API] Browser GraphQL login failed. Response JSON:', resJson);
          }
        } else {
          console.warn('[Login-API] Browser GraphQL login request failed. Status:', loginRes.status);
        }
      } catch (e) {
        console.warn('[Login-API] Error during browser GraphQL login attempt:', e);
      }

      if (webLoginSuccess) {
        const responsePostData = {
          ...DEFAULT_DATA,
        };
        if (fbDtsg) responsePostData['fb_dtsg'] = fbDtsg;
        if (lsd) responsePostData['lsd'] = lsd;

        return NextResponse.json({
          success: true,
          message: 'Giriş başarıyla yapıldı!',
          cookies: webLoginCookies,
          headers: webLoginHeaders,
          postData: responsePostData
        });
      }

      console.log('[Login-API] Web GraphQL login failed or bypassed, falling back to legacy MQTT Client...');
      const ig = new IgApiClientExt();

      // Override / wrap ig.request.send to manually capture cookies for Node 24+ compatibility
      const originalSend = ig.request.send;
      ig.request.send = (async function<T = any>(options: any, onlyCheckHttpStatus?: boolean): Promise<any> {
        const response = await originalSend.call(ig.request, options, onlyCheckHttpStatus);
        
        // 1. Standart set-cookie başlıklarını işle
        const setCookieHeaders = response.headers?.['set-cookie'] || response.headers?.['Set-Cookie'];
        if (setCookieHeaders) {
          const cookieArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
          cookieArray.forEach((cookieStr: string) => {
            try {
              ig.state.cookieJar.setCookie(cookieStr, 'https://i.instagram.com');
              ig.state.cookieJar.setCookie(cookieStr, 'https://instagram.com');
            } catch (e) {
              console.warn('[Login-API] Failed to manually set cookie:', cookieStr, e);
            }
          });
        }

        // 2. Mobil API'ye özgü özel yetkilendirme başlığını (Bearer IGT) işle ve çerez havuzuna yaz
        const authHeader = response.headers?.['ig-set-authorization'];
        if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer IGT:2:')) {
          try {
            const base64Token = authHeader.substring('Bearer IGT:2:'.length);
            const decodedJsonStr = Buffer.from(base64Token, 'base64').toString('utf8');
            const parsedToken = JSON.parse(decodedJsonStr);
            
            if (parsedToken.sessionid) {
              ig.state.cookieJar.setCookie(`sessionid=${parsedToken.sessionid}`, 'https://i.instagram.com');
              ig.state.cookieJar.setCookie(`sessionid=${parsedToken.sessionid}`, 'https://instagram.com');
            }
            if (parsedToken.ds_user_id) {
              ig.state.cookieJar.setCookie(`ds_user_id=${parsedToken.ds_user_id}`, 'https://i.instagram.com');
              ig.state.cookieJar.setCookie(`ds_user_id=${parsedToken.ds_user_id}`, 'https://instagram.com');
            }
          } catch (e) {
            console.warn('[Login-API] Failed to parse ig-set-authorization:', e);
          }
        }

        // 3. Mobil API'ye özgü mid başlığını işle
        const midHeader = response.headers?.['ig-set-x-mid'];
        if (midHeader && typeof midHeader === 'string') {
          try {
            ig.state.cookieJar.setCookie(`mid=${midHeader}`, 'https://i.instagram.com');
            ig.state.cookieJar.setCookie(`mid=${midHeader}`, 'https://instagram.com');
          } catch (e) {
            console.warn('[Login-API] Failed to set mid cookie:', e);
          }
        }

        // 4. Mobil API'ye özgü user-id başlığını işle
        const dsUserIdHeader = response.headers?.['ig-set-ig-u-ds-user-id'];
        if (dsUserIdHeader && typeof dsUserIdHeader === 'string') {
          try {
            ig.state.cookieJar.setCookie(`ds_user_id=${dsUserIdHeader}`, 'https://i.instagram.com');
            ig.state.cookieJar.setCookie(`ds_user_id=${dsUserIdHeader}`, 'https://instagram.com');
          } catch (e) {
            console.warn('[Login-API] Failed to set ds_user_id cookie:', e);
          }
        }

        return response;
      }) as any;

      try {
        ig.state.generateDevice(username);
        await ig.simulate.preLoginFlow();
        await ig.account.login(username, password);

        // Extract cookies from tough-cookie store in a domain-independent way
        const extractedCookies: Record<string, string> = {};
        try {
          const serialized = (ig.state.cookieJar as any)._jar.serializeSync();
          const cookiesArray = serialized.cookies || [];
          console.log('[Login-API] Serialized cookies:', cookiesArray.map((c: any) => `${c.key}=${c.value} (${c.domain})`));
          cookiesArray.forEach((c: any) => {
            extractedCookies[c.key] = c.value;
          });
        } catch (e) {
          console.warn('[Login-API] Failed to serialize cookie jar, falling back to getCookies', e);
          // Fallback to getCookies for i.instagram.com and instagram.com
          const urls = ['https://i.instagram.com', 'https://instagram.com'];
          for (const url of urls) {
            const items = ig.state.cookieJar.getCookies(url);
            if (Array.isArray(items)) {
              items.forEach(c => {
                extractedCookies[c.key] = c.value;
              });
            }
          }
        }

        if (!extractedCookies.sessionid) {
          throw new Error('Oturum anahtarı (sessionid) alınamadı.');
        }

        // Fill remaining default cookies
        const mergedCookies = {
          ...DEFAULT_COOKIES,
          ...extractedCookies,
          ds_user_id: extractedCookies.ds_user_id || ig.state.cookieUserId || ''
        };

        const cookieHeaderStr = Object.entries(mergedCookies)
          .map(([n, v]) => `${n}=${v}`)
          .join('; ');

        // Extract DTSG and LSD tokens from the homepage HTML using the cookies
        let fbDtsg = '';
        let lsd = '';
        try {
          console.log('[Login-API] Fetching Instagram homepage to extract DTSG and LSD tokens...');
          const homeResponse = await fetch('https://www.instagram.com/', {
            headers: {
              'cookie': cookieHeaderStr,
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
              'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
            },
            cache: 'no-store'
          });
          
          if (homeResponse.ok) {
            const html = await homeResponse.text();
            
            const dtsgMatch = html.match(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) || html.match(/"token"\s*:\s*"([^"]+)"/);
            if (dtsgMatch) {
              fbDtsg = dtsgMatch[1];
              console.log('[Login-API] Extracted new fb_dtsg:', fbDtsg);
            }
            
            const lsdMatch = html.match(/"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) || html.match(/"lsd"\s*:\s*"([^"]+)"/);
            if (lsdMatch) {
              lsd = lsdMatch[1];
              console.log('[Login-API] Extracted new lsd:', lsd);
            }
          } else {
            console.warn('[Login-API] Failed to fetch homepage. Status:', homeResponse.status);
          }
        } catch (e) {
          console.error('[Login-API] Failed to scrape DTSG/LSD:', e);
        }

        const responseHeaders: Record<string, string> = {
          ...DEFAULT_HEADERS,
          'cookie': cookieHeaderStr
        };
        if (lsd) {
          responseHeaders['x-fb-lsd'] = lsd;
        }

        const responsePostData = {
          ...DEFAULT_DATA,
        };
        if (fbDtsg) {
          responsePostData['fb_dtsg'] = fbDtsg;
        }
        if (lsd) {
          responsePostData['lsd'] = lsd;
        }

        return NextResponse.json({
          success: true,
          message: 'Giriş başarıyla yapıldı!',
          cookies: mergedCookies,
          headers: responseHeaders,
          postData: responsePostData
        });

      } catch (err: any) {
        console.error('[Login-API] Credentials login failed:', err);
        
        let friendlyError = 'Giriş başarısız. Lütfen şifrenizi ve kullanıcı adınızı kontrol edin.';
        if (err.message) {
          if (err.message.includes('challenge_required')) {
            friendlyError = 'İki adımlı doğrulama veya güvenlik onayı gerekiyor. Lütfen cURL yöntemi ile giriş yapın.';
          } else if (err.message.includes('checkpoint_required')) {
            friendlyError = 'Instagram güvenlik kontrolü (checkpoint) gerektiriyor. Lütfen cURL yöntemi ile giriş yapın.';
          } else if (
            err.message.includes('email') || 
            err.message.includes('Forgotten password') || 
            err.message.includes('back into your account') ||
            err.message.includes('bad_password')
          ) {
            friendlyError = 'Instagram bu sunucudan şifreyle girişi engelledi (doğrulama veya e-posta sıfırlama uyarısı tetiklendi). Lütfen cURL yöntemi ile giriş yapın.';
          } else if (err.message.includes('password')) {
            friendlyError = 'Girdiğiniz şifre yanlış. Lütfen şifrenizi kontrol edin.';
          } else {
            friendlyError = `Hata: ${err.message}`;
          }
        }

        return NextResponse.json({
          success: false,
          error: friendlyError
        });
      }

    } else {
      return NextResponse.json({
        success: false,
        error: 'Geçersiz giriş yöntemi belirtildi.'
      }, { status: 400 });
    }

  } catch (error: any) {
    console.error('Error in login proxy route:', error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Sunucu hatası oluştu.'
    }, { status: 500 });
  }
}
