'use strict';
// =====================================================================
// VideoMixer — FFmpeg Merger Pipeline
// 1. Each video → 9:16 crop (720x1280)
// 2. Optional heading OR ranking overlay
// 3. Audio: original / mute / mute+loop from URL
// 4. Concat all clips → single output
// =====================================================================

const { spawn, spawnSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const { renderTitlePng } = require('./titleRenderer');

const VIDEO_W  = parseInt(process.env.VIDEO_WIDTH  || '720',  10);
const VIDEO_H  = parseInt(process.env.VIDEO_HEIGHT || '1280', 10);
const PRESET   = process.env.FFMPEG_PRESET || 'ultrafast';
const CRF      = process.env.FFMPEG_CRF    || '23';
const OUTPUT_DIR = process.env.OUTPUT_DIR  || '/app/data/output';
const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');

// ─── Helpers ──────────────────────────────────────────────────────
function runFFmpeg(args, jobLog, jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.info(`ffmpeg> ${l}`)));
    proc.stderr.on('data', d => {
      const t = d.toString(); stderr += t;
      t.split(/\r?\n/).forEach(l => {
        if (!l) return;
        if (/time=/.test(l) && onProgress) onProgress(l);
        else if (/error|invalid/i.test(l)) jobLog.error(`ffmpeg> ${l}`);
        else jobLog.info(`ffmpeg> ${l}`);
      });
    });
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}\n${stderr.slice(-500)}`)));
  });
}

const COOKIES_FILE = process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt';
const TIKTOK_COOKIES_FILE = process.env.TIKTOK_COOKIES_FILE || '/app/data/cookies/tiktok_cookies.txt';

function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/i.test(url);
}
function isTikTokUrl(url) {
  return /tiktok\.com|vm\.tiktok\.com/i.test(url);
}

function pickBengaliFont(weight = 'bold') {
  const candidates = weight === 'bold' ? [
    path.join(FONT_DIR, 'HindSiliguri-Bold.ttf'),
    path.join(FONT_DIR, 'NotoSansBengali-Bold.ttf'),
    path.join(FONT_DIR, 'HindSiliguri-Regular.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Bold.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf',
  ] : [
    path.join(FONT_DIR, 'HindSiliguri-Regular.ttf'),
    path.join(FONT_DIR, 'NotoSansBengali-Regular.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Bengali font available');
}

function pickEmojiFont() {
  const candidates = [
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/truetype/NotoColorEmoji.ttf',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// Download audio from URL (YT/any) using yt-dlp audio mode
async function downloadAudioFromUrl(url, dest, jobLog) {
  jobLog.info(`🎵 Downloading audio: ${url}`);
  await new Promise((resolve, reject) => {
    const args = [
      '--no-warnings', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '--no-playlist',
      '--retries', '5', '--socket-timeout', '60',
      '-o', dest, url,
    ];
    if (isYouTubeUrl(url)) {
      if (fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100)
        args.push('--cookies', COOKIES_FILE);
      if (process.env.YTDLP_PROXY)
        args.push('--proxy', process.env.YTDLP_PROXY);
    }
    if (isTikTokUrl(url)) {
      if (fs.existsSync(TIKTOK_COOKIES_FILE) && fs.statSync(TIKTOK_COOKIES_FILE).size > 100)
        args.push('--cookies', TIKTOK_COOKIES_FILE);
    }
    args.push('-o', dest);
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.info(`audio> ${l}`)));
    proc.stderr.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && jobLog.warn(`audio> ${l}`)));
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`audio download failed (exit ${code})`)));
  });
  const mp3 = dest.endsWith('.mp3') ? dest : dest + '.mp3';
  if (fs.existsSync(mp3)) return mp3;
  const dir = path.dirname(dest);
  const base = path.basename(dest, path.extname(dest));
  for (const ext of ['.mp3', '.m4a', '.aac', '.opus']) {
    const f = path.join(dir, base + ext);
    if (fs.existsSync(f)) return f;
  }
  throw new Error('Audio file not found after download');
}

// ─── Step 1: Convert single video to 9:16 ────────────────────────
async function convertTo916(inputPath, outputPath, jobLog, speed = 1) {
  const vf = `scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H}`;
  let vfFull = vf;
  let audioFilter = null;
  if (speed && speed !== 1) {
    const s = parseFloat(speed);
    vfFull = `${vf},setpts=${(1/s).toFixed(4)}*PTS`;
    if (s <= 2) audioFilter = `atempo=${s}`;
    else audioFilter = `atempo=2.0,atempo=${(s/2).toFixed(4)}`;
  }
  const ffArgs = [
    '-i', inputPath,
    '-vf', vfFull,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
  ];
  if (audioFilter) ffArgs.push('-af', audioFilter, '-c:a', 'aac', '-b:a', '128k');
  else ffArgs.push('-c:a', 'aac', '-b:a', '128k');
  ffArgs.push('-r', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath);
  await runFFmpeg(ffArgs, jobLog, null);
}

// ─── Heading renderers ────────────────────────────────────────────
async function addHeadingLegacy(inputPath, outputPath, text, position, fontSize, jobLog) {
  const sanitizedText = String(text).replace(/'/g, '\u2019').replace(/:/g, '\\:');
  const fontPath = '/app/src/public/fonts/HindSiliguri-Bold.ttf';
  const yMap = { top: '80', center: '(h/2-text_h/2)', bottom: '(h-text_h-80)' };
  const y = yMap[position] || '80';
  const drawtext = [
    `fontfile=${fontPath}`,
    `text='${sanitizedText}'`,
    `fontsize=${fontSize}`,
    `fontcolor=white`,
    `x=(w-text_w)/2`,
    `y=${y}`,
    `box=1`,
    `boxcolor=black@0.55`,
    `boxborderw=18`,
  ].join(':');

  await runFFmpeg([
    '-i', inputPath,
    '-vf', `drawtext=${drawtext}`,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ], jobLog, null);
}

async function addHeading(inputPath, outputPath, heading, jobLog) {
  const text = typeof heading === 'string' ? heading : heading?.text;
  if (!text || !String(text).trim()) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  const position = (typeof heading === 'object' && heading?.position) || 'top';
  const parsedFontSize = parseInt(typeof heading === 'object' ? heading?.fontSize : '', 10);
  const fontSize = Number.isFinite(parsedFontSize) ? Math.max(24, Math.min(96, parsedFontSize)) : 52;
  const titlePng = path.join(path.dirname(outputPath), `heading_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const canvasW = Math.max(420, VIDEO_W - 60);
  const canvasH = Math.max(120, Math.min(260, Math.round(fontSize * 3.8)));
  const yMap = { top: '80', center: '(main_h-overlay_h)/2', bottom: '(main_h-overlay_h-80)' };
  const y = yMap[position] || '80';

  try {
    renderTitlePng({
      text: String(text).trim(),
      width: canvasW,
      height: canvasH,
      fontSize,
      minFontSize: 20,
      maxLines: 4,
      paddingX: 28,
      paddingY: 18,
      lineHeightRatio: 1.22,
      outPath: titlePng,
      fg: [255, 255, 255, 255],
      bg: [0, 0, 0, 145],
      shadow: [0, 0, 0, 180, 2, 2],
      fontWeight: 'bold',
    });

    await runFFmpeg([
      '-i', inputPath,
      '-i', titlePng,
      '-filter_complex', `[0:v][1:v]overlay=x=(main_w-overlay_w)/2:y=${y}:format=auto[v]`,
      '-map', '[v]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ], jobLog, null);
  } catch (err) {
    jobLog.warn(`PNG heading renderer failed, using legacy drawtext fallback: ${err.message}`);
    await addHeadingLegacy(inputPath, outputPath, String(text).trim(), position, fontSize, jobLog);
  } finally {
    try { if (fs.existsSync(titlePng)) fs.unlinkSync(titlePng); } catch (_) {}
  }
}

const PY_RANKING_RENDERER = String.raw`
import sys, json, unicodedata
from PIL import Image, ImageDraw, ImageFont

cfg = json.loads(sys.argv[1])
W = int(cfg['width'])
H = int(cfg['height'])
preset = cfg.get('preset', 'left_list')
current_rank = int(cfg.get('current_rank', 1))
total_ranks = max(1, int(cfg.get('total_ranks', 1)))
title = str(cfg.get('title') or '').strip()
font_path = cfg['font_path']
emoji_font_path = cfg.get('emoji_font_path')

try:
    layout = ImageFont.Layout.RAQM
except AttributeError:
    layout = ImageFont.LAYOUT_RAQM if hasattr(ImageFont, 'LAYOUT_RAQM') else ImageFont.LAYOUT_BASIC

img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

num_size = 74 if total_ranks <= 5 else 66
active_num_size = num_size + 4
small_num_size = 86
active_title_size = 42
badge_title_size = 46

num_font = ImageFont.truetype(font_path, num_size, layout_engine=layout)
active_num_font = ImageFont.truetype(font_path, active_num_size, layout_engine=layout)
small_num_font = ImageFont.truetype(font_path, small_num_size, layout_engine=layout)
active_title_font = ImageFont.truetype(font_path, active_title_size, layout_engine=layout)
badge_title_font = ImageFont.truetype(font_path, badge_title_size, layout_engine=layout)

emoji_font = None
if emoji_font_path:
    try:
        emoji_font = ImageFont.truetype(emoji_font_path, active_title_size, layout_engine=ImageFont.Layout.BASIC if hasattr(ImageFont, 'Layout') else ImageFont.LAYOUT_BASIC)
    except Exception:
        emoji_font = None

badge_emoji_font = None
if emoji_font_path:
    try:
        badge_emoji_font = ImageFont.truetype(emoji_font_path, badge_title_size, layout_engine=ImageFont.Layout.BASIC if hasattr(ImageFont, 'Layout') else ImageFont.LAYOUT_BASIC)
    except Exception:
        badge_emoji_font = emoji_font

def is_emoji(ch):
    try:
        cat = unicodedata.category(ch)
        cp = ord(ch)
        return cat in ('So', 'Sm') or (0x1F000 <= cp <= 0x1FFFF) or (0x2600 <= cp <= 0x27BF) or cp in (0xFE0F, 0x200D)
    except Exception:
        return False

def draw_text_with_emoji(draw, x, y, text, main_font, emoji_font_obj, fill, shadow=None):
    cx = x
    i = 0
    while i < len(text):
        ch = text[i]
        seq = ch
        j = i + 1
        while j < len(text) and (text[j] in ('\uFE0F', '\u200D') or (is_emoji(text[j]) and j > i and text[j-1] == '\u200D')):
            seq += text[j]
            j += 1
        use_emoji = emoji_font_obj and any(is_emoji(c) for c in seq)
        font = emoji_font_obj if use_emoji else main_font
        if shadow:
            sr, sg, sb, sa, sox, soy = shadow
            draw.text((cx + sox, y + soy), seq, font=font, fill=(sr, sg, sb, sa))
        draw.text((cx, y), seq, font=font, fill=fill)
        bb = draw.textbbox((0, 0), seq, font=font)
        cx += bb[2] - bb[0] + 1
        i = j


def wrap_text(text, font, max_w, emoji_font_obj):
    words = text.split()
    if not words:
        return []
    lines = []
    cur = []
    for w in words:
        candidate = ' '.join(cur + [w])
        bb = draw.textbbox((0, 0), candidate, font=font)
        if bb[2] - bb[0] <= max_w or not cur:
            cur.append(w)
        else:
            lines.append(' '.join(cur))
            cur = [w]
    if cur:
        lines.append(' '.join(cur))
    return lines

shadow = (0, 0, 0, 220, 2, 2)
white = (255, 255, 255, 245)
red = (255, 72, 72, 255)
faded = (255, 255, 255, 210)

if preset == 'current_badge':
    draw.rounded_rectangle((18, 34, W - 18, 200), radius=28, fill=(0, 0, 0, 135))
    draw.rounded_rectangle((28, 48, 140, 186), radius=24, fill=(120, 0, 0, 170), outline=(255, 80, 80, 230), width=2)
    draw_text_with_emoji(draw, 46, 70, f'{current_rank}.', small_num_font, badge_emoji_font, red, shadow)
    if title:
        lines = wrap_text(title, badge_title_font, W - 176, badge_emoji_font)[:2]
        ty = 66
        for line in lines:
            draw_text_with_emoji(draw, 165, ty, line, badge_title_font, badge_emoji_font, white, shadow)
            ty += 56
else:
    start_y = 210 if total_ranks <= 5 else 165
    gap = 98 if total_ranks <= 5 else 84
    for rank in range(1, total_ranks + 1):
        y = start_y + (rank - 1) * gap
        is_active = rank == current_rank
        font = active_num_font if is_active else num_font
        fill = red if is_active else faded
        draw_text_with_emoji(draw, 32, y, f'{rank}.', font, emoji_font, fill, shadow)
        if is_active and title:
            lines = wrap_text(title, active_title_font, W - 155, emoji_font)[:2]
            ty = y + 18
            for line in lines:
                draw_text_with_emoji(draw, 118, ty, line, active_title_font, emoji_font, white, shadow)
                ty += 50

img.save(cfg['out'])
print('OK')
`;

function renderRankingPng(opts) {
  const cfg = {
    width: opts.width,
    height: opts.height,
    preset: opts.preset || 'left_list',
    current_rank: opts.currentRank,
    total_ranks: opts.totalRanks,
    title: String(opts.title || ''),
    font_path: pickBengaliFont('bold'),
    emoji_font_path: pickEmojiFont(),
    out: opts.outPath,
  };
  const r = spawnSync('python3', ['-c', PY_RANKING_RENDERER, JSON.stringify(cfg)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ranking overlay render failed: ${r.stderr || r.stdout || 'python3 exited ' + r.status}`);
  if (!fs.existsSync(opts.outPath)) throw new Error('ranking overlay PNG not created');
  return opts.outPath;
}

function computeRankForIndex(index, total, ranking) {
  return ranking?.direction === 'countdown' ? (total - index) : (index + 1);
}

async function addRankingOverlay(inputPath, outputPath, rankingItem, jobLog) {
  if (!rankingItem) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }
  const overlayPng = path.join(path.dirname(outputPath), `ranking_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  try {
    renderRankingPng({
      width: VIDEO_W,
      height: VIDEO_H,
      preset: rankingItem.preset,
      currentRank: rankingItem.currentRank,
      totalRanks: rankingItem.totalRanks,
      title: rankingItem.title,
      outPath: overlayPng,
    });

    await runFFmpeg([
      '-i', inputPath,
      '-i', overlayPng,
      '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[v]',
      '-map', '[v]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ], jobLog, null);
  } finally {
    try { if (fs.existsSync(overlayPng)) fs.unlinkSync(overlayPng); } catch (_) {}
  }
}

function buildRankingItem(sourceMeta, index, total, ranking) {
  if (!ranking || !ranking.enabled) return null;
  const currentRank = computeRankForIndex(index, total, ranking);
  return {
    preset: ranking.preset || 'left_list',
    currentRank,
    totalRanks: total,
    title: sourceMeta?.rankTitle || sourceMeta?.title || `Rank ${currentRank}`,
  };
}

// ─── Step 3: Concat all clips ─────────────────────────────────────
async function concatClips(clipPaths, outputPath, jobLog) {
  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], outputPath);
    return;
  }

  const concatFile = outputPath + '.concat.txt';
  fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));

  await runFFmpeg([
    '-f', 'concat', '-safe', '0',
    '-i', concatFile,
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ], jobLog, null);

  try { fs.unlinkSync(concatFile); } catch (_) {}
}

// ─── Step 4: Apply audio settings ────────────────────────────────
async function applyAudio(inputPath, outputPath, audioOpts, workDir, jobLog) {
  const { mode, audioUrl } = audioOpts;

  if (mode === 'original') {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  if (mode === 'mute') {
    await runFFmpeg([
      '-i', inputPath,
      '-c:v', 'copy', '-an',
      outputPath,
    ], jobLog, null);
    return;
  }

  if (mode === 'audio_url' && audioUrl) {
    const audioDest = path.join(workDir, 'bg_audio');
    const audioFile = await downloadAudioFromUrl(audioUrl, audioDest, jobLog);

    const getDuration = (filePath) => {
      try {
        const { execSync } = require('child_process');
        const out = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`).toString().trim();
        return parseFloat(out) || 0;
      } catch (_) { return 0; }
    };

    const videoDuration = getDuration(inputPath);
    const audioDuration = getDuration(audioFile);
    jobLog.info(`📹 Video: ${videoDuration.toFixed(1)}s | 🎵 Audio: ${audioDuration.toFixed(1)}s`);

    let ffmpegArgs;
    if (audioDuration > 0 && audioDuration < videoDuration) {
      jobLog.info(`🔁 Audio shorter — looping to fill ${videoDuration.toFixed(1)}s`);
      ffmpegArgs = [
        '-i', inputPath,
        '-stream_loop', '-1', '-i', audioFile,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-t', String(videoDuration),
        '-movflags', '+faststart', outputPath,
      ];
    } else {
      jobLog.info(`✂️ Audio longer/equal — cutting at ${videoDuration.toFixed(1)}s`);
      ffmpegArgs = [
        '-i', inputPath, '-i', audioFile,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-movflags', '+faststart', outputPath,
      ];
    }

    await runFFmpeg(ffmpegArgs, jobLog, null);
    return;
  }

  fs.copyFileSync(inputPath, outputPath);
}

// ─── Main merge pipeline ──────────────────────────────────────────
async function mergeVideos({ videoFiles, sourcesMeta = [], workDir, jobId, heading, ranking, audioOpts, jobLog, speeds = [] }) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const steps = videoFiles.length * 2 + 2;
  let step = 0;
  const progress = () => jobLog.info(`[merge] step ${++step}/${steps}`);

  const croppedPaths = [];
  for (let i = 0; i < videoFiles.length; i++) {
    const cropped = path.join(workDir, `cropped_${i}.mp4`);
    const speed = parseFloat(speeds[i]) || 1;
    jobLog.info(`📐 Cropping ${i + 1}/${videoFiles.length} to 9:16${speed !== 1 ? ` (${speed}x)` : ''}...`);
    await convertTo916(videoFiles[i], cropped, jobLog, speed);
    croppedPaths.push(cropped);
    progress();
  }

  const headedPaths = [];
  for (let i = 0; i < croppedPaths.length; i++) {
    const headed = path.join(workDir, `headed_${i}.mp4`);
    if (ranking && ranking.enabled) {
      const rankItem = buildRankingItem(sourcesMeta[i], i, croppedPaths.length, ranking);
      jobLog.info(`🏆 Adding ranking overlay ${i + 1}/${croppedPaths.length} → #${rankItem.currentRank}`);
      await addRankingOverlay(croppedPaths[i], headed, rankItem, jobLog);
    } else if (heading && heading.text && heading.text.trim()) {
      jobLog.info(`📝 Adding heading ${i + 1}/${croppedPaths.length}...`);
      await addHeading(croppedPaths[i], headed, heading, jobLog);
    } else {
      fs.copyFileSync(croppedPaths[i], headed);
    }
    headedPaths.push(headed);
    progress();
  }

  const concatPath = path.join(workDir, 'concat.mp4');
  jobLog.info(`🔗 Concatenating ${headedPaths.length} clips...`);
  await concatClips(headedPaths, concatPath, jobLog);
  progress();

  const timestamp = Date.now();
  const finalName = `merged_${jobId}_${timestamp}.mp4`;
  const finalPath = path.join(OUTPUT_DIR, finalName);
  jobLog.info(`🎵 Applying audio (mode: ${audioOpts?.mode || 'original'})...`);
  await applyAudio(concatPath, finalPath, audioOpts || { mode: 'original' }, workDir, jobLog);
  progress();

  const sizeBytes = fs.statSync(finalPath).size;
  jobLog.info(`✅ Merge complete! (${(sizeBytes/1024/1024).toFixed(2)} MB) → ${finalName}`);
  return { filePath: finalPath, fileName: finalName, sizeBytes };
}

module.exports = { mergeVideos, convertTo916, addHeading, addRankingOverlay };
