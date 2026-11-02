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
 * Per-user choices for reading slates: the provider, a model per provider, and consent per provider (the person
 * agreeing that video frames are sent to that company). Older configs had one Claude model and one consent flag.
 */
function visionConfig() {
  const v = loadConfig().vision || {};
  const models = { ...(typeof v.model === 'string' ? { anthropic: v.model } : {}), ...(v.models || {}) };
  const consent = v.consent && typeof v.consent === 'object' ? { ...v.consent } : { anthropic: !!v.consent };
  return { provider: v.provider || 'anthropic', models, consent };
}

async function setVisionConfig(next) {
  const c = loadConfig();
  const { provider, models, consent } = { ...visionConfig(), ...next };
  c.vision = { provider, models, consent };
  await saveConfig(c);
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

module.exports = { configDir, cacheDir, loadConfig, saveConfig, getKey, keySource, setKey, getVisionKey, visionKeySource, setVisionKey, visionConfig, setVisionConfig, rememberProject, forgetProject, APP_DIR_NAME };
