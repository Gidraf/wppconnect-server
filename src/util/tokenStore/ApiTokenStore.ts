/*
 * apiTokenStore.ts
 *
 * BUG 3 FIX – 413 Request Entity Too Large
 * The WPPConnect token data object contains the full Puppeteer/Chrome session
 * state: cookies, localStorage entries, IndexedDB handles, extension state etc.
 * This can easily be 2–10 MB.  Flask (and most web frameworks) default to a
 * 1 MB or 16 KB body limit.
 *
 * Fix: we store only the 4 fields WPPConnect actually needs to restore a
 * session without re-scanning a QR code:
 *   WABrowserId   – device identifier
 *   WASecretBundle – encryption keys
 *   WAToken1       – auth token part 1
 *   WAToken2       – auth token part 2
 *
 * Everything else (page state, caches, etc.) is regenerated on reconnect.
 *
 * Flask side: also increase body limit in your Flask app:
 *   app.config['MAX_CONTENT_LENGTH'] = 2 * 1024 * 1024  # 2 MB
 * And in Gunicorn (already in our CMD):
 *   --timeout 120   (already set)
 * If you use Nginx as a reverse proxy, add:
 *   client_max_body_size 2m;
 */

import axios from 'axios';

const API_URL =
  process.env.WPP_TOKEN_API_URL ?? 'http://localhost:5000/api/v1/wpp-sessions';
const API_SECRET = process.env.WPP_TOKEN_API_SECRET ?? 'changeme';

const headers = {
  'Content-Type': 'application/json',
  'X-Internal-Secret': API_SECRET,
};

// Fields WPPConnect actually needs for session restore – everything else is noise
const ESSENTIAL_TOKEN_KEYS = [
  'WABrowserId',
  'WASecretBundle',
  'WAToken1',
  'WAToken2',
  // Also keep these if present (newer WPPConnect versions use them)
  'wid',
  'phone',
  'pushname',
];

/**
 * Strip the token data to only essential fields before sending to the API.
 * Reduces payload from potentially 5–10 MB down to ~200–500 bytes.
 */
function stripTokenData(tokenData: any): any {
  if (!tokenData || typeof tokenData !== 'object') return tokenData ?? {};

  const stripped: Record<string, any> = {};
  for (const key of ESSENTIAL_TOKEN_KEYS) {
    if (tokenData[key] !== undefined) {
      stripped[key] = tokenData[key];
    }
  }
  return stripped;
}

class ApiTokenStore {
  declare client: any;

  constructor(client: any) {
    this.client = client;
  }

  tokenStore = {
    getToken: async (sessionName: string): Promise<any | null> => {
      try {
        const res = await axios.get(`${API_URL}/${sessionName}`, {
          headers,
          timeout: 10_000,
        });
        if (res.status === 404 || !res.data?.result) return null;

        const result = res.data.result;
        if (result.config && typeof result.config === 'string') {
          result.config = JSON.parse(result.config);
        }
        if (result.token_data && typeof result.token_data === 'string') {
          try {
            result.token_data = JSON.parse(result.token_data);
          } catch {}
        }
        if (result.webhook) result.config.webhook = result.webhook;
        this.client.config = result.config;
        // Return token_data as the actual token (what WPPConnect reads)
        return result.token_data ?? result;
      } catch (err: any) {
        if (err?.response?.status === 404) return null;
        console.error('[ApiTokenStore] getToken error:', err?.message);
        return null;
      }
    },

    setToken: async (sessionName: string, tokenData: any): Promise<boolean> => {
      try {
        // BUG 3 FIX: strip to essential fields only before sending
        const slim = stripTokenData(tokenData);
        const slimJson = JSON.stringify(slim);

        // Safety check – if still somehow large, log a warning but proceed
        if (slimJson.length > 500_000) {
          console.warn(
            `[ApiTokenStore] setToken payload is ${slimJson.length} bytes after stripping – consider investigating`,
          );
        }

        await axios.post(
          API_URL,
          {
            session_name: sessionName,
            webhook: this.client.config?.webhook ?? null,
            config: JSON.stringify(this.client.config ?? {}),
            token_data: slimJson,
            partner_id: this.client.config?.partner_id ?? null,
          },
          {
            headers,
            timeout: 10_000,
            maxBodyLength: 2 * 1024 * 1024, // 2 MB max
            maxContentLength: 2 * 1024 * 1024,
          },
        );
        return true;
      } catch (err: any) {
        if (err?.response?.status === 413) {
          console.error(
            '[ApiTokenStore] setToken 413: payload still too large after stripping. Check Flask MAX_CONTENT_LENGTH.',
          );
        } else {
          console.error('[ApiTokenStore] setToken error:', err?.message);
        }
        return false;
      }
    },

    removeToken: async (sessionName: string): Promise<boolean> => {
      try {
        await axios.delete(`${API_URL}/${sessionName}`, {
          headers,
          timeout: 10_000,
        });
        return true;
      } catch (err: any) {
        console.error('[ApiTokenStore] removeToken error:', err?.message);
        return false;
      }
    },

    listTokens: async (): Promise<string[]> => {
      try {
        const res = await axios.get(API_URL, { headers, timeout: 10_000 });
        return (res.data?.results ?? []).map((r: any) => r.session_name);
      } catch (err: any) {
        console.error('[ApiTokenStore] listTokens error:', err?.message);
        return [];
      }
    },
  };
}

export default ApiTokenStore;
