/* Tasker Local — read-only viewer over .tasker/ folders.
   All verbs live in the coding platform + MCP; this window only looks. */

const state = {
  projects: [],
  activeRoot: null,
  data: null,        // { project, tasks: parsed[], sync, syncMtime }
  prevMtimes: {},    // file -> mtime, to flash freshly-changed cards
  filter: localStorage.getItem('filter') || 'open',
  q: '',
  openTaskId: null,
};

const $ = (id) => document.getElementById(id);

/* ── frontmatter + markdown ── */

function parseValue(raw) {
  const v = raw.trim();
  if (!v) return '';
  if (v[0] === '"' || v[0] === '{' || v[0] === '[') {
    try { return JSON.parse(v); } catch { return v.replace(/^"|"$/g, ''); }
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseTask(file) {
  const m = file.content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const t = { file: file.file, mtime: file.mtime, body: file.content, fm: {} };
  if (m) {
    t.body = file.content.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 1 || /^\s/.test(line)) continue;
      t.fm[line.slice(0, i).trim()] = parseValue(line.slice(i + 1));
    }
  }
  // The ⚖ GOVERNANCE footer is agent-facing carriage — hide it from humans.
  const gov = t.body.search(/^[-\s]*⚖\s*GOVERNANCE/m);
  if (gov > -1) { t.body = t.body.slice(0, gov); t.hadGovernance = true; }
  t.id = t.fm.id || file.file.replace(/\.md$/, '');
  t.title = t.fm.title || t.id;
  t.status = String(t.fm.status || 'pending');
  t.priority = String(t.fm.priority || 'medium');
  t.section = t.fm.section || 'unfiled';
  t.order = typeof t.fm.order === 'number' ? t.fm.order : 1e9;
  return t;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
}

// Minimal, safe markdown: escape first, then transform. Covers what task
// bodies actually use (headers, lists, code fences, quotes, hr, bold/code).
function renderMd(src) {
  const lines = esc(src).split(/\r?\n/);
  const out = [];
  let list = null, para = [], code = false;

  const flushPara = () => { if (para.length) { out.push(`<p>${inlineMd(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) { out.push('</code></pre>'); code = false; }
      else out.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushPara(); flushList(); out.push('<pre><code>'); code = true; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length + 1}>${inlineMd(h[2])}</h${h[1].length + 1}>`); continue; }
    if (/^(---|\*\*\*)\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    const q = line.match(/^&gt;\s?(.*)/);
    if (q) { flushPara(); flushList(); out.push(`<blockquote>${inlineMd(q[1])}</blockquote>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { flushList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    para.push(line);
  }
  if (code) out.push('</code></pre>');
  flushPara(); flushList();
  return out.join('\n');
}

/* ── helpers ── */

function rel(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? ts : Date.parse(ts);
  if (Number.isNaN(d)) return String(ts);
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const PRIO_DOT = { rush: 'dot-rush', high: 'dot-high', medium: 'dot-med', low: 'dot-low' };

/* ── rendering ── */

function render() {
  const d = state.data;
  const has = !!(d && d.project);
  $('empty').hidden = has || state.projects.length > 0;
  if (!has && state.projects.length > 0) {
    // registered projects exist but none readable/selected — still show board chrome
  }
  $('project-select').hidden = state.projects.length < 2;
  $('search').hidden = !has;
  $('live-chip').hidden = !has;
  $('pull-btn').hidden = !has;

  if (!has) {
    $('mast-title').textContent = state.projects.length ? 'Project unreadable' : 'No project open';
    $('mast-kicker').textContent = 'TASKER LOCAL';
    $('mast-sub').textContent = '';
    $('board').innerHTML = '';
    return;
  }

  const tasks = d.tasks;
  const done = tasks.filter((t) => t.status === 'done').length;
  $('mast-title').textContent = d.project.name || state.activeRoot;
  $('mast-kicker').textContent = `${d.project.prefix || ''} · LOCAL MIRROR · READ-ONLY`;

  const bits = [`${done}/${tasks.length} done`];
  if (d.sync) bits.push(`device ${d.sync.device_id} · cursor ${d.sync.cursor}`);
  bits.push(d.syncMtime ? `synced ${rel(d.syncMtime)}` : 'no sync state');
  $('mast-sub').innerHTML = bits.map(esc).join('<span class="sep">·</span>');

  const q = state.q.toLowerCase();
  const visible = tasks.filter((t) =>
    (state.filter === 'all' || t.status !== 'done') &&
    (!q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
  );

  const sections = [...(d.project.sections || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const bySection = new Map(sections.map((s) => [s.id, []]));
  for (const t of visible) {
    if (!bySection.has(t.section)) bySection.set(t.section, []); // tolerate unknown section ids
    bySection.get(t.section).push(t);
  }

  const board = $('board');
  board.innerHTML = '';
  for (const s of sections) {
    const secTasks = (bySection.get(s.id) || []).sort((a, b) => a.order - b.order);
    const all = tasks.filter((t) => t.section === s.id);
    if (!all.length && !secTasks.length) continue; // hide empty sections — a viewer shows what exists

    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `
      <div class="col-head">
        <span class="kicker">${esc(s.name)}</span>
        <span class="col-count" title="done / total">${all.filter((t) => t.status === 'done').length}/${all.length}</span>
      </div><div class="col-body"></div>`;
    const body = col.querySelector('.col-body');
    for (const t of secTasks) body.appendChild(cardEl(t));
    board.appendChild(col);
  }

  // orphans: tasks pointing at section ids project.json doesn't know
  const known = new Set(sections.map((s) => s.id));
  const orphans = visible.filter((t) => !known.has(t.section));
  if (orphans.length) {
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = `<div class="col-head"><span class="kicker">Unfiled</span>
      <span class="col-count">${orphans.length}</span></div><div class="col-body"></div>`;
    const body = col.querySelector('.col-body');
    for (const t of orphans.sort((a, b) => a.order - b.order)) body.appendChild(cardEl(t));
    board.appendChild(col);
  }
}

function cardEl(t) {
  const el = document.createElement('div');
  el.className = 'card' + (t.status === 'done' ? ' card-done' : '');
  const prev = state.prevMtimes[t.file];
  if (prev && t.mtime > prev) el.classList.add('card-flash');

  const marker = t.status === 'done'
    ? '<span class="check">✓</span>'
    : t.status === 'in_progress'
      ? '<span class="dot dot-live-accent"></span>'
      : `<span class="dot ${PRIO_DOT[t.priority] || 'dot-med'}"></span>`;
  const statusTag = t.status === 'in_progress' ? '<span class="card-status">in progress</span>' : '';

  el.innerHTML = `<div class="card-top">${marker}<span class="card-id">${esc(t.id)}</span>${statusTag}</div>
    <div class="card-title">${esc(t.title)}</div>`;
  el.addEventListener('click', () => openDetail(t.id));
  return el;
}

function openDetail(id) {
  const t = state.data?.tasks.find((x) => x.id === id);
  if (!t) return;
  state.openTaskId = id;
  $('detail-id').textContent = `${t.id} · ${t.file}`;
  $('detail-title').textContent = t.title;

  const chips = [];
  chips.push(`<span class="chip ${t.status === 'done' ? 'chip-done' : t.status === 'in_progress' ? 'chip-progress' : ''}">${esc(t.status.replace('_', ' '))}</span>`);
  chips.push(`<span class="chip chip-${esc(t.priority)}">${esc(t.priority)}</span>`);
  $('detail-chips').innerHTML = chips.join('');

  const secName = state.data.project.sections?.find((s) => s.id === t.section)?.name || t.section;
  $('detail-meta').innerHTML = `
    <span class="k">Section</span><span>${esc(String(secName))}</span>
    <span class="k">Updated</span><span>${esc(String(t.fm.updated_at || '—'))} (${rel(t.fm.updated_at)})</span>
    <span class="k">Order</span><span>${esc(String(t.fm.order ?? '—'))}</span>`;

  const rev = t.fm.review;
  const rules = rev && rev.bar && Array.isArray(rev.bar.rules) ? rev.bar.rules : null;
  $('detail-review').innerHTML = rules
    ? `<div class="review-box"><div class="kicker">Quality bar · ${rules.length} rule${rules.length > 1 ? 's' : ''}</div>
       <ul>${rules.map((r) => `<li><span class="sev">${esc(r.severity || 'rule')}</span> ${esc(r.label || r.rule || '')}</li>`).join('')}</ul></div>`
    : '';

  $('detail-body').innerHTML = renderMd(t.body) +
    (t.hadGovernance ? '<div class="gov-note">⚖ governance footer hidden (agent-facing)</div>' : '');

  $('detail').hidden = false;
  $('scrim').hidden = false;
  $('detail').scrollTop = 0;
}

function closeDetail() {
  state.openTaskId = null;
  $('detail').hidden = true;
  $('scrim').hidden = true;
}

/* ── data flow ── */

async function loadProject(root, { flash = false } = {}) {
  const res = await window.tasker.readProject(root);
  if (!res || res.error) { state.data = null; render(); return; }
  if (!flash) state.prevMtimes = {};
  state.activeRoot = root;
  localStorage.setItem('activeRoot', root);
  state.data = {
    project: res.project,
    sync: res.sync,
    syncMtime: res.syncMtime,
    tasks: res.tasks.map(parseTask),
  };
  render();
  if (flash) {
    // refresh an open detail panel in place if its task changed
    if (state.openTaskId) {
      const still = state.data.tasks.find((t) => t.id === state.openTaskId);
      if (still) openDetail(still.id); else closeDetail();
    }
  }
  const next = {};
  for (const t of state.data.tasks) next[t.file] = t.mtime;
  state.prevMtimes = next;
  window.tasker.watchProject(root);
}

// Two mirrors of the same project share a name — disambiguate with a path tail.
function projectLabel(p) {
  const parts = p.dir.split(/[\\/]/).filter((x) => x && x !== '.tasker');
  return `${p.name} · ${parts.slice(-2).join('/')}`;
}

async function refreshProjects() {
  state.projects = await window.tasker.listProjects();
  const sel = $('project-select');
  sel.innerHTML = state.projects
    .map((p) => `<option value="${esc(p.dir)}" ${p.dir === state.activeRoot ? 'selected' : ''}>${esc(projectLabel(p))}</option>`)
    .join('');
  sel.hidden = state.projects.length < 2;
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

async function addProject() {
  const res = await window.tasker.addProject();
  if (!res) return;
  if (res.error === 'no-tasker') {
    toast(`No Tasker project found in "${res.picked}" — pick a folder that contains a .tasker/ directory (flat or per-project).`);
    return;
  }
  await refreshProjects();
  if (res.added?.length) await loadProject(res.added[0].dir);
  render();
}

/* ── hub pull ── */

async function doPull(dir) {
  const btn = $('pull-btn');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '↓ Pulling…';
  $('progress').hidden = false;
  try {
    const res = await window.tasker.hubPull(dir);
    if (res.needsToken) { openTokenModal(dir); return; }
    if (res.error) {
      toast(res.badToken ? 'Hub rejected the token — paste a fresh one.' : `Pull failed: ${res.error}`);
      if (res.badToken) openTokenModal(dir);
      return;
    }
    if (res.upToDate) {
      toast(`Already up to date (hub cursor ${res.hubCursor}). Nothing to pull.`);
      return;
    }
    // Files changed on disk — the fs.watcher will re-render, but refresh now so
    // the toast and board are in lockstep.
    await loadProject(dir, { flash: true });
    toast(`Pulled ${res.changed} file${res.changed === 1 ? '' : 's'}${res.removed ? `, removed ${res.removed}` : ''} · cursor ${res.localCursor} → ${res.hubCursor}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    $('progress').hidden = true;
  }
}

let tokenModalDir = null;
function openTokenModal(dir) {
  tokenModalDir = dir;
  $('token-input').value = '';
  $('token-modal').hidden = false;
  $('token-input').focus();
}
function closeTokenModal() { tokenModalDir = null; $('token-modal').hidden = true; }

async function saveTokenAndPull() {
  const dir = tokenModalDir;
  const res = await window.tasker.hubSetToken(dir, $('token-input').value);
  if (res.error) { toast(res.error); return; }
  closeTokenModal();
  await doPull(dir);
}

$('pull-btn').addEventListener('click', () => { if (state.activeRoot) doPull(state.activeRoot); });
$('token-save').addEventListener('click', saveTokenAndPull);
$('token-cancel').addEventListener('click', closeTokenModal);
$('token-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveTokenAndPull();
  if (e.key === 'Escape') closeTokenModal();
});

/* ── wiring ── */

$('add-btn').addEventListener('click', addProject);
$('empty-add').addEventListener('click', addProject);
$('detail-close').addEventListener('click', closeDetail);
$('scrim').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

$('project-select').addEventListener('change', (e) => loadProject(e.target.value));
$('search').addEventListener('input', (e) => { state.q = e.target.value; render(); });

function setFilter(f) {
  state.filter = f;
  localStorage.setItem('filter', f);
  $('pill-open').classList.toggle('pill-active', f === 'open');
  $('pill-all').classList.toggle('pill-active', f === 'all');
  render();
}
$('pill-open').addEventListener('click', () => setFilter('open'));
$('pill-all').addEventListener('click', () => setFilter('all'));

$('theme-btn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
});

window.tasker.onProjectChanged((root) => {
  if (root === state.activeRoot) loadProject(root, { flash: true });
});

window.addEventListener('error', (e) => console.log('RENDER-ERROR:', e.message, e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => console.log('PROMISE-REJECT:', e.reason?.message || e.reason));

(async function init() {
  document.documentElement.dataset.theme = localStorage.getItem('theme') || 'light';
  setFilter(state.filter);
  await refreshProjects();
  const saved = localStorage.getItem('activeRoot');
  const first = state.projects.some((p) => p.dir === saved) ? saved : state.projects[0]?.dir;
  if (first) await loadProject(first);
  render();
})();
