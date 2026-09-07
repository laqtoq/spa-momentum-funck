import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE, presetHash } from '../src/core/config.js';
import { PARAM_SPEC, diffFromBaseline, dofCount, overBudget, setPath, readParam,
         makePresetStore, makeLog, promotionInstruction } from '../src/core/presets.js';

const mem = () => { const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
let clock = 0;
const now = () => `2026-09-07T00:00:${String(clock++).padStart(2, '0')}Z`;

// ---- Task 1: the spec must cover the config, with nothing missing and nothing invented ----

test('PARAM_SPEC addresses only real config keys', () => {
  for (const spec of PARAM_SPEC) {
    if (spec.type === 'criterion') continue;                 // enabled.* keys are absent by default
    assert.notEqual(readParam(BASELINE, spec), undefined, `${spec.key} is not in BASELINE`);
  }
});

test('PARAM_SPEC leaves no BASELINE parameter unreachable', () => {
  const covered = new Set(PARAM_SPEC.map(s => s.key.split('.')[0]));
  const missing = Object.keys(BASELINE).filter(k => !covered.has(k));
  assert.deepEqual(missing, [], `unreachable in the workbench: ${missing}`);
});

test('diff: an untouched config deviates in nothing', () => {
  assert.deepEqual(diffFromBaseline(BASELINE), []);
  assert.equal(dofCount(BASELINE), 0);
  assert.equal(overBudget(BASELINE), false);
});

test('diff: an RSI band counts as one deviation, not two numbers', () => {
  const cfg = setPath(BASELINE, 'rsiLong', [40, 65]);
  const d = diffFromBaseline(cfg);
  assert.equal(d.length, 1);
  assert.equal(d[0].spec.key, 'rsiLong');
  assert.deepEqual(d[0].base, [45, 65]);
});

test('diff: criterion toggles count individually and default to on', () => {
  const spec = PARAM_SPEC.find(s => s.key === 'enabled.E8');
  assert.equal(readParam(BASELINE, spec), true, 'absent means enabled');
  const cfg = setPath(BASELINE, 'enabled.E8', false);
  assert.equal(dofCount(cfg), 1);
  assert.equal(diffFromBaseline(cfg)[0].spec.key, 'enabled.E8');
});

test('DoF budget: the warning arrives on the fourth deviation (FRD 4.7 §4)', () => {
  let cfg = setPath(BASELINE, 'rsiLong', [40, 65]);
  cfg = setPath(cfg, 'relVolMin', 1.8);
  cfg = setPath(cfg, 'runwayPct', 2.5);
  assert.equal(dofCount(cfg), 3);
  assert.equal(overBudget(cfg), false, 'three is the budget, not a breach');
  cfg = setPath(cfg, 'vixCap', 28);
  assert.equal(dofCount(cfg), 4);
  assert.equal(overBudget(cfg), true);
});

test('setPath does not mutate the config it is given', () => {
  const before = JSON.stringify(BASELINE);
  setPath(BASELINE, 'targetPct', 99);
  assert.equal(JSON.stringify(BASELINE), before);
});

// ---- preset store ----

test('presets: create, hash, and reject a duplicate name', () => {
  const s = makePresetStore(mem(), now);
  const p = s.create('tighter stop', setPath(BASELINE, 'stopPct', 0.6));
  assert.equal(p.hash, presetHash(setPath(BASELINE, 'stopPct', 0.6)));
  assert.notEqual(p.hash, presetHash(BASELINE));
  assert.equal(p.locked, false);
  assert.throws(() => s.create('tighter stop', BASELINE), /already exists/);
});

test('presets: editing an unlocked preset updates it in place', () => {
  const s = makePresetStore(mem(), now);
  s.create('draft', BASELINE);
  const r = s.update('draft', setPath(BASELINE, 'runwayPct', 2.5));
  assert.equal(r.forked, false);
  assert.equal(s.list().length, 1);
  assert.equal(s.get('draft').cfg.runwayPct, 2.5);
});

// FR-C4: results are stamped with a hash, so a locked preset must never change under them.
test('presets: editing a LOCKED preset forks to a new preset and leaves the original intact', () => {
  const s = makePresetStore(mem(), now);
  s.create('candidate', setPath(BASELINE, 'stopPct', 0.6));
  const lockedHash = s.lock('candidate').preset.hash;

  const r = s.update('candidate', setPath(BASELINE, 'stopPct', 0.7));
  assert.equal(r.forked, true);
  assert.equal(r.from, 'candidate');
  assert.notEqual(r.preset.hash, lockedHash);
  assert.equal(r.preset.parent, 'candidate');
  assert.equal(r.preset.locked, false);

  const original = s.get('candidate');
  assert.equal(original.locked, true);
  assert.equal(original.cfg.stopPct, 0.6, 'the locked preset did not move');
  assert.equal(original.hash, lockedHash);
  assert.equal(s.list().length, 2);
});

test('presets: locking twice is a no-op, not an error', () => {
  const s = makePresetStore(mem(), now);
  s.create('p', BASELINE);
  assert.equal(s.lock('p').changed, true);
  assert.equal(s.lock('p').changed, false);
});

test('presets: export → import round-trips and renames collisions rather than overwriting', () => {
  const s = makePresetStore(mem(), now);
  s.create('alpha', setPath(BASELINE, 'vixCap', 25));
  const dump = s.exportJSON();

  const s2 = makePresetStore(mem(), now);
  assert.equal(s2.importJSON(dump), 1);
  assert.equal(s2.get('alpha').cfg.vixCap, 25);
  assert.equal(s2.get('alpha').hash, s.get('alpha').hash);

  s2.importJSON(dump);                                   // same names again
  assert.equal(s2.list().length, 2);
  assert.ok(s2.list().some(p => p.name === 'alpha (2)'), 'collision renamed, nothing overwritten');
  assert.equal(s2.get('alpha').cfg.vixCap, 25);
});

test('presets: importing a non-preset file is rejected', () => {
  const s = makePresetStore(mem(), now);
  assert.throws(() => s.importJSON('{"trades":[]}'), /not a preset file/);
});

// ---- Task 2: append-only log ----

test('log: entries keep insertion order and cannot be mutated through the API', () => {
  const st = mem(); const log = makeLog(st, now);
  log.append({ action: 'created', preset: 'alpha', hash: 'aaaa1111', rationale: 'tighter stop' });
  log.append({ action: 'locked', preset: 'alpha', hash: 'aaaa1111' });
  const list = log.list();
  assert.deepEqual(list.map(e => e.action), ['created', 'locked']);
  list[0].action = 'tampered';
  list.pop();
  assert.deepEqual(log.list().map(e => e.action), ['created', 'locked'], 'the log is append-only');
});

test('log: Markdown export carries action, hash and rationale for the IC appendix', () => {
  const log = makeLog(mem(), now);
  log.append({ action: 'created', preset: 'alpha', hash: 'aaaa1111',
    rationale: 'Wider runway should raise the share of setups with room to reach target.' });
  const md = log.exportMarkdown();
  assert.match(md, /# Optimization log/);
  assert.match(md, /created/);
  assert.match(md, /aaaa1111/);
  assert.match(md, /Wider runway/);
  assert.match(makeLog(mem(), now).exportMarkdown(), /No entries yet/);
});

// ---- FR-C8: promotion is an instruction, never an action ----

test('promotion: prints the config.js edit and refuses to perform it', () => {
  const s = makePresetStore(mem(), now);
  const p = s.create('wider runway', setPath(BASELINE, 'runwayPct', 3.5));
  const text = promotionInstruction(p);
  assert.match(text, /runwayPct: 3 → 3\.5/);
  assert.match(text, /src\/core\/config\.js/);
  assert.match(text, /will not write config\.js for you/);
});
