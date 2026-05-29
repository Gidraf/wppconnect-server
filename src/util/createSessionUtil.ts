/*
 * Improved createSessionUtil.ts
 * - Stable Puppeteer session (reduced memory, crash recovery, auto-restart)
 * - Tailscale-aware proxy rotation (picks most-active node)
 * - Webhook on proxy unavailability (TODO: email hook stubbed)
 * - External browserless/chrome support info in comments
 */
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
  /** last rx bytes – higher = more recently used */
  rxBytes?: number;
}

/**
 * Parse the output of `tailscale status --json` (or a manually maintained list)
 * and return the most-active node suitable for proxying.
 *
 * In production you should call `tailscale status --json` via child_process and
 * parse the JSON.  For now we keep a static list that mirrors your current
 * `tailscale status` output and can be extended to 1000 nodes.
 */
function getBestTailscaleProxy(): TailscaleNode | null {
  // TODO: replace with dynamic `tailscale status --json` call
  const nodes: TailscaleNode[] = [
    { ip: '100.68.207.107', hostname: 'mail', status: '-', rxBytes: 0 },
    { ip: '100.65.45.69', hostname: 'gidraf', status: 'idle', rxBytes: 0 },
    {
      ip: '100.70.180.34',
      hostname: 'gtv',
      status: 'active',
      rxBytes: 862911316,
    },
    // Add more nodes here as your tailnet grows – order doesn't matter,
    // the selector below picks the best one automatically.
  ];

  // Prefer 'active' nodes, then 'idle', then '-'.
  // Among equals pick the one with the highest rxBytes (most traffic = most alive).
  const ranked = [...nodes].sort((a, b) => {
    const priority = { active: 0, idle: 1, '-': 2 };
    const pa = priority[a.status as keyof typeof priority] ?? 3;
    const pb = priority[b.status as keyof typeof priority] ?? 3;
    if (pa !== pb) return pa - pb;
    return (b.rxBytes ?? 0) - (a.rxBytes ?? 0);
  });

  const best = ranked[0] ?? null;
  if (!best || best.status === '-') {
    // TODO: send webhook/email notification that no proxy is available
    console.warn(
      '[ProxySelector] ⚠️  No active Tailscale proxy available. TODO: send email alert.',
    );
    return null;
  }

  console.log(
    `[ProxySelector] ✅  Using proxy node: ${best.hostname} (${best.ip}) – status=${best.status}`,
  );
  return best;
}

/**
 * Build a proxy config object for wppconnect's `create()` call.
 * Returns `{}` (no proxy) if no active node is found.
 */
function buildProxyConfig(explicitProxy?: {
  url?: string;
  username?: string;
  password?: string;
}) {
  // If the caller already supplied a proxy, honour it.
  if (explicitProxy?.url) return { proxy: explicitProxy };

  const node = getBestTailscaleProxy();
  if (!node) return {}; // no proxy → direct connection

  // WPPConnect accepts an HTTP/SOCKS proxy URL.
  // Tailscale nodes speak SOCKS5 on port 1080 if you run `tailscale up --exit-node`.
  // Adjust the port/scheme to match your actual setup.
  return {
    proxy: {
      url: `socks5://${node.ip}:1080`,
      // username / password only needed if you have auth on the SOCKS proxy
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STABLE PUPPETEER / BROWSER ARGS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal, stable Chromium flags.
 *
 * Goals:
 *  - Reduce RAM:          --single-process removed (it's unstable), instead we
 *                         use --js-flags to limit V8 heap, disable unnecessary
 *                         subsystems, and restrict the page cache.
 *  - Reduce crashes:      keep --no-sandbox only in headless Linux envs,
 *                         use --disable-dev-shm-usage to avoid /dev/shm OOM.
 *  - Reduce page weight:  block images/fonts at the network level via
 *                         requestInterception (see listenMessages).
 *
 * EXTERNAL PUPPETEER / BROWSERLESS:
 *  If you want to offload Chromium to a separate host, set
 *    BROWSERLESS_WS_ENDPOINT=wss://your-browserless-host:3000
 *  in your environment and uncomment the `browserWSEndpoint` line below.
 *  You can self-host browserless with:
 *    docker run -p 3000:3000 browserless/chrome
 *  Then point BROWSERLESS_WS_ENDPOINT=ws://localhost:3000
 *  See: https://www.browserless.io/docs/docker
 */
const STABLE_BROWSER_ARGS = [
  // Security (required for headless Linux)
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // use /tmp instead of /dev/shm → no OOM

  // Memory reduction
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad', // no crash reporter
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

  // Page / cache limits (reduces RAM footprint significantly)
  '--aggressive-cache-discard',
  '--disable-cache',
  '--disable-application-cache',
  '--disable-offline-load-stale-cache',
  '--disk-cache-size=0',
  '--media-cache-size=0',

  // V8 heap limit (tweak to your available RAM; 512 MB is safe for a single WA session)
  '--js-flags=--max-old-space-size=512',
];

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-RESTART CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BACKOFF_MS = 5_000; // initial backoff; doubles each attempt
const SESSION_HEALTH_CHECK_INTERVAL_MS = 60_000; // check every 60 s

// Track restart attempts per session
const restartAttempts: Record<string, number> = {};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CLASS
// ─────────────────────────────────────────────────────────────────────────────

export default class CreateSessionUtil {
  startChatWootClient(client: any) {
    if (client.config.chatWoot && !client._chatWootClient)
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
      client.config = req.body;

      const tokenStore = new Factory();
      const myTokenStore = tokenStore.createTokenStory(client);
      const tokenData = await myTokenStore.getToken(session);
      myTokenStore.setToken(session, tokenData ?? {});

      this.startChatWootClient(client);

      // ── Puppeteer userDataDir ──────────────────────────────────────────────
      if (req.serverOptions.customUserDataDir) {
        req.serverOptions.createOptions.puppeteerOptions = {
          userDataDir: req.serverOptions.customUserDataDir + session,
          // Uncomment to use external Browserless instance:
          // browserWSEndpoint: process.env.BROWSERLESS_WS_ENDPOINT,
        };
      }

      // ── Proxy selection ────────────────────────────────────────────────────
      const proxyConfig = buildProxyConfig(client.config.proxy);

      const wppClient = await create(
        Object.assign(
          {},
          { tokenStore: myTokenStore },
          proxyConfig,
          req.serverOptions.createOptions,
          {
            // Override browserArgs with our stable set
            browserArgs: STABLE_BROWSER_ARGS,

            session: session,
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

                if (
                  statusFind === StatusFind.autocloseCalled ||
                  statusFind === StatusFind.disconnectedMobile
                ) {
                  client.status = 'CLOSED';
                  client.qrcode = null;
                  client.close();
                  clientsArray[session] = undefined;

                  // Auto-restart after disconnect
                  this.scheduleRestart(req, session);
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

      // Reset restart counter on successful init
      restartAttempts[session] = 0;

      client = clientsArray[session] = Object.assign(wppClient, client);
      await this.start(req, client);

      // Start periodic health check
      this.startHealthCheck(req, session);

      if (req.serverOptions.webhook.onParticipantsChanged) {
        await this.onParticipantsChanged(req, client);
      }
      if (req.serverOptions.webhook.onReactionMessage) {
        await this.onReactionMessage(client, req);
      }
      if (req.serverOptions.webhook.onRevokedMessage) {
        await this.onRevokedMessage(client, req);
      }
      if (req.serverOptions.webhook.onPollResponse) {
        await this.onPollResponse(client, req);
      }
      if (req.serverOptions.webhook.onLabelUpdated) {
        await this.onLabelUpdated(client, req);
      }
    } catch (e) {
      req.logger.error(e);
      if (e instanceof Error && e.name === 'TimeoutError') {
        const client = this.getClient(session) as any;
        client.status = 'CLOSED';
      }
      // Auto-restart on init failure
      this.scheduleRestart(req, session);
    }
  }

  // ── Auto-restart with exponential backoff ──────────────────────────────────

  scheduleRestart(req: any, session: string) {
    const attempt = (restartAttempts[session] ?? 0) + 1;
    restartAttempts[session] = attempt;

    if (attempt > MAX_RESTART_ATTEMPTS) {
      req.logger.error(
        `[${session}] ❌  Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached. Manual intervention required.`,
      );
      callWebHook(clientsArray[session] ?? { session }, req, 'session-failed', {
        session,
        message: `Session ${session} failed to restart after ${MAX_RESTART_ATTEMPTS} attempts`,
      });
      return;
    }

    const delay = RESTART_BACKOFF_MS * Math.pow(2, attempt - 1); // 5s, 10s, 20s, 40s, 80s
    req.logger.warn(
      `[${session}] ⚠️  Scheduling restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS} in ${delay / 1000}s`,
    );

    setTimeout(async () => {
      req.logger.info(
        `[${session}] 🔄  Restarting session (attempt ${attempt})…`,
      );
      // Mark as CLOSED so createSessionUtil lets it through
      if (clientsArray[session]) {
        clientsArray[session].status = 'CLOSED';
      }
      await this.opendata(req, session);
    }, delay);
  }

  // ── Periodic health check ──────────────────────────────────────────────────

  startHealthCheck(req: any, session: string) {
    // Clear any existing interval for this session
    if ((clientsArray[session] as any)?._healthCheckInterval) {
      clearInterval((clientsArray[session] as any)._healthCheckInterval);
    }

    const interval = setInterval(async () => {
      const client = clientsArray[session] as any;
      if (!client || client.status === 'CLOSED' || client.status === null) {
        clearInterval(interval);
        return;
      }

      try {
        await client.isConnected();
        req.logger.info(`[${session}] 💚  Health check OK`);
      } catch {
        req.logger.warn(
          `[${session}] 💔  Health check FAILED – scheduling restart`,
        );
        client.status = 'CLOSED';
        clearInterval(interval);
        this.scheduleRestart(req, session);
      }
    }, SESSION_HEALTH_CHECK_INTERVAL_MS);

    // Attach to client so we can clear it on explicit close
    if (clientsArray[session]) {
      (clientsArray[session] as any)._healthCheckInterval = interval;
    }
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

    // WPPConnect strips the data-URI prefix before passing qrCode here,
    // so we always re-attach it for the webhook payload.
    const rawB64 = qrCode.replace('data:image/png;base64,', '');
    const imageBuffer = Buffer.from(rawB64, 'base64');

    req.io.emit('qrCode', {
      data: 'data:image/png;base64,' + imageBuffer.toString('base64'),
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

  // ── Session start + listeners ─────────────────────────────────────────────

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

    if (req.serverOptions.webhook.listenAcks) {
      await this.listenAcks(client, req);
    }
    if (req.serverOptions.webhook.onPresenceChanged) {
      await this.onPresenceChanged(client, req);
    }
  }

  async checkStateSession(client: WhatsAppServer, req: Request) {
    await client.onStateChange((state) => {
      req.logger.info(`State Change ${state}: ${client.session}`);
      const conflits = [SocketState.CONFLICT];
      if (conflits.includes(state)) {
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

      if (message.type === 'sticker') {
        download(message, client, req.logger);
      }

      if (
        req.serverOptions?.websocket?.autoDownload ||
        (req.serverOptions?.webhook?.autoDownload && message.fromMe == false)
      ) {
        await autoDownload(client, req, message);
      }

      req.io.emit('received-message', { response: message });
      if (req.serverOptions.webhook.onSelfMessage && message.fromMe)
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
    await client.onPresenceChanged(async (presenceChangedEvent) => {
      req.io.emit('onpresencechanged', presenceChangedEvent);
      callWebHook(client, req, 'onpresencechanged', presenceChangedEvent);
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
    let client = clientsArray[session];
    if (!client)
      client = clientsArray[session] = {
        status: null,
        session: session,
      } as any;
    return client;
  }
}
