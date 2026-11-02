'use strict';
// A stand-in for the three AI APIs that read slates, for tests: Anthropic (/v1/messages), OpenAI (/v1/responses,
// /v1/models) and Gemini (/v1beta/models/...). Answers come from one script, in the order requests arrive.
// Point the kit at it with ANTHROPIC_BASE_URL=url, OPENAI_BASE_URL=url/v1 and GEMINI_BASE_URL=url.
const http = require('http');

function startFakeAI() {
  const state = {
    requests: [],          // { provider, url, key, version, read, body } of every request; read = a slate reading
    answers: [],           // queue of slate readings; an entry may be { status, error } to fail instead
    validKey: 'sk-ant-test',
    validKeys: { openai: 'sk-openai-test', google: 'AIza-test' },
    answerAsText: false,
    fail: null,            // { status, message, code, times } makes the next requests fail
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const url = req.url.split('?')[0];
      const provider = url.startsWith('/v1beta/') ? 'google' : url === '/v1/messages' ? 'anthropic' : 'openai';
      const key = provider === 'google' ? req.headers['x-goog-api-key'] : provider === 'anthropic' ? req.headers['x-api-key'] : String(req.headers.authorization || '').replace(/^Bearer /, '');
      const read = req.method === 'POST' && (provider === 'anthropic' ? !!body.tools : provider === 'openai' ? url === '/v1/responses' : /:generateContent$/.test(url));
      state.requests.push({ provider, url: req.url, key, version: req.headers['anthropic-version'], read, body });

      // each API's own error shape
      const fail = (status, message, extra = {}) => (provider === 'anthropic'
        ? send(status, { type: 'error', error: { type: extra.type || 'api_error', message } }, status === 429 ? { 'retry-after': '0' } : {})
        : provider === 'openai'
          ? send(status, { error: { message, type: extra.type || 'api_error', code: extra.code || null } }, status === 429 ? { 'retry-after': '0' } : {})
          : send(status, { error: { code: status, message, status: extra.type || 'INTERNAL' } }));

      const known = provider === 'anthropic' || ['/v1/responses', '/v1/models'].includes(url) || /^\/v1beta\/models(\/[^/]+:generateContent)?$/.test(url);
      if (!known) return fail(404, 'no route');
      if (key !== (provider === 'anthropic' ? state.validKey : state.validKeys[provider])) {
        if (provider === 'google') return fail(400, 'API key not valid. Please pass a valid API key.', { type: 'INVALID_ARGUMENT' });
        return fail(401, provider === 'anthropic' ? 'invalid x-api-key' : 'Incorrect API key provided.', { type: 'authentication_error' });
      }
      if (state.fail && state.fail.times > 0) {
        state.fail.times--;
        return fail(state.fail.status, state.fail.message || 'boom', { code: state.fail.code });
      }
      if (req.method === 'GET') return send(200, provider === 'google' ? { models: [{ name: 'models/gemini-3.8-flash' }] } : { object: 'list', data: [{ id: 'gpt-6.1-terra' }] });

      if (provider === 'anthropic') {
        // like the real API for current models: a forced tool call is refused
        if (body.tool_choice && (body.tool_choice.type === 'tool' || body.tool_choice.type === 'any')) return fail(400, `tool_choice: type "${body.tool_choice.type}" is not supported for this model.`, { type: 'invalid_request_error' });
        if (!body.tools) return send(200, { id: 'msg_x', model: body.model, content: [{ type: 'text', text: 'Hi' }], usage: { input_tokens: 8, output_tokens: 1 } });
      }
      // like the real OpenAI API: JSON mode needs the word "JSON" in the input
      if (provider === 'openai' && body.text && body.text.format && body.text.format.type === 'json_object' && !JSON.stringify(body.input).includes('JSON')) return fail(400, "'messages' must contain the word 'json' in some form, to use 'text.format' of type 'json_object'.", { type: 'invalid_request_error' });

      const next = state.answers.shift() || { slate_visible: false, scene: null, shot: null, take: null, confidence: 0, evidence: '' };
      if (next.status) return fail(next.status, next.error || 'failed');
      if (provider === 'openai') return send(200, { id: 'resp_1', model: body.model, status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(next) }] }], usage: { input_tokens: 5000, output_tokens: 60 } });
      if (provider === 'google') return send(200, { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(next) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 60, thoughtsTokenCount: 20 } });
      const asText = state.answerAsText; // some models may answer in prose with JSON instead of calling the tool
      send(200, { id: 'msg_y', model: body.model, content: asText ? [{ type: 'text', text: `Here is my reading:
${JSON.stringify(next)}` }] : [{ type: 'tool_use', id: 'tu_1', name: body.tools[0].name, input: next }], usage: { input_tokens: 5000, output_tokens: 60 } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { startFakeAI };
