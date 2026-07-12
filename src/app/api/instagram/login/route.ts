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
      let jsonResponse: any;
      try {
        jsonResponse = JSON.parse(responseText);
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

    } else if (method === 'credentials') {
      if (!username || !password) {
        return NextResponse.json({
          success: false,
          error: 'Lütfen kullanıcı adı ve şifrenizi girin.'
        }, { status: 400 });
      }

      console.log(`[Login-API] Attempting credentials login for user: ${username}`);
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
