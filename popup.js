'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const IC = {
  chat: '<svg viewBox="0 0 24 24"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4V5a2 2 0 0 1 2-2z"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zm-2 8h14v10H5z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.400 14.500L6 11.900l1.400-1.400 3.200 3.200 6-6L18 9.100z"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 2h2v20H5zm3 1h11l-2 4.500L19 12H8z"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M19.400 13a7.800 7.800 0 0 0 0-2l2.100-1.600-2-3.500-2.500 1a7.600 7.600 0 0 0-1.700-1L15 3h-4l-.4 2.900a7.600 7.600 0 0 0-1.700 1l-2.500-1-2 3.500L6.600 11a7.800 7.800 0 0 0 0 2l-2.100 1.600 2 3.500 2.500-1c.5.400 1.100.7 1.700 1L11 21h4l.4-2.900c.6-.3 1.200-.6 1.700-1l2.500 1 2-3.500zM13 15.500a3.500 3.500 0 1 1 0-7 3.500 3.500 0 0 1 0 7z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M19 6.4 17.600 5 12 10.600 6.400 5 5 6.400 10.600 12 5 17.600 6.400 19 12 13.400 17.600 19 19 17.600 13.400 12z"/></svg>',
  dots: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M17.600 6.400A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.800-4.200L13 11h7V4z"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.500A2.500 2.500 0 1 1 12 6.500a2.500 2.500 0 0 1 0 5z"/></svg>',
  people: '<svg viewBox="0 0 24 24"><path d="M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.300 0-7 1.200-7 3.500V19h14v-2.500C15 14.200 10.300 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.200.9 2 2 2 3.400V19h6v-2.500C23 14.200 18.300 13 16 13z"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v5.400l4 2.400-1 1.700-5-3V7z"/></svg>',
  user: '<svg viewBox="0 0 24 24"><path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-3.300 0-10 1.700-10 5v3h20v-3c0-3.300-6.700-5-10-5z"/></svg>'
};
const KIND = { event: ['Event', 'cal'], decision: ['Decision', 'check'], deadline: ['Deadline', 'flag'], reply: ['Needs reply', 'chat'] };

document.querySelectorAll('[data-ic]').forEach(e => { e.innerHTML = IC[e.dataset.ic] || ''; });

let D = null;            // latest dashboard data
let tab = 'today';
let sortBy = 'time';
let pollTimer = null;
const views = ['onboard', 'scan', 'dash', 'detail', 'cal', 'mute', 'plan', 'pick'];
function show(v) { views.forEach(n => $('v-' + n).classList.toggle('on', n === v)); }
function send(msg) { return new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r)); } catch (e) { res({ ok: false, error: e.message }); } }); }
function say(id, t, cls) { const e = $(id); e.textContent = t || ''; e.className = 'msg ' + (cls || ''); }
function getSettings() { return new Promise(r => chrome.storage.local.get(GP.STORE.SETTINGS, d => r(d[GP.STORE.SETTINGS] || {}))); }
function saveSettings(patch) { return getSettings().then(s => new Promise(r => chrome.storage.local.set({ [GP.STORE.SETTINGS]: Object.assign(s, patch) }, r))); }

/* ---------- helpers ---------- */
function avatar(name) {
  const cols = ['#1f9d55', '#2f6fed', '#7a52d9', '#e08a00', '#d64545', '#0e8fa8', '#c2478a'];
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const ini = String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  return '<div class="av" style="background:' + cols[h % cols.length] + '">' + esc(ini) + '</div>';
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return ((h % 12) || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function fmtWhen(e) {
  if (!e.date) return e.time ? fmtTime(e.time) : '';
  const today = gpDayKey(), tomorrow = gpDayKey(Date.now() + 86400000);
  let d = e.date === today ? 'Today' : e.date === tomorrow ? 'Tomorrow' :
    new Date(e.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return d + (e.time ? ', ' + fmtTime(e.time) : '');
}
function clock(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function bannerHtml(cls, html) { return '<div class="banner ' + cls + '">' + html + '</div>'; }

/* ---------- entry ---------- */
async function init() {
  D = await send({ type: 'gp-dashboard' });
  if (!D || !D.ok) { show('dash'); $('d-body').innerHTML = bannerHtml('bad', 'GroupPing could not start: ' + esc((D && D.error) || 'no answer') + '. Reload the extension.'); return; }
  if (!D.onboarded) { show('onboard'); $('keyrow').style.display = D.hasKey ? 'none' : 'block'; return; }
  if (!D.selectedCount) { showPick(true); return; } // opt-in: nothing is read until groups are picked
  const p = D.progress;
  if (p && (p.phase === 'listing' || p.phase === 'reading') && Date.now() - p.ts < 12000) { startScanView(true); return; }
  const seen = localStorage.getItem('gp_planSeen');
  if (D.plan.tier === 'free' && seen !== 'free') { localStorage.setItem('gp_planSeen', 'free'); showPlan(true); return; }
  renderDash();
}

/* ---------- 1. onboarding ---------- */
$('ob-connect').addEventListener('click', async () => {
  const btn = $('ob-connect');
  const keyIn = $('ob-key').value.trim();
  const s = await getSettings();
  const key = keyIn || s.geminiKey;
  if (!key) { say('ob-msg', 'Paste your Gemini API key first.', 'bad'); return; }
  btn.disabled = true; say('ob-msg', 'Checking your key...');
  const t = await send({ type: 'gp-test-key', key, model: s.model || GP.DEFAULT_MODEL });
  if (!t || !t.ok) { btn.disabled = false; say('ob-msg', 'Key check failed: ' + ((t && t.error) || 'no answer') + '. Check the key and try again.', 'bad'); return; }
  await saveSettings({ geminiKey: key, deepRead: $('ob-deep').checked });
  const c = await send({ type: 'gp-connect' });
  if (c && c.opened) {
    btn.disabled = false; btn.textContent = 'I am logged in - start scanning';
    say('ob-msg', 'WhatsApp Web opened in a new tab. Log in there (scan the QR code), then press this button again.', 'ok');
    $('ob-connect').onclick = null;
    $('ob-connect').addEventListener('click', () => startScan(), { once: true });
    return;
  }
  startScan();
});

/* ---------- 2. scanning ---------- */
function startScanView(alreadyRunning) {
  show('scan'); say('sc-msg', '');
  $('sc-bar').style.width = '3%';
  clearInterval(pollTimer);
  pollTimer = setInterval(pollProgress, 600);
  pollProgress();
}
async function pollProgress() {
  const d = await new Promise(r => chrome.storage.local.get(GP.STORE.PROGRESS, r));
  const p = d[GP.STORE.PROGRESS];
  if (!p) return;
  $('sc-bar').style.width = Math.max(3, p.pct || 0) + '%';
  $('sc-pct').textContent = (p.pct || 0) + '%';
  $('sc-count').textContent = p.phase === 'reading'
    ? 'Reading ' + (p.current || '') + ' (' + (p.done || 0) + ' read)'
    : (p.found || 0) + ' groups found';
  $('sc-title').textContent = p.phase === 'done' ? 'Scan finished' : 'Scanning your WhatsApp groups...';
  $('sc-list').innerHTML = (p.groups || []).map(g => '<div class="found">' + avatar(g) + '<span>' + esc(g) + '</span><span class="tag">Found</span></div>').join('');
}
async function startScan() {
  startScanView();
  const r = await send({ type: 'gp-scan-now' });
  clearInterval(pollTimer);
  if (r && r.running) { await init2(); return; }
  if (!r || r.ok === false && !r.note) {
    show('scan'); say('sc-msg', 'Scan problem: ' + ((r && r.error) || 'unknown') + '. Open Settings > General > Debug log for details.', 'bad');
    addRetry(); return;
  }
  if (r.note && /reload|not open/i.test(r.note) && !(r.read && r.read.ok)) {
    say('sc-msg', r.note, 'bad'); addRetry(true); return;
  }
  await init2();
}
function addRetry(reload) {
  const m = $('sc-msg');
  const b = document.createElement('button'); b.className = 'btn pri'; b.style.marginTop = '8px';
  b.textContent = reload ? 'Reload WhatsApp tab and retry' : 'Retry';
  b.addEventListener('click', async () => {
    if (reload) {
      chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (tabs) => { (tabs || []).forEach(t => chrome.tabs.reload(t.id)); setTimeout(startScan, 8000); say('sc-msg', 'Reloading WhatsApp Web... retrying in a few seconds.'); });
    } else startScan();
  });
  m.after(b);
}
async function init2() {
  D = await send({ type: 'gp-dashboard' }); tab = 'today';
  if (!D.selectedCount) { showPick(true); return; } // onboarding: pick the groups GroupPing may read
  await send({ type: 'gp-finish-onboard' });
  renderDash();
}

/* ---------- 3a. group picker (opt-in) ---------- */
let PICK = { groups: [], q: '', showInactive: false, checked: {} };
async function showPick(firstRun) {
  const r = await send({ type: 'gp-groups' });
  if (r && r.ok) {
    PICK.groups = r.groups;
    PICK.checked = {};
    r.groups.forEach(g => { if (g.selected) PICK.checked[g.name] = true; });
    PICK.maxGroups = r.maxGroups || null;
  }
  PICK.firstRun = !!firstRun;
  renderPick();
  show('pick');
  if (!PICK.groups.length) pickScan(); // nothing listed yet - the picker runs the scan itself
}

/* The picker scans for groups itself (v0.5.4): no waiting for the hourly
   scan. Shows a live "Scanning your groups..." state, then fills the list.
   Ticks she already made survive the rescan. */
let pickScanning = false;
async function pickScan() {
  if (pickScanning) return;
  pickScanning = true;
  show('pick');
  say('pk-msg', '');
  $('pk-scan').style.display = '';
  $('pk-body').style.display = 'none';
  $('pk-go').style.display = 'none';
  clearInterval(pollTimer);
  pollTimer = setInterval(pollPickProgress, 600);
  pollPickProgress();
  const r = await send({ type: 'gp-list-groups' });
  clearInterval(pollTimer);
  pickScanning = false;
  $('pk-scan').style.display = 'none';
  $('pk-body').style.display = '';
  $('pk-go').style.display = '';
  const g = await send({ type: 'gp-groups' });
  if (g && g.ok) {
    PICK.groups = g.groups;
    const keep = PICK.checked;
    PICK.checked = {};
    g.groups.forEach(x => { if (x.selected || keep[x.name]) PICK.checked[x.name] = true; });
    PICK.maxGroups = g.maxGroups || null;
  }
  renderPick();
  if (!r || r.ok === false) {
    say('pk-msg', 'Scan problem: ' + ((r && r.error) || 'unknown') + ' (details in Settings > General > Debug log)', 'bad');
  } else if (PICK.groups.length) {
    say('pk-msg', PICK.groups.length + ' groups found. Turn on the ones GroupPing may read.', 'ok');
  } else {
    say('pk-msg', 'Still no groups found. Open WhatsApp Web, make sure the chat list is visible, then press Rescan. Details: Settings > General > Debug log.', 'bad');
  }
}
function pollPickProgress() {
  chrome.storage.local.get(GP.STORE.PROGRESS, (d) => {
    const p = d[GP.STORE.PROGRESS];
    if (!p) return;
    $('pks-bar').style.width = Math.max(3, p.pct || 0) + '%';
    $('pks-count').textContent = (p.found || 0) + ' groups found';
    $('pks-title').textContent = p.phase === 'done' ? 'Scan finished' : 'Scanning your groups...';
    $('pks-list').innerHTML = (p.groups || []).map(g => '<div class="found">' + avatar(g) + '<span>' + esc(g) + '</span><span class="tag">Found</span></div>').join('');
  });
}
function renderPick() {
  const q = (PICK.q || '').toLowerCase();
  const match = (g) => !q || g.name.toLowerCase().includes(q);
  const active = PICK.groups.filter(g => !g.inactive && match(g));
  const inactive = PICK.groups.filter(g => g.inactive && match(g));
  const row = (g) => '<label class="pickrow"><input type="checkbox" data-n="' + esc(g.name) + '"' + (PICK.checked[g.name] ? ' checked' : '') + '>' +
    '<div class="grow"><b>' + esc(g.name) + '</b>' + (g.isCommunity ? ' <span class="chip" style="background:#fff3d6;color:#8a5a00">Community</span>' : '') + '<div class="small mut">' + (g.isCommunity ? 'A Community container' + (g.subCount ? ' - ticking it selects its ' + g.subCount + ' subgroups.' : ' - its messages live in its subgroups, tick those.') + ' ' : '') +
    (g.msgCount ? g.msgCount + ' msgs in window' : (g.lastTs ? 'active ' + gpAgeText(g.lastTs) : 'quiet')) +
    (g.muted ? ' · muted' : '') + '</div></div></label>';
  $('pk-list').innerHTML = active.length ? active.map(row).join('') :
    '<div class="mut" style="padding:12px">' + (PICK.groups.length ? 'No groups match.' : 'No groups found yet. Press Rescan above - the picker scans your chat list itself (about a minute).') + '</div>';
  $('pk-inactivelist').innerHTML = PICK.showInactive ? (inactive.length ? inactive.map(row).join('') : '<div class="mut small" style="padding:8px">No older groups.</div>') : '';
  $('pk-inactive').textContent = PICK.showInactive ? 'Hide groups inactive for 6+ months' : 'Show groups inactive for 6+ months (' + inactive.length + ')';
  const n = Object.keys(PICK.checked).filter(k => PICK.checked[k]).length;
  $('pk-count').textContent = n + ' selected' + (PICK.maxGroups ? ' (Free plan: up to ' + PICK.maxGroups + ')' : '');
  $('pk-go').textContent = n ? 'Start watching ' + n + ' group' + (n === 1 ? '' : 's') : (PICK.firstRun ? 'Skip for now - pick later' : 'Done');
}
$('pk-q').addEventListener('input', () => { PICK.q = $('pk-q').value; renderPick(); });
$('pk-list').addEventListener('change', (e) => { const n = e.target.dataset.n; if (n) PICK.checked[n] = e.target.checked; renderPick(); });
$('pk-inactivelist').addEventListener('change', (e) => { const n = e.target.dataset.n; if (n) PICK.checked[n] = e.target.checked; renderPick(); });
$('pk-inactive').addEventListener('click', (e) => { e.preventDefault(); PICK.showInactive = !PICK.showInactive; renderPick(); });
$('pk-all').addEventListener('click', (e) => {
  e.preventDefault();
  const q = (PICK.q || '').toLowerCase();
  PICK.groups.filter(g => !g.inactive && (!q || g.name.toLowerCase().includes(q))).forEach(g => { PICK.checked[g.name] = true; });
  renderPick();
});
$('pk-none').addEventListener('click', (e) => { e.preventDefault(); PICK.checked = {}; renderPick(); });
$('pk-rescan').addEventListener('click', (e) => { e.preventDefault(); pickScan(); });
$('pk-go').addEventListener('click', async () => {
  const patch = {};
  PICK.groups.forEach(g => { patch[g.name] = !!PICK.checked[g.name]; });
  const r = await send({ type: 'gp-select-groups', patch, replace: true });
  if (r && r.ok === false) { say('pk-msg', r.error || 'Could not save.', 'bad'); return; }
  await send({ type: 'gp-finish-onboard' });
  await init2();
});

/* ---------- 3. dashboard ---------- */
function tabCounts() {
  document.querySelectorAll('#d-tabs .tab').forEach((t) => {
    const k = t.dataset.tab;
    t.classList.toggle('on', k === tab);
    if (k === 'pending') t.textContent = 'Pending (' + D.stats.needReply + ')';
    if (k === 'muted') t.textContent = 'Muted (' + D.muted.length + ')';
  });
}
document.querySelectorAll('#d-tabs .tab').forEach(t => t.addEventListener('click', () => { tab = t.dataset.tab; renderDash(); }));
$('d-gear').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('d-plan').addEventListener('click', (e) => { e.preventDefault(); showPlan(false); });
$('d-groups').addEventListener('click', (e) => { e.preventDefault(); showPick(false); });
$('d-privacy').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '#privacy' }); });
$('d-scan').addEventListener('click', async () => {
  $('d-scan').disabled = true; say('d-msg', 'Scanning...');
  const t0 = Date.now();
  pollTimer = setInterval(pollMini, 700);
  const r = await send({ type: 'gp-scan-now' });
  clearInterval(pollTimer); $('d-scan').disabled = false;
  if (r && r.running) say('d-msg', 'A scan is already running. It will finish by itself - results appear here.', 'ok');
  else if (!r || r.ok === false) say('d-msg', 'Scan problem: ' + ((r && r.error) || (r && r.note) || 'unknown') + ' (see Settings > Debug log)', 'bad');
  else if (r.note && !(r.read && r.read.ok)) say('d-msg', r.note, 'bad');
  else say('d-msg', (r.read && r.read.reloaded ? 'Fixed the WhatsApp tab. ' : '') +
    ((r.read && typeof r.read.groups === 'number') ? r.read.groups + ' groups found. ' : '') +
    (r.calls ? 'Scan done. ' + r.found + ' new item(s).' : 'Scan done. Nothing new to analyse.'), 'ok');
  D = await send({ type: 'gp-dashboard' }); renderDash();
});
async function pollMini() {
  const d = await new Promise(r => chrome.storage.local.get(GP.STORE.PROGRESS, r));
  const p = d[GP.STORE.PROGRESS];
  if (p && p.phase === 'reading') say('d-msg', 'Reading ' + (p.current || '') + ' (' + (p.done || 0) + '/' + (p.total || '?') + ' done)');
  else if (p && p.phase === 'listing') say('d-msg', 'Scanning chat list... ' + (p.found || 0) + ' groups');
}

function gStat() { return (D && D.lastScan && D.lastScan.groupStatus) || {}; }
function gFailed(g) { const x = gStat()[g]; return !!(x && x.state === 'failed'); }
/* v0.5.8: honest end-of-scan report, so the user always knows what was and was not read. */
function scanReportHtml() {
  const gs = gStat(), names = Object.keys(gs);
  const ls = D.lastScan;
  if (!ls || !names.length) return '';
  const sel = (D.selectedNames || []).filter(n => gs[n]);
  const list = sel.length ? sel : names;
  const comm = list.filter(n => gs[n].state === 'community'), read = list.filter(n => gs[n].state === 'read'), quiet = list.filter(n => gs[n].state === 'quiet'), bad = list.filter(n => gs[n].state === 'failed');
  const done = read.length + quiet.length;
  let head = '<b>Scanned ' + done + ' of ' + (list.length - comm.length) + ' groups</b> (' + clock(ls.at) + ').';
  if (quiet.length) head += ' No new messages in ' + quiet.length + ': ' + quiet.map(esc).join(', ') + '.';
  if (comm.length) head += ' <span style="color:#8a5a00">' + comm.length + ' selected ' + (comm.length === 1 ? 'is a Community container' : 'are Community containers') + ' (' + comm.map(esc).join(', ') + ') - its messages live in its subgroups, so tick those instead.</span>';
  if (bad.length) head += ' <span style="color:#b32222">Could not read ' + bad.length + ': ' + bad.map(esc).join(', ') + '.</span>';
  const rows = list.slice().sort((a, b) => ({ failed: 0, community: 1, read: 2, quiet: 3 }[gs[a].state] - { failed: 0, community: 1, read: 2, quiet: 3 }[gs[b].state])).map((n) => {
    const x = gs[n];
    const t = x.state === 'read' ? (x.retried ? '(2nd try) ' : '') + 'Read ' + (x.n || 0) + ' message' + (x.n === 1 ? '' : 's') : x.state === 'community' ? 'Community - pick its subgroups' : x.state === 'quiet' ? 'No new messages' + (x.why ? ' (' + esc(x.why) + ')' : '') : 'Could not read (' + esc(x.why || '') + ')';
    return '<div class="small" style="display:flex;justify-content:space-between;gap:8px;padding:2px 0"><span>' + esc(n) + '</span><span style="color:' +
      (x.state === 'failed' ? '#b32222' : x.state === 'community' ? '#8a5a00' : x.state === 'read' ? 'var(--gd)' : '#777') + '">' + t + '</span></div>';
  }).join('');
  return '<div class="sec"><span class="grow">Scan report</span></div><div class="card"><div class="small" style="margin-bottom:6px">' + head + '</div>' + rows + '</div>';
}

function renderStatus() {
  const el = $('d-status');
  let html = '';
  if (D.connected === false) {
    html = bannerHtml('bad', '<b>Not reading WhatsApp yet.</b> ' +
      (D.tabCount ? 'The WhatsApp tab needs one reload so GroupPing can see it.' : 'WhatsApp Web is not open in any tab.') +
      ' <a href="#" id="d-fix" style="font-weight:700;color:#b32222">Fix it &amp; scan now</a>');
  } else if (D.scanning) {
    const pg = D.progress;
    html = '<div class="small" style="margin:0 2px 8px;color:var(--gd);font-weight:600">Scanning now' +
      (pg && pg.phase === 'reading' ? ' - reading ' + esc(pg.current || '') + ' (' + (pg.done || 0) + ' of ' + (pg.total || '?') + ' done)' : '...') +
      ' <span class="mut" style="font-weight:400">It finishes by itself - no need to press anything.</span></div>';
  } else if (D.lastScan && D.lastScan.at) {
    const ls = D.lastScan;
    html = '<div class="small mut" style="margin:0 2px 8px">Last scan ' + clock(ls.at) +
      (ls.groups != null ? ' · ' + ls.groups + ' groups found' : '') +
      (ls.deep === false ? '' : (ls.readOk ? ' · ' + (ls.opened || 0) + ' opened' + (ls.failed ? ', ' + ls.failed + ' failed to open' : '') : '')) +
      (ls.found ? ' · ' + ls.found + ' new' : '') +
      (ls.note ? ' · ' + esc(ls.note) : '') + '</div>';
  } else {
    html = '<div class="small mut" style="margin:0 2px 8px">First scan starts by itself - nothing to do.</div>';
  }
  el.innerHTML = html;
  const fix = $('d-fix');
  if (fix) fix.addEventListener('click', (e) => { e.preventDefault(); $('d-scan').click(); });
}

function renderDash() {
  show('dash'); tabCounts(); renderStatus();
  const s = D.stats, free = D.plan.tier === 'free';
  let ban = '';
  if (!D.selectedCount) ban += bannerHtml('warn', '<b>No groups selected.</b> GroupPing is reading nothing. <a href="#" id="b-pick" style="color:var(--gd);font-weight:700">Pick the groups it may read</a>');
  if (D.localOnly) ban += bannerHtml('ok', 'Local-only mode: nothing is analysed or sent anywhere. Reply reminders still work. Turn this off in Settings &gt; Privacy to get AI updates.');
  else if (!D.hasKey) ban += bannerHtml('warn', 'Add your Gemini key in Settings to start analysing messages.');
  if (free) ban += bannerHtml('warn', '<b>Your free trial ended.</b> Free plan watches ' + GP_FREE_MAX_GROUPS + ' groups, no calendar, no reply reminders. <a href="#" id="b-up" style="color:var(--gd);font-weight:700">See Pro</a>');
  else if (D.plan.tier === 'trial' && D.plan.daysLeft <= 3) ban += bannerHtml('warn', 'Free trial: ' + D.plan.daysLeft + ' day(s) left. <a href="#" id="b-up" style="color:var(--gd);font-weight:700">See Pro</a>');
  $('d-banner').innerHTML = ban;
  const bp = $('b-pick'); if (bp) bp.addEventListener('click', (e) => { e.preventDefault(); showPick(false); });
  const bu = $('b-up'); if (bu) bu.addEventListener('click', (e) => { e.preventDefault(); showPlan(false); });

  let html = '';
  if (tab === 'today') {
    html += '<div class="card sumcard"><div class="big"><b>' + s.messages + '</b> messages &rarr; <b>' + s.updates + '</b> important updates</div>' +
      '<div class="small mut">Across ' + s.groups + ' groups &middot; ' + s.groupsQuiet + ' groups had nothing important</div>' +
      '<div class="tiles"><div class="tile c1"><b>' + s.events + '</b><span>Events</span></div><div class="tile c2"><b>' + s.decisions + '</b><span>Decisions</span></div>' +
      '<div class="tile c3"><b>' + s.needReply + '</b><span>Need reply</span></div><div class="tile c4"><b>' + s.deadlines + '</b><span>Deadline</span></div></div>' +
      (D.mostActive && D.mostActive.length ? '<div class="chips"><span class="chip" style="background:var(--g50);color:var(--gd)">Most active</span>' +
        D.mostActive.map(m => '<span class="chip">' + esc(m.name) + ' · ' + m.count + '</span>').join('') + '</div>' : '') + '</div>';
    // Action plan: what to do, by when, across the selected groups. Always
    // visible - when it is empty, say WHY in plain words (v0.5.6).
    html += '<div class="sec"><span class="grow">Your action plan</span></div>';
    if (D.actionPlan && D.actionPlan.length) {
      html += '<div class="card aplan"><ul style="margin:0 0 0 16px;padding:0">' +
        D.actionPlan.map(a => '<li>' + esc(a.text) + ' <span class="mut small">(' + esc(a.group) + ')</span></li>').join('') + '</ul></div>';
    } else if (D.selectedCount) {
      const ls = D.lastScan || {};
      let why;
      if (D.localOnly) why = 'Local-only mode is on - nothing is analysed, so no plan can be built. Turn it off in Settings > Privacy.';
      else if (!D.hasKey) why = 'Add your Gemini key in Settings - without it GroupPing cannot read what matters.';
      else if (ls.scanning) why = 'A scan is running now - the plan fills in when it finishes.';
      else if (ls.readOk === false) why = 'The last scan could not read WhatsApp' + (ls.note ? ': ' + ls.note : '.') + ' Try Scan now.';
      else if (!ls.at) why = 'The first scan has not run yet - it starts by itself about 30 seconds after install.';
      else if (ls.deep !== false && (ls.opened || 0) === 0) why = 'The last scan found no new messages in your selected groups, so there is nothing to plan yet.';
      else why = 'Your groups were read - nothing needs action yet. New plans, deadlines and unanswered questions land here.';
      html += '<div class="card mut" style="text-align:center"><div class="small">' + esc(why) + '</div></div>';
    }
    html += '<div class="sec"><span class="grow">Today\'s updates, group by group</span></div>';
    // every important item, listed under its own group with the group's digest
    const byGroup = {};
    D.today.forEach(e => { (byGroup[e.group] = byGroup[e.group] || []).push(e); });
    const gnames = Object.keys(byGroup).sort((a, b) => {
      const ta = Math.min.apply(null, byGroup[a].map(e => e.whenTs || e.foundAt));
      const tb = Math.min.apply(null, byGroup[b].map(e => e.whenTs || e.foundAt));
      return ta - tb;
    });
    if (!gnames.length) html += emptyHtml('Nothing important today yet.', 'GroupPing checks every ' + (D.scanMinutes === 180 ? '3 hours' : 'hour') + ' while Chrome and WhatsApp Web are open.');
    gnames.forEach((g) => {
      const dg = gFailed(g) ? null : (D.digests || {})[g];
      html += '<div class="grpblock"><div class="grphead">' + avatar(g) + '<div class="grow"><b>' + esc(g) + '</b>' +
        (dg ? '<div class="digest">' +
          (dg.discussed ? '<div><b>Discussed</b>' + esc(dg.discussed) + '</div>' : '') +
          (dg.plan ? '<div><b>Plan</b>' + esc(dg.plan) + '</div>' : '') +
          (dg.decision ? '<div><b>Decision</b>' + esc(dg.decision) + '</div>' : '') + '</div>' : '') +
        '</div></div>' + byGroup[g].map(cardHtml).join('') + '</div>';
    });
    // v0.5.6: selected groups with a fresh summary but nothing plan-like
    // still get their block - she asked for a summary of EVERY selected
    // group, not only the ones with action items.
    const quiet = (D.selectedNames || []).filter(g => !byGroup[g] && !gFailed(g) && (D.digests || {})[g]).sort();
    quiet.forEach((g) => {
      const dg = D.digests[g];
      html += '<div class="grpblock"><div class="grphead">' + avatar(g) + '<div class="grow"><b>' + esc(g) + '</b>' +
        '<div class="digest">' +
        (dg.discussed ? '<div><b>Discussed</b>' + esc(dg.discussed) + '</div>' : '') +
        (dg.plan ? '<div><b>Plan</b>' + esc(dg.plan) + '</div>' : '') +
        (dg.decision ? '<div><b>Decision</b>' + esc(dg.decision) + '</div>' : '') + '</div>' +
        '<div class="small mut">Nothing here needs action.</div>' +
        '</div></div></div>';
    });
    // v0.5.8: a group that could not be read NEVER shows a summary - only an honest "could not read"
    Object.keys(gStat()).filter(g => gFailed(g) && (D.selectedNames || []).indexOf(g) !== -1).sort().forEach((g) => {
      html += '<div class="grpblock"><div class="grphead">' + avatar(g) + '<div class="grow"><b>' + esc(g) + '</b>' +
        '<div class="small" style="color:#b32222;font-weight:600">Could not read this group in the last scan (' + esc(gStat()[g].why || 'unknown') + '). No summary is shown so nothing wrong is reported.</div>' +
        '</div></div></div>';
    });
    html += scanReportHtml();
    if (D.summary) {
      const sm = D.summary, names = Object.keys(sm.groups || {});
      html += '<div class="sec"><span class="grow">Evening summary</span><span class="small mut">' + esc(sm.day) + '</span></div><div class="card"><div style="margin-bottom:6px">' + esc(sm.overall || '') + '</div>' +
        (sm.actionplan && sm.actionplan.length ? '<div style="margin-bottom:8px"><b>Action plan</b><ul style="margin:4px 0 0 16px;padding:0">' + sm.actionplan.map(a => '<li>' + esc(a) + '</li>').join('') + '</ul></div>' : '') +
        names.map(n => '<details class="sm"><summary>' + esc(n) + ' <span class="mut">(' + ((sm.counts || {})[n] || '?') + ' msgs)</span></summary><ul style="margin:4px 0 8px 16px;padding:0">' +
          (Array.isArray(sm.groups[n]) ? sm.groups[n] : [sm.groups[n]]).map(b => '<li>' + esc(b) + '</li>').join('') + '</ul></details>').join('') + '</div>';
    }
  } else if (tab === 'upcoming') {
    html += D.upcoming.length ? D.upcoming.map(cardHtml).join('') : emptyHtml('Nothing coming up.', 'Plans with a future date show here.');
  } else if (tab === 'pending') {
    if (D.plan.tier === 'free') html += bannerHtml('warn', 'Reply reminders are part of Pro. <a href="#" id="b-up2" style="color:var(--gd);font-weight:700">See Pro</a>');
    html += '<div class="sec"><span class="grow">Needs your reply <span class="pill Medium">' + D.pending.length + '</span></span></div>';
    html += D.pending.length ? D.pending.map(pendHtml).join('') : emptyHtml('Nobody is waiting on you.', 'Chats are flagged after ' + 3 + ' days without a reply.');
  } else {
    html += D.muted.length ? D.muted.map(m => '<div class="card row">' + avatar(m.name) + '<div class="grow"><b>' + esc(m.name) + '</b><div class="small mut">' + muteText(m.state) + '</div></div><button class="btn sm" data-unmute="' + esc(m.name) + '">Unmute</button></div>').join('') :
      emptyHtml('No muted groups.', 'Mute a group from the ... menu on any update.');
  }
  $('d-body').innerHTML = html;
  const b2 = $('b-up2'); if (b2) b2.addEventListener('click', (e) => { e.preventDefault(); showPlan(false); });

  $('d-foot').textContent = D.plan.label + ' \u00b7 ' + (D.selectedCount || 0) + ' groups \u00b7 scans every ' + (D.scanMinutes === 180 ? '3 hours' : 'hour');
}
function muteText(st) { return st.mode === 'mentions' ? 'Muted, mentions still allowed' : st.until ? 'Muted until ' + new Date(st.until).toLocaleDateString() : 'Muted until you unmute'; }
function emptyHtml(a, b) { return '<div class="card mut" style="text-align:center"><b style="color:var(--ink)">' + esc(a) + '</b><div class="small">' + esc(b) + '</div></div>'; }

function cardHtml(e) {
  const [label, ic] = KIND[e.kind] || KIND.event;
  const when = fmtWhen(e);
  const locked = !D.plan.calendar;
  return '<div class="card upd" data-id="' + esc(e.id) + '"><button class="iconbtn x" data-act="resolve" title="Resolved" data-ic="x">' + IC.x + '</button>' +
    '<div class="row" style="align-items:flex-start"><div class="ic ' + e.kind + '">' + IC[ic] + '</div><div class="grow" style="padding-right:22px"><div class="t">' + esc(e.title) + '</div>' +
    '<div class="g">' + esc(e.group) + (when ? ' &middot; ' + esc(when) : '') + ' <span class="pill ' + e.kind + '">' + label + '</span></div></div></div>' +
    (e.summary ? '<div class="desc">' + esc(e.summary) + '</div>' : '') +
    '<div class="actions"><button class="btn sm" data-act="detail">View details</button>' +
    (e.kind === 'reply' ? '<button class="btn sm pri" data-act="reply">Reply</button>' :
      '<button class="btn sm" data-act="cal">' + (locked ? 'Add to calendar <span class="lock">PRO</span>' : 'Add to calendar') + '</button>') +
    '<span class="grow"></span><button class="iconbtn" data-act="menu">' + IC.dots + '</button></div></div>';
}
function pendHtml(p) {
  const age = p.source === 'chat' ? (p.days + ' day' + (p.days === 1 ? '' : 's') + ' ago') : gpAgeText(p.at);
  const id = p.source === 'ai' ? esc(p.id) : '';
  return '<div class="card upd" data-src="' + p.source + '" data-id="' + id + '" data-name="' + esc(p.name) + '">' +
    '<span class="pill ' + p.priority + '" style="position:absolute;right:10px;top:10px">' + p.priority + '</span>' +
    '<div class="row" style="align-items:flex-start">' + avatar(p.from || p.name) + '<div class="grow"><b>' + esc(p.from || p.name) + '</b>' +
    '<div class="g">' + esc(p.name) + ' &middot; ' + esc(age) + '</div></div></div>' +
    (p.preview ? '<div class="desc">' + esc(p.preview) + '</div>' : '') +
    '<div class="actions"><button class="btn sm pri" data-act="reply">Reply</button>' +
    '<select class="btn sm" data-act="later" style="width:auto;padding:5px 6px"><option value="">Remind later</option><option value="1">In 1 hour</option><option value="3">In 3 hours</option><option value="tomorrow">Tomorrow 9 AM</option></select>' +
    '<button class="btn sm" data-act="done">Resolved</button></div></div>';
}

/* one click handler for all dashboard cards */
$('d-body').addEventListener('click', async (ev) => {
  const un = ev.target.closest('[data-unmute]');
  if (un) { await send({ type: 'gp-mute', name: un.dataset.unmute, mode: 'unmute' }); D = await send({ type: 'gp-dashboard' }); renderDash(); return; }
  const btn = ev.target.closest('[data-act]');
  if (!btn || btn.tagName === 'SELECT') return;
  closeMenus();
  const card = btn.closest('.card');
  const id = card.dataset.id, act = btn.dataset.act;
  const item = D.today.concat(D.upcoming).find(e => e.id === id);
  if (card.dataset.src) return pendAct(card, act);
  if (act === 'resolve') { await send({ type: 'gp-item', id, action: 'resolve' }); refresh(); }
  else if (act === 'detail') showDetail(item);
  else if (act === 'cal') { if (!D.plan.calendar) showPlan(false); else showCal(item); }
  else if (act === 'reply') openWA(item.group);
  else if (act === 'menu') openMenu(btn, item);
});
$('d-body').addEventListener('change', async (ev) => {
  const sel = ev.target.closest('select[data-act="later"]');
  if (!sel || !sel.value) return;
  const card = sel.closest('.card');
  if (card.dataset.src === 'ai') await send({ type: 'gp-item', id: card.dataset.id, action: 'snooze', arg: sel.value });
  else await send({ type: 'gp-unr-snooze', name: card.dataset.name, hours: sel.value === 'tomorrow' ? 18 : Number(sel.value) });
  say('d-msg', 'Okay, will remind you later.', 'ok'); refresh();
});
async function pendAct(card, act) {
  if (act === 'reply') return openWA(card.dataset.name);
  if (act === 'done') {
    if (card.dataset.src === 'ai') await send({ type: 'gp-item', id: card.dataset.id, action: 'resolve' });
    else await send({ type: 'gp-unr-dismiss', name: card.dataset.name });
    refresh();
  }
}
async function refresh() { D = await send({ type: 'gp-dashboard' }); renderDash(); }
async function openWA(name) {
  say('d-msg', 'Opening "' + name + '" in WhatsApp Web...');
  const r = await send({ type: 'gp-open-chat', name });
  say('d-msg', r && r.ok ? '' : (r && r.error) || 'Could not open the chat.', r && r.ok ? '' : 'bad');
}
function closeMenus() { document.querySelectorAll('.menu').forEach(m => m.remove()); }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu') && !e.target.closest('[data-act="menu"]')) closeMenus(); });
function openMenu(btn, item) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'menu';
  m.innerHTML = '<button data-m="later1">Remind me in 1 hour</button><button data-m="tomorrow">Remind me tomorrow</button><button data-m="mute">Mute this group...</button><button data-m="resolve">Mark resolved</button>';
  btn.closest('.card').appendChild(m);
  m.style.top = (btn.offsetTop + 28) + 'px';
  m.addEventListener('click', async (ev) => {
    const k = ev.target.dataset.m; if (!k) return;
    closeMenus();
    if (k === 'mute') return showMute(item.group);
    if (k === 'resolve') await send({ type: 'gp-item', id: item.id, action: 'resolve' });
    if (k === 'later1') await send({ type: 'gp-item', id: item.id, action: 'snooze', arg: 1 });
    if (k === 'tomorrow') await send({ type: 'gp-item', id: item.id, action: 'snooze', arg: 'tomorrow' });
    refresh();
  });
}

/* ---------- 4. detail ---------- */
function showDetail(e) {
  const [label, ic] = KIND[e.kind] || KIND.event;
  const att = [e.going != null ? e.going + ' going' : '', e.maybe != null ? e.maybe + ' maybe' : '', e.unsure != null ? e.unsure + ' not sure' : ''].filter(Boolean).join(', ');
  const rows = [
    ['clock', 'When', fmtWhen(e) || 'Not stated'],
    ['pin', 'Where', e.location || 'Not stated'],
    ['people', 'Who', att || 'Not stated'],
    ['user', 'Your status', e.userReplied ? 'You replied / confirmed' : "Haven't replied yet"]
  ];
  $('v-detail').innerHTML =
    '<div class="row" style="align-items:flex-start;margin-bottom:10px"><div class="upd"><div class="ic ' + e.kind + '" style="width:40px;height:40px">' + IC[ic] + '</div></div>' +
    '<div class="grow"><div style="font-weight:700;font-size:16px">' + esc(e.title) + '</div><div class="mut">' + esc(e.group) + ' <span class="pill ' + e.kind + '">' + label + '</span></div>' +
    '<div class="small mut">' + esc(new Date(e.foundAt).toLocaleDateString() === new Date().toLocaleDateString() ? 'Today' : new Date(e.foundAt).toLocaleDateString()) + ', ' + clock(e.foundAt) + (e.keyMessages && e.keyMessages.length ? ' &middot; ' + e.keyMessages.length + ' key messages' : '') + '</div></div>' +
    '<button class="iconbtn" id="dt-x">' + IC.x + '</button></div>' +
    '<div class="card"><b>Summary</b><div style="margin-top:4px">' + esc(e.summary || 'No summary.') + '</div></div>' +
    '<div class="card">' + rows.map(r => '<div class="kv">' + IC[r[0]] + '<b>' + r[1] + '</b><span>' + esc(r[2]) + '</span></div>').join('') + '</div>' +
    '<div class="card"><div class="row"><b class="grow">Key messages</b><a href="#" id="dt-all" class="small" style="color:var(--gd)">View all in WhatsApp</a></div>' +
    ((e.keyMessages && e.keyMessages.length) ? e.keyMessages.map(k => '<div class="km">' + avatar(k.sender) + '<div class="b"><b>' + esc(k.sender) + '</b><div>' + esc(k.text) + '</div></div></div>').join('') : '<div class="mut small" style="margin-top:4px">No key messages captured.</div>') + '</div>' +
    '<div class="actions">' + (e.kind === 'reply' ? '' : '<button class="btn pri grow" id="dt-cal">' + (D.plan.calendar ? 'Add to calendar' : 'Add to calendar (Pro)') + '</button>') +
    '<button class="btn line grow" id="dt-wa">Open in WhatsApp</button></div>';
  show('detail');
  $('dt-x').addEventListener('click', renderDash);
  $('dt-all').addEventListener('click', (ev) => { ev.preventDefault(); openWA(e.group); });
  $('dt-wa').addEventListener('click', () => openWA(e.group));
  const c = $('dt-cal'); if (c) c.addEventListener('click', () => D.plan.calendar ? showCal(e) : showPlan(false));
}

/* ---------- 6. calendar ---------- */
function showCal(e) {
  const t = e.time || '09:00';
  const [h, m] = t.split(':').map(Number);
  const end = String((h + 1) % 24).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  const det = 'GroupPing detected this from ' + e.group + '. ' + (e.summary || '');
  $('v-cal').innerHTML =
    '<div class="row" style="margin-bottom:6px"><b class="grow" style="font-size:15px">Add to Calendar</b><button class="iconbtn" id="cl-x">' + IC.x + '</button></div>' +
    '<label class="f">Title</label><input type="text" id="cl-title" value="' + esc(e.title) + '">' +
    '<div class="row"><div class="grow"><label class="f">Date</label><input type="date" id="cl-date" value="' + esc(e.date || gpDayKey()) + '"></div>' +
    '<div class="grow"><label class="f">Start</label><input type="time" id="cl-start" value="' + esc(t.length === 4 ? '0' + t : t) + '"></div>' +
    '<div class="grow"><label class="f">End</label><input type="time" id="cl-end" value="' + end + '"></div></div>' +
    '<label class="f">Location</label><input type="text" id="cl-loc" value="' + esc(e.location || '') + '">' +
    '<label class="f">Description</label><textarea id="cl-desc">' + esc(det) + '</textarea>' +
    '<label class="row small" style="margin:10px 0 4px"><input type="checkbox" id="cl-rem" checked> <span>Remind me with a GroupPing notification</span></label>' +
    '<select id="cl-lead"><option value="15">15 minutes before</option><option value="30">30 minutes before</option><option value="60" selected>1 hour before</option><option value="120">2 hours before</option><option value="1440">1 day before</option></select>' +
    '<label class="f">Calendar</label><select id="cl-cal"><option>Google Calendar</option></select>' +
    '<div class="small mut" style="margin-top:6px">This opens Google Calendar with the event filled in. Press Save there. Google\'s links cannot set a calendar reminder, so the reminder above comes from GroupPing.</div>' +
    '<div class="row" style="margin-top:10px"><button class="btn grow" id="cl-cancel">Cancel</button><button class="btn pri grow" id="cl-add">Add Event</button></div>';
  show('cal');
  $('cl-x').addEventListener('click', renderDash); $('cl-cancel').addEventListener('click', renderDash);
  $('cl-add').addEventListener('click', async () => {
    const url = gpCalendarUrl({ title: $('cl-title').value, date: $('cl-date').value, time: $('cl-start').value, endTime: $('cl-end').value, location: $('cl-loc').value, details: $('cl-desc').value });
    chrome.tabs.create({ url });
    if ($('cl-rem').checked) await send({ type: 'gp-item', id: e.id, action: 'remind', arg: $('cl-lead').value });
    renderDash(); say('d-msg', 'Opened Google Calendar. Press Save there.', 'ok');
  });
}

/* ---------- 7. mute ---------- */
function showMute(name) {
  $('v-mute').innerHTML =
    '<div class="row" style="margin-bottom:6px"><b class="grow" style="font-size:15px">Mute Group Updates</b><button class="iconbtn" id="mu-x">' + IC.x + '</button></div>' +
    '<div class="card row">' + avatar(name) + '<div><b>' + esc(name) + '</b><div class="small mut">You won\'t get updates from this group while muted.</div></div></div>' +
    '<div class="card"><label class="radio"><input type="radio" name="mm" value="forever" checked><div><b>Mute forever</b><div class="small mut">Never show updates from this group again.</div></div></label>' +
    '<label class="radio"><input type="radio" name="mm" value="30d"><div><b>Mute for 30 days</b><div class="small mut">Temporarily pause updates.</div></div></label>' +
    '<label class="radio"><input type="radio" name="mm" value="mentions"><div><b>Mute until I unmute</b><div class="small mut">Pause updates but allow important mentions (when someone directly asks you something).</div></div></label></div>' +
    '<div class="banner warn small">You can unmute this group anytime from the Muted tab or Settings.</div>' +
    '<div class="row"><button class="btn grow" id="mu-c">Cancel</button><button class="btn pri grow" id="mu-ok">Mute Group</button></div>';
  show('mute');
  $('mu-x').addEventListener('click', renderDash); $('mu-c').addEventListener('click', renderDash);
  $('mu-ok').addEventListener('click', async () => {
    const mode = document.querySelector('input[name=mm]:checked').value;
    await send({ type: 'gp-mute', name, mode }); await refresh(); say('d-msg', 'Muted "' + name + '".', 'ok');
  });
}

/* ---------- plan / upgrade ---------- */
async function showPlan(auto) {
  const free = D.plan.tier === 'free', pro = D.plan.tier === 'pro';
  $('v-plan').innerHTML =
    '<div class="row" style="margin-bottom:8px"><b class="grow" style="font-size:16px">' + (free && auto ? 'Your free trial ended' : 'Free vs Pro') + '</b><button class="iconbtn" id="pl-x">' + IC.x + '</button></div>' +
    '<div class="small mut" style="margin-bottom:10px">' + (pro ? 'You are on Pro.' : free ? 'GroupPing keeps working on the Free plan with limits.' : D.plan.label + '. Everything is unlocked during the trial.') + '</div>' +
    '<div class="plans"><div class="plan"><h3>Free</h3><ul><li>' + GP_FREE_MAX_GROUPS + ' groups watched</li><li>Hourly scans &amp; alerts</li><li>Evening summary</li><li class="no">Add to calendar</li><li class="no">Reply reminders</li></ul></div>' +
    '<div class="plan pro"><h3>Pro</h3><ul><li>All your groups</li><li>Hourly scans &amp; alerts</li><li>Evening summary</li><li>Add to calendar</li><li>Reply reminders</li></ul></div></div>' +
    (pro ? '' : '<button class="btn pri big" id="pl-up" style="margin-top:12px">Upgrade to Pro</button><div class="msg" id="pl-msg"></div>' +
      '<label class="f">Already have a license key?</label><div class="row"><input type="text" id="pl-key" placeholder="GP-XXXX-XXXX-XXXX-XXX"><button class="btn" id="pl-act">Activate</button></div>') +
    '<button class="btn line big" id="pl-back" style="margin-top:10px">' + (free ? 'Continue on Free' : 'Back') + '</button>';
  show('plan');
  $('pl-x').addEventListener('click', renderDash); $('pl-back').addEventListener('click', renderDash);
  const up = $('pl-up');
  if (up) up.addEventListener('click', () => {
    if (D.upgradeUrl) chrome.tabs.create({ url: D.upgradeUrl });
    else say('pl-msg', 'Checkout is not connected yet. If you have a license key, paste it below. (The checkout link is set in Settings > General.)', 'bad');
  });
  const act = $('pl-act');
  if (act) act.addEventListener('click', async () => {
    const k = $('pl-key').value.trim();
    if (!GP_LICENSE.isValid(k)) { say('pl-msg', 'That key is not valid.', 'bad'); return; }
    await saveSettings({ licenseKey: k }); await refresh(); say('d-msg', 'Pro unlocked.', 'ok');
  });
}

init();
