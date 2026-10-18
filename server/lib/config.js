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
const anthropicKeyFile = () => path.join(configDir(), 'anthropic.key');

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

/** Anthropic (Claude) key for reading slates: environment first, then a user-only file. Never leaves this computer except to api.anthropic.com. */
function getAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try { return fs.readFileSync(anthropicKeyFile(), 'utf8').trim() || null; } catch { return null; }
}

function anthropicKeySource() {
  if (process.env.ANTHROPIC_API_KEY) return 'environment';
  return fs.existsSync(anthropicKeyFile()) ? 'file' : null;
}

async function setAnthropicKey(key) {
  const k = String(key || '').trim();
  if (!k) { try { fs.unlinkSync(anthropicKeyFile()); } catch { /* already gone */ } return; }
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(anthropicKeyFile(), k, { mode: 0o600 });
}

/** Per-user choices for reading slates with Claude. `consent` is the person agreeing that video frames are sent to Anthropic. */
function visionSettings() {
  const v = loadConfig().vision || {};
  return { model: v.model || 'claude-sonnet-5-5', consent: !!v.consent };
}

async function setVisionSettings(patch) {
  const c = loadConfig();
  c.vision = { ...visionSettings(), ...patch };
  await saveConfig(c);
  return visionSettings();
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

module.exports = { configDir, cacheDir, loadConfig, saveConfig, getKey, keySource, setKey, getAnthropicKey, anthropicKeySource, setAnthropicKey, visionSettings, setVisionSettings, rememberProject, forgetProject, APP_DIR_NAME };
