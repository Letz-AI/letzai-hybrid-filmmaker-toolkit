'use strict';
// Reading slates with Claude, ChatGPT and Gemini: key handling, the request that is sent, parsing, flags, retries and
// failure modes. Everything runs against a fake of the three APIs and ffmpeg-made clips.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-slate-'));
process.env.LETZAI_KIT_HOME = path.join(tmp, 'home');
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k];
const ff = require('../server/lib/ffmpeg');
const vision = require('../server/lib/vision');
const slate = require('../server/lib/slate');
const { createServer } = require('../server/index.js');
const { startFakeAI } = require('./helpers/fake-ai');
const cfg = require('../server/lib/config');
const { until } = require('./helpers/wait');

const loc = ff.locate(true);
const skip = !loc.ok && 'ffmpeg not installed';
const TOKEN = 'slate-test-token';
const reading = (o) => ({ slate_visible: true, scene: '6', shot: '2A', take: 3, confidence: 0.95, best_frame: 2, evidence: 'SCENE 6 / SHOT 2A / TAKE 3', ...o });

test('field validation keeps only real slate numbers', () => {
  assert.equal(vision.fieldOk('06'), '6');
  assert.equal(vision.fieldOk('2a'), '2A');
  assert.equal(vision.fieldOk('12A'), '12A');
  assert.equal(vision.fieldOk('two'), null);
  assert.equal(vision.fieldOk(null), null);
  assert.equal(vision.fieldOk('1234'), null);
});

test('frame times stay inside short clips and the second pass looks further in', () => {
  assert.deepEqual(slate.frameTimes(10, 0), [0.4, 1, 1.7, 2.5, 3.5, 4.8]);
  assert.deepEqual(slate.frameTimes(2, 0), [0.4, 1]);
  assert.deepEqual(slate.frameTimes(1, 0), [0.4]);
  assert.equal(slate.frameTimes(0.4, 0).length, 1); // a clip shorter than the first frame still gets one
  assert.deepEqual(slate.frameTimes(5, 1), []);
  assert.equal(slate.frameTimes(30, 1)[0], 6);
});

let fake; let server; let port; let cookie = '';
function req(method, url, { body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Host: `127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, json, text: t }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const waitJob = (id) => (assert.ok(id, 'no job was started'), until(async () => {
  const j = (await req('GET', '/api/jobs')).json.jobs.find((x) => x.id === id);
  return j && (j.state === 'done' || j.state === 'error' || j.state === 'canceled') && j;
}, 'the slate job to finish'));
const library = async () => (await req('GET', '/api/library')).json.clips;

test.after(async () => { try { server && server.close(); } catch { /* not started */ } if (fake) await fake.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('reading slates: key, consent, request shape, results, flags, retries, failures, clearing', { skip }, async () => {
  fake = await startFakeAI();
  process.env.ANTHROPIC_BASE_URL = fake.url;
  process.env.OPENAI_BASE_URL = `${fake.url}/v1`;
  process.env.GEMINI_BASE_URL = fake.url;

  const film = path.join(tmp, 'film');
  fs.mkdirSync(film, { recursive: true });
  const make = (n, secs) => assert.equal(spawnSync(loc.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=25:duration=${secs}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(film, n)]).status, 0);
  make('Film-scene6-shot2A-take1.mp4', 3);
  make('A001_C001.mp4', 16);
  make('A001_C002.mp4', 16);
  make('A001_C003.mp4', 16);

  ({ server } = createServer({ token: TOKEN, port: 0 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  server.close();
  ({ server } = createServer({ token: TOKEN, port }));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  // the cookie comes from the launch link
  const launch = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/?k=${TOKEN}`, headers: { Host: `127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
  cookie = launch;

  // a first launch offers the setup assistant; finishing or skipping it is remembered
  assert.equal((await req('GET', '/api/info')).json.setup.done, false);
  assert.equal((await req('PUT', '/api/setup', { body: { done: true } })).json.done, true);
  assert.equal((await req('GET', '/api/info')).json.setup.done, true);

  assert.equal((await req('POST', '/api/project/create', { body: { root: film, name: 'T', prefix: 'Film' } })).status, 200);
  let clips;
  await until(async () => { clips = await library(); return clips.every((c) => c.probe); }, 'every clip to be probed');
  const raws = clips.filter((c) => c.kind === 'raw').sort((a, b) => a.name.localeCompare(b.name));
  const named = clips.find((c) => c.kind === 'shot');

  // nothing works before there is a key and consent
  assert.equal((await req('GET', '/api/vision')).json.key.set, false);
  const noKey = await req('POST', '/api/slate/read', { body: { keys: [raws[0].key] } });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.code, 'no-vision-key');

  // a wrong key is caught by the test call, and is not saved
  const bad = await req('POST', '/api/vision/test', { body: { key: 'sk-ant-wrong', save: true } });
  assert.equal(bad.status, 401);
  assert.match(bad.json.error, /did not accept/i);
  assert.equal((await req('GET', '/api/vision')).json.key.set, false);
  // a good key is saved; the key never comes back to the browser
  const good = await req('POST', '/api/vision/test', { body: { key: 'sk-ant-test', save: true } });
  assert.equal(good.status, 200);
  assert.equal(good.json.key.set, true);
  assert.ok(!JSON.stringify(good.json).includes('sk-ant-test'));
  assert.ok(fs.existsSync(path.join(process.env.LETZAI_KIT_HOME, 'config', 'anthropic.key')));
  assert.equal((await req('PUT', '/api/vision', { body: { model: 'gpt-4' } })).status, 400);

  const noConsent = await req('POST', '/api/slate/read', { body: { keys: [raws[0].key] } });
  assert.equal(noConsent.json.code, 'no-consent');
  await req('PUT', '/api/vision', { body: { consent: true, model: 'claude-haiku-5-5' } });

  // estimate counts clips and frames, and what they cost: Haiku at $0.10 / $0.50 per million tokens,
  // 3 clips x (6 frames x 800 + 450 prompt) in, 3 x 600 out
  const est = (await req('POST', '/api/slate/estimate', { body: { keys: raws.map((c) => c.key) } })).json;
  assert.equal(est.clips, 3);
  assert.equal(est.frames, 18);
  assert.ok(Math.abs(est.usd - 0.002475) < 1e-9, `estimate ${est.usd}`);
  assert.ok(est.usdMax > est.usd, 'a second look further in can cost more');
  assert.equal(est.model, 'claude-haiku-5-5');
  assert.deepEqual([est.budget.spent, est.budget.monthly, est.budget.confirmAbove], [0, null, 5]);

  // read one clip: request shape and result
  fake.state.requests.length = 0;
  fake.state.answers.push(reading({ scene: '06', shot: '2a', take: 2 }));
  const one = await req('POST', '/api/slate/read', { body: { keys: [raws[0].key] } });
  assert.equal(one.status, 200, one.text);
  assert.equal((await waitJob(one.json.job)).state, 'done');
  const sent = fake.state.requests.filter((r) => r.body.tools);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, 'sk-ant-test');
  assert.equal(sent[0].version, '2023-06-01');
  assert.equal(sent[0].body.model, 'claude-haiku-5-5');
  assert.equal(sent[0].body.tool_choice, undefined, 'a forced tool call is refused by current models');
  assert.equal(sent[0].body.tools[0].name, 'report_slate');
  const imgs = sent[0].body.messages[0].content.filter((c) => c.type === 'image');
  assert.equal(imgs.length, 6);
  assert.equal(imgs[0].source.media_type, 'image/jpeg');
  assert.ok(Buffer.from(imgs[0].source.data, 'base64').slice(0, 2).equals(Buffer.from([0xff, 0xd8])), 'a real JPEG was sent');
  assert.ok(!JSON.stringify(sent[0].body).includes('A001_C001'), 'file names are not sent');
  clips = await library();
  let r0 = clips.find((c) => c.key === raws[0].key);
  assert.deepEqual([r0.slate.scene, r0.slate.shot, r0.slate.take, r0.slate.status], ['6', '2A', 2, 'new']);
  assert.deepEqual(r0.slate.flags, []);
  assert.ok(r0.slate.tokens.in >= 5000);
  // the cost of what the API reported (5000 in, 60 out) is kept with the reading and added to this month's spending
  assert.ok(Math.abs(r0.slate.usd - 0.00053) < 1e-9, `cost ${r0.slate.usd}`);
  assert.ok(Math.abs((await req('GET', '/api/vision')).json.budget.spent - 0.00053) < 1e-9);

  // already-read clips are skipped (no second charge) unless forced
  fake.state.requests.length = 0;
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[0].key] } })).json.job)).state, 'done');
  assert.equal(fake.state.requests.filter((r) => r.body.tools).length, 0);

  // flags: a take that exists, the same reading twice, an earlier recording with a higher take, low confidence
  fake.state.answers.push(reading({ take: 1 }));                       // taken by Film-scene6-shot2A-take1
  fake.state.answers.push(reading({ take: 2, confidence: 0.6 }));      // same as raws[0], and not sure
  const two = await req('POST', '/api/slate/read', { body: { keys: [raws[1].key] } });
  assert.equal((await waitJob(two.json.job)).state, 'done');
  const three = await req('POST', '/api/slate/read', { body: { keys: [raws[2].key] } });
  assert.equal((await waitJob(three.json.job)).state, 'done');
  clips = await library();
  const f1 = clips.find((c) => c.key === raws[1].key).slate;
  const f2 = clips.find((c) => c.key === raws[2].key).slate;
  assert.ok(f1.flags.includes('taken'));
  assert.ok(f2.flags.includes('low'));
  assert.ok(f2.flags.includes('twice'));
  assert.ok(clips.find((c) => c.key === raws[0].key).slate.flags.includes('twice'));

  // a named take: matches, or differs
  fake.state.answers.push(reading({ take: 1 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [named.key] } })).json.job)).state, 'done');
  assert.equal((await library()).find((c) => c.key === named.key).slate.status, 'match');
  fake.state.answers.push(reading({ take: 5 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [named.key], force: true } })).json.job)).state, 'done');
  const diff = (await library()).find((c) => c.key === named.key).slate;
  assert.equal(diff.status, 'differs');
  assert.equal(diff.take, 5);

  // when a named take was read as something else (it will move), its old name is free: not flagged as taken
  fake.state.answers.push(reading({ take: 1 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[1].key], force: true } })).json.job)).state, 'done');
  assert.ok(!(await library()).find((c) => c.key === raws[1].key).slate.flags.includes('taken'));

  // a scene that is not in the shot list is flagged; one that is, is not
  assert.equal((await req('PUT', '/api/shotlist', { body: { text: ['# Scene 6', '6.2A wide'].join('\n') } })).status, 200);
  fake.state.answers.push(reading({ scene: '9', shot: '1', take: 1 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[1].key], force: true } })).json.job)).state, 'done');
  assert.ok((await library()).find((c) => c.key === raws[1].key).slate.flags.includes('not-in-plan'));
  fake.state.answers.push(reading({ scene: '6', shot: '2A', take: 8 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[1].key], force: true } })).json.job)).state, 'done');
  assert.ok(!(await library()).find((c) => c.key === raws[1].key).slate.flags.includes('not-in-plan'));

  // the reading follows the clip when it is renamed
  const rn = await req('POST', '/api/clip/rename', { body: { key: raws[0].key, scene: '6', shot: '2A', take: 2 } });
  assert.equal(rn.status, 200, rn.text);
  const renamed = (await library()).find((c) => c.name === 'Film-scene6-shot2A-take2.mp4');
  assert.equal(renamed.slate.status, 'match');

  // no slate in the first pass: the second pass looks further in, and an unreadable result is kept (no repeat charge)
  fake.state.requests.length = 0;
  fake.state.answers.push({ slate_visible: false, scene: null, shot: null, take: null, confidence: 0, evidence: '' });
  fake.state.answers.push(reading({ scene: '7', shot: '1', take: 4, best_frame: 3 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[1].key], force: true } })).json.job)).state, 'done');
  assert.equal(fake.state.requests.filter((r) => r.body.tools).length, 2);
  const late = (await library()).find((c) => c.key === raws[1].key).slate;
  assert.deepEqual([late.scene, late.shot, late.take, late.pass], ['7', '1', 4, 2]);
  assert.equal(late.frameT, 9);

  // temporary trouble is retried; a bad key or an empty account stops the run with a clear message
  fake.state.fail = { status: 429, message: 'slow down', times: 1 };
  fake.state.answers.push(reading({ scene: '9', shot: '1', take: 1 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[2].key], force: true } })).json.job)).state, 'done');
  fake.state.fail = { status: 400, message: 'Your credit balance is too low to access the Anthropic API.', times: 99 };
  const broke = await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[1].key, raws[2].key], force: true } })).json.job);
  assert.equal(broke.state, 'error');
  assert.match(broke.error, /no credit left/i);
  fake.state.fail = null;

  // a model that answers in text with JSON instead of calling the tool still works
  fake.state.answerAsText = true;
  fake.state.answers.push(reading({ scene: '6', shot: '2A', take: 9 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[2].key], force: true } })).json.job)).state, 'done');
  assert.equal((await library()).find((c) => c.key === raws[2].key).slate.take, 9);
  fake.state.answerAsText = false;

  // a run above the "ask before" amount needs a confirmation the browser asks for
  await req('PUT', '/api/vision', { body: { budget: { confirmAbove: 0 } } });
  const ask = await req('POST', '/api/slate/read', { body: { keys: [raws[2].key], force: true } });
  assert.equal(ask.status, 409);
  assert.equal(ask.json.code, 'confirm-cost');
  fake.state.answers.push(reading({ take: 4 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[2].key], force: true, confirmed: true } })).json.job)).state, 'done');
  await req('PUT', '/api/vision', { body: { budget: { confirmAbove: null } } });
  assert.equal((await req('PUT', '/api/vision', { body: { budget: { monthly: 'lots' } } })).status, 400);

  // the monthly budget: a run stops once it is used up (what was read is kept); then no new run starts
  await req('PUT', '/api/vision', { body: { model: 'claude-opus-5-5' } });   // about $0.021 per clip
  const spent = (await req('GET', '/api/vision')).json.budget.spent;
  await req('PUT', '/api/vision', { body: { budget: { monthly: Math.ceil((spent + 0.005) * 100) / 100 } } });
  const all4 = (await library()).map((c) => c.key);
  assert.equal(all4.length, 4);
  for (let i = 0; i < 4; i++) fake.state.answers.push(reading({ take: 20 + i }));
  const capped = await waitJob((await req('POST', '/api/slate/read', { body: { keys: all4, force: true } })).json.job);
  assert.equal(capped.state, 'error');
  assert.match(capped.error, /monthly budget .* is used up, so 1 clip was not read/);
  const after = (await req('GET', '/api/vision')).json.budget;
  assert.equal(after.reached, true);
  const refused = await req('POST', '/api/slate/read', { body: { keys: [raws[1].key], force: true } });
  assert.equal(refused.status, 402);
  assert.equal(refused.json.code, 'budget');
  await req('PUT', '/api/vision', { body: { model: 'claude-haiku-5-5', budget: { monthly: null } } });
  fake.state.answers.length = 0;

  // clearing readings
  assert.equal((await req('POST', '/api/slate/clear', { body: { keys: [raws[1].key, raws[2].key] } })).json.cleared, 2);
  assert.equal((await library()).find((c) => c.key === raws[1].key).slate, null);

  // removing the key
  await req('PUT', '/api/vision', { body: { key: '' } });
  assert.equal((await req('GET', '/api/vision')).json.key.set, false);
  assert.ok(!fs.existsSync(path.join(process.env.LETZAI_KIT_HOME, 'config', 'anthropic.key')));

  // ---- ChatGPT (OpenAI) ----
  let v = (await req('PUT', '/api/vision', { body: { provider: 'openai' } })).json;
  assert.deepEqual([v.provider, v.label, v.model, v.key.set, v.consent], ['openai', 'ChatGPT', 'gpt-6.1-terra', false, false], 'consent is per company: agreeing for Anthropic is not agreeing for OpenAI');
  assert.equal((await req('PUT', '/api/vision', { body: { model: 'claude-haiku-5-5' } })).status, 400, 'a model of another provider is refused');
  assert.equal((await req('POST', '/api/slate/read', { body: { keys: [raws[2].key] } })).json.code, 'no-vision-key');
  const badOpenai = await req('POST', '/api/vision/test', { body: { key: 'sk-wrong', save: true } });
  assert.equal(badOpenai.status, 401);
  assert.match(badOpenai.json.error, /OpenAI did not accept/);
  v = (await req('POST', '/api/vision/test', { body: { key: 'sk-openai-test', save: true } })).json;
  assert.equal(v.key.set, true);
  assert.ok(fs.existsSync(path.join(process.env.LETZAI_KIT_HOME, 'config', 'openai.key')));
  assert.ok(!JSON.stringify(v).includes('sk-openai-test'));
  assert.equal((await req('POST', '/api/slate/read', { body: { keys: [raws[2].key] } })).json.code, 'no-consent');
  await req('PUT', '/api/vision', { body: { consent: true, model: 'gpt-6-luna' } });

  fake.state.requests.length = 0;
  fake.state.answers.push(reading({ scene: '4', shot: '1', take: 2 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[2].key], force: true } })).json.job)).state, 'done');
  const oa = fake.state.requests.filter((r) => r.read);
  assert.equal(oa.length, 1);
  assert.deepEqual([oa[0].provider, oa[0].key, oa[0].body.model, oa[0].body.text.format.type], ['openai', 'sk-openai-test', 'gpt-6-luna', 'json_object']);
  const oaImgs = oa[0].body.input[0].content.filter((c) => c.type === 'input_image');
  assert.equal(oaImgs.length, 6);
  assert.match(oaImgs[0].image_url, /^data:image\/jpeg;base64,\/9j\//, 'a real JPEG was sent');
  assert.ok(!JSON.stringify(oa[0].body).includes('A001_C003'), 'file names are not sent');
  let s0 = (await library()).find((c) => c.key === raws[2].key).slate;
  assert.deepEqual([s0.scene, s0.shot, s0.take, s0.provider, s0.model, s0.tokens.in], ['4', '1', 2, 'openai', 'gpt-6-luna', 5000]);

  // an OpenAI account without credit stops the run at once (no retries, no 40 failed clips)
  fake.state.requests.length = 0;
  fake.state.fail = { status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota.', times: 99 };
  const quota = await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[1].key, raws[2].key], force: true } })).json.job);
  assert.equal(quota.state, 'error');
  assert.match(quota.error, /OpenAI account has no credit/);
  assert.ok(fake.state.requests.filter((r) => r.read).length <= 3, 'not retried');
  fake.state.fail = null;

  // ---- Gemini (Google) ----
  v = (await req('PUT', '/api/vision', { body: { provider: 'google' } })).json;
  assert.deepEqual([v.provider, v.label, v.model], ['google', 'Gemini', 'gemini-3.8-flash']);
  const badGemini = await req('POST', '/api/vision/test', { body: { key: 'AIza-wrong', save: true } });
  assert.equal(badGemini.status, 401, 'Google answers 400 for a bad key; the kit says what it means');
  assert.match(badGemini.json.error, /Google did not accept/);
  assert.equal((await req('POST', '/api/vision/test', { body: { key: 'AIza-test', save: true } })).status, 200);
  assert.ok(fs.existsSync(path.join(process.env.LETZAI_KIT_HOME, 'config', 'gemini.key')));
  await req('PUT', '/api/vision', { body: { consent: true } });
  fake.state.requests.length = 0;
  fake.state.answers.push(reading({ scene: '5', shot: '3B', take: 1 }));
  assert.equal((await waitJob((await req('POST', '/api/slate/read', { body: { keys: [raws[2].key], force: true } })).json.job)).state, 'done');
  const gm = fake.state.requests.filter((r) => r.read);
  assert.equal(gm.length, 1);
  assert.equal(gm[0].url, '/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(gm[0].key, 'AIza-test');
  assert.equal(gm[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(gm[0].body.contents[0].parts.filter((x) => x.inlineData).length, 6);
  s0 = (await library()).find((c) => c.key === raws[2].key).slate;
  assert.deepEqual([s0.scene, s0.shot, s0.take, s0.provider, s0.tokens.out], ['5', '3B', 1, 'google', 80]);

  // every provider keeps its own key and model; switching back does not lose them
  v = (await req('PUT', '/api/vision', { body: { provider: 'openai' } })).json;
  assert.deepEqual([v.model, v.key.set, v.consent], ['gpt-6-luna', true, true]);
  assert.deepEqual(v.providers.map((x) => [x.id, x.key.set]), [['anthropic', false], ['openai', true], ['google', true]]);

  // start from scratch: keys, settings, recent films and spending are gone, the project is closed, setup runs again;
  // the film folder keeps its project file and readings
  const home = path.join(process.env.LETZAI_KIT_HOME, 'config');
  assert.ok(fs.existsSync(path.join(home, 'spend.json')));
  const reset = await req('POST', '/api/reset');
  assert.equal(reset.status, 200, reset.text);
  assert.deepEqual(reset.json.envKeys, []);
  for (const f of ['config.json', 'openai.key', 'gemini.key', 'spend.json']) assert.ok(!fs.existsSync(path.join(home, f)), `${f} removed`);
  const fresh = (await req('GET', '/api/info')).json;
  assert.deepEqual([fresh.project, fresh.setup.done, fresh.key.set, fresh.vision.keySet, fresh.recent.length], [null, false, false, false, 0]);
  assert.equal((await req('GET', '/api/vision')).json.budget.spent, 0);
  assert.ok(fs.existsSync(path.join(film, 'letzai-kit.json')), 'the film folder is not touched');
});

test('an older config (one Claude model, one consent switch) still reads the same', async () => {
  await cfg.saveConfig({ ...cfg.loadConfig(), vision: { model: 'claude-opus-5-5', consent: true } });
  assert.deepEqual(vision.settings(), { provider: 'anthropic', model: 'claude-opus-5-5', consent: true });
  await cfg.setVisionConfig({ provider: 'google' });
  assert.deepEqual(vision.settings(), { provider: 'google', model: 'gemini-3.8-flash', consent: false });
});
