/**
 * Utility to parse Chrome/Safari/Firefox "Copy as cURL" strings or raw HTTP requests
 * into structured cookies, headers, and form-data.
 */
export interface ParsedCurl {
  cookies: Record<string, string>;
  headers: Record<string, string>;
  postData: Record<string, string>;
}

export function parseCurlCommand(curlString: string): ParsedCurl {
  const cookies: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const postData: Record<string, string> = {};

  if (!curlString || typeof curlString !== 'string') {
    return { cookies, headers, postData };
  }

  const trimmed = curlString.trim();

  // Helper to parse cookie strings
  const parseCookieStr = (cookieStr: string) => {
    cookieStr.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim();
        if (key) {
          cookies[key] = val;
        }
      } else if (parts.length === 1) {
        const key = parts[0].trim();
        if (key) cookies[key] = '';
      }
    });
  };

  // If it's a cURL command, use cURL parsing logic
  if (trimmed.toLowerCase().startsWith('curl') || trimmed.includes(' -H ') || trimmed.includes(' --header ')) {
    // Normalize line endings and combine backslashed lines into a single line
    const normalized = trimmed
      .replace(/\\\r?\n/g, ' ') // join backslash lines
      .replace(/\s+/g, ' ');   // normalize spaces

    // 1. Extract Headers: -H "Key: Value" or -H 'Key: Value' or --header ...
    const headerRegex = /(?:-H|--header)\s+(['"])(.*?)\1/g;
    let match;
    while ((match = headerRegex.exec(normalized)) !== null) {
      const headerStr = match[2];
      const colonIndex = headerStr.indexOf(':');
      if (colonIndex > -1) {
        const key = headerStr.substring(0, colonIndex).trim().toLowerCase();
        const val = headerStr.substring(colonIndex + 1).trim();

        if (key === 'cookie') {
          parseCookieStr(val);
        } else {
          headers[key] = val;
        }
      }
    }

    // 2. Extract Cookies via -b or --cookie flags (fallback if not in -H 'cookie:')
    const cookieFlagRegex = /(?:-b|--cookie)\s+(['"])(.*?)\1/g;
    while ((match = cookieFlagRegex.exec(normalized)) !== null) {
      parseCookieStr(match[2]);
    }

    // 3. Extract POST body: --data-raw, --data, --data-binary, -d ...
    const dataFlagRegex = /(?:--data-raw|--data|--data-binary|-d)\s+(['"])(.*?)\1/g;
    let dataMatch = dataFlagRegex.exec(normalized);
    
    // Try matching without quotes if not matched with quotes
    if (!dataMatch) {
      const unquotedDataRegex = /(?:--data-raw|--data|--data-binary|-d)\s+([^\s'"-]+)/g;
      dataMatch = unquotedDataRegex.exec(normalized);
    }

    if (dataMatch) {
      const rawData = dataMatch[2] || dataMatch[1];
      if (rawData) {
        // Decode and parse URL parameters
        const params = new URLSearchParams(rawData);
        params.forEach((value, key) => {
          postData[key] = value;
        });
      }
    }
  } else {
    // Parse as raw HTTP request
    const lines = trimmed.split(/\r?\n/);
    let isParsingHeaders = true;
    let bodyLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Stop parsing if we reach the response block (e.g. HTTP/2 200)
      if (line.match(/^HTTP\/\d\.\d\s+\d{3}/i)) {
        break;
      }

      if (isParsingHeaders) {
        if (line === '') {
          isParsingHeaders = false;
          continue;
        }

        // Skip the request line (e.g. POST https://... HTTP/2.0)
        if (i === 0 && (line.startsWith('POST') || line.startsWith('GET') || line.startsWith('PUT') || line.startsWith('DELETE'))) {
          continue;
        }

        const colonIndex = line.indexOf(':');
        if (colonIndex > -1) {
          const key = line.substring(0, colonIndex).trim().toLowerCase();
          const val = line.substring(colonIndex + 1).trim();

          if (key === 'cookie') {
            parseCookieStr(val);
          } else {
            headers[key] = val;
          }
        } else if (line.includes('=') && line.includes('&')) {
          // If a line contains '=' and '&' with no colon, headers ended and body started
          isParsingHeaders = false;
          bodyLines.push(line);
        }
      } else {
        bodyLines.push(line);
      }
    }

    // Parse the collected body lines
    const rawBody = bodyLines.join('\n').trim();
    if (rawBody) {
      if (rawBody.startsWith('{') && rawBody.endsWith('}')) {
        try {
          const json = JSON.parse(rawBody);
          Object.entries(json).forEach(([k, v]) => {
            postData[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
          });
        } catch (e) {
          const params = new URLSearchParams(rawBody);
          params.forEach((value, key) => {
            postData[key] = value;
          });
        }
      } else {
        const params = new URLSearchParams(rawBody);
        params.forEach((value, key) => {
          postData[key] = value;
        });
      }
    }
  }

  return { cookies, headers, postData };
}
