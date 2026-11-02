'use strict';
// Wait for background work (ffmpeg probes, jobs) by checking a condition, never by sleeping a fixed time: CI machines
// are many times slower than a desktop, so a sleep that always passes locally fails there now and then.
async function until(check, what, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

module.exports = { until };
