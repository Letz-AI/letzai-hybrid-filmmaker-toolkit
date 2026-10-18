'use strict';
// AI results are the generated versions of a real take. These helpers guess which take a file belongs to.

/** Hints in a file name, with loose separators: "..._scene6_shot2A_take3_cut-2_v1.mp4". */
function aiHints(name) {
  const base = String(name).replace(/\.[A-Za-z0-9]{2,4}$/, '');
  const m = /scene[\s._-]*(\d+[A-Za-z]?)[\s._-]*shot[\s._-]*(\d+[A-Za-z]?)[\s._-]*take[\s._-]*(\d+)/i.exec(base);
  const cut = /(?:^|[\s._-])cut[\s._-]*(\d+)(?!\d)/i.exec(base);
  return {
    scene: m ? m[1] : null,
    shot: m ? m[2].toUpperCase() : null,
    take: m ? parseInt(m[3], 10) : null,
    cut: cut ? parseInt(cut[1], 10) : null,
  };
}

const boundary = (s, end) => end >= s.length || !/[0-9]/.test(s[end]); // "take1" must not match "take10"

/**
 * Which take does this file belong to? Tries, in order: the take's full file name inside the AI file's name, the
 * scene/shot/take numbers spelled out in it, and the camera's original clip name (A001_..._C047).
 * @param {string} name file name of the AI result
 * @param {{key:string, stem:string, scene:string, shot:string, take:number, orig?:string}[]} takes named takes
 * @returns {{key:string, why:string, cut:number|null}|null}
 */
function suggestTake(name, takes) {
  const base = String(name).replace(/\.[A-Za-z0-9]{2,4}$/, '').toLowerCase();
  const hints = aiHints(name);

  let best = null;
  for (const t of takes) {
    const stem = t.stem.replace(/-(void|ok|good)$/i, '').replace(/-print$/i, '').replace(/-(void|ok|good)$/i, '').toLowerCase();
    const at = base.indexOf(stem);
    if (at >= 0 && boundary(base, at + stem.length) && (!best || stem.length > best.len)) best = { key: t.key, len: stem.length, why: 'the file name contains the take name' };
  }
  if (best) return { key: best.key, why: best.why, cut: hints.cut };

  if (hints.scene && hints.shot && hints.take != null) {
    const hit = takes.find((t) => String(t.scene) === String(hints.scene).replace(/^0+(?=\d)/, '') && String(t.shot).toUpperCase() === hints.shot && t.take === hints.take);
    if (hit) return { key: hit.key, why: `the file name says scene ${hints.scene}, shot ${hints.shot}, take ${hints.take}`, cut: hints.cut };
  }

  for (const t of takes) {
    const o = String(t.orig || '').replace(/\.[A-Za-z0-9]{2,4}$/, '').toLowerCase();
    if (o && o.length > 6 && base.includes(o)) return { key: t.key, why: 'the file name contains the camera clip name', cut: hints.cut };
  }
  return null;
}

module.exports = { aiHints, suggestTake };
