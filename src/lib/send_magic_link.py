import sys
import io
import json
import re
import uuid
import time
from curl_cffi import requests

# Ensure UTF-8 output on Windows
if sys.platform.startswith('win'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

def log_err(msg):
    print(f"[Python-Script] {msg}", file=sys.stderr)

def send_magic_link(username):
    # Setup session with Chrome impersonation to bypass TLS finger-printing
    session = requests.Session(impersonate="chrome124")
    
    # 1. Fetch password reset page to get cookies and LSD token
    url_reset = "https://www.instagram.com/accounts/password/reset/"
    headers_reset = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
    
    log_err(f"Fetching password reset page for cookies/LSD...")
    try:
        r_reset = session.get(url_reset, headers=headers_reset, timeout=15)
        if not r_reset.ok:
            return {"success": False, "error": f"Failed to load reset page: status {r_reset.status_code}"}
        
        html = r_reset.text
        # Extract LSD token
        lsd_match = (
            re.search(r'"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"', html) or
            re.search(r'"lsd"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"', html) or
            re.search(r'"lsd"\s*:\s*"([^"]+)"', html)
        )
        lsd = lsd_match.group(1) if lsd_match else "AdR8_ZPSEhXtXHZZmcOT2Z_q5bc"
        log_err(f"Extracted LSD token: {lsd}")
    except Exception as e:
        log_err(f"Error fetching reset page: {e}")
        return {"success": False, "error": f"Error fetching reset page: {str(e)}"}
    
    # Extract csrftoken cookie
    csrf_token = session.cookies.get("csrftoken") or "kbZXiCsoRBYFNUKX37EJufhInXmfwfqN"
    log_err(f"Extracted csrftoken: {csrf_token}")
    
    # 2. Step 1: CAAIGAccountSearchViewQuery
    event_id = str(uuid.uuid4())
    waterfall_id = str(uuid.uuid4())
    
    search_variables = {
        "params": {
            "event_request_id": event_id,
            "next_uri": "",
            "search_query": username,
            "waterfall_id": waterfall_id
        }
    }
    
    gql_headers = {
        "accept": "*/*",
        "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "content-type": "application/x-www-form-urlencoded",
        "origin": "https://www.instagram.com",
        "referer": "https://www.instagram.com/accounts/password/reset/",
        "x-asbd-id": "359341",
        "x-csrftoken": csrf_token,
        "x-fb-friendly-name": "PolarisDirectInboxMobileQuery",
        "x-fb-lsd": lsd,
        "x-ig-app-id": "1217981644879628",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
    
    timestamp_str = str(int(time.time()))
    
    form_data_1 = {
        "av": "0",
        "__d": "www",
        "__user": "0",
        "__a": "1",
        "__req": "a",
        "__hs": "20649.HYP:instagram_web_pkg.2.1...0",
        "dpr": "1",
        "__ccg": "GOOD",
        "__rev": "1043188201",
        "__s": "zuqfe6:sh5mgo:b7t4yw",
        "__hsi": "7662708204024103304",
        "__comet_req": "7",
        "lsd": lsd,
        "jazoest": "22337",
        "__spin_r": "1043188201",
        "__spin_b": "trunk",
        "__spin_t": timestamp_str,
        "__crn": "comet.igweb.PolarisCAAIGAccountRecoverySearchRoute",
        "qpl_active_flow_ids": "516759801",
        "fb_api_caller_class": "RelayModern",
        "fb_api_req_friendly_name": "CAAIGAccountSearchViewQuery",
        "server_timestamps": "true",
        "variables": json.dumps(search_variables),
        "doc_id": "36716895674620546"
    }
    
    log_err(f"Executing Step 1: CAAIGAccountSearchViewQuery for {username}...")
    try:
        r_step1 = session.post("https://www.instagram.com/api/graphql", headers=gql_headers, data=form_data_1, timeout=15)
        if not r_step1.ok:
            log_err(f"Step 1 request failed with status: {r_step1.status_code}")
            return {"success": False, "error": f"Search account query failed: status {r_step1.status_code}"}
        
        text1 = r_step1.text
        if text1.startswith("for (;;);"):
            text1 = text1[9:]
        
        json1 = json.loads(text1)
        if json1.get("errors"):
            main_error = json1["errors"][0]
            error_msg = main_error.get("message", "Hesap aranamadı.")
            if main_error.get("code") == 1675004 or "rate limit" in error_msg.lower():
                error_msg = "Instagram çok fazla e-posta linki gönderme talebi nedeniyle geçici engel (Rate Limit) uyguladı. Lütfen tarayıcıdan \"Şifremi Unuttum\" diyerek e-posta gönderin, ardından gelen linki yapıştırın."
            log_err(f"Step 1 returned errors: {error_msg}")
            return {"success": False, "error": error_msg}
        
        cipher = json1.get("data", {}).get("caa_ar_ig_account_search", {}).get("cipher")
        if not cipher:
            log_err("Step 1 response missing cipher.")
            return {"success": False, "error": "Giriş linki için şifreleme anahtarı (cipher) alınamadı. Bu kullanıcı adı bulunamadı veya hesap kurtarma devre dışı bırakılmış."}
            
        log_err("Step 1 completed successfully. Cipher obtained.")
    except Exception as e:
        log_err(f"Error in Step 1 (Search): {e}")
        return {"success": False, "error": f"Error in Step 1 (Search): {str(e)}"}
        
    # 3. Step 2: useCAASendIGRecoveryLinkMutation
    mutation_variables = {
        "input": {
            "actor_id": "0",
            "client_mutation_id": "1",
            "access_flow_version": "pre_mt_behavior",
            "cipher": cipher,
            "idx": 0,
            "next_uri": ""
        }
    }
    
    # Update csrftoken from cookies in case it changed
    csrf_token = session.cookies.get("csrftoken") or csrf_token
    gql_headers["x-csrftoken"] = csrf_token
    
    form_data_2 = {
        "av": "0",
        "__d": "www",
        "__user": "0",
        "__a": "1",
        "__req": "h",
        "__hs": "20649.HYP:instagram_web_pkg.2.1...0",
        "dpr": "1",
        "__ccg": "GOOD",
        "__rev": "1043188201",
        "__s": "zuqfe6:sh5mgo:b7t4yw",
        "__hsi": "7662708204024103304",
        "__comet_req": "7",
        "lsd": lsd,
        "jazoest": "22337",
        "__spin_r": "1043188201",
        "__spin_b": "trunk",
        "__spin_t": timestamp_str,
        "__crn": "comet.igweb.PolarisCAAIGAccountRecoverySearchRoute",
        "qpl_active_flow_ids": "516759801",
        "fb_api_caller_class": "RelayModern",
        "fb_api_req_friendly_name": "useCAASendIGRecoveryLinkMutation",
        "server_timestamps": "true",
        "variables": json.dumps(mutation_variables),
        "doc_id": "24589582083964410"
    }
    
    log_err("Executing Step 2: useCAASendIGRecoveryLinkMutation...")
    try:
        r_step2 = session.post("https://www.instagram.com/api/graphql", headers=gql_headers, data=form_data_2, timeout=15)
        if not r_step2.ok:
            log_err(f"Step 2 request failed with status: {r_step2.status_code}")
            return {"success": False, "error": f"Send recovery link mutation failed: status {r_step2.status_code}"}
            
        text2 = r_step2.text
        if text2.startswith("for (;;);"):
            text2 = text2[9:]
            
        json2 = json.loads(text2)
        if json2.get("errors"):
            error_msg = json2["errors"][0].get("message", "Giriş e-postası gönderilemedi.")
            log_err(f"Step 2 returned errors: {error_msg}")
            return {"success": False, "error": error_msg}
            
        notification_info = json2.get("data", {}).get("caa_ar_ig_send_notification_w_recaptcha", {}).get("notification_info")
        if notification_info:
            msg = notification_info.get("message", "Giriş bağlantısı başarıyla gönderildi!")
            title = notification_info.get("title")
            log_err(f"Step 2 success: {msg} (Title: {title})")
            return {
                "success": True,
                "message": msg,
                "title": title
            }
        else:
            log_err("Step 2 response missing notification_info.")
            return {"success": False, "error": "E-posta gönderimi tamamlanamadı veya güvenlik doğrulaması (reCAPTCHA) gerekiyor."}
            
    except Exception as e:
        log_err(f"Error in Step 2 (Send Email): {e}")
        return {"success": False, "error": f"Error in Step 2 (Send Email): {str(e)}"}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Username argument is missing."}))
        sys.exit(1)
    username = sys.argv[1]
    result = send_magic_link(username)
    print(json.dumps(result))
