/*
 * createSessionUtil.ts  – fixed & improved
 *
 * ROOT CAUSES FIXED:
 *
 * BUG 1 – "The browser is already running for ./userDataDir/<session>"
 *   The previous scheduleRestart() only set client.status = 'CLOSED' in
 *   clientsArray but never called client.close() / client.kill() to actually
 *   terminate the Puppeteer/Chrome process or release the userDataDir lock.
 *   On the next restart attempt Chromium found its profile directory locked
 *   by the previous (zombie) process and refused to start.
 *   FIX: forceCloseClient() — fully kills the browser process AND removes the
 *   SingletonLock file from the userDataDir before every restart.
 *
 * BUG 2 – "Auto Close Called" / qrReadError / notLogged loop
 *   WPPConnect has a built-in 60-second auto-close timer that fires when the
 *   QR code is not scanned.  Our restart logic was re-triggering restarts from
 *   BOTH the statusFind('autocloseCalled') callback AND the catch() block of
 *   createSessionUtil, doubling the attempt counter and exhausting MAX_RESTART_ATTEMPTS
 *   in half the expected iterations.
 *   FIX: deduplicated restart scheduling with an _isRestarting flag per session;
 *   only one restart is ever queued at a time.
 *
 * BUG 3 – Health check fires after max retries reached
 *   The 60-second health check interval was still running after all restart
 *   attempts were exhausted, spamming "Max restart attempts reached" every minute.
 *   FIX: clearAllTimers() clears both the health-check interval and any pending
 *   restart timeout whenever we give up.
 *
 * OTHER IMPROVEMENTS:
 *  - Tailscale dynamic proxy via `tailscale status --json` (falls back to static list)
 *  - Stable Puppeteer browser args (low RAM, no crashes)
 *  - External Browserless/Chrome support (see comments)
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
// TAILSCALE PROXY ROTATION
// ─────────────────────────────────────────────────────────────────────────────

interface TailscaleNode {
  ip: string;
  hostname: string;
  /** 'active' | 'idle' | '-' */
  status: string;
  rxBytes: number;
}

/**
 * Reads the live Tailscale peer list via `tailscale status --json`.
 * Falls back to a static list if the CLI is unavailable.
 * Scales to 1000+ nodes automatically since it reads from the daemon.
 */
function getLiveTailscaleNodes(): TailscaleNode[] {
  try {
    const raw = execSync('tailscale status --json', {
      timeout: 3000,
    }).toString();
    const json = JSON.parse(raw);
    const peers: TailscaleNode[] = [];

    // `Peer` is a map of public-key → peer object
    for (const peer of Object.values(json.Peer ?? {}) as any[]) {
      const ip: string = peer.TailscaleIPs?.[0] ?? '';
      const hostname: string = peer.HostName ?? peer.DNSName ?? ip;
      // Online = last seen within the last 3 minutes
      const lastSeenMs = peer.LastSeen ? Date.parse(peer.LastSeen) : 0;
      const ageSeconds = (Date.now() - lastSeenMs) / 1000;
      const status = peer.Online ? 'active' : ageSeconds < 180 ? 'idle' : '-';
      const rxBytes: number = peer.RxBytes ?? 0;
      peers.push({ ip, hostname, status, rxBytes });
    }
    return peers;
  } catch {
    // Fallback: static list matching your current `tailscale status` output.
    // Update this manually or replace with a more robust dynamic approach.
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
  const nodes = getLiveTailscaleNodes();
  const priority: Record<string, number> = { active: 0, idle: 1, '-': 2 };

  const ranked = [...nodes].sort((a, b) => {
    const pa = priority[a.status] ?? 3;
    const pb = priority[b.status] ?? 3;
    if (pa !== pb) return pa - pb;
    return b.rxBytes - a.rxBytes;
  });

  const best = ranked[0] ?? null;
  if (!best || best.status === '-') {
    // TODO: send webhook/email notification that no proxy is available
    console.warn(
      '[ProxySelector] ⚠️  No active Tailscale proxy. TODO: send email alert.',
    );
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
  // Tailscale nodes expose SOCKS5 on port 1080 when used as exit nodes.
  // Adjust port/scheme to match your actual setup.
  return { proxy: { url: `socks5://${node.ip}:1080` } };
}

// ─────────────────────────────────────────────────────────────────────────────
// STABLE PUPPETEER BROWSER ARGS
// ─────────────────────────────────────────────────────────────────────────────
//
// EXTERNAL CHROME / BROWSERLESS:
//   To offload Chromium to a separate machine:
//   1. Self-host:  docker run -p 3000:3000 browserless/chrome
//   2. Set env:    BROWSERLESS_WS_ENDPOINT=ws://your-host:3000
//   3. In createSessionUtil below, uncomment `browserWSEndpoint`.
//   When using a remote endpoint these browserArgs are ignored by Puppeteer.

const STABLE_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // prevent /dev/shm OOM
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
  // Cap V8 heap to ~512 MB per session. Tune to available RAM.
  '--js-flags=--max-old-space-size=512',
];

// ─────────────────────────────────────────────────────────────────────────────
// SESSION RESTART STATE
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BACKOFF_MS = 10_000; // 10s, 20s, 40s, 80s, 160s
const SESSION_HEALTH_CHECK_INTERVAL_MS = 90_000; // check every 90 s

interface SessionTimers {
  restartTimeout: ReturnType<typeof setTimeout> | null;
  healthCheckInterval: ReturnType<typeof setInterval> | null;
  attempts: number;
  isRestarting: boolean; // ← BUG 2 FIX: prevent duplicate queuing
}

const sessionTimers: Record<string, SessionTimers> = {};

function getTimers(session: string): SessionTimers {
  if (!sessionTimers[session]) {
    sessionTimers[session] = {
      restartTimeout: null,
      healthCheckInterval: null,
      attempts: 0,
      isRestarting: false,
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
// FORCE-CLOSE HELPER  (BUG 1 FIX)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fully terminates the Puppeteer browser for `session` and removes the
 * Chromium SingletonLock file so the next start() call can acquire the
 * userDataDir without the "browser is already running" error.
 */
async function forceCloseClient(
  session: string,
  userDataDir: string,
  logger?: any,
) {
  const client = (clientsArray as any)[session];

  // 1. Try graceful close first
  try {
    if (client && typeof client.close === 'function') {
      await client.close();
    }
  } catch {
    // ignore – process may already be gone
  }

  // 2. Kill the underlying browser process if it's still alive
  try {
    const browser = client?.page?.browser?.() ?? client?._browser;
    if (browser && typeof browser.process === 'function') {
      const proc = browser.process();
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
        logger?.warn(
          `[${session}] 🔪  SIGKILL sent to browser process PID ${proc.pid}`,
        );
      }
    }
  } catch {
    // ignore
  }

  // 3. Remove the Chromium SingletonLock file  ← KEY FIX for "already running"
  const lockFile = path.join(userDataDir, 'SingletonLock');
  const sockFile = path.join(userDataDir, 'SingletonSocket');
  for (const f of [lockFile, sockFile]) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        logger?.info(`[${session}] 🗑️  Removed lock file: ${f}`);
      }
    } catch {
      // ignore – might be a race condition
    }
  }

  // 4. Mark slot as empty in clientsArray
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

  // ── Session creation ───────────────────────────────────────────────────────

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
          // Uncomment to use external Browserless:
          // browserWSEndpoint: process.env.BROWSERLESS_WS_ENDPOINT,
        };
      }

      const proxyConfig = buildProxyConfig(client.config.proxy);

      const wppClient = await create(
        Object.assign(
          {},
          { tokenStore: myTokenStore },
          proxyConfig,
          req.serverOptions.createOptions,
          {
            browserArgs: STABLE_BROWSER_ARGS,
            session,
            phoneNumber: client.config.phone ?? null,
            deviceName:
              client.config.phone == undefined
                ? client.config?.deviceName ||
                  req.serverOptions.deviceName ||
                  'WppConnect'
                : undefined,
            poweredBy:
              client.config.phone == undefined
                ? client.config?.poweredBy ||
                  req.serverOptions.poweredBy ||
                  'WPPConnect-Server'
                : undefined,

            catchLinkCode: (code: string) => {
              this.exportPhoneCode(req, client.config.phone, code, client, res);
            },
            catchQR: (
              base64Qr: any,
              asciiQR: any,
              attempt: any,
              urlCode: string,
            ) => {
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

                // BUG 2 FIX: autocloseCalled / disconnectedMobile schedule a
                // restart exactly once via scheduleRestart() which checks
                // isRestarting.  We do NOT also throw in the catch block.
                if (
                  statusFind === StatusFind.autocloseCalled ||
                  statusFind === StatusFind.disconnectedMobile
                ) {
                  client.status = 'CLOSED';
                  client.qrcode = null;

                  // Close the browser cleanly before restarting
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
                req.logger.info(statusFind + '\n\n');
              } catch (error) {}
            },
          },
        ),
      );

      // Successful init: reset counters
      const timers = getTimers(session);
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
      req.logger.error(e);

      const udd = req.serverOptions.customUserDataDir
        ? req.serverOptions.customUserDataDir + session
        : '';

      // BUG 2 FIX: only schedule restart from catch() if we are NOT already
      // restarting (statusFind may have already queued one above).
      const timers = getTimers(session);
      if (!timers.isRestarting) {
        // Force-close to clear the lock file before retry (BUG 1 FIX)
        await forceCloseClient(session, udd, req.logger);
        this.scheduleRestart(req, session, udd);
      }
    }
  }

  // ── Force close + schedule restart ────────────────────────────────────────

  scheduleRestart(req: any, session: string, userDataDir: string) {
    const timers = getTimers(session);

    // BUG 2 FIX: only one restart can be queued at a time
    if (timers.isRestarting) {
      req.logger.warn(
        `[${session}] ⏭  Restart already queued, skipping duplicate`,
      );
      return;
    }

    timers.attempts += 1;
    timers.isRestarting = true;

    if (timers.attempts > MAX_RESTART_ATTEMPTS) {
      req.logger.error(
        `[${session}] ❌  Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached. Manual intervention required.`,
      );
      // BUG 3 FIX: clear health check so it stops spamming
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

    // Exponential backoff: 10s, 20s, 40s, 80s, 160s
    const delay = RESTART_BACKOFF_MS * Math.pow(2, timers.attempts - 1);
    req.logger.warn(
      `[${session}] ⚠️  Restart attempt ${timers.attempts}/${MAX_RESTART_ATTEMPTS} in ${delay / 1000}s`,
    );

    timers.restartTimeout = setTimeout(async () => {
      req.logger.info(
        `[${session}] 🔄  Restarting session (attempt ${timers.attempts})…`,
      );
      timers.isRestarting = false; // allow createSessionUtil guard to pass
      timers.restartTimeout = null;

      // BUG 1 FIX: ensure lock files are gone before re-launching
      await forceCloseClient(session, userDataDir, req.logger);
      await this.opendata(req, session);
    }, delay);
  }

  // ── Periodic health check ──────────────────────────────────────────────────

  startHealthCheck(req: any, session: string, userDataDir: string) {
    const timers = getTimers(session);

    // Clear any pre-existing interval
    if (timers.healthCheckInterval) {
      clearInterval(timers.healthCheckInterval);
      timers.healthCheckInterval = null;
    }

    timers.healthCheckInterval = setInterval(async () => {
      const client = (clientsArray as any)[session] as any;

      // Stop if session was intentionally closed or already restarting
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
        req.logger.info(`[${session}] 💚  Health OK`);
      } catch {
        req.logger.warn(
          `[${session}] 💔  Health check FAILED – scheduling restart`,
        );
        clearInterval(timers.healthCheckInterval!);
        timers.healthCheckInterval = null;
        client.status = 'CLOSED';
        await forceCloseClient(session, userDataDir, req.logger);
        this.scheduleRestart(req, session, userDataDir);
      }
    }, SESSION_HEALTH_CHECK_INTERVAL_MS);
  }

  // ── Public entry point ─────────────────────────────────────────────────────

  async opendata(req: Request, session: string, res?: any) {
    await this.createSessionUtil(req, clientsArray, session, res);
  }

  // ── QR / phone code export ─────────────────────────────────────────────────

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

    // Strip prefix before sending – consumer (your Flask side) re-attaches it
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

  // ── Session start + listeners ──────────────────────────────────────────────

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
      if ([SocketState.CONFLICT].includes(state)) {
        client.useHere();
      }
    });
  }

  async listenMessages(client: WhatsAppServer, req: Request) {
    await client.onMessage(async (message: any) => {
      eventEmitter.emit(`mensagem-${client.session}`, client, message);
      callWebHook(client, req, 'onmessage', message);
      if (message.type === 'location')
        client.onLiveLocation(message.sender.id, (location) => {
          callWebHook(client, req, 'location', location);
        });
    });

    await client.onAnyMessage(async (message: any) => {
      message.session = client.session;
      if (message.type === 'sticker') download(message, client, req.logger);
      if (
        (req as any).serverOptions?.websocket?.autoDownload ||
        ((req as any).serverOptions?.webhook?.autoDownload && !message.fromMe)
      ) {
        await autoDownload(client, req, message);
      }
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
    await client.onParticipantsChanged((message: any) => {
      callWebHook(client, req, 'onparticipantschanged', message);
    });
  }

  async onReactionMessage(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onReactionMessage(async (reaction: any) => {
      req.io.emit('onreactionmessage', reaction);
      callWebHook(client, req, 'onreactionmessage', reaction);
    });
  }

  async onRevokedMessage(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onRevokedMessage(async (response: any) => {
      req.io.emit('onrevokedmessage', response);
      callWebHook(client, req, 'onrevokedmessage', response);
    });
  }

  async onPollResponse(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onPollResponse(async (response: any) => {
      req.io.emit('onpollresponse', response);
      callWebHook(client, req, 'onpollresponse', response);
    });
  }

  async onLabelUpdated(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onUpdateLabel(async (response: any) => {
      req.io.emit('onupdatelabel', response);
      callWebHook(client, req, 'onupdatelabel', response);
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
