'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICONS = {
  chat: '<path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4V5a2 2 0 0 1 2-2z"/>',
  people: '<path d="M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.9 2 2 2 3.4V19h6v-2.5C23 14.2 18.3 13 16 13z"/>',
  cal: '<path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zm-2 8h14v10H5z"/>',
  bell: '<path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1z"/>',
  gear: '<path d="M19.4 13a7.800 7.800 0 0 0 0-2l2.100-1.600-2-3.500-2.500 1a7.600 7.600 0 0 0-1.700-1L15 3h-4l-.4 2.900a7.600 7.600 0 0 0-1.700 1l-2.500-1-2 3.500L6.600 11a7.800 7.800 0 0 0 0 2l-2.100 1.600 2 3.500 2.500-1c.5.400 1.100.7 1.700 1L11 21h4l.4-2.900c.6-.3 1.200-.6 1.700-1l2.500 1 2-3.500zM13 15.500a3.500 3.500 0 1 1 0-7 3.500 3.500 0 0 1 0 7z"/>',
  lock: '<path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3z"/>'
};
document.querySelectorAll('[data-ic]').forEach(e => { e.innerHTML = '<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">' + ICONS[e.dataset.ic] + '</svg>'; });
$('lg').innerHTML = '<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#fff">' + ICONS.chat + '</svg>';
function send(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, x => r(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : x))); }
function say(id, t, bad) { $(id).textContent = t; $(id).style.color = bad ? '#b32222' : '#127c43'; }

function goTo(sect) {
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('on', n.dataset.s === sect));
  document.querySelectorAll('.sect').forEach(s => s.classList.toggle('on', s.id === 's-' + sect));
  if (sect === 'groups') loadGroups();
  if (sect === 'dashboard') loadDash();
  if (sect === 'general') loadLog();
}
document.querySelectorAll('.nav').forEach(b => b.addEventListener('click', () => goTo(b.dataset.s)));
if (location.hash) { const h = location.hash.slice(1); if (document.getElementById('s-' + h)) goTo(h); }

let S = {}, INSTALL = 0;
function load() {
  chrome.storage.local.get([GP.STORE.SETTINGS, GP.STORE.INSTALL], (d) => {
    S = Object.assign({ model: GP.DEFAULT_MODEL, summaryTime: GP.DEFAULT_SUMMARY_TIME, unrepliedDays: GP.DEFAULT_UNREPLIED_DAYS,
      unrepliedNudgeHours: GP.DEFAULT_NUDGE_HOURS, unrepliedAlerts: true, scanMinutes: 60, deepRead: true, remindMinutes: 60,
      eventAlerts: true, eveningSummary: true, windowDays: GP.DEFAULT_WINDOW_DAYS }, d[GP.STORE.SETTINGS] || {});
    INSTALL = d[GP.STORE.INSTALL] || Date.now();
    $('key').value = S.geminiKey || ''; $('model').value = S.model; $('scanmin').value = String(S.scanMinutes === 180 ? 180 : 60);
    $('deep').checked = S.deepRead !== false; $('lic').value = S.licenseKey || ''; $('upurl').value = S.upgradeUrl || '';
    $('windowdays').value = String(S.windowDays || GP.DEFAULT_WINDOW_DAYS);
    $('c-lead').value = String(S.remindMinutes || 60);
    $('n-ev').checked = S.eventAlerts !== false; $('n-sum').checked = S.eveningSummary !== false; $('n-time').value = S.summaryTime;
    $('n-un').checked = S.unrepliedAlerts !== false; $('n-days').value = S.unrepliedDays; $('n-nudge').value = S.unrepliedNudgeHours;
    $('n-imp').value = S.importantNames || ''; $('n-mute').value = S.unrepliedMuteNames || '';
    showLic();
    loadDash();
  });
}
function showLic() {
  const p = gpPlan({ licenseKey: $('lic').value.trim() || S.licenseKey }, INSTALL);
  $('licstatus').textContent = 'Plan: ' + p.label;
  $('licstatus').style.color = p.tier === 'free' ? '#b32222' : '#127c43';
}
$('lic').addEventListener('input', showLic);
function save(patch, msgId, after) {
  chrome.storage.local.get(GP.STORE.SETTINGS, (d) => {
    S = Object.assign(d[GP.STORE.SETTINGS] || {}, patch);
    chrome.storage.local.set({ [GP.STORE.SETTINGS]: S }, () => { send({ type: 'gp-reschedule' }); say(msgId, 'Saved.'); if (after) after(); });
  });
}
$('save').addEventListener('click', () => save({
  geminiKey: $('key').value.trim(), model: $('model').value.trim() || GP.DEFAULT_MODEL, scanMinutes: Number($('scanmin').value) === 180 ? 180 : 60,
  deepRead: $('deep').checked, licenseKey: $('lic').value.trim(), upgradeUrl: $('upurl').value.trim(),
  windowDays: [7, 14, 30, 60, 90].includes(Number($('windowdays').value)) ? Number($('windowdays').value) : GP.DEFAULT_WINDOW_DAYS
}, 'msg', showLic));
$('c-save').addEventListener('click', () => save({ remindMinutes: Number($('c-lead').value) || 60 }, 'c-msg'));
$('n-save').addEventListener('click', () => save({
  eventAlerts: $('n-ev').checked, eveningSummary: $('n-sum').checked, summaryTime: $('n-time').value.trim() || GP.DEFAULT_SUMMARY_TIME,
  unrepliedAlerts: $('n-un').checked, unrepliedDays: Math.min(30, Math.max(1, parseInt($('n-days').value, 10) || 3)),
  unrepliedNudgeHours: Math.min(24, Math.max(1, parseInt($('n-nudge').value, 10) || 6)),
  importantNames: $('n-imp').value.trim(), unrepliedMuteNames: $('n-mute').value.trim()
}, 'n-msg'));
$('test').addEventListener('click', async () => {
  const key = $('key').value.trim(); if (!key) return say('msg', 'Paste your API key first.', true);
  say('msg', 'Testing...');
  const r = await send({ type: 'gp-test-key', key, model: $('model').value.trim() || GP.DEFAULT_MODEL });
  if (r && r.ok) say('msg', 'Key works! Gemini replied: ' + r.answer);
  else say('msg', 'Key failed: ' + ((r && r.error) || 'no answer') + (/404/.test((r && r.error) || '') ? ' - change the model name and test again.' : ''), true);
});

async function loadDash() {
  const D = await send({ type: 'gp-dashboard' });
  if (!D || !D.ok) { $('o-sum').textContent = 'Could not load: ' + ((D && D.error) || 'no answer'); return; }
  const s = D.stats;
  $('o-sum').innerHTML = '<div style="font-size:15px"><b>' + s.messages + '</b> messages today &rarr; <b>' + s.updates + '</b> important updates</div><div class="small mut">' + s.groups + ' groups watched &middot; ' + s.events + ' events, ' + s.decisions + ' decisions, ' + s.deadlines + ' deadlines, ' + s.needReply + ' waiting on you</div>';
  $('o-plan').innerHTML = '<b>' + esc(D.plan.label) + '</b><div class="small mut">' + (D.plan.tier === 'free' ? 'Free watches ' + GP_FREE_MAX_GROUPS + ' groups. Pro unlocks all groups, calendar and reply reminders.' : 'Everything is unlocked.') + '</div>';
}
$('o-scan').addEventListener('click', async () => {
  $('o-scan').disabled = true; $('o-scanmsg').textContent = 'Scanning...';
  const r = await send({ type: 'gp-scan-now' });
  $('o-scan').disabled = false;
  $('o-scanmsg').textContent = !r || r.ok === false ? 'Problem: ' + ((r && (r.error || r.note)) || 'unknown') : (r.note || ('Done. ' + (r.found || 0) + ' new item(s).'));
  loadDash();
});

let GROUPS = [], MAXG = null, SHOWINACTIVE = false;
async function loadGroups() {
  const r = await send({ type: 'gp-groups' });
  if (!r || !r.ok) { $('g-list').textContent = 'Could not load groups.'; return; }
  GROUPS = r.groups; MAXG = r.maxGroups || null;
  renderGroups();
}
function growHtml(g) {
  return '<div class="grp"><div class="av" style="background:#1f9d55;width:30px;height:30px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px">' + esc(g.name.trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase()) + '</div>' +
  '<div class="grow"><b>' + esc(g.name) + '</b><div class="small mut">' +
  (g.msgCount ? g.msgCount + ' messages in window &middot; ' : '') + g.updatesWeek + ' update' + (g.updatesWeek === 1 ? '' : 's') + ' this week' +
  (g.muted ? ' &middot; ' + (g.mode === 'mentions' ? 'mentions only' : g.until ? 'muted until ' + new Date(g.until).toLocaleDateString() : 'muted') : '') +
  (g.selected && !g.monitored ? ' &middot; over Free plan limit' : '') + '</div></div>' +
  '<label class="sw" title="GroupPing may read this group"><input type="checkbox" data-n="' + esc(g.name) + '"' + (g.selected ? ' checked' : '') + '><i></i></label></div>';
}
function renderGroups() {
  const q = $('g-q').value.toLowerCase(), f = $('g-f').value;
  const match = (g) => (!q || g.name.toLowerCase().includes(q)) && (f === 'all' || (f === 'on') === !!g.selected);
  const active = GROUPS.filter(g => !g.inactive && match(g));
  const inactive = GROUPS.filter(g => g.inactive && match(g));
  $('g-count').textContent = '(' + GROUPS.length + ')';
  const selN = GROUPS.filter(g => g.selected).length;
  $('g-note').textContent = selN + ' switched on' + (MAXG ? ' (Free plan: up to ' + MAXG + ')' : '');
  $('g-list').innerHTML = active.length ? active.map(growHtml).join('')
    : '<div class="mut" style="padding:12px">' + (GROUPS.length ? 'No groups match.' : 'No groups known yet. Open WhatsApp Web and press "Scan my full chat list".') + '</div>';
  $('g-inactivelist').innerHTML = SHOWINACTIVE ? (inactive.length ? inactive.map(growHtml).join('') : '<div class="mut small" style="padding:8px">No older groups.</div>') : '';
  $('g-inactive').textContent = SHOWINACTIVE ? 'Hide groups inactive for 6+ months' : 'Show groups inactive for 6+ months (' + inactive.length + ')';
}
$('g-q').addEventListener('input', renderGroups); $('g-f').addEventListener('change', renderGroups);
$('g-inactive').addEventListener('click', (e) => { e.preventDefault(); SHOWINACTIVE = !SHOWINACTIVE; renderGroups(); });
async function toggleGroup(n, on) {
  const r = await send({ type: 'gp-select-group', name: n, on });
  if (r && r.ok === false) { say('g-msg', r.error || 'Could not save.', true); }
  loadGroups();
}
$('g-list').addEventListener('change', (e) => { const n = e.target.dataset.n; if (n) toggleGroup(n, e.target.checked); });
$('g-inactivelist').addEventListener('change', (e) => { const n = e.target.dataset.n; if (n) toggleGroup(n, e.target.checked); });
$('g-all').addEventListener('click', async (e) => {
  e.preventDefault();
  const patch = {}; GROUPS.forEach(g => { patch[g.name] = true; });
  const r = await send({ type: 'gp-select-groups', patch, replace: false });
  if (r && r.ok === false) say('g-msg', r.error || 'Could not save.', true);
  loadGroups();
});
$('g-none').addEventListener('click', async (e) => {
  e.preventDefault();
  const patch = {}; GROUPS.forEach(g => { patch[g.name] = false; });
  await send({ type: 'gp-select-groups', patch, replace: false });
  loadGroups();
});
$('g-scan').addEventListener('click', async () => {
  $('g-scan').disabled = true; say('g-msg', 'Listing your groups in WhatsApp Web (about a minute)...');
  const r = await send({ type: 'gp-list-groups' });
  $('g-scan').disabled = false;
  say('g-msg', !r || r.ok === false ? 'Problem: ' + ((r && r.error) || 'unknown')
    : 'Done - ' + (r.groups || 0) + ' groups listed' + (r.removed ? ', ' + r.removed + ' non-group chat(s) removed' : '') + '.', !r || r.ok === false);
  loadGroups();
});

function loadLog() { chrome.storage.local.get(GP.STORE.LOG, d => { $('log').value = (d[GP.STORE.LOG] || []).join('\n') || '(log is empty)'; $('log').scrollTop = 1e9; }); }
$('copylog').addEventListener('click', () => { $('log').select(); document.execCommand('copy'); say('msg', 'Log copied.'); });
$('selftest').addEventListener('click', async () => {
  say('msg', 'Running self-test on the WhatsApp tab...');
  const r = await send({ type: 'gp-selftest' });
  say('msg', r && r.ok ? 'Self-test done - see the log below.' : 'Self-test problem: ' + ((r && r.error) || 'no answer'), !(r && r.ok));
  setTimeout(loadLog, 800);
});
$('clearlog').addEventListener('click', () => chrome.storage.local.set({ [GP.STORE.LOG]: [] }, loadLog));
$('sumnow').addEventListener('click', async () => { say('msg', 'Building summary...'); const r = await send({ type: 'gp-summary-now' }); say('msg', r && r.ok ? (r.groups ? 'Summary ready for ' + r.groups + ' group(s). Open the popup.' : 'No messages from today yet.') : 'Problem: ' + ((r && r.error) || 'unknown'), !(r && r.ok)); loadLog(); });
load();

/* ---------- Privacy section ---------- */
chrome.storage.local.get(GP.STORE.SETTINGS, (d) => { $('p-local').checked = !!((d[GP.STORE.SETTINGS] || {}).localOnly); });
$('p-local').addEventListener('change', () => save({ localOnly: $('p-local').checked }, 'p-msg'));
$('p-wipe').addEventListener('click', async () => {
  if (!confirm('Delete EVERYTHING GroupPing has stored - messages, plans, summaries, settings and your license key? This cannot be undone.')) return;
  const r = await send({ type: 'gp-wipe' });
  if (r && r.ok) { say('p-msg', 'All GroupPing data deleted. The extension restarts fresh.'); setTimeout(() => location.reload(), 1200); }
  else say('p-msg', 'Could not delete: ' + ((r && r.error) || 'unknown'), true);
});
