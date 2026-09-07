// Module C preset model + append-only optimization log (FRD 4.7, FR-C1–C4, FR-C8).
//
// The governance is the feature. Module C makes every threshold editable, which combined with
// Module B is a curve-fitting machine unless the tooling refuses to let results drift away from
// the configuration that produced them. Hence: deterministic hashes, fork-on-edit-when-locked,
// a counted degrees-of-freedom budget, and a log nothing can rewrite.
import { BASELINE, presetHash } from './config.js';

const g = (group, key, label, type, extra = {}) => ({ group, key, label, type, ...extra });

// Every parameter FR-C1 asks for, described as data so the UI stays generic and nothing is
// silently unreachable. `path` addresses nested values; `enabled.*` are the criterion toggles.
export const PARAM_SPEC = [
  g('Gates', 'vixCap', 'VIX cap', 'number', { min: 5, max: 80, step: 1 }),
  g('Gates', 'spyMaDays', 'SPY MA period (days)', 'number', { min: 5, max: 200, step: 1 }),

  g('Structure', 'rsiLong', 'RSI band — long', 'range2', { min: 0, max: 100, step: 1 }),
  g('Structure', 'rsiShort', 'RSI band — short', 'range2', { min: 0, max: 100, step: 1 }),
  g('Structure', 'runwayPct', 'Runway minimum (%)', 'number', { min: 0, max: 20, step: 0.1 }),
  g('Structure', 'feasK', 'Feasibility multiplier', 'number', { min: 0.1, max: 10, step: 0.1 }),

  g('Trigger', 'relVolMin', 'Relative volume ≥', 'number', { min: 0, max: 10, step: 0.1 }),

  g('Exits', 'targetPct', 'Target (%)', 'number', { min: 0.1, max: 20, step: 0.1 }),
  g('Exits', 'stopPct', 'Stop (%)', 'number', { min: 0.1, max: 10, step: 0.1 }),
  g('Exits', 'timeStopHours', 'Time stop (hours)', 'number', { min: 0.5, max: 12, step: 0.5 }),

  g('Session', 'entryWindow.start', 'Entry window start (CET)', 'time'),
  g('Session', 'entryWindow.end', 'Entry window end (CET)', 'time'),
  g('Session', 'hardCloseCET', 'Hard close (CET)', 'time'),
  g('Session', 'blackoutDays.before', 'Blackout days before', 'number', { min: 0, max: 10, step: 1 }),
  g('Session', 'blackoutDays.after', 'Blackout days after', 'number', { min: 0, max: 10, step: 1 }),

  g('Alerts', 'alertProximityPct', 'Alert proximity (pp)', 'number', { min: 0.01, max: 3, step: 0.01 }),
  g('Alerts', 'alertTimeMin', 'Alert before limit (min)', 'number', { min: 1, max: 120, step: 1 }),

  g('Sizing', 'riskPerTrade', 'Risk per trade (fraction)', 'number', { min: 0.001, max: 0.1, step: 0.001 }),
  g('Sizing', 'leverage', 'Leverage', 'number', { min: 1, max: 30, step: 1 }),
  g('Sizing', 'maxConcurrent', 'Max concurrent positions', 'number', { min: 1, max: 10, step: 1 }),
  g('Sizing', 'maxPerDirection', 'Max per direction', 'number', { min: 1, max: 10, step: 1 }),
  g('Sizing', 'clusterSecondHalf', 'Second in cluster at half size', 'bool'),
  g('Sizing', 'betaCap', 'Beta-weighted exposure cap', 'number', { min: 0.5, max: 20, step: 0.1 }),
  g('Sizing', 'ddThrottle', 'Drawdown throttle (fraction)', 'number', { min: 0.01, max: 0.5, step: 0.01 }),
  g('Sizing', 'atrScaled', 'ATR-scaled sizing', 'bool'),

  g('Limits', 'dailyLossLimitPct', 'Daily loss limit (%)', 'number', { min: 0.5, max: 20, step: 0.5 }),
  g('Limits', 'weeklyLossLimitPct', 'Weekly circuit breaker (%)', 'number', { min: 1, max: 40, step: 0.5 }),
  g('Limits', 'maxCapitalPerPositionPct', 'Max capital per position (%)', 'number', { min: 1, max: 100, step: 1 }),

  g('Kill criteria', 'killHitRate', 'Kill: hit rate below (fraction)', 'number', { min: 0.01, max: 1, step: 0.01 }),
  g('Kill criteria', 'killHitRateWindow', 'Kill: hit-rate window (trades)', 'number', { min: 5, max: 200, step: 1 }),
  g('Kill criteria', 'killSlippagePp', 'Kill: avg stop slippage above (pp)', 'number', { min: 0.01, max: 2, step: 0.01 }),
  g('Kill criteria', 'killSlippageWindow', 'Kill: slippage window (stops)', 'number', { min: 5, max: 100, step: 1 }),
  g('Kill criteria', 'killConsecutiveDailyLimits', 'Kill: consecutive daily-limit days', 'number', { min: 1, max: 10, step: 1 }),

  ...['G1', 'G2', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']
    .map(id => g('Criteria', `enabled.${id}`, `${id} enabled`, 'criterion')),
];

export const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
export function setPath(obj, path, value) {
  const keys = path.split('.'), out = structuredClone(obj);
  let node = out;
  for (const k of keys.slice(0, -1)) node = (node[k] ??= {});
  node[keys.at(-1)] = value;
  return out;
}
// Criteria default to on, so an absent key reads as enabled rather than undefined.
export const readParam = (cfg, spec) =>
  spec.type === 'criterion' ? getPath(cfg, spec.key) !== false : getPath(cfg, spec.key);

const same = (a, b) => Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b;

// Deviations from the committed baseline (FR-C2). An RSI band counts once: the DoF budget exists
// to keep changes explainable, and a band is one idea, not two numbers.
export function diffFromBaseline(cfg, baseline = BASELINE) {
  return PARAM_SPEC
    .map(spec => ({ spec, current: readParam(cfg, spec), base: readParam(baseline, spec) }))
    .filter(d => !same(d.current, d.base));
}
export const dofCount = (cfg, baseline = BASELINE) => diffFromBaseline(cfg, baseline).length;
export const overBudget = (cfg, budget = 3, baseline = BASELINE) => dofCount(cfg, baseline) > budget;

// ---- Preset store (FR-C3/C4) ----
export function makePresetStore(storage, now = () => new Date().toISOString()) {
  const KEY = 'mr_presets_v1';
  const load = () => JSON.parse(storage.getItem(KEY) || '{"presets":[]}');
  const save = s => storage.setItem(KEY, JSON.stringify(s));
  const stamp = p => ({ ...p, hash: presetHash(p.cfg) });

  const api = {
    list() { return load().presets.map(stamp); },
    get(name) { return api.list().find(p => p.name === name) ?? null; },

    create(name, cfg, { parent = null, rationale = '' } = {}) {
      const s = load();
      if (s.presets.some(p => p.name === name)) throw new Error(`preset "${name}" already exists`);
      const p = { name, cfg, locked: false, parent, rationale, created: now() };
      s.presets.push(p); save(s);
      return stamp(p);
    },

    // FR-C4: a locked preset has validation results attached to its hash, so an edit must not
    // change it under them. Editing forks instead — the operator keeps moving, the results stay put.
    update(name, cfg, { forkName } = {}) {
      const s = load();
      const i = s.presets.findIndex(p => p.name === name);
      if (i < 0) throw new Error(`no preset "${name}"`);
      if (s.presets[i].locked) {
        const child = { name: forkName || nextForkName(s.presets, name), cfg, locked: false,
                        parent: name, rationale: '', created: now() };
        s.presets.push(child); save(s);
        return { preset: stamp(child), forked: true, from: name };
      }
      s.presets[i] = { ...s.presets[i], cfg };
      save(s);
      return { preset: stamp(s.presets[i]), forked: false };
    },

    lock(name) {
      const s = load();
      const p = s.presets.find(x => x.name === name);
      if (!p) throw new Error(`no preset "${name}"`);
      if (p.locked) return { preset: stamp(p), changed: false };
      p.locked = true; p.lockedAt = now(); save(s);
      return { preset: stamp(p), changed: true };
    },

    remove(name) { const s = load(); s.presets = s.presets.filter(p => p.name !== name); save(s); },

    exportJSON() { return JSON.stringify({ presets: load().presets.map(stamp) }, null, 2); },
    importJSON(text) {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.presets)) throw new Error('not a preset file');
      const s = load();
      let added = 0;
      for (const p of parsed.presets) {
        if (!p.name || !p.cfg) continue;
        const name = s.presets.some(x => x.name === p.name) ? nextForkName(s.presets, p.name) : p.name;
        s.presets.push({ name, cfg: p.cfg, locked: !!p.locked, parent: p.parent ?? null,
                         rationale: p.rationale ?? '', created: p.created ?? now() });
        added += 1;
      }
      save(s);
      return added;
    },
  };
  return api;
}
function nextForkName(presets, base) {
  const root = base.replace(/ \(\d+\)$/, '');
  let n = 2;
  while (presets.some(p => p.name === `${root} (${n})`)) n += 1;
  return `${root} (${n})`;
}

// ---- Append-only optimization log (FR-C8) ----
// Nothing here edits or deletes: the log is evidence, and the IC appendix quotes it.
export function makeLog(storage, now = () => new Date().toISOString()) {
  const KEY = 'mr_optlog_v1';
  const load = () => JSON.parse(storage.getItem(KEY) || '[]');
  return {
    append({ action, preset, hash, rationale = '', detail = '' }) {
      const entries = load();
      entries.push({ ts: now(), action, preset, hash, rationale, detail });
      storage.setItem(KEY, JSON.stringify(entries));
      return entries.length;
    },
    list() { return structuredClone(load()); },     // callers cannot mutate the stored log
    exportJSON() { return JSON.stringify(load(), null, 2); },
    exportMarkdown() {
      const rows = load().map(e =>
        `### ${e.ts} — ${e.action}\n\n- Preset: **${e.preset}** \`${e.hash}\`\n` +
        (e.detail ? `- ${e.detail}\n` : '') +
        (e.rationale ? `\n> ${e.rationale}\n` : '\n> _(no rationale recorded)_\n'));
      return `# Optimization log — Momentum with Runway\n\n` +
        `Append-only record of preset creation, locking and promotion (FRD 4.7 §5, FR-C8).\n\n` +
        (rows.length ? rows.join('\n') : '_No entries yet._\n');
    },
  };
}

// FR-C8: promotion is a repository commit, not a button. The UI shows this and stops.
export function promotionInstruction(preset) {
  const lines = diffFromBaseline(preset.cfg)
    .map(d => `  ${d.spec.key}: ${JSON.stringify(d.base)} → ${JSON.stringify(d.current)}`);
  return [
    `Promoting "${preset.name}" (${preset.hash}) to baseline is a manual, version-controlled step.`,
    `Edit src/core/config.js so BASELINE contains:`,
    ...lines,
    ``,
    `Then commit it, and record the rationale in the optimization log.`,
    `The application will not write config.js for you — the baseline is what the repository says it is.`,
  ].join('\n');
}
