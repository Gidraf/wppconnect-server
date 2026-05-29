/*
 * createSessionUtil.ts
 *
 * KEY IMPROVEMENTS IN THIS VERSION
 * ──────────────────────────────────
 * 1. QR + PHONE-CODE DUAL-MODE LINKING
 *    WPPConnect supports two ways to link a device:
 *      a) QR code  – user scans with phone camera
 *      b) Phone/pairing code  – user types 8-char code into WhatsApp
 *    We now support both.  The flow is:
 *      - Attempt 1 & 2: show QR  (normal path)
 *      - Attempt 3+:    fall back to phone code (more reliable when QR repeatedly fails)
 *    The phone number is stored in integration.config.phone (passed from the frontend).
 *    If no phone number is configured we stay on QR-only mode.
 *
 * 2. EXTENDED AUTO-CLOSE TIMEOUT
 *    The default WPPConnect auto-close is 60 s – too short for the QR to
 *    propagate to the user's screen via webhook → polling → frontend.
 *    We override `autoClose` to 300 s (5 min) giving the user plenty of time.
 *
 * 3. BROWSER LOCK-FILE FIX (carried over)
 *    forceCloseClient() kills the Chromium process and removes SingletonLock
 *    before every restart to prevent "browser already running" errors.
 *
 * 4. DUPLICATE-RESTART GUARD (carried over)
 *    isRestarting flag ensures only one restart is ever queued per session.
 *
 * 5. HEALTH-CHECK TIMER LEAK FIX (carried over)
 *    All timers tracked in sessionTimers map, cleared atomically on give-up.
 *
 * 6. TAILSCALE DYNAMIC PROXY (carried over)
 *    Live `tailscale status --json` with static-list fallback.
 *
 * 7. QR_ATTEMPT TRACKING
 *    qrAttempt counter per session – after QR_ATTEMPTS_BEFORE_PHONE_CODE
 *    consecutive QR failures we automatically switch to phone-code mode.
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

const MAX_RESTART_ATTEMPTS = 8; // more attempts before giving up
const RESTART_BACKOFF_MS = 8_000; // 8 s, 16 s, 32 s … up to ~17 min
const SESSION_HEALTH_CHECK_INTERVAL_MS = 90_000;
const QR_ATTEMPTS_BEFORE_PHONE_CODE = 2; // after 2 QR failures, try phone code
const AUTO_CLOSE_TIMEOUT_MS = 300_000; // 5 min (override WPPConnect default 60 s)

// ─────────────────────────────────────────────────────────────────────────────
// TAILSCALE PROXY ROTATION
// ─────────────────────────────────────────────────────────────────────────────

interface TailscaleNode {
  ip: string;
  hostname: string;
  status: string; // 'active' | 'idle' | '-'
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
      const ip: string = peer.TailscaleIPs?.[0] ?? '';
      const hostname: string = peer.HostName ?? peer.DNSName ?? ip;
      const lastSeenMs = peer.LastSeen ? Date.parse(peer.LastSeen) : 0;
      const ageSeconds = (Date.now() - lastSeenMs) / 1000;
      const status = peer.Online ? 'active' : ageSeconds < 180 ? 'idle' : '-';
      const rxBytes: number = peer.RxBytes ?? 0;
      peers.push({ ip, hostname, status, rxBytes });
    }
    return peers;
  } catch {
    // Static fallback – update as your tailnet grows
    return [
      { ip: '100.68.207.107', hostname: 'mail', status: '-', rxBytes: 0 },
      { ip: '100.65.45.69', hostname: 'gidraf', status: 'idle', rxBytes: 0 },
      {
        ip: '100.70.180.34',
        hostname: 'gtv',
        status: 'active',
        rxBytes: 862911316,
      },
    ];
  }
}

function getBestTailscaleProxy(): TailscaleNode | null {
  const priority: Record<string, number> = { active: 0, idle: 1, '-': 2 };
  const ranked = getLiveTailscaleNodes().sort((a, b) => {
    const pa = priority[a.status] ?? 3;
    const pb = priority[b.status] ?? 3;
    if (pa !== pb) return pa - pb;
    return b.rxBytes - a.rxBytes;
  });

  const best = ranked[0] ?? null;
  if (!best || best.status === '-') {
    // TODO: send email/webhook alert – no active proxy
    console.warn('[ProxySelector] ⚠️  No active Tailscale proxy available.');
    return null;
  }
  console.log(
    `[ProxySelector] ✅  Using ${best.hostname} (${best.ip}) status=${best.status}`,
  );
  return best;
}

function buildProxyConfig(explicitProxy?: {
  url?: string;
  username?: string;
  password?: string;
}) {
  if (explicitProxy?.url) return { proxy: explicitProxy };
  const node = getBestTailscaleProxy();
  if (!node) return {};
  return { proxy: { url: `socks5://${node.ip}:1080` } };
}

// ─────────────────────────────────────────────────────────────────────────────
// STABLE BROWSER ARGS
// ─────────────────────────────────────────────────────────────────────────────
// EXTERNAL CHROME: set BROWSERLESS_WS_ENDPOINT=ws://host:3000 and uncomment
// browserWSEndpoint in the puppeteerOptions block below.
// Self-host: docker run -p 3000:3000 browserless/chrome

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
  qrAttempts: number; // how many times QR has failed for this session
  isRestarting: boolean;
  usePhoneCode: boolean; // true = next start should use phone-code auth
  phone: string; // phone number for phone-code auth
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

// ─────────────────────────────────────────────────────────────────────────────
// FORCE-CLOSE HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function forceCloseClient(
  session: string,
  userDataDir: string,
  logger?: any,
) {
  const client = (clientsArray as any)[session];

  // 1. Graceful close
  try {
    if (client && typeof client.close === 'function') await client.close();
  } catch {}

  // 2. SIGKILL if still alive
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

  // 3. Remove Chromium lock files so the next launch can use the same userDataDir
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

  // 4. Reset slot
  (clientsArray as any)[session] = { status: 'CLOSED', session };
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

  // ───────────────────────────────────────────────────────────────────────────
  // createSessionUtil
  // ───────────────────────────────────────────────────────────────────────────

  async createSessionUtil(
    req: any,
    clientsArray: any,
    session: string,
    res?: any,
  ) {
    try {
      let client = this.getClient(session) as any;
      if (client.status != null && client.status !== 'CLOSED') return;

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

            // ── PHONE-CODE MODE ──────────────────────────────────────────────
            // When usePhoneCode is true we pass the phone number so WPPConnect
            // requests a pairing code instead of generating a QR.
            phoneNumber: usePhoneCode
              ? timers.phone
              : (client.config.phone ?? null),

            // NOTE: deviceName & poweredBy must NOT be set when phoneNumber is
            // provided (WPPConnect bug #1687).
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

            // Override auto-close to 5 minutes so users have time to scan
            autoClose: AUTO_CLOSE_TIMEOUT_MS,

            // ── PHONE CODE received ──────────────────────────────────────────
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

            // ── QR CODE received ─────────────────────────────────────────────
            catchQR: (
              base64Qr: any,
              asciiQR: any,
              attempt: any,
              urlCode: string,
            ) => {
              req.logger.info(
                `[${session}] 📷 QR code ready (attempt ${attempt})`,
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

                if (statusFind === StatusFind.qrReadError) {
                  // QR scan failed – increment counter and decide whether to
                  // switch to phone-code mode on the next restart.
                  timers.qrAttempts += 1;
                  req.logger.warn(
                    `[${session}] ⚠️  QR scan failed (${timers.qrAttempts} times). ` +
                      `Threshold=${QR_ATTEMPTS_BEFORE_PHONE_CODE}`,
                  );

                  if (
                    timers.qrAttempts >= QR_ATTEMPTS_BEFORE_PHONE_CODE &&
                    timers.phone
                  ) {
                    timers.usePhoneCode = true;
                    req.logger.info(
                      `[${session}] 🔄 Switching to phone-code auth for next attempt`,
                    );
                  }

                  // Notify webhook so frontend can show appropriate UI
                  callWebHook(client, req, 'status-find', {
                    status: statusFind,
                    session: client.session,
                    nextMode: timers.usePhoneCode ? 'phone_code' : 'qr',
                  });
                  // QR read error = browser will close shortly via autocloseCalled
                  return;
                }

                if (statusFind === StatusFind.qrReadSuccess) {
                  // Linked! Reset everything
                  timers.qrAttempts = 0;
                  timers.usePhoneCode = false;
                  timers.attempts = 0;
                  timers.isRestarting = false;
                }

                if (
                  statusFind === StatusFind.autocloseCalled ||
                  statusFind === StatusFind.disconnectedMobile
                ) {
                  client.status = 'CLOSED';
                  client.qrcode = null;
                  const udd = userDataDir ?? '';
                  forceCloseClient(session, udd, req.logger).then(() => {
                    this.scheduleRestart(req, session, udd);
                  });
                  clientsArray[session] = { status: 'CLOSED', session };
                }

                callWebHook(client, req, 'status-find', {
                  status: statusFind,
                  session: client.session,
                });
              } catch {}
            },
          },
        ),
      );

      // ── Successful create() ────────────────────────────────────────────────
      timers.attempts = 0;
      timers.isRestarting = false;
      // Keep qrAttempts / usePhoneCode until a successful qrReadSuccess resets them

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

  // ───────────────────────────────────────────────────────────────────────────
  // scheduleRestart
  // ───────────────────────────────────────────────────────────────────────────

  scheduleRestart(req: any, session: string, userDataDir: string) {
    const timers = getTimers(session);

    if (timers.isRestarting) {
      req.logger.warn(
        `[${session}] ⏭  Restart already queued – skipping duplicate`,
      );
      return;
    }

    timers.attempts += 1;
    timers.isRestarting = true;

    if (timers.attempts > MAX_RESTART_ATTEMPTS) {
      req.logger.error(
        `[${session}] ❌  Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached`,
      );
      clearAllTimers(session);
      callWebHook(
        (clientsArray as any)[session] ?? { session },
        req,
        'session-failed',
        {
          session,
          message: `Session ${session} could not restart after ${MAX_RESTART_ATTEMPTS} attempts`,
        },
      );
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

  // ───────────────────────────────────────────────────────────────────────────
  // startHealthCheck
  // ───────────────────────────────────────────────────────────────────────────

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

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  async opendata(req: Request, session: string, res?: any) {
    await this.createSessionUtil(req, clientsArray, session, res);
  }

  /**
   * Called externally (e.g. from the start-session route) to pre-configure
   * the phone number for phone-code fallback before the session starts.
   * The Flask backend passes phone in the request body when known.
   */
  setPhoneForSession(session: string, phone: string) {
    const timers = getTimers(session);
    timers.phone = phone;
  }

  /**
   * Returns current session linking state – useful for the status-session endpoint.
   */
  getSessionLinkMode(session: string): 'qr' | 'phone_code' {
    const timers = getTimers(session);
    return timers.usePhoneCode ? 'phone_code' : 'qr';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // QR / Phone-code export
  // ───────────────────────────────────────────────────────────────────────────

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
    callWebHook(client, req, 'phoneCode', {
      phoneCode,
      phone,
      session: client.session,
    });

    if (res && !res._headerSent)
      res.status(200).json({
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

    // WPPConnect strips the data-URI prefix before passing qrCode here.
    // Re-attach it for the webhook payload so the frontend can render it directly.
    const rawB64 = qrCode.replace('data:image/png;base64,', '');
    const imgBuf = Buffer.from(rawB64, 'base64');

    req.io.emit('qrCode', {
      data: 'data:image/png;base64,' + imgBuf.toString('base64'),
      session: client.session,
    });

    callWebHook(client, req, 'qrcode', {
      qrcode: rawB64,
      urlcode: urlCode,
      session: client.session,
    });

    if (res && !res._headerSent)
      res.status(200).json({
        status: 'qrcode',
        qrcode: rawB64,
        urlcode: urlCode,
        session: client.session,
      });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Session start & listeners
  // ───────────────────────────────────────────────────────────────────────────

  async start(req: Request, client: WhatsAppServer) {
    try {
      await client.isConnected();
      Object.assign(client, { status: 'CONNECTED', qrcode: null });
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
      callWebHook(client, req, 'onmessage', message);
      if (message.type === 'location')
        client.onLiveLocation(message.sender.id, (loc) =>
          callWebHook(client, req, 'location', loc),
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
        callWebHook(client, req, 'onselfmessage', message);
    });

    await client.onIncomingCall(async (call) => {
      req.io.emit('incomingcall', call);
      callWebHook(client, req, 'incomingcall', call);
    });
  }

  async listenAcks(client: WhatsAppServer, req: Request) {
    await client.onAck(async (ack) => {
      req.io.emit('onack', ack);
      callWebHook(client, req, 'onack', ack);
    });
  }

  async onPresenceChanged(client: WhatsAppServer, req: Request) {
    await client.onPresenceChanged(async (ev) => {
      req.io.emit('onpresencechanged', ev);
      callWebHook(client, req, 'onpresencechanged', ev);
    });
  }

  async onParticipantsChanged(req: any, client: any) {
    await client.isConnected();
    await client.onParticipantsChanged((msg: any) =>
      callWebHook(client, req, 'onparticipantschanged', msg),
    );
  }

  async onReactionMessage(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onReactionMessage(async (r: any) => {
      req.io.emit('onreactionmessage', r);
      callWebHook(client, req, 'onreactionmessage', r);
    });
  }

  async onRevokedMessage(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onRevokedMessage(async (r: any) => {
      req.io.emit('onrevokedmessage', r);
      callWebHook(client, req, 'onrevokedmessage', r);
    });
  }

  async onPollResponse(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onPollResponse(async (r: any) => {
      req.io.emit('onpollresponse', r);
      callWebHook(client, req, 'onpollresponse', r);
    });
  }

  async onLabelUpdated(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onUpdateLabel(async (r: any) => {
      req.io.emit('onupdatelabel', r);
      callWebHook(client, req, 'onupdatelabel', r);
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

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
