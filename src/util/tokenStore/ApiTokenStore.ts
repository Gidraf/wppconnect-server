/*
 * apiTokenStore.ts
 *
 * Replaces MongoDB/File/Redis token stores with a call to YOUR Flask API.
 * The token (session cookie, auth state) is stored in the `wpp_sessions` table
 * on your Flask backend – no MongoDB or extra dependencies needed.
 *
 * HOW TO ACTIVATE:
 *   1. Add WPP_TOKEN_API_URL=https://your-flask-api/api/v1/wpp-sessions
 *      and WPP_TOKEN_API_SECRET=<your-internal-secret> to the Node .env
 *   2. In config.ts set:  tokenStoreType: 'api'
 *   3. In factory.ts add the 'api' branch (see factory.ts output file)
 */

import axios from 'axios';

const API_URL =
  process.env.WPP_TOKEN_API_URL ??
  'https://api.ajiriwa.gidraf.dev/api/v1/wpp-sessions';
const API_SECRET = process.env.WPP_TOKEN_API_SECRET ?? 'changeme';

const headers = {
  'Content-Type': 'application/json',
  'X-Internal-Secret': API_SECRET,
};

class ApiTokenStore {
  declare client: any;

  constructor(client: any) {
    this.client = client;
  }

  tokenStore = {
    /**
     * Fetch session token data from the Flask API.
     * Returns null if the session does not exist yet.
     */
    getToken: async (sessionName: string): Promise<any | null> => {
      try {
        const res = await axios.get(`${API_URL}/${sessionName}`, { headers });
        if (res.status === 404 || !res.data?.result) return null;

        const result = res.data.result;
        // Re-attach config and webhook just like the MongoDB store does
        if (result.config && typeof result.config === 'string') {
          result.config = JSON.parse(result.config);
        }
        if (result.webhook) {
          result.config.webhook = result.webhook;
        }
        this.client.config = result.config;
        return result;
      } catch (err: any) {
        if (err?.response?.status === 404) return null;
        console.error('[ApiTokenStore] getToken error:', err?.message);
        return null;
      }
    },

    /**
     * Upsert session token data in the Flask API.
     */
    setToken: async (sessionName: string, tokenData: any): Promise<boolean> => {
      try {
        await axios.post(
          API_URL,
          {
            session_name: sessionName,
            webhook: this.client.config?.webhook ?? null,
            config: JSON.stringify(this.client.config ?? {}),
            token_data: JSON.stringify(tokenData ?? {}),
            partner_id: this.client.config?.partner_id ?? null,
          },
          { headers },
        );
        return true;
      } catch (err: any) {
        console.error('[ApiTokenStore] setToken error:', err?.message);
        return false;
      }
    },

    /**
     * Delete a session token from the Flask API.
     */
    removeToken: async (sessionName: string): Promise<boolean> => {
      try {
        await axios.delete(`${API_URL}/${sessionName}`, { headers });
        return true;
      } catch (err: any) {
        console.error('[ApiTokenStore] removeToken error:', err?.message);
        return false;
      }
    },

    /**
     * List all known session names from the Flask API.
     */
    listTokens: async (): Promise<string[]> => {
      try {
        axios
          .get(API_URL, { headers })
          .then((res) => {
            console.log(res);
          })
          .then((e) => {
            console.log(e);
            console.log(e.response);
          });
        const res = await axios.get(API_URL, { headers });

        return (res.data?.results ?? []).map((r: any) => r.session_name);
      } catch (err: any) {
        console.error('[ApiTokenStore] listTokens error:', err?.message);
        return [];
      }
    },
  };
}

export default ApiTokenStore;
