'use strict';
// Coverage = the plan (shot list) laid over what was actually shot. Pure functions, unit tested.
const { natCompare, compareShots } = require('./util');

const RATING_RANK = { good: 3, ok: 2, '': 1, void: 0 };

/**
 * @param {object[]} clips   library entries of kind "shot" ({scene, shot, take, rating, print, key, duration, onCanvas})
 * @param {object[]} shotList [{scene, title, shots:[{id,desc,size,optional}]}]
 * @returns {{scenes: object[], totals: object}}
 */
function buildCoverage(clips, shotList, opts = {}) {
  const inferGaps = opts.inferGaps !== false;
  const planned = new Map(); // scene -> {title, shots:Map(id -> plan)}
  for (const s of shotList || []) {
    const shots = new Map();
    for (const sh of s.shots || []) shots.set(String(sh.id).toUpperCase(), sh);
    planned.set(String(s.scene), { title: s.title || '', shots });
  }

  const actual = new Map(); // scene -> Map(shot -> clips[])
  for (const c of clips) {
    if (c.kind !== 'shot') continue;
    const sc = String(c.scene);
    const sh = String(c.shot).toUpperCase();
    if (!actual.has(sc)) actual.set(sc, new Map());
    const m = actual.get(sc);
    if (!m.has(sh)) m.set(sh, []);
    m.get(sh).push(c);
  }

  const sceneIds = [...new Set([...planned.keys(), ...actual.keys()])].sort(natCompare);
  const scenes = sceneIds.map((id) => {
    const plan = planned.get(id);
    const act = actual.get(id) || new Map();
    const shotIds = new Set([...(plan ? plan.shots.keys() : []), ...act.keys()]);

    // Without a plan for this scene, holes in the numbering (1,2,4 -> 3) are surfaced as gaps.
    const inferredGaps = new Set();
    if (!plan && inferGaps) {
      const nums = [...act.keys()].map((s) => parseInt(s, 10)).filter(Number.isFinite);
      if (nums.length) {
        const max = Math.max(...nums);
        for (let n = 1; n < max; n++) if (!nums.includes(n)) inferredGaps.add(String(n));
      }
    }
    for (const g of inferredGaps) shotIds.add(g);

    const shots = [...shotIds].sort(compareShots).map((sid) => {
      const p = plan ? plan.shots.get(sid) : null;
      const takes = (act.get(sid) || []).slice().sort((a, b) => a.take - b.take || natCompare(a.name, b.name));
      const printed = takes.filter((t) => t.print);
      const rated = takes.filter((t) => t.rating);
      const best = pickBest(takes);
      let status;
      if (!takes.length) status = inferredGaps.has(sid) ? 'gap' : p && p.optional ? 'optional' : 'missing';
      else if (printed.length) status = 'selected';
      else if (rated.length) status = 'reviewed';
      else status = 'shot';
      const nums = [...new Set(takes.map((t) => t.take))].sort((a, b) => a - b);
      const takeGaps = [];
      for (let n = 1; nums.length && n < nums[nums.length - 1]; n++) if (!nums.includes(n)) takeGaps.push(n);
      const dupTakes = nums.filter((n) => takes.filter((t) => t.take === n).length > 1);
      return {
        id: sid,
        planned: !!p,
        extra: !p && !!plan, // shot exists on disk but was not in this scene's plan
        desc: p ? p.desc || '' : '',
        size: p ? p.size || '' : '',
        optional: !!(p && p.optional),
        status,
        takes: takes.map((t) => t.key),
        best: best ? best.key : null,
        printed: printed.length,
        rated: rated.length,
        takeGaps,
        dupTakes,
        duration: takes.reduce((a, t) => a + (t.duration || 0), 0),
        onCanvas: takes.length ? takes.every((t) => t.onCanvas) : false,
      };
    });

    const counted = shots.filter((s) => s.status !== 'gap' && !(s.status === 'optional'));
    const stats = {
      shots: shots.length,
      covered: shots.filter((s) => s.takes.length).length,
      missing: shots.filter((s) => s.status === 'missing' || s.status === 'gap').length,
      selected: shots.filter((s) => s.status === 'selected').length,
      toReview: shots.filter((s) => s.status === 'shot').length,
      takes: shots.reduce((a, s) => a + s.takes.length, 0),
      planned: counted.filter((s) => s.planned).length,
    };
    const done = stats.shots > 0 && shots.every((s) => s.status === 'selected' || s.status === 'optional');
    return { id, title: plan ? plan.title : '', planned: !!plan, shots, stats, done };
  });

  const totals = scenes.reduce((a, s) => {
    a.scenes++;
    a.shots += s.stats.shots;
    a.covered += s.stats.covered;
    a.missing += s.stats.missing;
    a.selected += s.stats.selected;
    a.toReview += s.stats.toReview;
    a.takes += s.stats.takes;
    if (s.done) a.scenesDone++;
    return a;
  }, { scenes: 0, scenesDone: 0, shots: 0, covered: 0, missing: 0, selected: 0, toReview: 0, takes: 0 });
  totals.runtime = clips.filter((c) => c.kind === 'shot').reduce((a, c) => a + (c.duration || 0), 0);
  totals.printedRuntime = clips.filter((c) => c.kind === 'shot' && c.print).reduce((a, c) => a + (c.duration || 0), 0);
  return { scenes, totals };
}

/** The take to show as a shot's face: first printed, else best rated, else the last take. */
function pickBest(takes) {
  if (!takes.length) return null;
  const printed = takes.find((t) => t.print);
  if (printed) return printed;
  return takes.slice().sort((a, b) =>
    (RATING_RANK[b.rating || ''] - RATING_RANK[a.rating || '']) || (b.take - a.take))[0];
}

module.exports = { buildCoverage, pickBest };
