const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

let win = null;
const watchers = new Map(); // root -> { watcher, timer }

const HUB_BASE = 'https://rzjhmipbamyvpwlkfvxx.supabase.co/functions/v1/mcp';

const registryPath = () => path.join(app.getPath('userData'), 'projects.json');
const tokensPath = () => path.join(app.getPath('userData'), 'tokens.json');

// Strip a UTF-8 BOM — files written by PowerShell/editors often carry one,
// and JSON.parse rejects it.
function readJson(p) {
  let s = fs.readFileSync(p, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip BOM
  return JSON.parse(s);
}

function loadRegistry() {
  try {
    const reg = readJson(registryPath());
    if (Array.isArray(reg.projects)) return reg;
  } catch {}
  return { projects: [] };
}

function saveRegistry(reg) {
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
}

function isProjectDir(dir) {
  return fs.existsSync(path.join(dir, 'project.json'));
}

// A picked folder can be: a project dir itself (contains project.json), a repo
// root with a flat .tasker/project.json, a .tasker/ folder, or a nested layout
// .tasker/<NAME>/project.json holding several projects. Return every project dir.
function discoverProjects(picked) {
  const found = [];
  const push = (d) => { if (!found.includes(d)) found.push(d); };
  if (isProjectDir(picked)) push(picked);
  const base = path.basename(picked) === '.tasker' ? picked : path.join(picked, '.tasker');
  if (isProjectDir(base)) push(base);
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory() && isProjectDir(path.join(base, e.name))) push(path.join(base, e.name));
    }
  } catch {}
  return found;
}

function projectName(dir) {
  try { return readJson(path.join(dir, 'project.json')).name || path.basename(dir); }
  catch { return path.basename(dir); }
}

// Registry entries may be project dirs or anything discoverProjects understands
// (old entries stored repo roots) — normalize to labeled project dirs.
function listProjects() {
  const out = [];
  for (const entry of loadRegistry().projects) {
    for (const dir of discoverProjects(entry)) {
      if (!out.some((p) => p.dir === dir)) out.push({ dir, name: projectName(dir) });
    }
  }
  return out;
}

function readProject(dir) {
  if (!isProjectDir(dir)) return { error: 'no-tasker', dir };

  const out = { dir, project: null, sync: null, syncMtime: null, tasks: [] };
  try {
    out.project = readJson(path.join(dir, 'project.json'));
  } catch (e) {
    return { error: 'bad-project-json', dir, message: String(e) };
  }
  try {
    const syncPath = path.join(dir, '.sync.json');
    out.sync = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
    out.syncMtime = fs.statSync(syncPath).mtimeMs;
  } catch {} // sync state is optional — viewer still works without it

  const tasksDir = path.join(dir, 'tasks');
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const p = path.join(tasksDir, f);
        out.tasks.push({ file: f, content: fs.readFileSync(p, 'utf8'), mtime: fs.statSync(p).mtimeMs });
      } catch {} // a file mid-write by the agent can vanish between readdir and read — skip, the watcher will re-read
    }
  }
  return out;
}

function stopWatch(dir) {
  const w = watchers.get(dir);
  if (w) {
    try { w.watcher.close(); } catch {}
    if (w.timer) clearTimeout(w.timer);
    watchers.delete(dir);
  }
}

function startWatch(dir) {
  stopWatch(dir);
  if (!fs.existsSync(dir)) return;
  try {
    const entry = { watcher: null, timer: null };
    entry.watcher = fs.watch(dir, { recursive: true }, () => {
      // debounce bursts (agent writes several files per flush/pull)
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (win && !win.isDestroyed()) win.webContents.send('project-changed', dir);
      }, 250);
    });
    watchers.set(dir, entry);
  } catch {} // watch is best-effort; manual refresh still works
}

// ── Hub pull (owner-only, manual) ────────────────────────────────
// A device token is project-scoped and stored per project dir. The pull is a
// plain HTTPS POST to the same device_poll/device_pull endpoints the watcher
// uses — main.js is Node, so we fetch + write files here directly. No child
// process, no reimplemented sync logic. Pull-only: overwrite files, drop
// tombstones, bump .sync.json cursor. Flush stays with the agent.

function loadTokens() {
  try { return readJson(tokensPath()); } catch { return {}; }
}
function tokenFor(dir) { return loadTokens()[dir] || null; }
function saveToken(dir, token) {
  const all = loadTokens();
  all[dir] = token;
  fs.writeFileSync(tokensPath(), JSON.stringify(all, null, 2));
}

async function hubApi(qs, token, body) {
  const res = await fetch(`${HUB_BASE}?${qs}=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { error: text }; }
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}

// Pull the hub bundle into this project's .tasker dir. Returns a summary; throws
// with a human message on token/network/mode failure.
async function pullFromHub(dir) {
  const token = tokenFor(dir);
  if (!token) return { needsToken: true };

  const syncPath = path.join(dir, '.sync.json');
  let sync = {};
  try { sync = readJson(syncPath); } catch {} // missing/corrupt → pull from cursor 0
  const localCursor = Number(sync.cursor || 0);

  const poll = await hubApi('device_poll', token, {});
  const hubCursor = Number(poll.cursor || 0);
  if (hubCursor <= localCursor) {
    return { changed: 0, hubCursor, localCursor, upToDate: true };
  }

  const bundle = await hubApi('device_pull', token, { cursor: localCursor });
  const files = bundle.files || {};
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content, 'utf8');
  }
  let removed = 0;
  for (const sid of bundle.tombstoned_short_ids || []) {
    const f = path.join(dir, 'tasks', `${bundle.prefix}-${sid}.md`);
    if (fs.existsSync(f)) { fs.rmSync(f); removed++; }
  }
  return {
    changed: Object.keys(files).length,
    removed,
    hubCursor: bundle.cursor,
    localCursor,
    upToDate: false,
  };
}

app.whenReady().then(() => {
  ipcMain.handle('registry:list', () => listProjects());

  ipcMain.handle('hub:hasToken', (_e, dir) => !!tokenFor(dir));
  ipcMain.handle('hub:setToken', (_e, dir, token) => {
    const t = String(token || '').trim();
    if (!/^dt_/.test(t)) return { error: 'That does not look like a device token (should start with "dt_"). Mint one with mint_device_token in Claude Code.' };
    saveToken(dir, t);
    return { ok: true };
  });
  ipcMain.handle('hub:pull', async (_e, dir) => {
    try { return await pullFromHub(dir); }
    catch (e) {
      const msg = String(e.message || e);
      // A dead/revoked token should not silently keep failing — surface it so
      // the UI can re-prompt.
      const badToken = /invalid|revoked|401/i.test(msg);
      return { error: msg, badToken };
    }
  });

  ipcMain.handle('registry:add', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Pick a folder that contains a .tasker/ project',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const picked = res.filePaths[0];
    const dirs = discoverProjects(picked);
    if (!dirs.length) return { error: 'no-tasker', picked };
    const reg = loadRegistry();
    for (const d of dirs) {
      if (!reg.projects.includes(d)) reg.projects.push(d);
    }
    saveRegistry(reg);
    return { added: dirs.map((d) => ({ dir: d, name: projectName(d) })) };
  });

  ipcMain.handle('registry:remove', (_e, dir) => {
    const reg = loadRegistry();
    reg.projects = reg.projects.filter((p) => p !== dir);
    saveRegistry(reg);
    stopWatch(dir);
    return listProjects();
  });

  ipcMain.handle('project:read', (_e, dir) => readProject(dir));
  ipcMain.handle('project:watch', (_e, dir) => { startWatch(dir); return true; });

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#FBFAF6',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (process.env.TL_DEBUG) console.log(`[renderer] ${message}`);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});

app.on('window-all-closed', () => {
  for (const root of [...watchers.keys()]) stopWatch(root);
  app.quit();
});
