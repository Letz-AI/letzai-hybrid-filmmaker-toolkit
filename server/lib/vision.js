'use strict';
// Reads a film slate (Klappe) from a few video frames with Claude, through the Anthropic Messages API.
// No SDK: one fetch call, so the kit stays dependency-free. The key comes from the user's config (see config.js).
const cfg = require('./config');
const { httpError } = require('./util');

const API_VERSION = '2023-06-01';
const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Recommended: reads handwriting well at a fair price' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest and cheapest; try it on clean, printed slates' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most careful, for messy or tilted slates; costs the most' },
];
const baseUrl = () => String(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');

const TOOL = {
  name: 'report_slate',
  description: 'Report what is written on the film slate (clapperboard) seen in the frames.',
  input_schema: {
    type: 'object',
    properties: {
      slate_visible: { type: 'boolean', description: 'true only if a slate with legible production numbers is visible in at least one frame' },
      scene: { type: ['string', 'null'], description: 'Scene as written, e.g. "6" or "12A". null if not legible.' },
      shot: { type: ['string', 'null'], description: 'Shot (Einstellung / Bild) as written, e.g. "2" or "2A". null if not legible.' },
      take: { type: ['integer', 'null'], description: 'Take number. null if not legible.' },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are that scene, shot and take are all read correctly. 0.9+ only when every digit is clear.' },
      best_frame: { type: 'integer', description: '1-based number of the frame where the slate is clearest' },
      evidence: { type: 'string', description: 'What is written on the slate, copied as literally as you can, e.g. "SCENE 6 / SHOT 2A / TAKE 3"' },
      other: { type: 'string', description: 'Other legible text: roll, camera, director, date, notes. Empty if none.' },
    },
    required: ['slate_visible', 'scene', 'shot', 'take', 'confidence', 'evidence'],
  },
};

const PROMPT = (n, times) => `These are ${n} frames, in time order, from the start of one film clip (at ${times.map((t) => `${t.toFixed(1)}s`).join(', ')}). A slate (clapperboard, "Klappe") may be held up in front of the camera in some of them.

Read the production numbers written on it: Scene (Szene), Shot (Einstellung, Bild) and Take. Labels may be in English or German, and the shot can carry a letter ("2A").

Rules:
- Never guess. If a field is blurry, cut off, hidden by a hand or too small, return null for it and lower the confidence.
- Do not invent numbers from the clip's content. Only read what is written.
- If no slate with numbers is visible, set slate_visible to false and the fields to null.
- Report your answer by calling the report_slate tool exactly once. Do not answer in prose.`;

/** A readable reason for an API failure. */
function explainApi(status, body) {
  const msg = (body && body.error && body.error.message) || '';
  if (status === 401) return 'Anthropic did not accept this API key. Check that it was copied completely.';
  if (status === 403) return `Anthropic refused the request: ${msg || 'this key may not have access to the model'}.`;
  if (status === 400 && /credit balance/i.test(msg)) return 'Your Anthropic account has no credit left. Add credit in the Anthropic console (Plans & Billing), then try again.';
  if (status === 404) return `Anthropic does not know this model (${msg || 'not found'}). Pick another one in Settings.`;
  if (status === 413) return 'The frames were too large for the API.';
  if (status === 429) return 'Anthropic is rate limiting this key. Wait a moment, or read fewer clips at once.';
  if (status === 529 || status >= 500) return 'Anthropic is overloaded or down right now. Try again in a few minutes.';
  return msg || `Anthropic returned an error (${status}).`;
}

/** Errors that will repeat for every remaining clip: stop instead of retrying them 40 times. */
const isFatal = (e) => e && (e.status === 401 || e.status === 403 || e.status === 404 || e.code === 'no-credit' || e.code === 'no-vision-key');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Canceled'), { cancelled: true })); }, { once: true });
});

/** POST to /v1/messages with retries on rate limits, overload and network errors. */
async function messages(body, { key, signal, retries = 3 } = {}) {
  const k = key || cfg.getAnthropicKey();
  if (!k) throw httpError(400, 'No Anthropic API key yet. Add one in Settings.', { code: 'no-vision-key' });
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 90000);
      const onAbort = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let res;
      try {
        res = await fetch(`${baseUrl()}/v1/messages`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-api-key': k, 'anthropic-version': API_VERSION }, body: JSON.stringify(body) });
      } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      if (res.ok) return json;
      const err = httpError(res.status === 400 && /credit balance/i.test((json && json.error && json.error.message) || '') ? 402 : res.status, explainApi(res.status, json), res.status === 400 && /credit balance/i.test(text) ? { code: 'no-credit' } : {});
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        lastErr = err;
        const wait = Math.min(20000, (parseFloat(res.headers.get('retry-after')) || 0) * 1000 || 1500 * 2 ** attempt);
        if (attempt < retries) { await sleep(wait, signal); continue; }
      }
      throw err;
    } catch (e) {
      if (signal && signal.aborted) throw Object.assign(new Error('Canceled'), { cancelled: true });
      if (e.status) throw e;
      lastErr = httpError(502, `Could not reach Anthropic (${e.cause && e.cause.code ? e.cause.code : e.message}). Check the internet connection.`);
      if (attempt < retries) { await sleep(1500 * 2 ** attempt, signal); continue; }
    }
  }
  throw lastErr;
}

/** Keep a reading only if it looks like a real slate number ("6", "12A"). Anything else counts as not read. */
const fieldOk = (v) => (v == null ? null : /^[0-9]{1,3}[A-Za-z]?$/.test(String(v).trim()) ? String(v).trim().toUpperCase().replace(/^0+(?=\d)/, '') : null);

/** The slate reading from a response: the tool call, or else a JSON object somewhere in the text. */
function answerOf(content) {
  const blocks = content || [];
  const use = blocks.find((c) => c.type === 'tool_use' && c.name === TOOL.name);
  if (use && use.input) return use.input;
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    const m = /\{[\s\S]*\}/.exec(b.text || '');
    if (!m) continue;
    try { const j = JSON.parse(m[0]); if (j && typeof j === 'object' && 'scene' in j) return j; } catch { /* not json */ }
  }
  return null;
}

/**
 * @param {{base64:string, t:number}[]} frames JPEG frames, in time order
 * @returns {{slateVisible:boolean, scene:string|null, shot:string|null, take:number|null, confidence:number, frame:number, evidence:string, other:string, tokens:{in:number,out:number}}}
 */
async function readSlate(frames, { model, key, signal } = {}) {
  if (!frames.length) throw httpError(400, 'No frames to read.');
  const content = [];
  frames.forEach((f, i) => {
    content.push({ type: 'text', text: `Frame ${i + 1} (${f.t.toFixed(1)}s)` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.base64 } });
  });
  content.push({ type: 'text', text: PROMPT(frames.length, frames.map((f) => f.t)) });
  // Some models refuse a forced tool_choice, so the tool is offered and the prompt asks for it; a JSON answer in text is accepted too.
  const res = await messages({ model: model || cfg.visionSettings().model, max_tokens: 1500, tools: [TOOL], messages: [{ role: 'user', content }] }, { key, signal });
  const r = answerOf(res.content);
  if (!r) throw httpError(502, 'Claude did not answer in the expected form. Try again.');
  const take = Number.isInteger(r.take) && r.take >= 1 && r.take <= 999 ? r.take : (/^\d{1,3}$/.test(String(r.take)) && +r.take >= 1 ? +r.take : null);
  const scene = fieldOk(r.scene);
  const shot = fieldOk(r.shot);
  const conf = Math.max(0, Math.min(1, Number(r.confidence) || 0));
  const complete = scene && shot && take;
  return {
    slateVisible: !!r.slate_visible && !!(scene || shot || take),
    scene, shot, take,
    confidence: complete ? conf : Math.min(conf, 0.5),
    frame: Math.max(1, Math.min(frames.length, parseInt(r.best_frame, 10) || 1)),
    evidence: String(r.evidence || '').slice(0, 200),
    other: String(r.other || '').slice(0, 200),
    tokens: { in: (res.usage && res.usage.input_tokens) || 0, out: (res.usage && res.usage.output_tokens) || 0 },
  };
}

/** Does this key work? One tiny request, so a wrong key is found when it is entered, not 40 clips later. */
async function verifyKey({ key, model } = {}) {
  const res = await messages({ model: model || cfg.visionSettings().model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }, { key, retries: 1 });
  return { ok: true, model: res.model || model };
}

module.exports = { MODELS, TOOL, answerOf, readSlate, verifyKey, explainApi, isFatal, fieldOk };
