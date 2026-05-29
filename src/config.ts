/*
 * config.ts  – improved for session stability + API token store + Tailscale
 *
 * Key changes vs original:
 *  - tokenStoreType: 'api'  →  uses Flask API instead of MongoDB
 *  - createOptions hardened with STABLE_BROWSER_ARGS from createSessionUtil
 *  - maxListeners increased (avoids EventEmitter leak warnings with many sessions)
 *  - browserless (external Chromium) config explained in comments
 */

import { ServerOptions } from './types/ServerOptions';

export default {
  secretKey: '14e866f74a6f260bfd89b76bca9f2bbb2a0a88a4',
  host: 'http://5.78.137.59',
  port: '21465',
  deviceName: 'cvpap',
  poweredBy: 'Ajiriwa',
  startAllSession: true,

  // ── Token store ───────────────────────────────────────────────────────────
  // 'api'     → store tokens in your Flask Postgres DB (recommended)
  // 'mongodb' → original MongoDB store
  // 'redis'   → Redis store
  // 'file'    → local JSON files (default, good for single-machine dev)
  tokenStoreType: 'api',

  maxListeners: 50, // raised from 15 – avoids warnings with many sessions
  customUserDataDir: './userDataDir/',

  webhook: {
    url: null,
    autoDownload: true,
    uploadS3: false,
    readMessage: true,
    allUnreadOnStart: false,
    listenAcks: true,
    onPresenceChanged: true,
    onParticipantsChanged: true,
    onReactionMessage: true,
    onPollResponse: true,
    onRevokedMessage: true,
    onLabelUpdated: true,
    onSelfMessage: false,
    ignore: ['status@broadcast'],
  },

  websocket: {
    autoDownload: false,
    uploadS3: false,
  },

  chatwoot: {
    sendQrCode: true,
    sendStatus: true,
  },

  archive: {
    enable: false,
    waitTime: 10,
    daysToArchive: 45,
  },

  log: {
    level: 'info', // change to 'silly' when debugging
    logger: ['console', 'file'],
  },

  createOptions: {
    // ── To use an external Browserless / remote Chrome instance ───────────
    // 1. Self-host:  docker run -p 3000:3000 browserless/chrome
    // 2. Set env:    BROWSERLESS_WS_ENDPOINT=ws://your-host:3000
    // 3. Uncomment:
    puppeteerOptions: {
      browserWSEndpoint: 'https://browserless.gidraf.dev',
    },
    //
    // When using browserWSEndpoint, browserArgs below are IGNORED by Puppeteer
    // (the remote browser controls its own flags).  You only need them for
    // local Chromium.
    // ─────────────────────────────────────────────────────────────────────

    browserArgs: [
      // ── Required for headless Linux ──────────────────────────────────────
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // prevent /dev/shm OOM on constrained hosts

      // ── GPU / renderer (not needed headless) ─────────────────────────────
      '--disable-gpu',
      '--disable-software-rasterizer',

      // ── Memory & process reduction ────────────────────────────────────────
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

      // ── Cache / disk (reduce I/O and RAM) ────────────────────────────────
      '--aggressive-cache-discard',
      '--disable-cache',
      '--disable-application-cache',
      '--disable-offline-load-stale-cache',
      '--disk-cache-size=0',
      '--media-cache-size=0',

      // ── V8 heap (tweak per available RAM; 512 MB fine for 1 WA session) ─
      '--js-flags=--max-old-space-size=512',
    ],

    linkPreviewApiServers: null,
  },

  mapper: {
    enable: false,
    prefix: 'tagone-',
  },

  db: {
    // MongoDB kept for reference but not used when tokenStoreType = 'api'
    mongodbDatabase: 'tokens',
    mongodbCollection: 'whatsappBot',
    mongodbUser: 'gidraf',
    mongodbPassword: '@Winners1127',
    mongodbHost: '5.78.137.59',
    mongoIsRemote: true,
    mongoURLRemote:
      'mongodb://gidraf:%40Winners1127@5.78.137.59:27017,5.78.137.59:27018,5.78.137.59:27019/?replicaSet=rs0&authSource=admin',
    mongodbPort: 27017,
    redisHost: '127.0.0.1',
    redisPort: 6379,
    redisPassword: 'Winners1127',
    redisDb: 0,
    redisPrefix: 'docker',
  },

  aws_s3: {
    region: 'sa-east-1' as any,
    access_key_id: null,
    secret_key: null,
    defaultBucketName: null,
    endpoint: null,
    forcePathStyle: null,
  },
} as unknown as ServerOptions;
