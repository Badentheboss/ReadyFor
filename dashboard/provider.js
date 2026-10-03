const DEMO_TODAY = new Date('2026-10-05T12:00:00');

function formatDate(isoDate) {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function daysUntil(isoDate) {
  return Math.ceil((new Date(`${isoDate}T12:00:00`) - DEMO_TODAY) / 86_400_000);
}

function toDashboardModel(fixture) {
  return {
    id: fixture.id,
    name: fixture.patient.name,
    initials: fixture.patient.initials,
    age: fixture.patient.age,
    procedure: fixture.procedure,
    date: formatDate(fixture.surgeryDate),
    days: daysUntil(fixture.surgeryDate),
    readiness: fixture.readiness === 'needs-attention' ? 'attention' : fixture.readiness,
    owner: fixture.blockers[0]?.owner ?? '',
    blockers: fixture.blockers.map((blocker) => ({
      id: blocker.id,
      kind: blocker.kind,
      title: blocker.title,
      reason: blocker.reason,
      owner: blocker.owner,
      action: blocker.kind === 'medication' ? 'Review medication template' : 'Mark verified',
      actionKind: blocker.kind === 'medication' ? 'template' : 'verify',
      cleared: blocker.state === 'cleared',
      approval: blocker.approval,
    })),
    tasks: fixture.tasks.map((task) => ({
      title: task.title,
      note: task.title,
      owner: task.owner,
    })),
  };
}

/**
 * Provider boundary consumed by the dashboard UI. A live implementation must
 * conform to docs/contract.md; no HTTP routes or payload formats are assumed
 * here while that contract is being authored.
 */
export function createDashboardProvider(kind = 'mock') {
  if (kind === 'core') {
    const pending = () => Promise.reject(new Error(
      'The core API adapter is pending docs/contract.md. Set DASHBOARD_PROVIDER=mock until the contract is available.',
    ));
    return { listSurgeries: pending, resolveBlocker: pending };
  }

  let fixturesPromise;
  const loadFixtures = () => {
    fixturesPromise ??= fetch('/db/seed/fixtures.json')
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load demo fixtures (${response.status}).`);
        return response.json();
      });
    return fixturesPromise;
  };

  return {
    async listSurgeries() {
      const fixtures = await loadFixtures();
      return fixtures.surgeries.map(toDashboardModel);
    },
    async resolveBlocker(surgeryId, blockerId) {
      const fixtures = await loadFixtures();
      const surgery = fixtures.surgeries.find((item) => item.id === surgeryId);
      const blocker = surgery?.blockers.find((item) => item.id === blockerId);
      if (!blocker || blocker.state === 'cleared') return this.listSurgeries();
      blocker.state = 'cleared';
      blocker.approval = 'Demo action recorded · Staff review required';
      return fixtures.surgeries.map(toDashboardModel);
    },
  };
}
