'use strict';
// The Windows "Choose folder" button uses the modern Explorer-style dialog (server/lib/pick-folder.ps1).
// Opening a real dialog needs a person, so this only checks that its code compiles, and that the server points at it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', 'server', 'lib', 'pick-folder.ps1');
const skip = process.platform !== 'win32' && 'Windows only';

test('the Windows folder picker script exists and the server uses it', () => {
  assert.ok(fs.existsSync(script), 'server/lib/pick-folder.ps1 is missing');
  const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(index, /pick-folder\.ps1/);
  assert.doesNotMatch(index, /FolderBrowserDialog/, 'the old tree dialog must not be the first choice any more');
});

test('the modern folder dialog code compiles, run the way the server runs it', { skip }, () => {
  // as -EncodedCommand, like server/index.js, so no execution policy is involved
  const encoded = Buffer.from(fs.readFileSync(script, 'utf8'), 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
    env: { ...process.env, KIT_SELFTEST: '1' }, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'compiled');
});
