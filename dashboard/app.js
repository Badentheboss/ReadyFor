import { createDashboardProvider } from './provider.js';
import { initStaffAccess, getAccessToken } from './auth.js';

const config = window.READYFOR_CONFIG ?? { provider: 'core', apiBaseUrl: 'http://localhost:8787' };
const staff = await initStaffAccess();
const actor = `${staff.membership.role}:${staff.user.name}`;
const provider = createDashboardProvider({ ...config, actor, getAccessToken });
const clinicalReviewer = staff.demo || ['admin', 'nurse', 'surgeon'].includes(staff.membership.role);
const labels = { 'at-risk': 'At risk', attention: 'Needs attention', ready: 'Ready' };
let surgeries = [];
let selectedId = null;
let selectedDetail = null;
let toastTimer;
let documentUrls = [];

const list = document.querySelector('#surgery-list');
const panel = document.querySelector('#detail-panel');
const toast = document.querySelector('#toast');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function statusClass(value) { return value === 'at-risk' ? 'status-risk' : value === 'ready' ? 'status-ready' : 'status-attention'; }
function isResolved(status) { return ['satisfied', 'verified', 'waived', 'cleared'].includes(status); }
function isOpenRequirement(requirement) { return requirement.blocking && ['open', 'evidence_received'].includes(requirement.status); }
function openBlockers(surgery) { return surgery.blockers?.filter((blocker) => !blocker.cleared).length ?? 0; }
function initials(value = '') { return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join(''); }

function renderList() {
  list.innerHTML = surgeries.map((surgery) => {
    const level = surgery.readiness;
    const count = surgery.openCount ?? openBlockers(surgery);
    const firstOpen = surgery.blockers.find((blocker) => !blocker.cleared);
    return `<article class="surgery-card ${surgery.id === selectedId ? 'selected' : ''}" data-id="${escapeHtml(surgery.id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(surgery.name)} surgery details">
      <div class="card-main"><div class="patient-avatar">${escapeHtml(surgery.initials)}</div><div class="patient-info"><strong>${escapeHtml(surgery.name)}</strong><small>${surgery.age ?? '—'} · ${escapeHtml(surgery.procedure)}</small></div><div class="surgery-meta"><strong>${escapeHtml(surgery.date)}</strong><small>in ${surgery.days} days</small></div><span class="chevron">›</span></div>
      <div class="card-bottom"><span class="status-pill ${statusClass(level)}">${labels[level] ?? 'Needs attention'}</span><span class="blocker-preview">${firstOpen ? `<b>${escapeHtml(firstOpen.title)}</b> · ${escapeHtml(firstOpen.reason)}` : 'All blocking requirements cleared'}</span>${count ? `<span class="blocker-count">${count} open</span>` : ''}</div>
    </article>`;
  }).join('');
  list.querySelectorAll('.surgery-card').forEach((card) => {
    card.addEventListener('click', () => selectSurgery(card.dataset.id));
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSurgery(card.dataset.id); } });
  });

  const totals = { ready: 0, attention: 0, risk: 0 };
  surgeries.forEach((surgery) => { const value = surgery.readiness; totals[value === 'at-risk' ? 'risk' : value]++; });
  document.querySelector('#total-count').textContent = surgeries.length;
  document.querySelector('#attention-count').textContent = totals.risk + totals.attention;
  document.querySelector('#ready-count').textContent = totals.ready;
  document.querySelector('#nav-count').textContent = surgeries.length;
}

function requirementMarkup(requirement) {
  const resolved = isResolved(requirement.status);
  const owner = escapeHtml(requirement.owner ?? 'Unassigned');
  const icon = requirement.kind === 'medication' ? 'Rx' : requirement.kind === 'lab' ? '⌁' : requirement.kind === 'logistics' ? '↗' : '◷';
  let actions = '';
  if (requirement.status === 'open') {
    if (requirement.proposal) actions += `<button class="blocker-action" data-action="approve" data-id="${escapeHtml(requirement.id)}">Approve &amp; send template</button>`;
    if (requirement.blocking) actions += `<button class="blocker-action secondary-action" data-action="verify" data-id="${escapeHtml(requirement.id)}">Verify</button>`;
    actions += `<button class="text-action" data-action="waive" data-id="${escapeHtml(requirement.id)}">Waive requirement</button>`;
  } else if (requirement.status === 'evidence_received') {
    actions = `<button class="blocker-action" data-action="verify" data-id="${escapeHtml(requirement.id)}">Verify evidence</button><button class="text-action" data-action="reject" data-id="${escapeHtml(requirement.id)}">Reject evidence</button>`;
  } else if (resolved && requirement.status !== 'satisfied') {
    actions = `<button class="text-action" data-action="reopen" data-id="${escapeHtml(requirement.id)}">Reopen</button>`;
  }
  if (!clinicalReviewer && requirement.kind !== 'logistics') actions = '<small>Clinical staff review required</small>';

  const source = requirement.source?.detail ? `<p class="source-detail"><strong>Source:</strong> ${escapeHtml(requirement.source.detail)}</p>` : '';
  const evidence = requirement.evidence ? `<div class="evidence-box"><strong>${escapeHtml(requirement.evidence.summary)}</strong>${requirement.evidence.checks?.length ? `<ul>${requirement.evidence.checks.map((check) => `<li class="${check.ok ? 'check-ok' : 'check-fail'}">${check.ok ? '✓' : '!'} ${escapeHtml(check.label)} · ${escapeHtml(check.detail)}</li>`).join('')}</ul>` : ''}${requirement.evidence.documentId && provider.documentBlob ? `<img class="lab-preview" alt="Synthetic lab report evidence" data-document-id="${escapeHtml(requirement.evidence.documentId)}" hidden />` : ''}</div>` : '';
  const proposal = requirement.proposal ? `<p class="template-copy"><strong>Staff-approved template · ${escapeHtml(requirement.proposal.drugClass)}</strong><br>${escapeHtml(requirement.proposal.text)}</p>` : '';
  return `<article class="blocker-item ${resolved ? 'cleared' : ''}"><div class="blocker-head"><span class="blocker-symbol">${icon}</span><div class="blocker-copy"><strong>${escapeHtml(requirement.title)}</strong><p>${escapeHtml(requirement.reason)}</p></div><span class="blocker-state ${resolved ? 'state-cleared' : ''}">${escapeHtml(requirement.status.replaceAll('_', ' '))}</span></div><div class="owner-row"><span class="owner-dot">${initials(owner)}</span> Owner: ${owner}${requirement.blocking ? ' · blocking' : ''}</div>${source}${proposal}${evidence}<div class="action-row">${actions}</div></article>`;
}

function renderTasks(detail) {
  const tasks = detail.tasks ?? [];
  return `<section class="task-section" id="tasks"><div class="blocker-title"><h3>Coordinator tasks</h3><span>${tasks.filter((task) => task.status !== 'done').length} open</span></div>${tasks.length ? tasks.map((task) => `<article class="task-card"><div class="task-head">${escapeHtml(task.title)}<span>${escapeHtml(task.status)}</span></div><p>${escapeHtml(task.note)}</p><div class="task-owner">Owner: ${escapeHtml(task.owner)}</div>${task.status === 'open' && task.id ? `<button class="blocker-action" data-task-complete="${escapeHtml(task.id)}">Mark done</button>` : ''}</article>`).join('') : '<div class="empty-state compact">No tasks for this surgery.</div>'}
    <form class="mini-form" id="task-form"><h4>Assign a follow-up</h4><input name="title" required maxlength="120" placeholder="Task, e.g. Call patient about transport" /><textarea name="detail" rows="2" placeholder="Notes for the owner"></textarea><div class="form-row"><select name="owner"><option value="coordinator">Coordinator</option><option value="nurse">Nurse</option><option value="surgeon">Surgeon</option></select><button class="blocker-action" type="submit">Create task</button></div></form></section>`;
}

function renderDetail() {
  documentUrls.forEach((url) => URL.revokeObjectURL(url));
  documentUrls = [];
  const detail = selectedDetail ?? surgeries.find((item) => item.id === selectedId);
  if (!detail) { panel.innerHTML = '<div class="empty-state">Select a surgery to see details.</div>'; return; }
  const open = detail.readiness === undefined ? openBlockers(detail) : (detail.requirements?.filter(isOpenRequirement).length ?? openBlockers(detail));
  const status = detail.readiness;
  panel.innerHTML = `<div class="panel-label">SURGERY DETAILS</div><h2>${escapeHtml(detail.name)}</h2><p class="detail-procedure">${detail.age ?? '—'} · ${escapeHtml(detail.procedure)}</p>
    <div class="detail-date"><span class="calendar-icon">▦</span><div><strong>${escapeHtml(detail.date)} · in ${detail.days} days</strong><small>${escapeHtml(detail.location ?? 'Northstar Surgical Center')} · ${escapeHtml(detail.surgeon ?? '')}</small></div></div>
    <div class="readiness-row"><span>Readiness level</span><span class="status-pill ${statusClass(status)}">${labels[status] ?? 'Needs attention'}</span></div>
    <p class="readiness-copy">${escapeHtml(detail.readinessHeadline ?? detail.headline ?? `${open} blocking requirement${open === 1 ? '' : 's'} need staff attention.`)}</p>
    <button class="blocker-action full-action" id="check-record">Run record check</button>
    <div class="panel-divider"></div><div class="blocker-title"><h3>Requirements &amp; blockers</h3><span>${open} open blockers</span></div>
    ${detail.requirements?.length ? detail.requirements.map(requirementMarkup).join('') : (detail.blockers?.length ? detail.blockers.map((blocker) => requirementMarkup({ ...blocker, blocking: true, status: blocker.cleared ? 'verified' : 'open' })).join('') : '<div class="empty-state">No requirements. Run the record check to start.</div>')}
    ${renderTasks(detail)}
    <form class="mini-form" id="patient-message-form"><h4>Simulate a patient reply</h4><textarea name="message" rows="3" maxlength="2000" required placeholder="For example: I can't get a ride home"></textarea><label class="upload-label">Attach lab photo or PDF<input name="attachment" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></label><div class="form-row"><button class="blocker-action" type="submit">Send as patient</button><button class="blocker-action secondary-action" type="button" id="send-sample-report">Send sample lab report</button></div></form>`;

  panel.querySelector('#check-record')?.addEventListener('click', () => runCheck(detail.id));
  panel.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => resolveRequirement(button.dataset.id, button.dataset.action)));
  panel.querySelectorAll('[data-document-id]').forEach(async (preview) => {
    try {
      const blob = await provider.documentBlob(preview.dataset.documentId);
      if (!preview.isConnected) return;
      const url = URL.createObjectURL(blob);
      documentUrls.push(url);
      preview.src = url;
      preview.hidden = false;
    } catch (error) { if (preview.isConnected) notify(error.message); }
  });
  panel.querySelectorAll('[data-task-complete]').forEach((button) => button.addEventListener('click', () => completeTask(button.dataset.taskComplete)));
  panel.querySelector('#task-form')?.addEventListener('submit', createTask);
  panel.querySelector('#patient-message-form')?.addEventListener('submit', sendPatientMessage);
  panel.querySelector('#send-sample-report')?.addEventListener('click', sendSampleReport);
}

async function loadList({ preserveSelection = true } = {}) {
  try {
    const nextSurgeries = await provider.listSurgeries();
    const listChanged = JSON.stringify(nextSurgeries) !== JSON.stringify(surgeries);
    surgeries = nextSurgeries;
    if (!preserveSelection || !surgeries.some((surgery) => surgery.id === selectedId)) selectedId = surgeries[0]?.id ?? null;
    if (listChanged || !preserveSelection) renderList();
    if (selectedId) await loadDetail(selectedId);
    else renderDetail();
    document.querySelector('#service-status').textContent = provider.mode === 'mock' ? 'MOCK DATA' : 'CORE CONNECTED';
    document.querySelector('#service-status').classList.toggle('mock-state', provider.mode === 'mock');
  } catch (error) {
    document.querySelector('#service-status').textContent = 'CORE OFFLINE';
    panel.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}<br><br>Start the core with <code>bun start</code>, then reload this page.</div>`;
  }
}

async function loadDetail(id) {
  selectedId = id;
  const nextDetail = await provider.getSurgery(id);
  const detailChanged = JSON.stringify(nextDetail) !== JSON.stringify(selectedDetail);
  selectedDetail = nextDetail;
  if (detailChanged) renderDetail();
}
async function selectSurgery(id) {
  selectedId = id;
  selectedDetail = null;
  renderList();
  try { await loadDetail(id); } catch (error) { notify(error.message); }
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}
async function refreshAfterMutation(message) {
  await loadList();
  notify(message);
}

async function runCheck(surgeryId) {
  try {
    await provider.refreshSurgery(surgeryId);
    await refreshAfterMutation('Record check complete. Review each finding and source.');
  } catch (error) { notify(error.message); }
}
async function resolveRequirement(requirementId, actionKey) {
  const requirement = selectedDetail?.requirements?.find((item) => item.id === requirementId);
  const action = ({ verify: 'verify', approve: 'approve_template', waive: 'waive', reject: 'reject_evidence', reopen: 'reopen' })[actionKey];
  if (!requirement || !action) return;
  let note;
  if (action === 'approve_template' && requirement.proposal?.requiresStaffInstruction) {
    note = window.prompt('Enter the exact staff-approved sentence to insert. Do not enter AI-generated medication advice:');
    if (!note?.trim()) return;
  } else if (action === 'waive' || action === 'reject_evidence') {
    note = window.prompt(action === 'waive' ? 'Why is this requirement being waived?' : 'Why is this evidence being rejected?');
    if (!note?.trim()) return;
  }
  try {
    await provider.resolveRequirement(requirementId, action, actor, note?.trim());
    await refreshAfterMutation(action === 'approve_template' ? 'Staff-approved template queued for the patient.' : `Requirement ${action.replace('_', ' ')} recorded.`);
  } catch (error) { notify(error.message); }
}
async function completeTask(taskId) {
  try { await provider.completeTask(taskId); await refreshAfterMutation('Task marked done. Its requirement stays unchanged until verified.'); }
  catch (error) { notify(error.message); }
}
async function createTask(event) {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  try {
    await provider.createTask(selectedId, values.get('title').trim(), values.get('owner'), values.get('detail').trim());
    await refreshAfterMutation('Follow-up task assigned.');
  } catch (error) { notify(error.message); }
}
async function sendPatientMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const message = data.get('message').trim();
  if (!message) return;
  try {
    const file = data.get('attachment');
    let attachment;
    if (file?.size) {
      if (file.size > 6 * 1024 * 1024) throw new Error('Choose a file smaller than 6 MB.');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the attachment.'));
        reader.readAsDataURL(file);
      });
      attachment = { mimeType: file.type || 'application/octet-stream', base64: dataUrl.split(',')[1] };
    }
    const result = await provider.sendPatientMessage(selectedId, message, attachment);
    await loadList();
    const replies = result.replies?.join(' ') ?? '';
    const effects = result.effects?.map((effect) => effect.title).join(', ') ?? '';
    notify([replies, effects && `Created: ${effects}`].filter(Boolean).join(' ')
      || `Message classified as ${result.classification?.intent ?? 'received'}.`);
  } catch (error) { notify(error.message); }
}
async function sendSampleReport() {
  try {
    const response = await fetch('/db/seed/assets/sample-lab-report.png');
    if (!response.ok) throw new Error('Could not load the synthetic sample lab report.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    const result = await provider.sendPatientMessage(selectedId,
      'I did my pre-op blood work at another clinic; here is the report.',
      { mimeType: 'image/png', base64: btoa(binary) });
    await loadList();
    notify(result.replies?.join(' ') || 'Sample lab report sent. Review its extraction and verify it as staff.');
  } catch (error) { notify(error.message); }
}

document.querySelector('#today').textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
document.querySelector('#page-date').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase();
document.querySelector('#reset-demo').addEventListener('click', async () => {
  if (!window.confirm('Reset the synthetic demo surgeries and erase the current in-memory demo changes?')) return;
  try { await provider.resetDemo(); await loadList({ preserveSelection: false }); notify('Demo reset. Run the record check to generate current blockers.'); }
  catch (error) { notify(error.message); }
});

loadList({ preserveSelection: false });
if (provider.mode === 'core') setInterval(() => loadList(), 3000);
