// Combines two people's-worth of synced data into one, used when a Google account that already has its own
// tasks is added to another account. Works the same way the page merges two devices:
//   - every task / event / label / quote is kept unless it was deleted AFTER it was last changed
//   - if both have the same item, the most recently changed copy wins
//   - settings and nickname: the most recently changed one wins

const KEYS = {
  tasks: function(x) { return String(x.id); },
  events: function(x) { return String(x.id); },
  labels: function(x) { return String(x.name); },
  quotes: function(x) { return String(x.text); }
};
const DEMO_TITLES = ['Study for science quiz', 'Finish reading chapter', 'Practice violin', 'Clean room'];

function isDemoTask(t) {
  return DEMO_TITLES.indexOf(t.title) !== -1 && !t.updatedAt && !t.completed;
}

export function mergeData(a, b) {
  if (!a || typeof a !== 'object') return b || null;
  if (!b || typeof b !== 'object') return a;
  const out = { v: 1, tomb: {} };
  Object.keys(KEYS).forEach(function(name) {
    const keyOf = KEYS[name];
    const tomb = Object.assign({}, (a.tomb && a.tomb[name]) || {});
    const tombB = (b.tomb && b.tomb[name]) || {};
    Object.keys(tombB).forEach(function(k) { tomb[k] = Math.max(tomb[k] || 0, tombB[k]); });
    const map = new Map();
    (Array.isArray(a[name]) ? a[name] : []).forEach(function(item) { if (item) map.set(keyOf(item), item); });
    const aHasTasks = map.size > 0;
    (Array.isArray(b[name]) ? b[name] : []).forEach(function(item) {
      if (!item) return;
      if (name === 'tasks' && aHasTasks && isDemoTask(item)) return; // sample tasks from a new account are not real tasks
      const k = keyOf(item);
      const have = map.get(k);
      if (!have || (item.updatedAt || 0) > (have.updatedAt || 0)) map.set(k, item);
    });
    out[name] = Array.from(map.values()).filter(function(item) {
      const t = tomb[keyOf(item)];
      return !(t && t >= (item.updatedAt || 0));
    });
    out.tomb[name] = tomb;
  });
  const settingsFromB = (b.settingsAt || 0) > (a.settingsAt || 0);
  out.settings = settingsFromB ? b.settings : a.settings;
  out.settingsAt = settingsFromB ? b.settingsAt : (a.settingsAt || 0);
  const profileFromB = (b.profileAt || 0) > (a.profileAt || 0);
  out.profile = profileFromB ? b.profile : a.profile;
  out.profileAt = profileFromB ? b.profileAt : (a.profileAt || 0);
  return out;
}
