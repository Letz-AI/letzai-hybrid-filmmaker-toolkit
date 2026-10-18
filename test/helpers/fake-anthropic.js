'use strict';
// A stand-in for api.anthropic.com/v1/messages, for tests. Answers come from a script, in the order requests arrive.
const http = require('http');

function startFakeAnthropic() {
  const state = {
    requests: [],          // { key, version, body } of every request
    answers: [],           // queue of slate readings; an entry may be { status, error } to fail instead
    validKey: 'sk-ant-test',
    fail: null,            // { status, message, times } makes the next requests fail
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      state.requests.push({ url: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], body });
      if (req.url !== '/v1/messages' || req.method !== 'POST') return send(404, { error: { type: 'not_found_error', message: 'no route' } });
      if (req.headers['x-api-key'] !== state.validKey) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (state.fail && state.fail.times > 0) {
        state.fail.times--;
        return send(state.fail.status, { type: 'error', error: { type: 'api_error', message: state.fail.message || 'boom' } }, state.fail.status === 429 ? { 'retry-after': '0' } : {});
      }
      if (!body.tools) return send(200, { id: 'msg_x', model: body.model, content: [{ type: 'text', text: 'Hi' }], usage: { input_tokens: 8, output_tokens: 1 } });
      const next = state.answers.shift() || { slate_visible: false, scene: null, shot: null, take: null, confidence: 0, evidence: '' };
      if (next.status) return send(next.status, { type: 'error', error: { type: 'x', message: next.error || 'failed' } });
      send(200, { id: 'msg_y', model: body.model, content: [{ type: 'tool_use', id: 'tu_1', name: body.tools[0].name, input: next }], usage: { input_tokens: 5000, output_tokens: 60 } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { startFakeAnthropic };
