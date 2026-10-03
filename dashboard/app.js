import { createDashboardProvider } from './provider.js';

const provider = createDashboardProvider(window.READYFOR_CONFIG?.provider);
let surgeries = [];

const labels = { 'at-risk': 'At risk', attention: 'Needs attention', ready: 'Ready' };
let selectedId = surgeries[0].id;
const list = document.querySelector('#surgery-list');
const panel = document.querySelector('#detail-panel');
const toast = document.querySelector('#toast');
let toastTimer;

function statusClass(value) { return value === 'at-risk' ? 'status-risk' : value === 'ready' ? 'status-ready' : 'status-attention'; }
function openBlockers(surgery) { return surgery.blockers.filter((blocker) => !blocker.cleared).length; }
function readiness(surgery) {
  const open = openBlockers(surgery);
  if (!open) return 'ready';
  // Demo-only heuristic; production thresholds and severity rules come from the shared contract/core.
  return surgery.days <= 5 && open >= 2 ? 'at-risk' : 'attention';
}

function renderList() {
  list.innerHTML = surgeries.map((surgery) => {
    const current = readiness(surgery);
    const count = openBlockers(surgery);
    const firstOpen = surgery.blockers.find((blocker) => !blocker.cleared);
    return `<article class="surgery-card ${surgery.id === selectedId ? 'selected' : ''}" data-id="${surgery.id}" tabindex="0" role="button" aria-label="Open ${surgery.name} surgery details">
      <div class="card-main"><div class="patient-avatar">${surgery.initials}</div><div class="patient-info"><strong>${surgery.name}</strong><small>${surgery.age} · ${surgery.procedure}</small></div><div class="surgery-meta"><strong>${surgery.date}</strong><small>in ${surgery.days} days</small></div><span class="chevron">›</span></div>
      <div class="card-bottom"><span class="status-pill ${statusClass(current)}">${labels[current]}</span><span class="blocker-preview">${firstOpen ? `<b>${firstOpen.title}</b> · ${firstOpen.reason}` : 'All requirements verified'}</span>${count ? `<span class="blocker-count">${count} open</span>` : ''}</div>
    </article>`;
  }).join('');
  list.querySelectorAll('.surgery-card').forEach((card) => {
    card.addEventListener('click', () => selectSurgery(card.dataset.id));
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSurgery(card.dataset.id); } });
  });
  const totals = { ready: 0, attention: 0, risk: 0 };
  surgeries.forEach((s) => { const value = readiness(s); totals[value === 'at-risk' ? 'risk' : value]++; });
  document.querySelector('#total-count').textContent = surgeries.length;
  document.querySelector('#attention-count').textContent = totals.risk + totals.attention;
  document.querySelector('#ready-count').textContent = totals.ready;
  document.querySelector('#nav-count').textContent = surgeries.length;
}

function blockerMarkup(blocker) {
  const cleared = blocker.cleared;
  const icon = blocker.kind === 'medication' ? 'Rx' : blocker.kind === 'lab' ? '⌁' : blocker.kind === 'transport' ? '↗' : '◷';
  const button = cleared ? `<button class="blocker-action" disabled>✓ Verified</button>` : `<button class="blocker-action" data-action="${blocker.id}">${blocker.action}</button>`;
  return `<article class="blocker-item ${cleared ? 'cleared' : ''}"><div class="blocker-head"><span class="blocker-symbol">${icon}</span><div class="blocker-copy"><strong>${blocker.title}</strong><p>${blocker.reason}</p></div><span class="blocker-state">${cleared ? 'Cleared' : 'Open'}</span></div><div class="owner-row"><span class="owner-dot">${blocker.owner.split(' ').map((part) => part[0]).join('')}</span> Owner: ${blocker.owner}</div>${button}${cleared && blocker.approval ? `<p class="approved-caption">${blocker.approval}</p>` : ''}</article>`;
}

function renderDetail() {
  const surgery = surgeries.find((item) => item.id === selectedId) ?? surgeries[0];
  const current = readiness(surgery);
  const open = openBlockers(surgery);
  panel.innerHTML = `<div class="panel-label">SURGERY DETAILS</div><h2>${surgery.name}</h2><p class="detail-procedure">${surgery.age} · ${surgery.procedure}</p>
    <div class="detail-date"><span class="calendar-icon">▦</span><div><strong>${surgery.date} · in ${surgery.days} days</strong><small>General Orthopedics</small></div></div>
    <div class="readiness-row"><span>Readiness level</span><span class="status-pill ${statusClass(current)}">${labels[current]}</span></div>
    <p class="readiness-copy">${open ? `${open} requirement${open === 1 ? '' : 's'} still need${open === 1 ? 's' : ''} staff review before surgery.` : 'All requirements have been verified by the care team.'}</p>
    <div class="panel-divider"></div><div class="blocker-title"><h3>Requirements &amp; blockers</h3><span>${open} open</span></div>
    ${surgery.blockers.length ? surgery.blockers.map(blockerMarkup).join('') : '<div class="empty-state">No open blockers. This surgery is ready.</div>'}
    ${surgery.tasks.length ? `<div class="task-card"><div class="task-head">Patient task <span>···</span></div>${surgery.tasks.map((task) => `<p>${task.note}</p><div class="task-owner"><span class="owner-dot">${task.owner.split(' ').map((part) => part[0]).join('')}</span> Assigned to ${task.owner}</div>`).join('')}</div>` : ''}`;
  panel.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => handleAction(surgery, button.dataset.action)));
}

function selectSurgery(id) { selectedId = id; renderList(); renderDetail(); }
function notify(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
}
async function handleAction(surgery, blockerId) {
  const blocker = surgery.blockers.find((item) => item.id === blockerId);
  if (!blocker || blocker.cleared) return;
  try {
    surgeries = await provider.resolveBlocker(surgery.id, blockerId);
    if (blocker.actionKind === 'template') notify('Demo action recorded. Staff review is still required.');
    else notify('Demo verification recorded.');
    renderList();
    renderDetail();
  } catch (error) {
    notify(error.message);
  }
}

document.querySelector('#today').textContent = 'MON, OCT 5';
document.querySelector('#add-surgery').addEventListener('click', () => notify('Surgery creation will be connected to the core service.'));
provider.listSurgeries().then((items) => {
  surgeries = items;
  selectedId = surgeries[0]?.id ?? null;
  renderList();
  if (surgeries.length) renderDetail();
  else panel.innerHTML = '<div class="empty-state">No surgeries are available.</div>';
}).catch((error) => {
  panel.innerHTML = `<div class="empty-state">${error.message}</div>`;
  notify(error.message);
});
