const DEFAULT_API_URL = 'http://localhost:8787';

function requestError(body, status) {
  const message = body?.error?.message || `Core API request failed (${status}).`;
  return new Error(message);
}


function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const birth = new Date(`${birthDate}T00:00:00Z`);
  const now = new Date();
  return now.getUTCFullYear() - birth.getUTCFullYear()
    - (now < new Date(Date.UTC(now.getUTCFullYear(), birth.getUTCMonth(), birth.getUTCDate())) ? 1 : 0);
}

function formatSurgeryDate(value) {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}

function ownerLabel(owner) {
  return ({ coordinator: 'Coordinator', nurse: 'Nurse', surgeon: 'Surgeon', patient: 'Patient' })[owner] ?? owner ?? 'Unassigned';
}

function mapReadiness(level) {
  return ({ ready: 'ready', needs_attention: 'attention', at_risk: 'at-risk' })[level] ?? 'attention';
}

function mapSummary(item) {
  const { surgery, patient, readiness, blockers = [] } = item;
  return {
    id: surgery.id,
    name: patient.displayName,
    initials: initials(patient.displayName),
    age: ageFromBirthDate(patient.birthDate),
    procedure: surgery.procedureName,
    date: formatSurgeryDate(surgery.scheduledAt),
    days: readiness.daysUntil,
    readiness: mapReadiness(readiness.level),
    headline: readiness.headline,
    openCount: readiness.openBlockers,
    pendingVerification: readiness.pendingVerification,
    location: surgery.location,
    surgeon: surgery.surgeon,
    blockers: blockers.map((blocker) => ({
      id: blocker.id,
      key: blocker.key,
      kind: blocker.kind,
      title: blocker.title,
      reason: blocker.reason,
      owner: ownerLabel(blocker.owner),
      status: blocker.status,
      cleared: ['satisfied', 'verified', 'waived'].includes(blocker.status),
      actionKind: blocker.kind === 'medication' ? 'template' : 'verify',
    })),
    schedule: item.schedule ?? null,
    tasks: [],
  };
}

function mapDetail(detail) {
  const base = mapSummary({
    surgery: detail.surgery,
    patient: detail.patient,
    readiness: detail.readiness,
    blockers: detail.requirements.filter((requirement) => requirement.blocking
      && ['open', 'evidence_received'].includes(requirement.status)),
  });
  return {
    ...base,
    readinessHeadline: detail.readiness.headline,
    lastCheckedAt: detail.surgery.lastCheckedAt,
    requirements: detail.requirements.map((requirement) => ({
      id: requirement.id,
      key: requirement.key,
      kind: requirement.kind,
      title: requirement.title,
      reason: requirement.reason,
      owner: ownerLabel(requirement.owner),
      status: requirement.status,
      blocking: requirement.blocking,
      source: requirement.source,
      proposal: requirement.proposal,
      evidence: requirement.evidence,
      staffNote: requirement.staffNote,
    })),
    tasks: detail.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      note: task.detail,
      owner: ownerLabel(task.owner),
      status: task.status,
      requirementId: task.requirementId,
    })),
    messages: detail.messages,
    documents: detail.documents,
    events: detail.events,
    outreach: detail.outreach ?? [],
    alerts: detail.alerts ?? [],
    schedule: detail.schedule ?? null,
    standby: detail.standby ?? null,
  };
}

function createCoreProvider(baseUrl, config = {}) {
  const base = baseUrl || DEFAULT_API_URL;
  const authorizedFetch = async (path, options = {}) => {
    const send = async (refresh = false) => {
      const token = await config.getAccessToken?.(refresh);
      return fetch(`${base}${path}`, { ...options, headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers, ...(token ? { authorization: `Bearer ${token}` } : {}),
      } });
    };
    let response = await send();
    if (response.status === 401 && config.getAccessToken) response = await send(true);
    if (response.status === 401) config.onUnauthorized?.();
    return response;
  };
  const json = async (path, method = 'GET', body) => {
    // The gateway accepts only JSON writes, so a POST without a payload still sends {}.
    const payload = body === undefined && method !== 'GET' ? {} : body;
    const response = await authorizedFetch(path, { method,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const result = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw requestError(result, response.status);
    return result;
  };
  const listSurgeries = async () => {
    const result = await json('/surgeries');
    return result.surgeries.map(mapSummary);
  };
  const getSurgery = async (id) => mapDetail(await json(`/surgeries/${encodeURIComponent(id)}`));
  return {
    mode: 'core',
    async listTasks({ owner = '', status = 'open' } = {}) {
      const query = new URLSearchParams({ status });
      if (owner) query.set('owner', owner);
      return (await json(`/tasks?${query}`)).tasks;
    },
    listSurgeries,
    getSurgery,
    async refreshSurgery(surgeryId) {
      await json(`/surgeries/${encodeURIComponent(surgeryId)}/check`, 'POST');
      const [items, detail] = await Promise.all([listSurgeries(), getSurgery(surgeryId)]);
      return { items, detail };
    },
    async resolveRequirement(requirementId, action, actor, note) {
      await json(`/requirements/${encodeURIComponent(requirementId)}/actions`, 'POST', {
        action, ...(note ? { note } : {}),
      });
    },
    async createTask(surgeryId, title, owner, detail) {
      return json('/tasks', 'POST', {
        surgeryId, title, owner, detail, origin: 'staff',
      });
    },
    async completeTask(taskId) {
      return json(`/tasks/${encodeURIComponent(taskId)}/actions`, 'POST', {
        action: 'complete',
      });
    },
    async sendPatientMessage(surgeryId, body, attachment) {
      return json('/messages/inbound', 'POST', {
        channel: 'simulated', surgeryId, body,
        ...(attachment ? { attachments: [attachment] } : {}),
      });
    },
    resetDemo: () => json('/demo/reset', 'POST'),
    retryMessage: (messageId) => json(`/messages/${encodeURIComponent(messageId)}/retry`, 'POST', {}),
    listAlerts: async () => (await json('/alerts')).alerts ?? [],
    scheduleAction: (surgeryId, key, action, note) => json(`/surgeries/${encodeURIComponent(surgeryId)}/schedule/${encodeURIComponent(key)}`, 'POST', { action, ...(note ? { note } : {}) }),
    standbyAction: (surgeryId, candidateId, action) => json(`/surgeries/${encodeURIComponent(surgeryId)}/standby`, 'POST', { candidateId, action }),
    acknowledgeAlert: (alertId) => json(`/alerts/${encodeURIComponent(alertId)}/acknowledge`, 'POST', {}),
    resolveAlert: (alertId, note) => json(`/alerts/${encodeURIComponent(alertId)}/resolve`, 'POST', { note }),
    health: () => json('/health'),
    documentUrl: () => null,
    async documentBlob(documentId) {
      const response = await authorizedFetch(`/documents/${encodeURIComponent(documentId)}/content`);
      if (!response.ok) throw new Error('Could not load the evidence document.');
      return response.blob();
    },
  };
}

function createMockProvider() {
  let fixturesPromise;
  const loadFixtures = () => {
    fixturesPromise ??= fetch('/db/seed/fixtures.json')
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load demo fixtures (${response.status}).`);
        return response.json();
      }).then((fixtures) => JSON.parse(JSON.stringify(fixtures)));
    return fixturesPromise;
  };
  const mapFixture = (fixture) => ({
    id: fixture.id,
    name: fixture.patient.name,
    initials: fixture.patient.initials,
    age: fixture.patient.age,
    procedure: fixture.procedure,
    date: new Date(`${fixture.surgeryDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
    days: Math.max(0, Math.ceil((new Date(`${fixture.surgeryDate}T12:00:00Z`) - new Date('2026-10-05T12:00:00Z')) / 86_400_000)),
    readiness: fixture.readiness === 'needs-attention' ? 'attention' : fixture.readiness,
    headline: (() => {
      const open = fixture.blockers.filter((blocker) => blocker.state !== 'cleared').length;
      const label = { 'at-risk': 'At risk', 'needs-attention': 'Needs attention', ready: 'Ready' }[fixture.readiness] ?? 'Needs attention';
      return open ? `${label}: ${open} blocker${open === 1 ? '' : 's'}` : label;
    })(),
    openCount: fixture.blockers.filter((blocker) => blocker.state !== 'cleared').length,
    blockers: fixture.blockers.map((blocker) => ({
      id: blocker.id, key: blocker.kind, kind: blocker.kind, title: blocker.title,
      reason: blocker.reason, owner: blocker.owner, status: blocker.state,
      cleared: blocker.state === 'cleared', actionKind: blocker.kind === 'medication' ? 'template' : 'verify',
    })),
    lastCheckedAt: fixture.lastCheckedAt ?? null,
    tasks: fixture.tasks.map((task, index) => ({ id: task.id ?? `${fixture.id}-task-${index}`, title: task.title, note: task.detail ?? task.title, owner: task.owner, status: task.state ?? 'open' })),
    schedule: mockSchedule(fixture),
    alerts: mockAlerts.filter((alert) => alert.surgeryId === fixture.id),
    standby: mockStandby(fixture),
  });
  // A synthetic waiting list for the offline demo; offers live only in this page's memory.
  const mockStandbyState = new Map();
  const MOCK_STANDBY = [
    { id: 'sb_marcus', name: 'Marcus Bell', age: 71, noticeHours: 48, waitingSinceDays: 63, note: 'Cleared by cardiology last month; son can drive on short notice.' },
    { id: 'sb_eleanor', name: 'Eleanor Park', age: 66, noticeHours: 24, waitingSinceDays: 41, note: 'Pre-op labs and anesthesia consult done in September.' },
    { id: 'sb_ruth', name: 'Ruth Okafor', age: 59, noticeHours: 72, waitingSinceDays: 28, note: 'Ready; needs three days to arrange time off work.' },
  ];
  const mockStandby = (fixture) => {
    const states = mockStandbyState.get(fixture.id) ?? {};
    const candidates = MOCK_STANDBY.map((c) => ({ ...c, procedureCode: 'TKA', surgeon: 'Dr. Avery Demo', status: states[c.id] ?? 'suggested', updatedAt: null, by: null, canMakeIt: true }));
    const confirmed = candidates.find((c) => c.status === 'accepted')?.id ?? null;
    const eligible = fixture.readiness === 'at-risk' || confirmed !== null;
    return { eligible, reason: eligible ? 'Open blockers inside a week: line up a backup in case this slot opens.' : 'No backup needed yet.', candidates, confirmed };
  };
  // Synthetic stand-ins so the offline demo shows escalation and scheduling too.
  const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const mockAlerts = [];
  let mockAlertReady;
  // Memoised: the list and the alerts load in parallel and must not both create the demo alert.
  const ensureMockAlert = () => (mockAlertReady ??= (async () => {
    const risky = (await loadFixtures()).surgeries.find((item) => item.readiness === 'at-risk');
    if (!risky) return;
    mockAlerts.push({
      id: 'alr_demo', surgeryId: risky.id, patientName: risky.patient.name, procedureName: risky.procedure,
      summary: 'Patient reports a new cough and a fever of 38.4°C since last night.', status: 'open', level: 0,
      createdAt: minutesAgo(3), notifiedAt: minutesAgo(3), escalateAfter: new Date(Date.now() + 2 * 60_000).toISOString(),
      exhausted: false, acknowledgedBy: null, acknowledgedAt: null,
      notified: { name: 'Priya Shah', role: 'nurse' }, next: { name: 'Dr. Avery Demo', role: 'surgeon' },
      notifications: [{ contactName: 'Priya Shah', contactRole: 'nurse', deliveryStatus: 'sent', deliveryError: null }],
    });
  })());
  const mockScheduleChecks = new Map();
  const mockSchedule = (fixture) => {
    const base = mockScheduleBase(fixture);
    const checks = mockScheduleChecks.get(fixture.id) ?? {};
    const items = base.items.map((i) => (checks[i.key] && i.status !== 'ok' ? { ...i, checked: checks[i.key] } : i));
    const live = items.filter((i) => !i.checked && i.status !== 'ok');
    const level = live.some((i) => i.status === 'conflict') ? 'conflict' : live.length ? 'needs_attention' : 'on_track';
    const headline = level === base.level ? base.headline : level === 'on_track' ? 'Schedule on track (checked by staff)' : `Schedule: ${live.length} item to confirm`;
    return { ...base, items, level, headline };
  };
  const mockScheduleBase = (fixture) => {
    const level = fixture.readiness === 'at-risk' ? 'needs_attention' : fixture.readiness === 'ready' ? 'on_track' : 'conflict';
    const item = (key, title, status, detail) => ({ key, title, status, detail, source: { system: 'fhir', resource: `Appointment/${fixture.id}-${key}`, lastUpdated: minutesAgo(180) } });
    const items = [
      level === 'conflict' ? item('or_case', 'Operating room booking', 'conflict', 'The OR is booked two hours after the scheduled surgery time.') : item('or_case', 'Operating room booking', 'ok', 'Booked for the scheduled time.'),
      level === 'needs_attention' ? item('preop_visit', 'Pre-op clinic visit', 'attention', 'The visit is proposed, not confirmed.') : item('preop_visit', 'Pre-op clinic visit', 'ok', 'Booked three days before surgery.'),
    ];
    const headline = { on_track: 'Schedule on track', needs_attention: 'Schedule: 1 item to confirm', conflict: 'Schedule conflict: operating room booking' }[level];
    return { level, headline, checkedAt: minutesAgo(1), feed: 'Synthetic FHIR R4 Appointment feed', items };
  };
  return {
    mode: 'mock',
    async listTasks({ owner = '', status = 'open' } = {}) {
      const fixtures = await loadFixtures();
      return fixtures.surgeries.flatMap((surgery) => surgery.tasks.map((task, index) => ({
        ...task, id: task.id ?? `${surgery.id}-task-${index}`,
        owner: task.owner.toLowerCase(), status: task.state ?? 'open',
        surgeryId: surgery.id, patientName: surgery.patient.name,
        procedureName: surgery.procedure, scheduledAt: `${surgery.surgeryDate}T12:00:00Z`,
      }))).filter((task) => (!owner || task.owner === owner) && (status === 'all' || task.status === status))
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    },
    async listSurgeries() {
      const fixtures = await loadFixtures();
      await ensureMockAlert();
      return fixtures.surgeries.map(mapFixture);
    },
    async getSurgery(id) {
      const surgery = (await loadFixtures()).surgeries.find((item) => item.id === id);
      return surgery ? mapFixture(surgery) : null;
    },
    async refreshSurgery(id) {
      const items = await this.listSurgeries();
      return { items, detail: await this.getSurgery(id) };
    },
    async resolveRequirement(requirementId, action) {
      const fixtures = await loadFixtures();
      for (const surgery of fixtures.surgeries) {
        const blocker = surgery.blockers.find((item) => item.id === requirementId);
        if (blocker) {
          blocker.state = action === 'reopen' ? 'open' : 'cleared';
          blocker.approval = 'Demo action recorded · staff review required';
          break;
        }
      }
    },
    async createTask(surgeryId, title, owner, detail) {
      const surgery = (await loadFixtures()).surgeries.find((item) => item.id === surgeryId);
      if (!surgery) throw new Error('Surgery was not found in the mock fixture.');
      surgery.tasks.push({ title, owner, detail, state: 'open' });
    },
    async completeTask(id) {
      for (const surgery of (await loadFixtures()).surgeries) {
        const task = surgery.tasks.find((item, index) => (item.id ?? `${surgery.id}-task-${index}`) === id);
        if (task) {
          if ((task.state ?? 'open') !== 'open') throw new Error('This task is already done.');
          task.state = 'done';
          return;
        }
      }
      throw new Error('Task not found.');
    },
    async retryMessage() { throw new Error('Retrying a message is available only against the core API.'); },
    async scheduleAction(surgeryId, key, action, note) {
      const surgery = (await loadFixtures()).surgeries.find((item) => item.id === surgeryId);
      if (!surgery) throw new Error('Surgery not found.');
      if (action === 'task') { surgery.tasks.push({ title: `Fix schedule: ${key.replace('_', ' ')}`, owner: 'Coordinator', state: 'open' }); return; }
      const checks = mockScheduleChecks.get(surgeryId) ?? {};
      checks[key] = { by: 'admin:Demo staff', at: new Date().toISOString(), note };
      mockScheduleChecks.set(surgeryId, checks);
    },
    async standbyAction(surgeryId, candidateId, action) {
      const states = mockStandbyState.get(surgeryId) ?? {};
      if (action !== 'offer' && states[candidateId] !== 'offered') throw new Error('Offer the slot first.');
      if (Object.values(states).includes('accepted') && action !== 'decline') throw new Error('A backup has already accepted this slot.');
      states[candidateId] = { offer: 'offered', accept: 'accepted', decline: 'declined' }[action];
      mockStandbyState.set(surgeryId, states);
    },
    async listAlerts() {
      await ensureMockAlert();
      return mockAlerts.filter((alert) => alert.status !== 'resolved').map((alert) => ({ ...alert }));
    },
    async acknowledgeAlert(id) {
      const alert = mockAlerts.find((item) => item.id === id);
      if (!alert || alert.status !== 'open') throw new Error('This alert is no longer open.');
      Object.assign(alert, { status: 'acknowledged', acknowledgedBy: 'admin:Demo staff', acknowledgedAt: new Date().toISOString(), next: null });
    },
    async resolveAlert(id, note) {
      const alert = mockAlerts.find((item) => item.id === id);
      if (!alert) throw new Error('Alert not found.');
      Object.assign(alert, { status: 'resolved', resolution: note });
    },
    async sendPatientMessage(surgeryId, body) {
      const surgery = (await loadFixtures()).surgeries.find((item) => item.id === surgeryId);
      if (!surgery) throw new Error('Surgery was not found in the mock fixture.');
      const isTransport = /ride|transport|drive/i.test(body);
      const task = { title: isTransport ? 'Arrange ride home' : 'Follow up with patient', owner: 'Coordinator', detail: body, state: 'open' };
      surgery.tasks.push(task);
      return { replies: ['Demo reply received. Connect the core API to classify and route patient messages.'], effects: [{ title: task.title }] };
    },
    async resetDemo() {
      fixturesPromise = undefined;
      await loadFixtures();
    },
    async health() { return { ok: true, database: 'mock', llm: 'mock', records: 'mock' }; },
    documentUrl: () => null,
  };
}

export function createDashboardProvider(config = {}) {
  return config.provider === 'mock'
    ? createMockProvider()
    : createCoreProvider(config.apiBaseUrl, config);
}
