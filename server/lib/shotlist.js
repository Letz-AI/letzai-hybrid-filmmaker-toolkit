'use strict';
// The shot list is the plan: it is what lets the Board say which shots are still missing.
// Stored as structured JSON in the project, edited as plain text because that is fastest on set.
//
//   # Scene 6 - Kitchen            (header: "Scene 6", "# Scene 6: Kitchen", "scene 6 - Kitchen")
//   6.1   Wide, Mira enters  [WS]  (shot line: "<scene>.<shot>  description  [size]")
//   2A    Close on the cup         (inside a scene header the scene number can be left out)
//   ?6.4  Optional insert          (a leading ? makes a shot optional)
//   6.5-8                          (a range expands to shots 5,6,7,8)
const { natCompare, compareShots } = require('./util');

const SCENE_HEADER = /^(?:#+\s*)?scene\s+([A-Za-z0-9]+)\s*(?:[-:–—]\s*(.*))?$/i;
const SHOT_LINE = /^(\?)?\s*(?:(\d+[A-Za-z]?)\.)?(\d+[A-Za-z]?)(?:-(\d+))?(?:\s+(.*))?$/;

function parseShotListText(text) {
  const scenes = new Map();
  const errors = [];
  let current = null;
  const sceneOf = (id) => {
    if (!scenes.has(id)) scenes.set(id, { scene: id, title: '', shots: [] });
    return scenes.get(id);
  };
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim().replace(/^[-*•]\s+/, '');
    if (!line || line.startsWith('//')) return;
    let m = SCENE_HEADER.exec(line);
    if (m) {
      current = sceneOf(m[1]);
      if (m[2]) current.title = m[2].trim();
      return;
    }
    m = SHOT_LINE.exec(line);
    if (!m) { errors.push({ line: i + 1, message: `Can't read "${raw.trim()}"` }); return; }
    const optional = !!m[1];
    let sceneId = m[2];
    let shotId = m[3];
    // "6.2" is scene.shot, but a bare "2A" belongs to the current scene header.
    if (!sceneId) {
      if (!current) { errors.push({ line: i + 1, message: 'Shot without a scene - add "Scene 6" above, or write 6.2' }); return; }
      sceneId = current.scene;
    }
    const scene = sceneOf(sceneId);
    current = scene;
    let desc = (m[5] || '').trim();
    let size = '';
    const sz = /\[([^\]]{1,12})\]\s*$/.exec(desc);
    if (sz) { size = sz[1].trim(); desc = desc.slice(0, sz.index).trim(); }
    const last = m[4] ? parseInt(m[4], 10) : null;
    const first = /^\d+$/.test(shotId) ? parseInt(shotId, 10) : null;
    const ids = last && first != null && last >= first && last - first < 100
      ? Array.from({ length: last - first + 1 }, (_, k) => String(first + k))
      : [shotId.toUpperCase()];
    for (const id of ids) {
      if (scene.shots.some((s) => s.id === id)) { errors.push({ line: i + 1, message: `Shot ${scene.scene}.${id} is listed twice` }); continue; }
      scene.shots.push({ id, desc, size, optional });
    }
  });
  const list = [...scenes.values()].sort((a, b) => natCompare(a.scene, b.scene));
  for (const s of list) s.shots.sort((a, b) => compareShots(a.id, b.id));
  return { scenes: list, errors };
}

function shotListToText(scenes) {
  const out = [];
  for (const s of scenes || []) {
    out.push(`Scene ${s.scene}${s.title ? ` - ${s.title}` : ''}`);
    for (const sh of s.shots) {
      out.push(`${sh.optional ? '?' : ''}${s.scene}.${sh.id}${sh.desc ? `  ${sh.desc}` : ''}${sh.size ? `  [${sh.size}]` : ''}`);
    }
    out.push('');
  }
  return out.join('\n').trim() + (out.length ? '\n' : '');
}

module.exports = { parseShotListText, shotListToText };
