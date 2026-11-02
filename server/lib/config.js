'use strict';
// Per-user settings that must NOT live in a (possibly synced) film folder: API key, recent projects, caches.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson, atomicWrite } = require('./util');

const APP_DIR_NAME = 'LetzAI-Hybrid-Filmmaker-Kit';

function configDir() {
  if (process.env.LETZAI_KIT_HOME) return path.join(process.env.LETZAI_KIT_HOME, 'config');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_DIR_NAME);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_DIR_NAME);
}

function cacheDir() {
  if (process.env.LETZAI_KIT_HOME) return path.join(process.env.LETZAI_KIT_HOME, 'cache');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_DIR_NAME, 'cache');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', APP_DIR_NAME);
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), APP_DIR_NAME);
}

const configFile = () => path.join(configDir(), 'config.json');
const keyFile = () => path.join(configDir(), 'letzai.key');

function loadConfig() {
  return { recent: [], ...readJson(configFile(), {}) };
}

async function saveConfig(cfg) {
  await atomicWrite(configFile(), JSON.stringify(cfg, null, 2));
}

/** API key precedence: environment, then the key file in the user's config dir. */
function getKey() {
  if (process.env.LETZAI_API_KEY) return process.env.LETZAI_API_KEY.trim();
  try {
    return fs.readFileSync(keyFile(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function keySource() {
  if (process.env.LETZAI_API_KEY) return 'environment';
  return fs.existsSync(keyFile()) ? 'file' : null;
}

async function setKey(key) {
  const k = String(key || '').trim();
  if (!k) {
    try { fs.unlinkSync(keyFile()); } catch { /* already gone */ }
    return;
  }
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(keyFile(), k, { mode: 0o600 });
}

/**
 * AI keys for reading slates (anthropic, openai, google): environment first, then a user-only file.
 * A key never leaves this computer except to its own provider's API.
 */
const VISION_KEYS = {
  anthropic: { env: ['ANTHROPIC_API_KEY'], file: 'anthropic.key' },
  openai: { env: ['OPENAI_API_KEY'], file: 'openai.key' },
  google: { env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], file: 'gemini.key' },
};
const visionKey = (provider) => {
  const k = VISION_KEYS[provider];
  if (!k) throw new Error(`Unknown AI provider: ${provider}`);
  return { ...k, path: path.join(configDir(), k.file), fromEnv: k.env.map((n) => process.env[n]).find((v) => v && v.trim()) };
};

function getVisionKey(provider) {
  const k = visionKey(provider);
  if (k.fromEnv) return k.fromEnv.trim();
  try { return fs.readFileSync(k.path, 'utf8').trim() || null; } catch { return null; }
}

function visionKeySource(provider) {
  const k = visionKey(provider);
  if (k.fromEnv) return 'environment';
  return fs.existsSync(k.path) ? 'file' : null;
}

async function setVisionKey(provider, key) {
  const p = visionKey(provider).path;
  const k = String(key || '').trim();
  if (!k) { try { fs.unlinkSync(p); } catch { /* already gone */ } return; }
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(p, k, { mode: 0o600 });
}

/**
 * Per-user choices for reading slates: the provider, a model per provider, consent per provider (the person
 * agreeing that video frames are sent to that company) and a budget. Older configs had one Claude model and one
 * consent flag. Budget: `monthly` stops readings once this month's estimated spend reaches it (null: no limit);
 * `confirmAbove` asks again before a single run estimated above it (null: never ask).
 */
const DEFAULT_BUDGET = { monthly: null, confirmAbove: 5 };
function visionConfig() {
  const v = loadConfig().vision || {};
  const models = { ...(typeof v.model === 'string' ? { anthropic: v.model } : {}), ...(v.models || {}) };
  const consent = v.consent && typeof v.consent === 'object' ? { ...v.consent } : { anthropic: !!v.consent };
  return { provider: v.provider || 'anthropic', models, consent, budget: { ...DEFAULT_BUDGET, ...(v.budget || {}) } };
}

async function setVisionConfig(next) {
  const c = loadConfig();
  const { provider, models, consent, budget } = { ...visionConfig(), ...next };
  c.vision = { provider, models, consent, budget };
  await saveConfig(c);
}

/**
 * What slate reading has cost this calendar month, estimated from the token counts the APIs report. Kept in its own
 * small file and written synchronously, so three readings finishing at once cannot overwrite each other's amount.
 */
const spendFile = () => path.join(configDir(), 'spend.json');
const monthNow = () => new Date().toISOString().slice(0, 7);
function visionSpend() {
  const s = readJson(spendFile(), {});
  return s.month === monthNow() ? { month: s.month, usd: s.usd || 0, byProvider: s.byProvider || {} } : { month: monthNow(), usd: 0, byProvider: {} };
}
function addVisionSpend(provider, usd) {
  if (!(usd > 0)) return visionSpend();
  const s = visionSpend();
  s.usd += usd;
  s.byProvider[provider] = (s.byProvider[provider] || 0) + usd;
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = `${spendFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, spendFile());
  return s;
}

/** First-run setup: done once finished or skipped. People who used the kit before it existed never see it. */
function setupState() {
  const c = loadConfig();
  return { done: !!c.setupDone || c.recent.length > 0 || !!getKey() };
}
async function setSetupDone(done = true) {
  const c = loadConfig();
  c.setupDone = !!done;
  await saveConfig(c);
}

/**
 * Start from scratch: forget everything kept for this user (keys, settings, recent films, spending, the setup flag),
 * as on a first start. Film folders and the cache are not touched. Keys set as environment variables cannot be
 * removed from here; their names are returned so the person can be told.
 */
function resetUser() {
  const files = ['config.json', 'letzai.key', 'spend.json', ...Object.values(VISION_KEYS).map((k) => k.file)];
  const removed = [];
  for (const f of files) {
    try { fs.unlinkSync(path.join(configDir(), f)); removed.push(f); } catch { /* not there */ }
  }
  const envKeys = ['LETZAI_API_KEY', ...Object.values(VISION_KEYS).flatMap((k) => k.env)].filter((n) => process.env[n] && process.env[n].trim());
  return { removed, envKeys };
}

async function rememberProject(root, name) {
  const cfg = loadConfig();
  cfg.recent = [{ root, name, openedAt: new Date().toISOString() }, ...cfg.recent.filter((r) => r.root !== root)].slice(0, 12);
  await saveConfig(cfg);
}

async function forgetProject(root) {
  const cfg = loadConfig();
  cfg.recent = cfg.recent.filter((r) => r.root !== root);
  await saveConfig(cfg);
}

module.exports = { configDir, cacheDir, loadConfig, saveConfig, getKey, keySource, setKey, getVisionKey, visionKeySource, setVisionKey, visionConfig, setVisionConfig, visionSpend, addVisionSpend, setupState, setSetupDone, resetUser, rememberProject, forgetProject, APP_DIR_NAME };
