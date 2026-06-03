'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');

// Load persisted config
const CONFIG_FILE = process.env.CONFIG_FILE || '/app/data/config.json';
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    for (const [k, v] of Object.entries(cfg))
      if (v && typeof v === 'string') process.env[k] = v;
    console.log(`[boot] loaded ${Object.keys(cfg).length} config keys`);
  }
} catch (e) { console.warn('[boot] config load failed:', e.message); }

const authRoutes  = require('./routes/auth');
const mixerRoutes = require('./routes/mixer');
const driveRoutes = require('./routes/drive');
const setupRoutes = require('./routes/setup');
const xray        = require('./services/xray');
const { logger }  = require('./utils/logger');

const app  = express();
const PORT = process.env.PORT || 3000;

// Ensure directories
const DATA_DIR    = process.env.OUTPUT_DIR  || '/app/data/output';
const TEMP_DIR    = process.env.TEMP_DIR    || '/tmp/vmixer';
const COOKIES_DIR = path.dirname(process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt');
[DATA_DIR, TEMP_DIR, COOKIES_DIR, path.dirname(CONFIG_FILE)].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'vmixer-secret-change-this',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*24*30, httpOnly: true, secure: process.env.NODE_ENV === 'production' }
}));
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/version', (_, res) => {
  const tryCmd = cmd => { try { return execSync(cmd).toString().trim(); } catch { return 'n/a'; } };
  res.json({
    app: 'VideoMixer',
    ffmpeg:  tryCmd('ffmpeg -version 2>&1 | head -n1'),
    ytdlp:   tryCmd('yt-dlp --version 2>&1'),
    deno:    tryCmd('deno --version 2>&1 | head -n1'),
    xray:    tryCmd('xray version 2>&1 | head -n1'),
    instaloader: tryCmd('instaloader --version 2>&1'),
    python:  tryCmd('python3 --version 2>&1'),
    node:    process.version,
    cookies: fs.existsSync(process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt'),
    ks_cookies: !!(process.env.KS_COOKIES),
    proxy:   !!(process.env.YTDLP_PROXY),
    vmess:   !!(process.env.VMESS_LINK),
    google_oauth: !!(process.env.GOOGLE_CLIENT_ID),
  });
});

app.use('/auth',        authRoutes);
app.use('/api/mixer',   mixerRoutes);
app.use('/api/drive',   driveRoutes);
app.use('/api/setup',   setupRoutes);
// Range-request aware file server — allows video seek/stream on slow connections
app.get('/files/:filename', (req, res) => {
  const filePath = path.join(DATA_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });

  const stat = fs.statSync(filePath);
  const ext  = path.extname(filePath).toLowerCase();
  const mime = ext === '.mp4' ? 'video/mp4' : ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : ext === '.ts' ? 'video/mp2t' : 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024, stat.size - 1); // 1MB chunks
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunkSize,
      'Content-Type':   mime,
      'Cache-Control':  'no-store',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type':   mime,
      'Accept-Ranges':  'bytes',
      'Cache-Control':  'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.use((err, req, res, next) => {
  logger.error('Unhandled:', err);
  res.status(500).json({ error: err.message });
});

// Start KS-Downloader API in background
function startKsDownloader() {
  const ksPath = '/app/ks-downloader';
  const fs2 = require('fs');
  if (!fs2.existsSync(ksPath + '/main.py')) {
    logger.warn('[KS] KS-Downloader not found at ' + ksPath);
    return;
  }
  // Write config.yaml with proxy
  const ksCookies = process.env.KS_COOKIES || '';
  const proxy = process.env.YTDLP_PROXY || 'socks5://127.0.0.1:10808';
  const configYaml = `work_path: "/app/data/output"\nfolder_name: "KS"\ncookie: "${ksCookies}"\nproxy: "${proxy}"\nmax_workers: 4\nmax_retry: 3\ntimeout: 30\n`;
  try {
    fs2.mkdirSync(ksPath + '/Volume', { recursive: true });
    fs2.writeFileSync(ksPath + '/Volume/config.yaml', configYaml);
    logger.info('[KS] config.yaml written');
  } catch(e) { logger.warn('[KS] config write failed: ' + e.message); }

  const { spawn } = require('child_process');
  const proc = spawn('python3', ['main.py', 'api'], {
    cwd: ksPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  proc.stdout.on('data', d => logger.info('[KS-API] ' + d.toString().trim()));
  proc.stderr.on('data', d => logger.info('[KS-API] ' + d.toString().trim()));
  proc.on('close', code => logger.warn('[KS-API] exited with code ' + code));
  logger.info('[KS] KS-Downloader API starting (PID ' + proc.pid + ')');
}

app.listen(PORT, () => {
  logger.info(`🎬 VideoMixer running on port ${PORT}`);
  if (process.env.VMESS_LINK) setTimeout(() => xray.startXray(), 1000);
  setTimeout(() => startKsDownloader(), 3000);
});

['SIGTERM','SIGINT'].forEach(sig => process.on(sig, () => { xray.stopXray(); process.exit(0); }));
