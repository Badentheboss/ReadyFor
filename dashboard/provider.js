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
    headline: fixture.readiness,
    openCount: fixture.blockers.filter((blocker) => blocker.state !== 'cleared').length,
    blockers: fixture.blockers.map((blocker) => ({
      id: blocker.id, key: blocker.kind, kind: blocker.kind, title: blocker.title,
      reason: blocker.reason, owner: blocker.owner, status: blocker.state,
      cleared: blocker.state === 'cleared', actionKind: blocker.kind === 'medication' ? 'template' : 'verify',
    })),
    tasks: fixture.tasks.map((task) => ({ title: task.title, note: task.title, owner: task.owner, status: 'open' })),
  });
  return {
    mode: 'mock',
    async listSurgeries() {
      const fixtures = await loadFixtures();
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
    async completeTask() { throw new Error('Task completion is available only against the core API.'); },
    async retryMessage() { throw new Error('Retrying a message is available only against the core API.'); },
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
