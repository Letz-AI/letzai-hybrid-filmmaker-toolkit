'use strict';
// Everything that touches ffmpeg / ffprobe: discovery, probing, thumbnails, review proxies, cuts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);

let located = null;

/** Where are ffmpeg and ffprobe? Looks at env overrides, PATH, next to the app, and WinGet's package folder. */
function locate(force) {
  if (located && !force) return located;
  const cands = [];
  const envDir = process.env.LETZAI_KIT_FFMPEG;
  if (envDir) cands.push(fs.existsSync(envDir) && fs.statSync(envDir).isDirectory() ? path.join(envDir, exe('ffmpeg')) : envDir);
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  if (lookup.status === 0) cands.push(...lookup.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  const here = path.join(__dirname, '..', '..');
  cands.push(path.join(here, 'bin', exe('ffmpeg')), path.join(here, 'tools', exe('ffmpeg')));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const wg = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const pkg of fs.readdirSync(wg)) {
        if (!/ffmpeg/i.test(pkg)) continue;
        const stack = [path.join(wg, pkg)];
        while (stack.length) {
          const d = stack.pop();
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) stack.push(path.join(d, e.name));
            else if (e.name.toLowerCase() === 'ffmpeg.exe') cands.push(path.join(d, e.name));
          }
        }
      }
    } catch { /* no winget packages */ }
  }
  if (process.platform === 'darwin') cands.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  const ffmpeg = cands.find((c) => c && fs.existsSync(c));
  if (!ffmpeg) { located = { ok: false }; return located; }
  const dir = path.dirname(ffmpeg);
  const probeCand = path.join(dir, exe('ffprobe'));
  const ffprobe = fs.existsSync(probeCand) ? probeCand : null;
  const v = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
  const version = (/ffmpeg version (\S+)/.exec(v.stdout || '') || [])[1] || 'unknown';
  located = { ok: !!ffprobe, ffmpeg, ffprobe, version, missing: ffprobe ? null : 'ffprobe' };
  return located;
}

/** Run a binary, collect output. Rejects on non-zero exit. */
function runCapture(bin, args, { signal, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = timeout ? setTimeout(() => { p.kill(); }, timeout) : null;
    if (signal) signal.addEventListener('abort', () => p.kill(), { once: true });
    p.on('error', reject);
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

/** ffprobe -> the handful of fields the kit cares about (including Blackmagic / Apple camera tags). */
async function probe(file) {
  const loc = locate();
  if (!loc.ok) throw new Error('ffprobe not found');
  const { out } = await runCapture(loc.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeout: 30000 });
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const tags = { ...(j.format && j.format.tags), ...(v.tags || {}) };
  const t = (k) => tags[k] ?? tags[k.toLowerCase()] ?? tags[k.toUpperCase()];
  const fr = String(v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate || '0/1').split('/');
  const fps = Number(fr[0]) / (Number(fr[1]) || 1) || 0;
  let rotation = 0;
  for (const sd of v.side_data_list || []) if (sd.rotation != null) rotation = Math.abs(Number(sd.rotation)) % 360;
  let w = v.width || 0;
  let h = v.height || 0;
  if (rotation === 90 || rotation === 270) [w, h] = [h, w];
  const loc6709 = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(t('com.apple.quicktime.location.ISO6709') || '');
  return {
    duration: Number(j.format && j.format.duration) || Number(v.duration) || 0,
    width: w,
    height: h,
    fps: Math.round(fps * 1000) / 1000,
    codec: v.codec_name || '',
    pixFmt: v.pix_fmt || '',
    hasAudio: !!a,
    audioCodec: a ? a.codec_name : '',
    bitrate: Number(j.format && j.format.bit_rate) || 0,
    recordedAt: t('com.blackmagic-design.camera.dateRecorded') || t('com.apple.quicktime.creationdate') || t('creation_time') || '',
    camera: {
      clipId: t('com.apple.proapps.clipID') || '',
      model: t('com.apple.quicktime.model') || '',
      lens: t('com.blackmagic-design.camera.lensType') || '',
      iso: t('com.blackmagic-design.camera.iso') || '',
      shutter: t('com.blackmagic-design.shutterSpeed') || '',
      aperture: t('com.blackmagic-design.camera.aperture') || '',
      kelvin: t('com.blackmagic-design.camera.whiteBalanceKelvin') || '',
      lut: t('com.blackmagic-design.camera.look.LUTName') || '',
      lat: loc6709 ? Number(loc6709[1]) : null,
      lon: loc6709 ? Number(loc6709[2]) : null,
    },
  };
}

/**
 * Run ffmpeg with progress reporting. `duration` (seconds) turns out_time into a 0..1 fraction.
 * Output goes to <dst>.part and is renamed when ffmpeg succeeds, so no half-written file ever has the real name.
 */
function runFfmpeg(args, { duration, onProgress, signal } = {}) {
  const loc = locate();
  if (!loc.ok) return Promise.reject(new Error('ffmpeg not found'));
  return new Promise((resolve, reject) => {
    const p = spawn(loc.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
    let err = '';
    let buf = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    if (signal) {
      if (signal.aborted) p.kill();
      signal.addEventListener('abort', () => p.kill(), { once: true });
    }
    p.on('error', reject);
    p.on('close', (code) => {
      if (signal && signal.aborted) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed: ${err.trim().split('\n').slice(-4).join(' ')}`));
    });
  });
}

async function runToFile(args, dst, opts) {
  const part = path.join(path.dirname(dst), `${path.basename(dst, path.extname(dst))}.part${path.extname(dst)}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.unlinkSync(part); } catch { /* none */ }
  try {
    await runFfmpeg([...args, part], opts);
    try { fs.unlinkSync(dst); } catch { /* none */ }
    fs.renameSync(part, dst);
  } catch (e) {
    try { fs.unlinkSync(part); } catch { /* none */ }
    throw e;
  }
}

// ---- encoders -------------------------------------------------------------
const ENCODERS = [
  { name: 'h264_nvenc', test: ['-c:v', 'h264_nvenc'], hq: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0', '-pix_fmt', 'yuv420p'], proxy: ['-c:v', 'h264_nvenc', '-preset', 'p3', '-rc', 'vbr', '-cq', '27', '-b:v', '0', '-pix_fmt', 'yuv420p'] },
  { name: 'h264_qsv', test: ['-c:v', 'h264_qsv'], hq: ['-c:v', 'h264_qsv', '-global_quality', '19', '-pix_fmt', 'nv12'], proxy: ['-c:v', 'h264_qsv', '-global_quality', '27', '-pix_fmt', 'nv12'] },
  { name: 'h264_amf', test: ['-c:v', 'h264_amf'], hq: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '19', '-qp_p', '19', '-pix_fmt', 'yuv420p'], proxy: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '27', '-qp_p', '27', '-pix_fmt', 'yuv420p'] },
  { name: 'h264_videotoolbox', test: ['-c:v', 'h264_videotoolbox'], hq: ['-c:v', 'h264_videotoolbox', '-b:v', '20M', '-pix_fmt', 'yuv420p'], proxy: ['-c:v', 'h264_videotoolbox', '-b:v', '5M', '-pix_fmt', 'yuv420p'] },
];
const CPU = { name: 'libx264', hq: ['-c:v', 'libx264', '-crf', '17', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'], proxy: ['-c:v', 'libx264', '-crf', '24', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] };

let encoderCache = null;
/** First H.264 encoder that actually works on this machine (GPU encoders are tried first), else x264. */
async function pickEncoder(preference = 'auto') {
  if (preference === 'cpu') return CPU;
  if (encoderCache) return encoderCache;
  const loc = locate();
  for (const enc of ENCODERS) {
    try {
      await runCapture(loc.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', ...enc.test, '-f', 'null', '-'], { timeout: 15000 });
      encoderCache = enc;
      return enc;
    } catch { /* not available */ }
  }
  encoderCache = CPU;
  return CPU;
}

/** Can a browser play this file as-is? (H.264 8-bit in an MP4/MOV family container.) */
function browserSafe(probeInfo, file) {
  const ext = path.extname(file).toLowerCase();
  return probeInfo.codec === 'h264' && /yuv420p$/.test(probeInfo.pixFmt || 'yuv420p') && ['.mp4', '.m4v', '.mov'].includes(ext) &&
    (!probeInfo.audioCodec || ['aac', 'mp3'].includes(probeInfo.audioCodec));
}

/** Review proxy: 720p H.264 with a short GOP so scrubbing and frame-stepping stay snappy. */
const hwDecoder = () => (process.platform === 'win32' ? 'd3d11va' : process.platform === 'darwin' ? 'videotoolbox' : 'auto');

async function makeProxy(src, dst, { duration, onProgress, signal, preference } = {}) {
  try { return await makeProxyWith(src, dst, { duration, onProgress, signal, preference, hw: hwDecoder() }); } catch (e) {
    if (e.cancelled) throw e;
    // some drivers refuse the hardware decoder for some files: do it in software rather than fail
    return makeProxyWith(src, dst, { duration, onProgress, signal, preference, hw: null });
  }
}

async function makeProxyWith(src, dst, { duration, onProgress, signal, preference, hw }) {
  const enc = await pickEncoder(preference);
  const args = ['-y', ...(hw ? ['-hwaccel', hw] : []), '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:min(720\\,ih)',
    ...enc.proxy, '-g', '12', '-bf', '0', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-sn', '-dn'];
  await runToFile(args, dst, { duration, onProgress, signal });
}

/** One JPEG frame. */
async function poster(src, t, dst, width = 480) {
  const loc = locate();
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const part = `${dst}.part.jpg`;
  await runCapture(loc.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', part], { timeout: 60000 });
  fs.renameSync(part, dst);
}

/** A horizontal strip of N evenly spaced frames across [from, to]. */
async function strip(src, from, to, count, dst, width = 320) {
  const loc = locate();
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const span = Math.max(0.1, to - from);
  const part = `${dst}.part.jpg`;
  await runCapture(loc.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, from)), '-t', String(span), '-i', src,
    '-vf', `fps=${count / span},scale=${width}:-2,tile=${count}x1`, '-frames:v', '1', '-q:v', '5', part], { timeout: 120000 });
  fs.renameSync(part, dst);
}

/**
 * Cut [start, start+len] out of src. `height` > 0 scales down (never up) and forces a re-encode;
 * `lossless` stream-copies (fast, keyframe-accurate only).
 */
async function cut(src, dst, { start, len, lossless, height, onProgress, signal, preference }) {
  const copy = lossless && !(height > 0);
  const args = ['-y'];
  if (!copy) args.push('-hwaccel', 'auto');
  args.push('-ss', start.toFixed(3), '-i', src);
  if (len != null) args.push('-t', len.toFixed(3));
  if (copy) args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  else {
    const enc = await pickEncoder(preference);
    args.push(...enc.hq);
    if (height > 0) args.push('-vf', `scale=-2:min(ih\\,${height})`);
    args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  }
  await runToFile(args, dst, { duration: len, onProgress, signal });
}

function describeSystem() {
  const loc = locate();
  return { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length, ffmpeg: loc.ok ? { path: loc.ffmpeg, version: loc.version } : null };
}

module.exports = { locate, probe, makeProxy, poster, strip, cut, pickEncoder, browserSafe, runCapture, describeSystem };
