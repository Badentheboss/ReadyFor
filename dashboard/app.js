import { createDashboardProvider } from './provider.js';
import { initStaffAccess, getAccessToken, hasStaffAccess, requireSignIn } from './auth.js';

const config = window.READYFOR_CONFIG ?? { provider: 'core', apiBaseUrl: 'http://localhost:8787' };
const staff = await initStaffAccess();
const clinicalReviewer = ['admin', 'nurse', 'surgeon'].includes(staff.membership.role);
const provider = createDashboardProvider({ ...config, getAccessToken, onUnauthorized: requireSignIn });
const documentUrls = new Set();
function releaseDocumentUrls() {
  for (const url of documentUrls) URL.revokeObjectURL(url);
  documentUrls.clear();
}
async function loadDocumentImages() {
  for (const link of caseEl.querySelectorAll('[data-document-id]')) {
    try {
      const blob = await provider.documentBlob(link.dataset.documentId);
      if (!link.isConnected || !hasStaffAccess()) continue;
      const url = URL.createObjectURL(blob);
      documentUrls.add(url);
      link.href = url;
      const img = link.querySelector('img');
      img.src = url;
      img.hidden = false;
      link.querySelector('span').hidden = true;
    } catch {
      if (link.isConnected) link.querySelector('span').textContent = 'Report unavailable';
    }
  }
}
window.addEventListener('pagehide', releaseDocumentUrls);

const LEVEL = { 'at-risk': 'risk', attention: 'attention', ready: 'ready' };
const LEVEL_LABEL = { risk: 'At risk', attention: 'Needs attention', ready: 'Ready' };
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'risk', label: 'At risk' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'ready', label: 'Ready' },
];
const SYSTEM_LABEL = { finchnode: 'FinchNode', rxclass: 'RxClass', patient_message: 'Patient', document: 'Document', staff: 'Staff', rule: 'Rule' };
const CLEARED = ['satisfied', 'verified', 'waived'];

const state = {
  surgeries: [],
  selectedId: null,
  detail: null,
  filter: 'all',
  tab: 'checklist',
  composer: null, // { id, action } for the requirement note being written
  loaded: false,
};
let detailRequest = 0;

const $ = (selector) => document.querySelector(selector);
const listEl = $('#surgery-list');
const caseEl = $('#case');
const runwayEl = $('#runway');

// ---------- Helpers ----------
function esc(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const levelOf = (surgery) => LEVEL[surgery.readiness] ?? 'attention';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function dayAt(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}
function relativeTime(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function clockTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
}
function kindIcon(kind) {
  return icon(['lab', 'medication', 'logistics', 'instruction', 'health'].includes(kind) ? kind : 'instruction');
}

// ---------- Board ----------
function renderSummary() {
  const counts = { risk: 0, attention: 0, ready: 0 };
  state.surgeries.forEach((s) => counts[levelOf(s)]++);
  const total = state.surgeries.length;
  const summary = $('#board-summary');
  if (!state.loaded) { summary.textContent = 'Loading surgeries…'; return; }
  if (!total) { summary.textContent = 'No surgeries scheduled.'; return; }
  const parts = [];
  if (counts.risk) parts.push(`<b class="risk">${counts.risk} at risk</b>`);
  if (counts.attention) parts.push(`<b>${counts.attention}</b> need${counts.attention === 1 ? 's' : ''} attention`);
  if (counts.ready) parts.push(`<b>${counts.ready}</b> ready`);
  summary.innerHTML = `${plural(total, 'surgery', 'surgeries')} in the next two weeks: ${parts.join(', ')}.`;
}

function renderRunway() {
  const byDay = new Map();
  state.surgeries.forEach((s) => {
    if (typeof s.days !== 'number' || s.days > 13) return;
    const list = byDay.get(s.days) ?? [];
    list.push(s);
    byDay.set(s.days, list);
  });
  runwayEl.innerHTML = Array.from({ length: 14 }, (_, offset) => {
    const date = dayAt(offset);
    const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const markers = (byDay.get(offset) ?? []).map((s) => {
      const level = levelOf(s);
      return `<button class="marker ${level} ${s.id === state.selectedId ? 'selected' : ''}" data-select="${esc(s.id)}" title="${esc(s.name)} · ${LEVEL_LABEL[level]}" aria-label="${esc(s.name)}, ${esc(s.date)}, ${LEVEL_LABEL[level]}">${esc(s.initials)}</button>`;
    }).join('');
    return `<div class="day ${offset === 0 ? 'today' : ''} ${weekend ? 'weekend' : ''}">
      <span class="day-label">${offset === 0 ? 'Today' : esc(weekday)}<b>${date.getDate()}</b></span>
      <div class="day-slot">${markers}</div>
    </div>`;
  }).join('');
}

function renderFilters() {
  const counts = { all: state.surgeries.length, risk: 0, attention: 0, ready: 0 };
  state.surgeries.forEach((s) => counts[levelOf(s)]++);
  $('#filters').innerHTML = FILTERS.map((f) => `<button type="button" role="radio" aria-checked="${state.filter === f.key}" data-filter="${f.key}">${f.label}<span class="count">${counts[f.key]}</span></button>`).join('');
}

function renderList() {
  if (!state.loaded) {
    listEl.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    return;
  }
  const visible = state.surgeries.filter((s) => state.filter === 'all' || levelOf(s) === state.filter);
  if (!visible.length) {
    listEl.innerHTML = `<div class="empty">${state.surgeries.length ? 'No surgeries match this filter.' : 'No surgeries scheduled.'}</div>`;
    return;
  }
  listEl.innerHTML = visible.map((s) => {
    const level = levelOf(s);
    const open = s.blockers.filter((b) => !b.cleared);
    const first = open[0];
    const review = s.pendingVerification ?? open.filter((b) => b.status === 'evidence_received').length;
    const line = first
      ? `<b>${esc(first.title)}</b> · ${esc(first.reason)}`
      : 'Every blocking requirement is cleared.';
    return `<button type="button" class="row ${level} ${s.id === state.selectedId ? 'selected' : ''}" data-select="${esc(s.id)}" aria-pressed="${s.id === state.selectedId}">
      <span class="countdown"><b>${s.days === 0 ? 'Today' : `T−${s.days}`}</b><span>${s.days === 0 ? 'surgery' : plural(s.days, 'day')}</span></span>
      <span class="row-main">
        <span class="row-title"><strong>${esc(s.name)}</strong><small>${s.age ?? '—'} · ${esc(s.procedure)}</small></span>
        <span class="row-blocker">${line}</span>
      </span>
      <span class="row-side">
        <span class="badge ${level}">${LEVEL_LABEL[level]}${open.length ? ` · ${open.length}` : ''}</span>
        ${review ? `<span class="badge review">${review} to review</span>` : `<span class="row-date">${esc(s.date)}</span>`}
      </span>
    </button>`;
  }).join('');
}

function renderBoard() {
  renderSummary();
  renderRunway();
  renderFilters();
  renderList();
}

// ---------- Case panel ----------
function requirementCard(req) {
  const cleared = CLEARED.includes(req.status);
  const review = req.status === 'evidence_received';
  const tags = [
    `<span class="tag">${esc(req.owner)}</span>`,
    req.blocking ? '<span class="tag blocking">Blocking</span>' : '<span class="tag">Advisory</span>',
  ];
  const statusBadge = cleared
    ? `<span class="badge ready">${req.status === 'satisfied' ? 'In record' : req.status === 'waived' ? 'Waived' : 'Verified'}</span>`
    : review ? '<span class="badge review">Needs review</span>' : '<span class="badge neutral">Open</span>';

  const provenance = req.source?.detail
    ? `<p class="provenance"><span class="system">${esc(SYSTEM_LABEL[req.source.system] ?? req.source.system)}</span><span>${esc(req.source.detail)}</span></p>`
    : '';

  const proposal = req.proposal && !cleared
    ? `<div class="template"><header>Staff-approved template · ${esc(req.proposal.drugClass)}</header>${esc(req.proposal.text).replace('{{staff_instruction}}', '<mark>staff instruction</mark>')}</div>`
    : '';

  let evidence = '';
  if (req.evidence) {
    const documentId = req.evidence.documentId;
    const hasImage = Boolean(documentId && provider.documentBlob);
    const checks = req.evidence.checks?.length
      ? `<ul class="checks">${req.evidence.checks.map((c) => `<li class="${c.ok ? 'ok' : 'fail'}">${icon(c.ok ? 'check' : 'alert')}<span>${esc(c.label)} <small>· ${esc(c.detail)}</small></span></li>`).join('')}</ul>`
      : '';
    evidence = `<div class="evidence ${hasImage ? '' : 'no-image'}"><div><p class="evidence-summary">${esc(req.evidence.summary)}</p>${checks}</div>${hasImage ? `<a class="evidence-thumb" data-document-id="${esc(documentId)}" target="_blank" rel="noreferrer"><span>Loading report…</span><img alt="Lab report the patient sent" hidden/></a>` : ''}</div>`;
  }

  const canReview = clinicalReviewer || !['lab', 'medication', 'health'].includes(req.kind);
  const composer = canReview && state.composer?.id === req.id ? noteComposer(req, state.composer.action) : '';
  let actions = '';
  if (canReview && !composer) {
    if (review) {
      actions = `<button class="primary-button" data-act="verify" data-id="${esc(req.id)}">${icon('check')}Verify evidence</button>
        <button class="ghost-button" data-compose="reject_evidence" data-id="${esc(req.id)}">Reject</button>`;
    } else if (req.status === 'open') {
      if (req.proposal) {
        actions += `<button class="primary-button" data-compose="approve_template" data-id="${esc(req.id)}">${icon('send')}Approve &amp; send</button>`;
      }
      actions += `<button class="${req.proposal ? 'ghost-button' : 'primary-button'}" data-act="verify" data-id="${esc(req.id)}">${icon('check')}Mark verified</button>
        <button class="quiet-button" data-compose="waive" data-id="${esc(req.id)}">Waive</button>`;
    } else if (cleared && req.status !== 'satisfied') {
      actions = `<button class="quiet-button" data-act="reopen" data-id="${esc(req.id)}">Reopen</button>`;
    }
  }
  const staffNote = cleared && req.staffNote ? `<p class="provenance"><span class="system">Note</span><span>${esc(req.staffNote)}</span></p>` : '';
  const outreach = outreachStrip(state.detail?.outreach?.find((o) => o.requirementId === req.id));

  return `<article class="req ${cleared ? 'cleared' : ''} ${review ? 'review' : ''}" id="req-${esc(req.id)}">
    <div class="req-head">
      <span class="kind">${cleared ? icon('check') : kindIcon(req.kind)}</span>
      <div><p class="req-title">${esc(req.title)}</p><p class="req-reason">${esc(req.reason)}</p><div class="req-tags">${tags.join('')}</div></div>
      ${statusBadge}
    </div>
    ${provenance}${staffNote}${outreach}${proposal}${evidence}${composer}
    ${actions ? `<div class="req-actions">${actions}</div>` : ''}
  </article>`;
}

// Approved plan → message delivery → patient acknowledgement, shown as three separate steps.
function outreachStrip(o) {
  if (!o) return '';
  const delivery = {
    queued: { cls: 'pending', label: 'Message queued' },
    sent: { cls: 'done', label: 'Message delivered' },
    failed: { cls: 'failed', label: 'Delivery failed' },
  }[o.deliveryStatus];
  const ack = o.acknowledgedAt
    ? { cls: 'done', label: `Patient acknowledged · ${relativeTime(o.acknowledgedAt)}` }
    : { cls: o.deliveryStatus === 'sent' ? 'pending' : 'idle', label: 'Awaiting acknowledgement' };
  return `<div class="outreach" aria-label="Patient outreach">
    <ol>
      <li class="done">${icon('check')}Plan approved</li>
      <li class="${delivery.cls}">${icon(o.deliveryStatus === 'failed' ? 'alert' : o.deliveryStatus === 'sent' ? 'check' : 'send')}${delivery.label}</li>
      <li class="${ack.cls}">${icon(o.acknowledgedAt ? 'check' : 'clock')}${ack.label}</li>
    </ol>
    ${o.deliveryStatus === 'failed' ? `<div class="outreach-failed"><span>${esc(o.deliveryError ?? 'The message could not be delivered.')}</span><button class="ghost-button" data-retry="${esc(o.messageId)}">${icon('refresh')}Retry send</button></div>` : ''}
  </div>`;
}

function noteComposer(req, action) {
  const copy = {
    approve_template: req.proposal?.requiresStaffInstruction
      ? { label: 'Staff instruction to insert', hint: 'Write the exact instruction from the care team. It replaces the highlighted placeholder. Do not paste AI-generated medication advice.', required: true }
      : { label: 'Optional note for the record', hint: 'The template above is sent as written.', required: false },
    waive: { label: 'Why is this requirement being waived?', hint: 'Saved to the activity log with your name.', required: true },
    reject_evidence: { label: 'Why is this evidence being rejected?', hint: 'The requirement reopens and the patient will need to send something new.', required: true },
  }[action];
  const submit = { approve_template: 'Approve & send to patient', waive: 'Waive requirement', reject_evidence: 'Reject evidence' }[action];
  return `<form class="note-composer" data-note-for="${esc(req.id)}" data-action="${action}">
    <label for="note-${esc(req.id)}">${copy.label}</label>
    <textarea id="note-${esc(req.id)}" name="note" rows="3" ${copy.required ? 'required' : ''} maxlength="600"></textarea>
    <p>${copy.hint}</p>
    <div class="row-actions"><button type="button" class="quiet-button" data-cancel-compose>Cancel</button><button type="submit" class="primary-button">${submit}</button></div>
  </form>`;
}

function checklistPanel(d) {
  const reqs = d.requirements ?? [];
  if (!reqs.length) {
    return `<div class="case-empty"><p>This surgery has not been checked yet.</p><p style="margin-top:14px"><button class="primary-button" data-run-check>${icon('refresh')}Run record check</button></p><p style="margin-top:10px;font-size:13px">Reads the health record and drug classes, then lists what is missing.</p></div>`;
  }
  const review = reqs.filter((r) => r.status === 'evidence_received');
  const open = reqs.filter((r) => r.status === 'open').sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const cleared = reqs.filter((r) => CLEARED.includes(r.status));
  const tasks = d.tasks ?? [];
  const openTasks = tasks.filter((t) => t.status !== 'done');

  const group = (title, items) => items.length
    ? `<section class="group"><h3 class="group-title"><span>${title}</span><span>${items.length}</span></h3>${items.map(requirementCard).join('')}</section>`
    : '';
  return `${group('Needs your review', review)}${group('Open', open)}
    ${cleared.length ? `<details class="group" ${!review.length && !open.length ? 'open' : ''}><summary class="group-title"><span>Cleared · ${cleared.length}</span></summary>${cleared.map(requirementCard).join('')}</details>` : ''}
    <section class="group">
      <h3 class="group-title"><span>Follow-ups</span><span>${openTasks.length} open</span></h3>
      ${tasks.length ? tasks.map((t) => `<div class="task ${t.status === 'done' ? 'done' : ''}">
        <button class="task-check" ${t.status === 'done' ? 'disabled aria-label="Done"' : `data-complete="${esc(t.id)}" aria-label="Mark ${esc(t.title)} done"`}>${icon('check')}</button>
        <div><p class="task-title">${esc(t.title)}</p>${t.note ? `<p class="task-detail">${esc(t.note)}</p>` : ''}</div>
        <span class="tag">${esc(t.owner)}</span>
      </div>`).join('') : '<p class="task-detail">No follow-ups yet.</p>'}
      <form class="task-form" id="task-form">
        <input type="text" name="title" required maxlength="120" placeholder="Add a follow-up, e.g. Call about the ride home" aria-label="Follow-up title" />
        <select name="owner" aria-label="Owner"><option value="coordinator">Coordinator</option><option value="nurse">Nurse</option><option value="surgeon">Surgeon</option></select>
        <button class="ghost-button" type="submit">${icon('plus')}Add</button>
      </form>
    </section>
    <p style="margin-top:4px"><button class="quiet-button" data-run-check>${icon('refresh')}Re-run record check</button></p>`;
}

function conversationPanel(d) {
  const messages = d.messages ?? [];
  const thread = messages.length
    ? messages.map((m) => {
      const dir = m.direction === 'in' ? 'in' : 'out';
      const status = dir === 'out'
        ? (m.deliveryStatus === 'queued' ? '<span class="queued">Queued</span>' : m.deliveryStatus === 'failed' ? '<span class="failed">Not delivered</span>' : 'Sent')
        : (m.classification?.intent ? `<span class="intent">${esc(m.classification.intent.replaceAll('_', ' '))}</span>` : 'Received');
      const files = m.attachments?.length ? `<br>${icon('clip')} ${plural(m.attachments.length, 'attachment')}` : '';
      return `<div class="bubble ${dir}">${esc(m.body) || '<em>Attachment</em>'}${files}</div><div class="bubble-meta ${dir}">${esc(m.channel)} · ${clockTime(m.createdAt)} · ${status}</div>`;
    }).join('')
    : '<p class="task-detail">No messages yet. The record check queues the first one.</p>';
  return `<div class="thread">${thread}</div>
    <form class="composer" id="patient-form">
      <textarea name="message" rows="2" maxlength="2000" placeholder="Reply as ${esc(d.name?.split(' ')[0] ?? 'the patient')}… e.g. My daughter is driving me home" aria-label="Simulated patient message"></textarea>
      <div class="composer-bar">
        <label class="attach">${icon('clip')}<span id="attach-label">Attach</span><input type="file" name="attachment" accept="image/jpeg,image/png,image/webp,application/pdf" /></label>
        <button type="button" class="quiet-button" id="send-sample">Send sample lab report</button>
        <span class="spacer"></span>
        <button type="submit" class="primary-button">${icon('send')}Send</button>
      </div>
    </form>
    <p class="composer-hint">Simulated channel: stands in for the patient's iMessage so the demo works without a phone.</p>`;
}

function activityPanel(d) {
  const events = d.events ?? [];
  if (!events.length) return '<p class="task-detail">Nothing has happened yet.</p>';
  return `<ol class="timeline">${events.map((e) => `<li><p>${esc(e.summary)}</p><time datetime="${esc(e.createdAt)}">${relativeTime(e.createdAt)}</time>${e.actor ? ` <span class="actor">· ${esc(e.actor)}</span>` : ''}</li>`).join('')}</ol>`;
}

function renderCase() {
  releaseDocumentUrls();
  document.body.classList.toggle('case-open', Boolean(state.selectedId));
  const d = state.detail;
  if (!d) {
    caseEl.innerHTML = state.selectedId
      ? '<div class="case-empty">Loading…</div>'
      : '<div class="case-empty">Select a surgery to see what stands between the patient and surgery day.</div>';
    return;
  }
  const level = levelOf(d);
  const reqs = d.requirements ?? [];
  const review = reqs.filter((r) => r.status === 'evidence_received').length;
  const openReqs = reqs.filter((r) => r.blocking && r.status === 'open').length;
  const sub = !reqs.length
    ? 'Run the record check to see what is missing.'
    : [openReqs && `${plural(openReqs, 'blocker')} open`, review && `${review} waiting for staff review`].filter(Boolean).join(' · ') || 'Nothing left to clear.';
  const tabs = [
    { key: 'checklist', label: 'Checklist', count: review + openReqs },
    { key: 'conversation', label: 'Conversation', count: d.messages?.length ?? 0 },
    { key: 'activity', label: 'Activity', count: 0 },
  ];
  const body = state.tab === 'conversation' ? conversationPanel(d) : state.tab === 'activity' ? activityPanel(d) : checklistPanel(d);

  caseEl.innerHTML = `<header class="case-head">
      <button class="quiet-button case-back" data-back>${icon('back')}All surgeries</button>
      <div class="case-name"><h2>${esc(d.name)}</h2><span class="badge ${level}">${LEVEL_LABEL[level]}</span></div>
      <p style="color:var(--ink-2);margin-top:2px">${d.age ?? '—'} · ${esc(d.procedure)}</p>
      <div class="case-meta"><span>${icon('calendar')}${esc(d.date)} · ${d.days === 0 ? 'today' : `in ${plural(d.days, 'day')}`}</span><span>${esc(d.location ?? '')}</span><span>${esc(d.surgeon ?? '')}</span></div>
      <div class="readiness-banner ${level}"><p>${esc(d.readinessHeadline ?? d.headline ?? LEVEL_LABEL[level])}<small>${esc(sub)}</small></p></div>
    </header>
    <nav class="tabs" role="tablist" aria-label="Surgery sections">${tabs.map((t) => `<button class="tab" role="tab" aria-selected="${state.tab === t.key}" data-tab="${t.key}">${t.label}${t.count ? `<span class="count">${t.count}</span>` : ''}</button>`).join('')}</nav>
    <div class="tabpanel" role="tabpanel">${body}</div>`;
  void loadDocumentImages();
}

// Polling must not wipe what someone is typing or a note they are writing.
function caseIsBusy() {
  if (state.composer) return true;
  const active = document.activeElement;
  if (active && caseEl.contains(active) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(active.tagName)) return true;
  return [...caseEl.querySelectorAll('textarea, input[type="text"], input[type="file"]')].some((el) => el.value);
}

// ---------- Data ----------
async function loadAll({ force = false } = {}) {
  try {
    const next = await provider.listSurgeries();
    const changed = !state.loaded || JSON.stringify(next) !== JSON.stringify(state.surgeries);
    state.surgeries = next;
    state.loaded = true;
    if (state.selectedId && !next.some((s) => s.id === state.selectedId)) { state.selectedId = null; state.detail = null; }
    if (!state.selectedId && next.length && window.matchMedia('(min-width: 1101px)').matches) state.selectedId = next[0].id;
    if (changed || force) renderBoard();
    setMode(provider.mode === 'mock' ? 'mock' : 'live');
    if (state.selectedId) await loadDetail(state.selectedId, { force });
    else renderCase();
  } catch (error) {
    setMode('offline');
    state.loaded = true;
    renderBoard();
    caseEl.innerHTML = `<div class="case-empty"><p>${esc(error.message)}</p><p style="margin-top:10px">Start the core with <code>bun start</code>; this page reconnects on its own.</p></div>`;
  }
}

async function loadDetail(id, { force = false } = {}) {
  const ticket = ++detailRequest;
  const next = await provider.getSurgery(id);
  // A slower response for a previously selected surgery must not replace the current one.
  if (ticket !== detailRequest || id !== state.selectedId) return;
  const changed = JSON.stringify(next) !== JSON.stringify(state.detail);
  state.detail = next;
  if (force || (changed && !caseIsBusy())) renderCase();
}

async function select(id) {
  if (id === state.selectedId && state.detail) return;
  state.selectedId = id;
  state.detail = null;
  state.composer = null;
  state.tab = 'checklist';
  renderRunway();
  renderList();
  renderCase();
  try { await loadDetail(id, { force: true }); } catch (error) { notify(error.message, true); }
  if (!window.matchMedia('(min-width: 1101px)').matches) window.scrollTo({ top: 0 });
}

function setMode(mode) {
  const el = $('#mode');
  el.className = `mode ${mode}`;
  el.querySelector('span').textContent = mode === 'live' ? 'Core live' : mode === 'mock' ? 'Mock data' : 'Core offline';
}

async function describeMode() {
  try {
    const health = await provider.health?.();
    if (!health) return;
    const bits = [health.database === 'neon' ? 'Neon' : 'in-memory DB', health.records === 'fixtures' ? 'record fixtures' : 'live records', health.llm === 'fake' ? 'keyword model' : health.llm];
    $('#mode').title = `Core: ${bits.join(' · ')}`;
  } catch { /* the poll reports offline */ }
}

// ---------- Actions ----------
let toastTimer;
function notify(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), isError ? 6000 : 3500);
}

async function run(button, work, message) {
  if (button) button.disabled = true;
  try {
    const result = await work();
    state.composer = null;
    await loadAll({ force: true });
    if (message) notify(typeof message === 'function' ? message(result) : message);
  } catch (error) {
    notify(error.message, true);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

const ACTION_DONE = {
  verify: 'Verified and logged.',
  approve_template: 'Plan approved. Delivery to the patient is tracked on the card.',
  waive: 'Requirement waived.',
  reject_evidence: 'Evidence rejected. The requirement is open again.',
  reopen: 'Requirement reopened.',
};

function requirementAction(button, id, action, note) {
  return run(button, () => provider.resolveRequirement(id, action, undefined, note), ACTION_DONE[action]);
}

function confirmDialog(title, body, confirmLabel) {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').textContent = body;
  $('#dialog-confirm').textContent = confirmLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

async function fileToAttachment(file) {
  if (file.size > 6 * 1024 * 1024) throw new Error('Choose a file smaller than 6 MB.');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the attachment.'));
    reader.readAsDataURL(file);
  });
  return { mimeType: file.type || 'application/octet-stream', base64: String(dataUrl).split(',')[1] };
}

function inboundMessage(result) {
  const effects = result?.effects?.map((e) => e.title).filter(Boolean) ?? [];
  if (effects.length) return `Patient message handled. Created: ${effects.join(', ')}.`;
  return result?.classification?.intent ? `Patient message read as “${result.classification.intent.replaceAll('_', ' ')}”.` : 'Patient message received.';
}

// ---------- Events (delegated, so re-renders keep working) ----------
document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target || target.closest('dialog')) return;

  if (target.dataset.select) { select(target.dataset.select); return; }
  if (target.dataset.filter) { state.filter = target.dataset.filter; renderFilters(); renderList(); return; }
  if (target.dataset.tab) { state.tab = target.dataset.tab; state.composer = null; renderCase(); return; }
  if (target.hasAttribute('data-back')) { state.selectedId = null; state.detail = null; renderBoard(); renderCase(); return; }
  if (target.hasAttribute('data-run-check')) {
    run(target, () => provider.refreshSurgery(state.selectedId), 'Record check complete. Each finding shows its source.');
    return;
  }
  if (target.dataset.act) { requirementAction(target, target.dataset.id, target.dataset.act); return; }
  if (target.dataset.compose) {
    state.composer = { id: target.dataset.id, action: target.dataset.compose };
    renderCase();
    caseEl.querySelector(`[data-note-for="${CSS.escape(target.dataset.id)}"] textarea`)?.focus();
    return;
  }
  if (target.hasAttribute('data-cancel-compose')) { state.composer = null; renderCase(); return; }
  if (target.dataset.retry) {
    run(target, () => provider.retryMessage(target.dataset.retry), 'Message queued again for the patient.');
    return;
  }
  if (target.dataset.complete) {
    run(target, () => provider.completeTask(target.dataset.complete), 'Follow-up done. Clear its requirement separately once verified.');
    return;
  }
  if (target.id === 'send-sample') {
    run(target, async () => {
      const response = await fetch('/db/seed/assets/sample-lab-report.png');
      if (!response.ok) throw new Error('Could not load the synthetic sample lab report.');
      const attachment = await fileToAttachment(new File([await response.blob()], 'sample-lab-report.png', { type: 'image/png' }));
      return provider.sendPatientMessage(state.selectedId, 'I did my pre-op blood work at another clinic; here is the report.', attachment);
    }, (result) => `${inboundMessage(result)} Open the Checklist tab to review it.`);
    return;
  }
  if (target.id === 'reset-demo') {
    const ok = await confirmDialog('Reset the demo?', 'This reloads the three synthetic surgeries and erases every change made so far in this demo database.', 'Reset demo');
    if (!ok) return;
    state.selectedId = null;
    state.detail = null;
    run(target, () => provider.resetDemo(), 'Demo reset. Open Harriet and run the record check.');
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (form.closest('dialog')) return;
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');

  if (form.dataset.noteFor) {
    const note = new FormData(form).get('note')?.toString().trim();
    requirementAction(submit, form.dataset.noteFor, form.dataset.action, note || undefined);
    return;
  }
  if (form.id === 'task-form') {
    const data = new FormData(form);
    run(submit, () => provider.createTask(state.selectedId, data.get('title').toString().trim(), data.get('owner'), ''), 'Follow-up added.');
    return;
  }
  if (form.id === 'patient-form') {
    const data = new FormData(form);
    const message = data.get('message')?.toString().trim() ?? '';
    const file = data.get('attachment');
    if (!message && !file?.size) { notify('Write a message or attach a file.', true); return; }
    run(submit, async () => {
      const attachment = file?.size ? await fileToAttachment(file) : undefined;
      return provider.sendPatientMessage(state.selectedId, message, attachment);
    }, inboundMessage);
  }
});

document.addEventListener('change', (event) => {
  if (event.target.name === 'attachment') {
    const label = $('#attach-label');
    if (label) label.textContent = event.target.files?.[0]?.name ?? 'Attach';
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.composer) { state.composer = null; renderCase(); }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.target.closest?.('#patient-form, .note-composer')) {
    event.target.closest('form').requestSubmit();
  }
});

// ---------- Start ----------
$('#today').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
renderBoard();
renderCase();
await loadAll({ force: true });
describeMode();
if (provider.mode === 'core') {
  setInterval(() => { if (!document.hidden && hasStaffAccess()) loadAll(); }, 3000);
}
