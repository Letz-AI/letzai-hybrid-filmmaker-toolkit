// Application state: one object, plain subscriptions. Views re-render when it changes.
import { get } from './api.js';

export const S = {
  info: null,          // server info (app, ffmpeg, key, recent, project summary)
  snap: null,          // project snapshot { project, clips, coverage, shotListText }
  byKey: new Map(),    // clip key -> clip
  jobs: [],            // job queue
  canvas: null,        // last canvas status
  hevc: false,         // can this browser decode HEVC?
  proxy: null,         // { left, ready, active, minutes } playback copies being prepared
  route: { view: 'board', args: [] },
  filters: { board: 'all', boardMode: 'scenes', q: '', folder: '' },
};

const subs = new Set();
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
let queued = false;
export function emit() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; for (const fn of subs) fn(); });
}

export async function loadInfo() {
  S.info = await get('/api/info');
  emit();
  return S.info;
}

export async function loadLibrary() {
  if (!S.info || !S.info.project) { S.snap = null; S.byKey = new Map(); emit(); return null; }
  S.snap = await get('/api/library');
  S.byKey = new Map(S.snap.clips.map((c) => [c.key, c]));
  // a remembered folder filter that no longer exists (another project, a renamed folder) must not hide everything
  if (S.filters.folder && !S.snap.folders.some((f) => f.path === S.filters.folder)) S.filters.folder = '';
  emit();
  return S.snap;
}

export const clip = (key) => S.byKey.get(key);
/** Every clip, regardless of the folder filter. */
export const allClips = () => (S.snap ? S.snap.clips : []);

// ---- folders -------------------------------------------------------------------
export const folders = () => (S.snap ? S.snap.folders : []);
export const hasManyFolders = () => folders().filter((f) => f.direct > 0).length > 1;
export const folderInfo = (path) => folders().find((f) => f.path === path);
/** Is this folder path inside the folder filter ('' = no filter)? */
export const inFolder = (dir, folder = S.filters.folder) => !folder || folder === '.' || dir === folder || String(dir).startsWith(folder + '/');
export const folderLabel = (path) => (path === '.' || !path ? (S.snap ? S.snap.project.name : '') : path.split('/').pop());
export function setFolderFilter(path) { S.filters.folder = path || ''; try { localStorage.setItem('filter.folder', S.filters.folder); } catch { /* ignore */ } emit(); }
try { S.filters.folder = localStorage.getItem('filter.folder') || ''; } catch { /* ignore */ }

/** Clips that pass the folder filter. Most views use this. */
export const clips = () => (S.snap ? (S.filters.folder ? S.snap.clips.filter((c) => inFolder(c.dir)) : S.snap.clips) : []);
/** Coverage for the folder filter: the whole plan, or (inside one folder) just what was shot there. */
const folderCoverage = () => (S.snap && S.filters.folder && S.snap.coverageByFolder[S.filters.folder]) || null;
export const scenes = () => (S.snap ? (folderCoverage() || S.snap.coverage).scenes : []);
export const totals = () => (S.snap ? (folderCoverage() || S.snap.coverage).totals : null);

export function findShot(scene, shot) {
  const sc = scenes().find((s) => String(s.id) === String(scene));
  const sh = sc && sc.shots.find((x) => String(x.id).toUpperCase() === String(shot).toUpperCase());
  return sh ? { scene: sc, shot: sh } : null;
}

/** Like findShot but ignoring the folder filter (the shot list and canvas always speak about the whole film). */
export function findShotAll(scene, shot) {
  const sc = S.snap && S.snap.coverage.scenes.find((s) => String(s.id) === String(scene));
  const sh = sc && sc.shots.find((x) => String(x.id).toUpperCase() === String(shot).toUpperCase());
  return sh ? { scene: sc, shot: sh } : null;
}

export const takesOf = (shot) => shot.takes.map((k) => S.byKey.get(k)).filter(Boolean);
export const unnamed = () => clips().filter((c) => c.kind === 'raw' && !c.skip);
export const failedSends = () => allClips().filter((c) => c.canvasError);

// Background work (preparing playback copies) is a quiet summary of its own, not one more job in the count.
export function runningJobs() { return S.jobs.filter((j) => !j.background && (j.state === 'queued' || j.state === 'running')); }
export const proxyLeft = () => S.proxy && S.proxy.active ? S.proxy.left : 0;

// Job progress ticks are frequent; they get their own channel so views don't re-render on every tick.
const jobSubs = new Set();
export const subscribeJobs = (fn) => { jobSubs.add(fn); return () => jobSubs.delete(fn); };
export const emitJobs = () => { for (const fn of jobSubs) fn(); };

export function upsertJob(j) {
  const i = S.jobs.findIndex((x) => x.id === j.id);
  if (i >= 0) S.jobs[i] = j; else S.jobs.unshift(j);
  emitJobs();
}
