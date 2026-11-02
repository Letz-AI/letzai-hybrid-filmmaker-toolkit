'use strict';
// Reads a film slate (Klappe) from a few video frames with an AI model: Claude (Anthropic), ChatGPT (OpenAI) or
// Gemini (Google), with the user's own API key. No SDKs: one fetch call per request, so the kit stays dependency-free.
// Keys and choices come from the user's config (see config.js).
const cfg = require('./config');
const { httpError } = require('./util');

const PROVIDERS = {
  anthropic: {
    id: 'anthropic', label: 'Claude', company: 'Anthropic', host: 'api.anthropic.com',
    keyUrl: 'https://console.anthropic.com/settings/keys', keyPage: 'Anthropic Console', keyHint: 'sk-ant-…', env: 'ANTHROPIC_API_KEY',
    limitsUrl: 'https://console.anthropic.com/settings/limits', imageTokens: 800,
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Recommended: reads handwriting well at a fair price', prices: [{ in: 2, out: 10 }] },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest and cheapest; try it on clean, printed slates', prices: [{ in: 0.1, out: 0.5 }] },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most careful, for messy or tilted slates; costs the most', prices: [{ in: 4, out: 20 }] },
    ],
  },
  openai: {
    id: 'openai', label: 'ChatGPT', company: 'OpenAI', host: 'api.openai.com',
    keyUrl: 'https://platform.openai.com/api-keys', keyPage: 'OpenAI dashboard', keyHint: 'sk-…', env: 'OPENAI_API_KEY',
    limitsUrl: 'https://platform.openai.com/settings/organization/limits', imageTokens: 1100,
    models: [
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', note: 'Recommended: made for reading images, at a fair price', prices: [{ in: 1, out: 5 }] },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'Cheapest; try it on clean, printed slates', prices: [{ in: 0.1, out: 0.5 }] },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', note: 'More careful, for messy or tilted slates; costs more', prices: [{ in: 2, out: 10 }] },
    ],
  },
  google: {
    id: 'google', label: 'Gemini', company: 'Google', host: 'generativelanguage.googleapis.com',
    keyUrl: 'https://aistudio.google.com/apikey', keyPage: 'Google AI Studio', keyHint: 'AIza…', env: 'GEMINI_API_KEY',
    limitsUrl: 'https://console.cloud.google.com/billing/budgets', imageTokens: 1100,
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'Recommended: fast and reads handwriting well', prices: [{ in: 0.75, out: 3.75 }, { from: '2027-01-01', in: 1.5, out: 7.5 }] },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', note: 'Cheapest; try it on clean, printed slates', prices: [{ in: 0.3, out: 2.5 }] },
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon', note: 'Most careful, for messy or tilted slates; costs the most', prices: [{ in: 2, out: 10 }, { from: '2026-12-01', in: 4, out: 20 }] },
    ],
  },
};
const PROVIDER_IDS = Object.keys(PROVIDERS);
const provider = (id) => PROVIDERS[id] || PROVIDERS.anthropic;

const BASE = {
  anthropic: () => process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  openai: () => process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',   // like the OpenAI SDKs, this includes /v1
  google: () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
};
const baseUrl = (p) => String(BASE[p]()).replace(/\/+$/, '');

// Prices are list prices in USD per million tokens, as published when this version of the kit was made; a later entry
// with `from` takes over on that date. Thinking tokens are billed as output. Prices only feed estimates: the
// provider's own usage page is the real bill.
const OUTPUT_TOKENS = 600;   // a typical answer, thinking included
const PROMPT_TOKENS = 450;

/** The price of a model today (or on `date`). */
function priceOf(pid, model, date = new Date().toISOString().slice(0, 10)) {
  const m = provider(pid).models.find((x) => x.id === model);
  if (!m) return null;
  return m.prices.filter((x) => !x.from || x.from <= date).pop();
}

/** USD for the tokens a request used. */
function costOf(pid, model, tokens) {
  const p = priceOf(pid, model);
  return p ? ((tokens.in || 0) * p.in + (tokens.out || 0) * p.out) / 1e6 : 0;
}

/** What reading `clips` clips with `frames` frames each should cost, roughly. */
function estimateCost(pid, model, clips, frames) {
  return costOf(pid, model, { in: clips * (frames * provider(pid).imageTokens + PROMPT_TOKENS), out: clips * OUTPUT_TOKENS });
}

/** This month's estimated spend against the budget. `left` is null when there is no monthly budget. */
function budgetState() {
  const { budget } = cfg.visionConfig();
  const spend = cfg.visionSpend();
  const left = budget.monthly == null ? null : Math.max(0, budget.monthly - spend.usd);
  return { ...budget, spent: spend.usd, month: spend.month, left, reached: left != null && left <= 0 };
}

/** The provider, model and consent in use, with defaults filled in. */
function settings() {
  const v = cfg.visionConfig();
  const p = provider(v.provider);
  const model = v.models[p.id] && p.models.some((m) => m.id === v.models[p.id]) ? v.models[p.id] : p.models[0].id;
  return { provider: p.id, model, consent: !!v.consent[p.id] };
}

const FIELDS = {
  slate_visible: { type: 'boolean', description: 'true only if a slate with legible production numbers is visible in at least one frame' },
  scene: { type: ['string', 'null'], description: 'Scene as written, e.g. "6" or "12A". null if not legible.' },
  shot: { type: ['string', 'null'], description: 'Shot (Einstellung / Bild) as written, e.g. "2" or "2A". null if not legible.' },
  take: { type: ['integer', 'null'], description: 'Take number. null if not legible.' },
  confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are that scene, shot and take are all read correctly. 0.9+ only when every digit is clear.' },
  best_frame: { type: 'integer', description: '1-based number of the frame where the slate is clearest' },
  evidence: { type: 'string', description: 'What is written on the slate, copied as literally as you can, e.g. "SCENE 6 / SHOT 2A / TAKE 3"' },
  other: { type: 'string', description: 'Other legible text: roll, camera, director, date, notes. Empty if none.' },
};
const TOOL = {
  name: 'report_slate',
  description: 'Report what is written on the film slate (clapperboard) seen in the frames.',
  input_schema: { type: 'object', properties: FIELDS, required: ['slate_visible', 'scene', 'shot', 'take', 'confidence', 'evidence'] },
};

const PROMPT = (n, times, tool) => `These are ${n} frames, in time order, from the start of one film clip (at ${times.map((t) => `${t.toFixed(1)}s`).join(', ')}). A slate (clapperboard, "Klappe") may be held up in front of the camera in some of them.

Read the production numbers written on it: Scene (Szene), Shot (Einstellung, Bild) and Take. Labels may be in English or German, and the shot can carry a letter ("2A").

Rules:
- Never guess. If a field is blurry, cut off, hidden by a hand or too small, return null for it and lower the confidence.
- Do not invent numbers from the clip's content. Only read what is written.
- If no slate with numbers is visible, set slate_visible to false and the fields to null.
${tool ? '- Report your answer by calling the report_slate tool exactly once. Do not answer in prose.'
    : `- Answer with one JSON object and nothing else, with these fields:\n${Object.entries(FIELDS).map(([k, f]) => `  "${k}": ${[].concat(f.type).join(' or ')}. ${f.description}`).join('\n')}`}`;

/** A readable reason for an API failure, and whether it is the kind that repeats for every clip. */
function explainApi(pid, status, body) {
  const p = provider(pid);
  const err = (body && (Array.isArray(body) ? body[0] : body).error) || {};
  const msg = err.message || '';
  const who = p.company;
  if (status === 401 || (pid === 'google' && status === 400 && /api key not valid|API_KEY_INVALID/i.test(msg + JSON.stringify(err.details || '')))) return { status: 401, text: `${who} did not accept this API key. Check that it was copied completely.` };
  if ((pid === 'anthropic' && status === 400 && /credit balance/i.test(msg)) || (pid === 'openai' && status === 429 && err.code === 'insufficient_quota')) {
    return { status: 402, code: 'no-credit', text: `Your ${who} account has no credit left. Add credit in the ${p.keyPage}, then try again.` };
  }
  if (status === 403) return { status, text: `${who} refused the request: ${msg || 'this key may not have access to the model'}.` };
  if (status === 404) return { status, text: `${who} does not know this model (${msg || 'not found'}). Pick another one in Settings.` };
  if (status === 413) return { status, text: 'The frames were too large for the API.' };
  if (status === 429) return { status, text: `${who} is limiting this key${pid === 'google' && /quota/i.test(msg) ? ' (quota used up)' : ''}. Wait a moment, or read fewer clips at once.` };
  if (status === 529 || status >= 500) return { status, text: `${who} is overloaded or down right now. Try again in a few minutes.` };
  return { status, text: msg || `${who} returned an error (${status}).` };
}

/** Errors that will repeat for every remaining clip: stop instead of retrying them 40 times. */
const isFatal = (e) => e && (e.status === 401 || e.status === 403 || e.status === 404 || e.code === 'no-credit' || e.code === 'no-vision-key' || e.code === 'budget');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Canceled'), { cancelled: true })); }, { once: true });
});

/** One API call with retries on rate limits, overload and network errors. */
async function call(pid, url, { method = 'POST', headers, body, signal, retries = 3 } = {}) {
  const who = provider(pid).company;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 90000);
      const onAbort = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let res;
      try {
        res = await fetch(url, { method, signal: ctl.signal, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      if (res.ok) return json;
      const why = explainApi(pid, res.status, json);
      const err = httpError(why.status, why.text, why.code ? { code: why.code } : {});
      if (!why.code && (res.status === 429 || res.status === 529 || res.status >= 500)) {
        lastErr = err;
        const wait = Math.min(20000, (parseFloat(res.headers.get('retry-after')) || 0) * 1000 || 1500 * 2 ** attempt);
        if (attempt < retries) { await sleep(wait, signal); continue; }
      }
      throw err;
    } catch (e) {
      if (signal && signal.aborted) throw Object.assign(new Error('Canceled'), { cancelled: true });
      if (e.status) throw e;
      lastErr = httpError(502, `Could not reach ${who} (${e.cause && e.cause.code ? e.cause.code : e.message}). Check the internet connection.`);
      if (attempt < retries) { await sleep(1500 * 2 ** attempt, signal); continue; }
    }
  }
  throw lastErr;
}

function keyFor(pid, key) {
  const k = key || cfg.getVisionKey(pid);
  if (!k) throw httpError(400, `No ${provider(pid).company} API key yet. Add one in Settings.`, { code: 'no-vision-key' });
  return k;
}

/** Keep a reading only if it looks like a real slate number ("6", "12A"). Anything else counts as not read. */
const fieldOk = (v) => (v == null ? null : /^[0-9]{1,3}[A-Za-z]?$/.test(String(v).trim()) ? String(v).trim().toUpperCase().replace(/^0+(?=\d)/, '') : null);

/** A JSON object with a scene field somewhere in a text answer. */
function answerInText(text) {
  const m = /\{[\s\S]*\}/.exec(text || '');
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return j && typeof j === 'object' && 'scene' in j ? j : null; } catch { return null; }
}

/** The slate reading from a Claude response: the tool call, or else a JSON object somewhere in the text. */
function answerOf(content) {
  const blocks = content || [];
  const use = blocks.find((c) => c.type === 'tool_use' && c.name === TOOL.name);
  if (use && use.input) return use.input;
  for (const b of blocks) if (b.type === 'text') { const j = answerInText(b.text); if (j) return j; }
  return null;
}

// Each provider: build the request from frames + prompt, and pull the answer and token counts out of the response.
const ASK = {
  async anthropic(frames, model, key, signal) {
    const content = [];
    frames.forEach((f, i) => {
      content.push({ type: 'text', text: `Frame ${i + 1} (${f.t.toFixed(1)}s)` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.base64 } });
    });
    content.push({ type: 'text', text: PROMPT(frames.length, frames.map((f) => f.t), true) });
    // Some models refuse a forced tool_choice, so the tool is offered and the prompt asks for it; a JSON answer in text is accepted too.
    const res = await call('anthropic', `${baseUrl('anthropic')}/v1/messages`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: { model, max_tokens: 1500, tools: [TOOL], messages: [{ role: 'user', content }] }, signal });
    const u = res.usage || {};
    return { answer: answerOf(res.content), tokens: { in: u.input_tokens || 0, out: u.output_tokens || 0 } };
  },
  async openai(frames, model, key, signal) {
    const content = [];
    frames.forEach((f, i) => {
      content.push({ type: 'input_text', text: `Frame ${i + 1} (${f.t.toFixed(1)}s)` });
      content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${f.base64}`, detail: 'high' });
    });
    content.push({ type: 'input_text', text: PROMPT(frames.length, frames.map((f) => f.t), false) });
    const res = await call('openai', `${baseUrl('openai')}/responses`, { headers: { authorization: `Bearer ${key}` }, body: { model, input: [{ role: 'user', content }], text: { format: { type: 'json_object' } }, reasoning: { effort: 'low' }, max_output_tokens: 4000 }, signal });
    const text = (res.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n');
    const u = res.usage || {};
    return { answer: answerInText(text), tokens: { in: u.input_tokens || 0, out: u.output_tokens || 0 } };
  },
  async google(frames, model, key, signal) {
    const parts = [];
    frames.forEach((f, i) => {
      parts.push({ text: `Frame ${i + 1} (${f.t.toFixed(1)}s)` });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: f.base64 } });
    });
    parts.push({ text: PROMPT(frames.length, frames.map((f) => f.t), false) });
    const res = await call('google', `${baseUrl('google')}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { headers: { 'x-goog-api-key': key }, body: { contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8000 } }, signal });
    if (res.promptFeedback && res.promptFeedback.blockReason) throw httpError(502, `Google blocked the request (${res.promptFeedback.blockReason}).`);
    const cand = (res.candidates || [])[0] || {};
    const text = ((cand.content && cand.content.parts) || []).filter((x) => !x.thought).map((x) => x.text || '').join('\n');
    const u = res.usageMetadata || {};
    return { answer: answerInText(text), tokens: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } };
  },
};

/**
 * @param {{base64:string, t:number}[]} frames JPEG frames, in time order
 * @returns {{slateVisible:boolean, scene:string|null, shot:string|null, take:number|null, confidence:number, frame:number, evidence:string, other:string, tokens:{in:number,out:number}}}
 */
async function readSlate(frames, { provider: pid, model, key, signal } = {}) {
  if (!frames.length) throw httpError(400, 'No frames to read.');
  const s = settings();
  const p = provider(pid || s.provider);
  const m = model || s.model;
  const { answer: r, tokens } = await ASK[p.id](frames, m, keyFor(p.id, key), signal);
  const usd = costOf(p.id, m, tokens);
  cfg.addVisionSpend(p.id, usd);   // counted even when the answer is unusable: it was paid for
  if (!r) throw httpError(502, `${p.label} did not answer in the expected form. Try again.`);
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
    tokens, usd,
  };
}

/** Does this key work? One request that costs nothing (or next to nothing), so a wrong key is found when it is entered, not 40 clips later. */
async function verifyKey({ provider: pid, key, model } = {}) {
  const p = provider(pid || settings().provider);
  const k = keyFor(p.id, key);
  if (p.id === 'openai') await call('openai', `${baseUrl('openai')}/models`, { method: 'GET', headers: { authorization: `Bearer ${k}` }, retries: 1 });
  else if (p.id === 'google') await call('google', `${baseUrl('google')}/v1beta/models?pageSize=1`, { method: 'GET', headers: { 'x-goog-api-key': k }, retries: 1 });
  else await call('anthropic', `${baseUrl('anthropic')}/v1/messages`, { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' }, body: { model: model || settings().model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }, retries: 1 });
  return { ok: true };
}

/** What the UI needs to know. Keys themselves never leave the server. */
function info() {
  const s = settings();
  const p = provider(s.provider);
  const withPrice = (x) => x.models.map((m) => ({ id: m.id, label: m.label, note: m.note, price: priceOf(x.id, m.id) }));
  const pub = (x) => ({ id: x.id, label: x.label, company: x.company, host: x.host, keyUrl: x.keyUrl, keyPage: x.keyPage, keyHint: x.keyHint, env: x.env, limitsUrl: x.limitsUrl, models: withPrice(x), key: { set: !!cfg.getVisionKey(x.id), source: cfg.visionKeySource(x.id) } });
  return { ...s, label: p.label, company: p.company, key: pub(p).key, models: withPrice(p), providers: PROVIDER_IDS.map((id) => pub(PROVIDERS[id])), budget: budgetState() };
}

module.exports = { PROVIDERS, PROVIDER_IDS, TOOL, settings, info, priceOf, costOf, estimateCost, budgetState, answerOf, answerInText, readSlate, verifyKey, explainApi, isFatal, fieldOk };
