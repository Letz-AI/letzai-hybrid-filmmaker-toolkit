'use strict';
// The UI has no build step, so a typo would only show up in the browser. Parse every module here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', 'ui', 'js');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } })(root);

test('every UI module parses', () => {
  assert.ok(files.length > 10);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(f), encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(root, f)}: ${r.stderr.split('\n').slice(0, 4).join(' ')}`);
  }
});

test('no attribute markup is inserted as plain text (html`` would escape its quotes)', () => {
  // ${on ? 'aria-current="page"' : ''} renders aria-current="&quot;page&quot;", so CSS never matches it.
  // Write aria-current="${on ? 'page' : 'false'}", or wrap the markup in html``.
  for (const f of files) {
    if (path.basename(f) === 'lib.js') continue; // the icon drawings are inserted as trusted markup on purpose
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      assert.ok(!/[?:] '[^']*="[^']*'/.test(line), `${path.relative(root, f)}:${i + 1} inserts attribute markup as text: ${line.trim().slice(0, 120)}`);
    });
  }
});

test('every import in the UI resolves to a file and an export that exists', () => {
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g;
    let m;
    while ((m = re.exec(src))) {
      const target = path.resolve(path.dirname(f), m[2]);
      assert.ok(fs.existsSync(target), `${path.relative(root, f)} imports missing file ${m[2]}`);
      const exported = fs.readFileSync(target, 'utf8');
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (!name) continue;
        const n = name.replace(/\$/g, '\\$');
        const ok = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${n}(?![\\w$])|export\\s*\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}`).test(exported);
        assert.ok(ok, `${path.relative(root, f)} imports ${name} which ${m[2]} does not export`);
      }
    }
  }
});
