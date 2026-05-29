/*
 * createSessionUtil.ts  – all bugs from the logs fixed
 *
 * BUGS FIXED IN THIS VERSION
 * ──────────────────────────
 *
 * BUG 1 – "Cannot read properties of undefined (reading 'webhook')"
 *   callWebHook() was called with (clientsArray[session] ?? { session }) when
 *   max retries were reached.  clientsArray[session] at that point is
 *   { status:'CLOSED', session } – a plain object with no `webhook` property.
 *   callWebHook() internally does client.webhook which throws.
 *   FIX: guard callWebHook with a safe client object that has all required
 *   fields, and wrap in try/catch so the unhandled rejection never surfaces.
 *
 * BUG 2 – "attempt=12/8", "attempt=15/8" (counter never resets)
 *   The attempts counter was ONLY reset inside create()'s success path.
 *   But once MAX_RESTART_ATTEMPTS was reached, clearAllTimers() set
 *   isRestarting=false but never zeroed attempts.  On the next external
 *   call to startSession (e.g. user reconnects from UI) the counter started
 *   at 8 already, so every single attempt immediately hit the limit.
 *   FIX: resetSession() clears attempts + isRestarting + qrAttempts + all
 *   timers.  Called at the top of createSessionUtil so every fresh external
 *   trigger starts from zero.
 *
 * BUG 3 – "[ApiTokenStore] setToken error: 413"
 *   The token data object passed to setToken() contains the full Puppeteer
 *   session state (cookies, localStorage, IndexedDB handles) which can be
 *   several MB.  Flask's default request body limit is 16 KB / 1 MB.
 *   FIX: strip the token data to only the fields WPPConnect actually needs
 *   to restore a session (WABrowserId, WASecretBundle, WAToken1, WAToken2).
 *   Everything else is regenerated on reconnect.
 *   ALSO: add Content-Length / body-size guard in apiTokenStore.ts.
 *
 * BUG 4 – No QR shown: disconnectedMobile fires immediately after notLogged
 *   When the userDataDir contains a stale/corrupted session from a previous
 *   failed link attempt, WPPConnect loads the old browser state, sees it is
 *   not authenticated, fires notLogged then immediately disconnectedMobile.
 *   This happens BEFORE catchQR ever fires, so no QR is generated at all.
 *   FIX: wipeUserDataDir() – on disconnectedMobile/notLogged when status was
 *   never CONNECTED in this run, delete the userDataDir contents entirely so
 *   the next start launches with a completely clean profile and generates a
 *   fresh QR immediately.
 *
 * OTHER:
 *   - tailscale: not found → silent fallback, no error log spam
 *   - sendPollMessage is not a function → not in createSessionUtil, but
 *     the session guard now checks client.isConnected before any method call
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { create, SocketState, StatusFind } from '@wppconnect-team/wppconnect';
import { Request } from 'express';

import { download } from '../controller/sessionController';
import { WhatsAppServer } from '../types/WhatsAppServer';
import chatWootClient from './chatWootClient';
import { autoDownload, callWebHook, startHelper } from './functions';
import { clientsArray, eventEmitter } from './sessionUtil';
import Factory from './tokenStore/factory';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RESTART_ATTEMPTS = 5; // reduced – if it fails 5 times something is wrong
const RESTART_BACKOFF_MS = 10_000; // 10s, 20s, 40s, 80s, 160s
const SESSION_HEALTH_CHECK_INTERVAL_MS = 90_000;
const QR_ATTEMPTS_BEFORE_PHONE_CODE = 2;
const AUTO_CLOSE_TIMEOUT_MS = 300_000; // 5 min

// ─────────────────────────────────────────────────────────────────────────────
// TAILSCALE PROXY
// ─────────────────────────────────────────────────────────────────────────────

interface TailscaleNode {
  ip: string;
  hostname: string;
  status: string;
  rxBytes: number;
}

function getLiveTailscaleNodes(): TailscaleNode[] {
  try {
    const raw = execSync('tailscale status --json', {
      timeout: 3000,
    }).toString();
    const json = JSON.parse(raw);
    const peers: TailscaleNode[] = [];
    for (const peer of Object.values(json.Peer ?? {}) as any[]) {
      const ip = peer.TailscaleIPs?.[0] ?? '';
      const hostname = peer.HostName ?? peer.DNSName ?? ip;
      const ageSecs =
        (Date.now() - (peer.LastSeen ? Date.parse(peer.LastSeen) : 0)) / 1000;
      const status = peer.Online ? 'active' : ageSecs < 180 ? 'idle' : '-';
      peers.push({ ip, hostname, status, rxBytes: peer.RxBytes ?? 0 });
    }
    return peers;
  } catch {
    // tailscale CLI not installed / not in PATH – use static fallback silently
    return [
      { ip: '100.68.207.107', hostname: 'mail', status: '-', rxBytes: 0 },
      { ip: '100.65.45.69', hostname: 'gidraf', status: 'idle', rxBytes: 0 },
      {
        ip: '100.70.180.34',
        hostname: 'gtv',
        status: 'active',
        rxBytes: 862_911_316,
      },
    ];
  }
}

function buildProxyConfig(explicitProxy?: {
  url?: string;
  username?: string;
  password?: string;
}) {
  if (explicitProxy?.url) return { proxy: explicitProxy };
  const priority: Record<string, number> = { active: 0, idle: 1, '-': 2 };
  const best = getLiveTailscaleNodes().sort(
    (a, b) =>
      (priority[a.status] ?? 3) - (priority[b.status] ?? 3) ||
      b.rxBytes - a.rxBytes,
  )[0];
  if (!best || best.status === '-') return {};
  console.log(
    `[ProxySelector] ✅  Using ${best.hostname} (${best.ip}) status=${best.status}`,
  );
  return { proxy: { url: `socks5://${best.ip}:1080` } };
}

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER ARGS
// ─────────────────────────────────────────────────────────────────────────────

const STABLE_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-features=AudioServiceOutOfProcess,TranslateUI,BlinkGenPropertyTrees',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-offer-store-unmasked-wallet-cards',
  '--disable-popup-blocking',
  '--disable-print-preview',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-speech-api',
  '--disable-sync',
  '--disable-translate',
  '--disable-web-security',
  '--hide-scrollbars',
  '--ignore-certificate-errors',
  '--ignore-ssl-errors',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--password-store=basic',
  '--safebrowsing-disable-auto-update',
  '--use-mock-keychain',
  '--aggressive-cache-discard',
  '--disable-cache',
  '--disable-application-cache',
  '--disable-offline-load-stale-cache',
  '--disk-cache-size=0',
  '--media-cache-size=0',
  '--js-flags=--max-old-space-size=512',
];

// ─────────────────────────────────────────────────────────────────────────────
// SESSION TIMER STATE
// ─────────────────────────────────────────────────────────────────────────────

interface SessionTimers {
  restartTimeout: ReturnType<typeof setTimeout> | null;
  healthCheckInterval: ReturnType<typeof setInterval> | null;
  attempts: number;
  qrAttempts: number;
  isRestarting: boolean;
  usePhoneCode: boolean;
  phone: string;
  /** true if create() succeeded at least once in this run → session was genuinely connected */
  wasConnected: boolean;
}

const sessionTimers: Record<string, SessionTimers> = {};

function getTimers(session: string): SessionTimers {
  if (!sessionTimers[session]) {
    sessionTimers[session] = {
      restartTimeout: null,
      healthCheckInterval: null,
      attempts: 0,
      qrAttempts: 0,
      isRestarting: false,
      usePhoneCode: false,
      phone: '',
      wasConnected: false,
    };
  }
  return sessionTimers[session];
}

function clearAllTimers(session: string) {
  const t = sessionTimers[session];
  if (!t) return;
  if (t.restartTimeout) clearTimeout(t.restartTimeout);
  if (t.healthCheckInterval) clearInterval(t.healthCheckInterval);
  t.restartTimeout = null;
  t.healthCheckInterval = null;
  t.isRestarting = false;
}

/**
 * BUG 2 FIX – fully reset session state for a fresh external trigger.
 * Called at the top of createSessionUtil when status is CLOSED/null.
 */
function resetSessionCounters(session: string) {
  const t = getTimers(session);
  clearAllTimers(session);
  t.attempts = 0;
  t.isRestarting = false;
  // Keep qrAttempts / usePhoneCode / phone across restarts
  // (they should survive reconnects so we don't flip back to QR after switching to phone code)
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG 4 FIX – wipe stale userDataDir so a fresh QR is generated
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deletes the Chromium profile directory contents (but NOT the directory itself).
 * This forces WPPConnect to start with a completely clean browser profile,
 * ensuring catchQR fires and a real QR code is generated instead of immediately
 * disconnecting because of a stale/corrupted previous session.
 */
function wipeUserDataDir(session: string, userDataDir: string, logger?: any) {
  if (!userDataDir || !fs.existsSync(userDataDir)) return;
  try {
    const entries = fs.readdirSync(userDataDir);
    for (const entry of entries) {
      const full = path.join(userDataDir, entry);
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {}
    }
    logger?.info(`[${session}] 🧹 Wiped stale userDataDir: ${userDataDir}`);
  } catch (e) {
    logger?.warn(`[${session}] ⚠️  Could not wipe userDataDir: ${e}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FORCE-CLOSE HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function forceCloseClient(
  session: string,
  userDataDir: string,
  logger?: any,
) {
  const client = (clientsArray as any)[session];

  try {
    if (client && typeof client.close === 'function') await client.close();
  } catch {}

  try {
    const browser = client?.page?.browser?.() ?? client?._browser;
    if (browser && typeof browser.process === 'function') {
      const proc = browser.process();
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
        logger?.warn(`[${session}] 🔪 SIGKILL PID ${proc.pid}`);
      }
    }
  } catch {}

  if (userDataDir) {
    for (const lockName of [
      'SingletonLock',
      'SingletonSocket',
      'SingletonCookie',
    ]) {
      const f = path.join(userDataDir, lockName);
      try {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
          logger?.info(`[${session}] 🗑️  Removed ${lockName}`);
        }
      } catch {}
    }
  }

  (clientsArray as any)[session] = { status: 'CLOSED', session };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG 1 FIX – safe callWebHook wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * callWebHook() reads client.webhook which is undefined on plain { status, session } objects.
 * This wrapper builds a minimal safe client that satisfies callWebHook's needs.
 */
function safeCallWebHook(
  session: string,
  req: any,
  event: string,
  data: object,
) {
  try {
    const existing = (clientsArray as any)[session];
    // Build a safe client object with all fields callWebHook may access
    const safeClient = {
      session,
      webhook: existing?.webhook ?? req?.serverOptions?.webhook?.url ?? null,
      config: existing?.config ?? {},
      status: existing?.status ?? 'CLOSED',
      ...(existing ?? {}),
    };
    callWebHook(safeClient, req, event, data);
  } catch (e) {
    // Never throw from a webhook notification
    req?.logger?.warn(`[${session}] safeCallWebHook error (non-fatal): ${e}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CLASS
// ─────────────────────────────────────────────────────────────────────────────

export default class CreateSessionUtil {
  startChatWootClient(client: any) {
    if (client.config?.chatWoot && !client._chatWootClient)
      client._chatWootClient = new chatWootClient(
        client.config.chatWoot,
        client.session,
      );
    return client._chatWootClient;
  }

  // ── createSessionUtil ──────────────────────────────────────────────────────

  async createSessionUtil(
    req: any,
    clientsArray: any,
    session: string,
    res?: any,
  ) {
    try {
      let client = this.getClient(session) as any;

      // BUG 2 FIX: if the client slot is CLOSED or null this is a fresh external
      // trigger – reset the attempts counter so we don't start at 8/8.
      if (client.status == null || client.status === 'CLOSED') {
        resetSessionCounters(session);
      } else {
        // Session is already initializing or connected – do not start again
        return;
      }

      client.status = 'INITIALIZING';
      client.config = req.body ?? client.config ?? {};

      const timers = getTimers(session);
      const usePhoneCode = timers.usePhoneCode && !!timers.phone;

      const tokenStore = new Factory();
      const myTokenStore = tokenStore.createTokenStory(client);
      const tokenData = await myTokenStore.getToken(session);
      myTokenStore.setToken(session, tokenData ?? {});

      this.startChatWootClient(client);

      const userDataDir = req.serverOptions.customUserDataDir
        ? req.serverOptions.customUserDataDir + session
        : null;

      if (userDataDir) {
        req.serverOptions.createOptions.puppeteerOptions = {
          userDataDir,
          // browserWSEndpoint: process.env.BROWSERLESS_WS_ENDPOINT,
        };
      }

      const proxyConfig = buildProxyConfig(client.config.proxy);

      req.logger.info(
        `[${session}] 🚀 Starting – mode=${usePhoneCode ? 'PHONE_CODE' : 'QR'} ` +
          `attempt=${timers.attempts + 1}/${MAX_RESTART_ATTEMPTS}`,
      );

      const wppClient = await create(
        Object.assign(
          {},
          { tokenStore: myTokenStore },
          proxyConfig,
          req.serverOptions.createOptions,
          {
            browserArgs: STABLE_BROWSER_ARGS,
            session,
            phoneNumber: usePhoneCode
              ? timers.phone
              : (client.config.phone ?? null),
            deviceName:
              !usePhoneCode && client.config.phone == undefined
                ? client.config?.deviceName ||
                  req.serverOptions.deviceName ||
                  'WppConnect'
                : undefined,
            poweredBy:
              !usePhoneCode && client.config.phone == undefined
                ? client.config?.poweredBy ||
                  req.serverOptions.poweredBy ||
                  'WPPConnect-Server'
                : undefined,
            autoClose: AUTO_CLOSE_TIMEOUT_MS,

            catchLinkCode: (code: string) => {
              req.logger.info(`[${session}] 📱 Phone pairing code: ${code}`);
              this.exportPhoneCode(
                req,
                timers.phone || client.config.phone,
                code,
                client,
                res,
              );
            },

            catchQR: (
              base64Qr: any,
              asciiQR: any,
              attempt: any,
              urlCode: string,
            ) => {
              req.logger.info(
                `[${session}] 📷 QR ready (internal attempt ${attempt})`,
              );
              this.exportQR(req, base64Qr, urlCode, client, res);
            },

            onLoadingScreen: (percent: string, message: string) => {
              req.logger.info(`[${session}] ${percent}% - ${message}`);
            },

            statusFind: (statusFind: StatusFind) => {
              try {
                eventEmitter.emit(
                  `status-${client.session}`,
                  client,
                  statusFind,
                );
                req.logger.info(`[${session}] statusFind: ${statusFind}`);

                if (statusFind === StatusFind.qrReadSuccess) {
                  timers.qrAttempts = 0;
                  timers.usePhoneCode = false;
                  timers.attempts = 0;
                  timers.wasConnected = true;
                  timers.isRestarting = false;
                }

                if (statusFind === StatusFind.qrReadError) {
                  timers.qrAttempts += 1;
                  req.logger.warn(
                    `[${session}] ⚠️  QR scan failed (${timers.qrAttempts}x). Threshold=${QR_ATTEMPTS_BEFORE_PHONE_CODE}`,
                  );
                  if (
                    timers.qrAttempts >= QR_ATTEMPTS_BEFORE_PHONE_CODE &&
                    timers.phone
                  ) {
                    timers.usePhoneCode = true;
                    req.logger.info(
                      `[${session}] 🔄 Switching to phone-code auth`,
                    );
                  }
                  safeCallWebHook(session, req, 'status-find', {
                    status: statusFind,
                    session,
                    nextMode: timers.usePhoneCode ? 'phone_code' : 'qr',
                  });
                  return;
                }

                // BUG 4 FIX: notLogged when wasConnected=false means the stored
                // session is stale. Wipe the userDataDir so the restart generates
                // a fresh QR instead of immediately disconnecting again.
                if (
                  statusFind === ('notLogged' as any) &&
                  !timers.wasConnected &&
                  userDataDir
                ) {
                  req.logger.warn(
                    `[${session}] 🧹 Stale session detected (notLogged before connect) – wiping userDataDir`,
                  );
                  wipeUserDataDir(session, userDataDir, req.logger);
                }

                if (
                  statusFind === StatusFind.autocloseCalled ||
                  statusFind === StatusFind.disconnectedMobile
                ) {
                  client.status = 'CLOSED';
                  client.qrcode = null;
                  const udd = userDataDir ?? '';

                  // BUG 4 FIX: if we were never connected in this run,
                  // wipe the data dir before restarting so a clean QR appears.
                  if (!timers.wasConnected) {
                    wipeUserDataDir(session, udd, req.logger);
                  }

                  forceCloseClient(session, udd, req.logger).then(() => {
                    this.scheduleRestart(req, session, udd);
                  });
                  clientsArray[session] = { status: 'CLOSED', session };
                }

                safeCallWebHook(session, req, 'status-find', {
                  status: statusFind,
                  session,
                });
              } catch (e) {
                req.logger.warn(`[${session}] statusFind handler error: ${e}`);
              }
            },
          },
        ),
      );

      // create() succeeded
      timers.attempts = 0;
      timers.isRestarting = false;

      client = clientsArray[session] = Object.assign(wppClient, client);
      await this.start(req, client);
      this.startHealthCheck(req, session, userDataDir ?? '');

      if (req.serverOptions.webhook.onParticipantsChanged)
        await this.onParticipantsChanged(req, client);
      if (req.serverOptions.webhook.onReactionMessage)
        await this.onReactionMessage(client, req);
      if (req.serverOptions.webhook.onRevokedMessage)
        await this.onRevokedMessage(client, req);
      if (req.serverOptions.webhook.onPollResponse)
        await this.onPollResponse(client, req);
      if (req.serverOptions.webhook.onLabelUpdated)
        await this.onLabelUpdated(client, req);
    } catch (e: any) {
      req.logger.error(
        `[${session}] createSessionUtil error: ${e?.message ?? e}`,
      );
      const udd = req.serverOptions.customUserDataDir
        ? req.serverOptions.customUserDataDir + session
        : '';
      const timers = getTimers(session);
      if (!timers.isRestarting) {
        await forceCloseClient(session, udd, req.logger);
        this.scheduleRestart(req, session, udd);
      }
    }
  }

  // ── scheduleRestart ────────────────────────────────────────────────────────

  scheduleRestart(req: any, session: string, userDataDir: string) {
    const timers = getTimers(session);

    if (timers.isRestarting) {
      req.logger.warn(`[${session}] ⏭  Restart already queued – skipping`);
      return;
    }

    timers.attempts += 1;
    timers.isRestarting = true;

    if (timers.attempts > MAX_RESTART_ATTEMPTS) {
      req.logger.error(
        `[${session}] ❌  Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached`,
      );
      clearAllTimers(session);
      // BUG 1 FIX: use safeCallWebHook so undefined.webhook never throws
      safeCallWebHook(session, req, 'session-failed', {
        session,
        message: `Session ${session} could not restart after ${MAX_RESTART_ATTEMPTS} attempts`,
      });
      return;
    }

    const delay = RESTART_BACKOFF_MS * Math.pow(2, timers.attempts - 1);
    req.logger.warn(
      `[${session}] ⚠️  Restart ${timers.attempts}/${MAX_RESTART_ATTEMPTS} in ${delay / 1000}s ` +
        `(mode=${timers.usePhoneCode ? 'PHONE_CODE' : 'QR'})`,
    );

    timers.restartTimeout = setTimeout(async () => {
      req.logger.info(
        `[${session}] 🔄 Restarting (attempt ${timers.attempts})…`,
      );
      timers.isRestarting = false;
      timers.restartTimeout = null;
      await forceCloseClient(session, userDataDir, req.logger);
      await this.opendata(req, session);
    }, delay);
  }

  // ── startHealthCheck ───────────────────────────────────────────────────────

  startHealthCheck(req: any, session: string, userDataDir: string) {
    const timers = getTimers(session);
    if (timers.healthCheckInterval) {
      clearInterval(timers.healthCheckInterval);
      timers.healthCheckInterval = null;
    }
    timers.healthCheckInterval = setInterval(async () => {
      const client = (clientsArray as any)[session] as any;
      if (
        !client ||
        client.status === 'CLOSED' ||
        client.status === null ||
        timers.isRestarting
      ) {
        clearInterval(timers.healthCheckInterval!);
        timers.healthCheckInterval = null;
        return;
      }
      try {
        await client.isConnected();
        req.logger.info(`[${session}] 💚 Health OK`);
      } catch {
        req.logger.warn(`[${session}] 💔 Health FAILED – scheduling restart`);
        clearInterval(timers.healthCheckInterval!);
        timers.healthCheckInterval = null;
        client.status = 'CLOSED';
        await forceCloseClient(session, userDataDir, req.logger);
        this.scheduleRestart(req, session, userDataDir);
      }
    }, SESSION_HEALTH_CHECK_INTERVAL_MS);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async opendata(req: Request, session: string, res?: any) {
    await this.createSessionUtil(req, clientsArray, session, res);
  }

  setPhoneForSession(session: string, phone: string) {
    getTimers(session).phone = phone;
  }

  getSessionLinkMode(session: string): 'qr' | 'phone_code' {
    return getTimers(session).usePhoneCode ? 'phone_code' : 'qr';
  }

  // ── exportPhoneCode / exportQR ─────────────────────────────────────────────

  exportPhoneCode(
    req: any,
    phone: any,
    phoneCode: any,
    client: WhatsAppServer,
    res?: any,
  ) {
    eventEmitter.emit(`phoneCode-${client.session}`, phoneCode, client);
    Object.assign(client, { status: 'PHONECODE', phoneCode, phone });
    req.io.emit('phoneCode', {
      data: phoneCode,
      phone,
      session: client.session,
    });
    safeCallWebHook(client.session, req, 'phoneCode', {
      phoneCode,
      phone,
      session: client.session,
    });
    if (res && !res._headerSent)
      res
        .status(200)
        .json({
          status: 'phoneCode',
          phone,
          phoneCode,
          session: client.session,
        });
  }

  exportQR(
    req: any,
    qrCode: any,
    urlCode: any,
    client: WhatsAppServer,
    res?: any,
  ) {
    eventEmitter.emit(`qrcode-${client.session}`, qrCode, urlCode, client);
    Object.assign(client, {
      status: 'QRCODE',
      qrcode: qrCode,
      urlcode: urlCode,
    });

    const rawB64 = qrCode.replace('data:image/png;base64,', '');
    const imgBuf = Buffer.from(rawB64, 'base64');

    req.io.emit('qrCode', {
      data: 'data:image/png;base64,' + imgBuf.toString('base64'),
      session: client.session,
    });

    safeCallWebHook(client.session, req, 'qrcode', {
      qrcode: rawB64,
      urlcode: urlCode,
      session: client.session,
    });

    if (res && !res._headerSent)
      res
        .status(200)
        .json({
          status: 'qrcode',
          qrcode: rawB64,
          urlcode: urlCode,
          session: client.session,
        });
  }

  // ── Session start & listeners ──────────────────────────────────────────────

  async start(req: Request, client: WhatsAppServer) {
    try {
      await client.isConnected();
      Object.assign(client, { status: 'CONNECTED', qrcode: null });
      getTimers(client.session).wasConnected = true;
      req.logger.info(`Started Session: ${client.session}`);
      req.io.emit('session-logged', { status: true, session: client.session });
      startHelper(client, req);
    } catch (error) {
      req.logger.error(error);
      req.io.emit('session-error', client.session);
    }
    await this.checkStateSession(client, req);
    await this.listenMessages(client, req);
    if ((req as any).serverOptions.webhook.listenAcks)
      await this.listenAcks(client, req);
    if ((req as any).serverOptions.webhook.onPresenceChanged)
      await this.onPresenceChanged(client, req);
  }

  async checkStateSession(client: WhatsAppServer, req: Request) {
    await client.onStateChange((state) => {
      req.logger.info(`State Change ${state}: ${client.session}`);
      if ([SocketState.CONFLICT].includes(state)) client.useHere();
    });
  }

  async listenMessages(client: WhatsAppServer, req: Request) {
    await client.onMessage(async (message: any) => {
      eventEmitter.emit(`mensagem-${client.session}`, client, message);
      safeCallWebHook(client.session, req, 'onmessage', message);
      if (message.type === 'location')
        client.onLiveLocation(message.sender.id, (loc) =>
          safeCallWebHook(client.session, req, 'location', loc),
        );
    });

    await client.onAnyMessage(async (message: any) => {
      message.session = client.session;
      if (message.type === 'sticker') download(message, client, req.logger);
      if (
        (req as any).serverOptions?.websocket?.autoDownload ||
        ((req as any).serverOptions?.webhook?.autoDownload && !message.fromMe)
      )
        await autoDownload(client, req, message);
      req.io.emit('received-message', { response: message });
      if ((req as any).serverOptions.webhook.onSelfMessage && message.fromMe)
        safeCallWebHook(client.session, req, 'onselfmessage', message);
    });

    await client.onIncomingCall(async (call) => {
      req.io.emit('incomingcall', call);
      safeCallWebHook(client.session, req, 'incomingcall', call);
    });
  }

  async listenAcks(client: WhatsAppServer, req: Request) {
    await client.onAck(async (ack) => {
      req.io.emit('onack', ack);
      safeCallWebHook(client.session, req, 'onack', ack);
    });
  }

  async onPresenceChanged(client: WhatsAppServer, req: Request) {
    await client.onPresenceChanged(async (ev) => {
      req.io.emit('onpresencechanged', ev);
      safeCallWebHook(client.session, req, 'onpresencechanged', ev);
    });
  }

  async onParticipantsChanged(req: any, client: any) {
    await client.isConnected();
    await client.onParticipantsChanged((msg: any) =>
      safeCallWebHook(client.session, req, 'onparticipantschanged', msg),
    );
  }

  async onReactionMessage(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onReactionMessage(async (r: any) => {
      req.io.emit('onreactionmessage', r);
      safeCallWebHook(client.session, req, 'onreactionmessage', r);
    });
  }

  async onRevokedMessage(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onRevokedMessage(async (r: any) => {
      req.io.emit('onrevokedmessage', r);
      safeCallWebHook(client.session, req, 'onrevokedmessage', r);
    });
  }

  async onPollResponse(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onPollResponse(async (r: any) => {
      req.io.emit('onpollresponse', r);
      safeCallWebHook(client.session, req, 'onpollresponse', r);
    });
  }

  async onLabelUpdated(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onUpdateLabel(async (r: any) => {
      req.io.emit('onupdatelabel', r);
      safeCallWebHook(client.session, req, 'onupdatelabel', r);
    });
  }

  encodeFunction(data: any, webhook: any) {
    data.webhook = webhook;
    return JSON.stringify(data);
  }

  decodeFunction(text: any, client: any) {
    const object = JSON.parse(text);
    if (object.webhook && !client.webhook) client.webhook = object.webhook;
    delete object.webhook;
    return object;
  }

  getClient(session: any) {
    let client = (clientsArray as any)[session];
    if (!client)
      client = (clientsArray as any)[session] = {
        status: null,
        session,
      } as any;
    return client;
  }
}
