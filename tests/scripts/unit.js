const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');

class TestElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.children = [];
    this.className = '';
    this.classList = { add: () => {}, remove: () => {} };
  }

  addEventListener() {}

  appendChild(child) {
    this.children.push(child);
  }

  querySelectorAll() {
    return [];
  }
}

function createDocumentStub() {
  const elements = new Map();
  const defaults = {
    coreCount: 'auto',
    loadThresholdMode: 'auto',
    minCurrent: '70',
    mvStep: '3.0',
    analysisScope: 'auto',
    csvText: ''
  };

  function getElementById(id) {
    if (!elements.has(id)) {
      const element = new TestElement(id);
      if (Object.prototype.hasOwnProperty.call(defaults, id)) {
        element.value = defaults[id];
      }
      elements.set(id, element);
    }
    return elements.get(id);
  }

  return {
    getElementById,
    createElement: () => new TestElement(),
    querySelectorAll: () => []
  };
}

function loadAnalyzerApi() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.equal(scripts.length, 1, 'index.html must contain exactly one inline script');

  const context = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    performance: { now: () => Date.now() },
    document: createDocumentStub(),
    navigator: { clipboard: { readText: async () => '', writeText: async () => {} } },
    alert: () => {}
  };
  context.window = context;
  context.globalThis = context;

  const exports = [
    'detectCCDGroups',
    'selectContiguousLoadRun',
    'selectAnalysisLoadRunAsync',
    'filterRowsByCurrentAsync',
    'filterRowsWithCompleteVidsAsync',
    'calculateVidMeansAsync',
    'calculateAvgCorrelationAsync',
    'calculateReferenceBaselines',
    'calculateVidStats',
    'calculateClockStretchAsync',
    'evaluateWindowStability',
    'selectStableAnalysisRows',
    'evaluateWindowConsensus',
    'evaluateRecommendationGate',
    'calculateOffsets'
  ];
  const exportBlock = `\nglobalThis.__api = { ${exports.join(', ')} };\n`;
  vm.runInNewContext(scripts[0] + exportBlock, context, { filename: 'index.html' });
  return context.__api;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertClose(actual, expected, tolerance = 1e-12, message = '') {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    message || `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

function makeLoadRows(count, { current = 90, usage = 95, prefix = 'row' } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    current,
    usage
  }));
}

function makeVidWindow(residuals, count, prefix) {
  return Array.from({ length: count }, (_, rowIndex) => Object.fromEntries([
    ['id', `${prefix}-${rowIndex}`],
    ...residuals.map((residual, core) => [
      `Core ${core} VID [V]`,
      1 + residual / 1000
    ])
  ]));
}

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

test('decimal-comma and decimal-point VIDs are equivalent', async api => {
  const columns = ['Core 0 VID [V]', 'Core 1 VID [V]'];
  const pointRows = [
    { [columns[0]]: '0.980', [columns[1]]: '1.020' },
    { [columns[0]]: '1.000', [columns[1]]: '0.990' },
    { [columns[0]]: '1.020', [columns[1]]: '1.010' }
  ];
  const commaRows = pointRows.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value.replace('.', ',')])
  ));

  const pointMeans = await api.calculateVidMeansAsync(pointRows, columns, 0);
  const commaMeans = await api.calculateVidMeansAsync(commaRows, columns, 0);
  columns.forEach(column => assertClose(commaMeans[column], pointMeans[column]));

  const pointCorrelation = await api.calculateAvgCorrelationAsync(pointRows, columns, 0);
  const commaCorrelation = await api.calculateAvgCorrelationAsync(commaRows, columns, 0);
  assertClose(commaCorrelation, pointCorrelation);
});

test('constant VID traces report bounded zero co-movement', async api => {
  const columns = ['Core 0 VID [V]', 'Core 1 VID [V]'];
  const rows = Array.from({ length: 50 }, () => ({ [columns[0]]: '1.100', [columns[1]]: '1.090' }));
  const correlation = await api.calculateAvgCorrelationAsync(rows, columns, 0);
  assert.equal(correlation, 0);
  assert.ok(correlation >= -1 && correlation <= 1);
});

test('partial CCD metadata falls back to a complete CPU group', api => {
  const cores = Array.from({ length: 8 }, (_, core) => core);
  const headers = [
    'Core0 (CCD0) [C]',
    'Core1 (CCD0) [C]',
    'Core4 (CCD1) [C]'
  ];

  assert.deepEqual(plain(api.detectCCDGroups(headers, cores)), { CPU: cores });
});

test('complete-row filter rejects missing, zero, invalid, and implausible VIDs', async api => {
  const columns = ['Core 0 VID [V]', 'Core 1 VID [V]'];
  const rows = [
    { id: 'point', [columns[0]]: '1.000', [columns[1]]: '1.010' },
    { id: 'comma', [columns[0]]: '1,005', [columns[1]]: '1,025' },
    { id: 'missing', [columns[0]]: '1.000', [columns[1]]: '' },
    { id: 'zero', [columns[0]]: '0', [columns[1]]: '1.010' },
    { id: 'invalid', [columns[0]]: 'not-a-number', [columns[1]]: '1.010' },
    { id: 'implausible', [columns[0]]: '2.5', [columns[1]]: '1.010' }
  ];

  const filtered = await api.filterRowsWithCompleteVidsAsync(rows, columns, 0);
  assert.deepEqual(plain(filtered.map(row => row.id)), ['point', 'comma']);
});

test('auto usage filtering enforces current and usage together', async api => {
  const rows = [
    { id: 'keep', current: 90, usage: 95 },
    { id: 'light', current: 90, usage: 50 },
    { id: 'low-current', current: 70, usage: 95 },
    { id: 'missing-usage', current: 90, usage: '' }
  ];
  const loadSensor = { note: 'synthetic current', read: row => Number(row.current) };
  const usageSensor = {
    label: 'synthetic CPU usage',
    read: row => row.usage === '' ? NaN : Number(row.usage)
  };

  const filtered = await api.filterRowsByCurrentAsync(
    rows,
    loadSensor,
    80,
    0,
    usageSensor,
    80
  );
  assert.deepEqual(plain(filtered.map(row => row.id)), ['keep']);
});

test('manual current run selection ignores CPU usage', async api => {
  const vidCols = ['Core 0 VID [V]', 'Core 1 VID [V]'];
  const usageColumn = 'Total CPU Usage [%]';
  const rows = Array.from({ length: 80 }, (_, index) => ({
    id: `manual-${index}`,
    current: 90,
    [usageColumn]: 5,
    [vidCols[0]]: 1.100,
    [vidCols[1]]: 1.101
  }));
  const headers = ['CPU Core Current (SVI3 TFN) [A]', usageColumn, ...vidCols];
  const loadSensor = { note: headers[0], read: row => Number(row.current) };

  const selection = await api.selectAnalysisLoadRunAsync(
    rows,
    headers,
    loadSensor,
    vidCols,
    [0, 1],
    2,
    'manual',
    80,
    0
  );

  assert.equal(selection.validRows.length, 80, 'manual current must keep low-usage rows that meet the current threshold');
  assert.equal(selection.loadThreshold.mode, 'manual');
  assert.equal(selection.loadThreshold.usageSensor, null);
  assert.equal(selection.loadThreshold.usageThreshold, null);
});

test('contiguous-run selection uses the newest complete load run instead of merging appended runs', async api => {
  const earlyRun = makeLoadRows(80, { prefix: 'early' });
  const separator = makeLoadRows(12, { current: 18, usage: 4, prefix: 'idle' });
  const lateFirstHalf = makeLoadRows(37, { current: 92, usage: 97, prefix: 'late-a' });
  const bridgedGap = makeLoadRows(1, { current: 55, usage: 30, prefix: 'bridge' });
  const lateSecondHalf = makeLoadRows(38, { current: 93, usage: 98, prefix: 'late-b' });
  const trailingIdle = makeLoadRows(5, { current: 12, usage: 2, prefix: 'tail' });
  const rows = [
    ...earlyRun,
    ...separator,
    ...lateFirstHalf,
    ...bridgedGap,
    ...lateSecondHalf,
    ...trailingIdle
  ];
  const loadSensor = { read: row => Number(row.current) };
  const usageSensor = { read: row => Number(row.usage) };

  const selected = api.selectContiguousLoadRun(
    rows,
    loadSensor,
    80,
    usageSensor,
    80,
    75,
    1
  );

  assert.equal(selected.runCount, 2, 'the two measurements must remain distinct runs');
  assert.equal(selected.matchedRows, 75, 'only qualified rows count toward the minimum');
  assert.equal(selected.startIndex, earlyRun.length + separator.length);
  assert.equal(selected.endIndex, earlyRun.length + separator.length + lateFirstHalf.length + bridgedGap.length + lateSecondHalf.length - 1);
  assert.equal(selected.rows.length, 76, 'the single sampling gap remains inside the selected run boundary');
  assert.ok(selected.rows.some(row => row.id.startsWith('bridge-')));
  assert.ok(selected.rows.every(row => !row.id.startsWith('early-')), 'the earlier measurement must not leak into the selected run');

  const filtered = await api.filterRowsByCurrentAsync(selected.rows, loadSensor, 80, 0, usageSensor, 80);
  assert.equal(filtered.length, 75, 'the later load filter must remove the bridged low-load row before VID statistics');
  assert.ok(filtered.every(row => row.current >= 80 && row.usage >= 80));
});

test('contiguous-run selection falls back from an undersized tail to a qualified earlier run', api => {
  const earlyRun = makeLoadRows(80, { current: 89, usage: 95, prefix: 'qualified' });
  const separator = makeLoadRows(8, { current: 10, usage: 1, prefix: 'idle' });
  const shortTail = makeLoadRows(60, { current: 94, usage: 99, prefix: 'short-tail' });
  const rows = [...earlyRun, ...separator, ...shortTail];
  const loadSensor = { read: row => Number(row.current) };
  const usageSensor = { read: row => Number(row.usage) };

  const selected = api.selectContiguousLoadRun(rows, loadSensor, 80, usageSensor, 80, 75, 1);

  assert.equal(selected.runCount, 2);
  assert.equal(selected.startIndex, 0);
  assert.equal(selected.endIndex, earlyRun.length - 1);
  assert.equal(selected.matchedRows, 80);
  assert.ok(selected.rows.every(row => row.id.startsWith('qualified-')));
});

test('a repeated CSV header splits adjacent qualifying load runs', api => {
  const firstRun = makeLoadRows(75, { current: 90, usage: 95, prefix: 'first' });
  const repeatedHeader = { id: 'id', current: 'current', usage: 'usage' };
  const secondRun = makeLoadRows(75, { current: 92, usage: 97, prefix: 'second' });
  const rows = [...firstRun, repeatedHeader, ...secondRun];
  const loadSensor = { read: row => Number(row.current) };
  const usageSensor = { read: row => Number(row.usage) };

  const selected = api.selectContiguousLoadRun(rows, loadSensor, 80, usageSensor, 80, 75, 2);

  assert.equal(selected.runCount, 2, 'the repeated header must be a hard measurement boundary');
  assert.equal(selected.matchedRows, 75, 'the two measurements must not be merged into 150 samples');
  assert.equal(selected.startIndex, firstRun.length + 1);
  assert.equal(selected.endIndex, rows.length - 1);
  assert.ok(selected.rows.every(row => row.id.startsWith('second-')));
});

test('stable-section selection skips a drifting tail and extends the newest stable plateau', api => {
  const vidCols = ['Core 0 VID [V]', 'Core 1 VID [V]'];
  const groups = { CPU: [0, 1] };
  const rows = [
    ...makeVidWindow([40, -40], 10, 'warmup'),
    ...makeVidWindow([-2, 2], 80, 'early'),
    ...makeVidWindow([80, -80], 25, 'transition'),
    ...makeVidWindow([-6, 6], 90, 'recent'),
    ...makeVidWindow([-80, 80], 25, 'tail')
  ];

  const selected = api.selectStableAnalysisRows(rows, vidCols, groups);

  assert.equal(selected.stableSelection, true);
  assert.equal(selected.matchedRows, 230);
  assert.equal(selected.warmupRows, 10);
  assert.equal(selected.rows.length, 90, 'the 75-row seed must extend across the whole stable plateau');
  assert.ok(selected.rows.every(row => row.id.startsWith('recent-')));
  assert.equal(selected.rows[0].id, 'recent-0');
  assert.equal(selected.rows.at(-1).id, 'recent-89');
  assert.equal(selected.omittedEarlierRows, 105);
  assert.equal(selected.omittedLaterRows, 25, 'the unstable tail must remain outside the selected block');
  assert.equal(selected.windowStability.stationary, true);
});

test('stable-section selection preserves the prepared tail when no 75-row subsection is stationary', api => {
  const vidCols = ['Core 0 VID [V]', 'Core 1 VID [V]'];
  const groups = { CPU: [0, 1] };
  const rows = Array.from({ length: 150 }, (_, index) => ({
    id: `ramp-${index}`,
    [vidCols[0]]: 1 + index * 0.0005,
    [vidCols[1]]: 1 - index * 0.0005
  }));

  const selected = api.selectStableAnalysisRows(rows, vidCols, groups);

  assert.equal(selected.stableSelection, false);
  assert.equal(selected.matchedRows, 150);
  assert.equal(selected.warmupRows, 10);
  assert.equal(selected.rows.length, 140, 'failure must keep the normal prepared rows instead of inventing a good slice');
  assert.equal(selected.rows[0].id, 'ramp-10');
  assert.equal(selected.rows.at(-1).id, 'ramp-149');
  assert.equal(selected.omittedEarlierRows, 0);
  assert.equal(selected.omittedLaterRows, 0);
  assert.equal(selected.windowStability.stationary, false);
  assert.match(selected.windowStability.reason, /drift/i);
});

test('stable-section selection does not reach back past the recent 300-row analysis window', api => {
  const vidCols = ['Core 0 VID [V]', 'Core 1 VID [V]'];
  const groups = { CPU: [0, 1] };
  const recentRamp = Array.from({ length: 310 }, (_, index) => ({
    id: `recent-ramp-${index}`,
    [vidCols[0]]: 1 + index * 0.0005,
    [vidCols[1]]: 1 - index * 0.0005
  }));
  const rows = [
    ...makeVidWindow([40, -40], 10, 'warmup'),
    ...makeVidWindow([-2, 2], 90, 'stale-stable'),
    ...recentRamp
  ];

  const selected = api.selectStableAnalysisRows(rows, vidCols, groups);

  assert.equal(selected.stableSelection, false, 'an old plateau must not replace a nonstationary recent operating state');
  assert.equal(selected.rows.length, 300);
  assert.equal(selected.rows[0].id, 'recent-ramp-10');
  assert.equal(selected.rows.at(-1).id, 'recent-ramp-309');
  assert.equal(selected.omittedEarlierRows, 100);
  assert.equal(selected.omittedLaterRows, 0);
});

test('stable-section selection uses recency rather than cherry-picking the smallest VID spread', async api => {
  const vidCols = ['Core 0 VID [V]', 'Core 1 VID [V]'];
  const groups = { CPU: [0, 1] };
  const earlier = makeVidWindow([-1.5, 1.5], 90, 'narrow-earlier');
  const later = makeVidWindow([-4, 4], 90, 'wide-later');
  const rows = [
    ...makeVidWindow([40, -40], 10, 'warmup'),
    ...earlier,
    ...makeVidWindow([80, -80], 25, 'transition'),
    ...later
  ];

  const selected = api.selectStableAnalysisRows(rows, vidCols, groups);
  const earlierMeans = await api.calculateVidMeansAsync(earlier, vidCols, 0);
  const earlierBaselines = api.calculateReferenceBaselines(earlierMeans, groups).referenceBaselines;
  const earlierStats = api.calculateVidStats(earlierMeans, earlierBaselines);
  const selectedMeans = await api.calculateVidMeansAsync(selected.rows, vidCols, 0);
  const selectedBaselines = api.calculateReferenceBaselines(selectedMeans, groups).referenceBaselines;
  const selectedStats = api.calculateVidStats(selectedMeans, selectedBaselines);

  assert.equal(selected.stableSelection, true);
  assert.equal(selected.rows.length, 90);
  assert.ok(selected.rows.every(row => row.id.startsWith('wide-later-')));
  assertClose(earlierStats.range, 3, 1e-9, 'the earlier stationary block must be the prettier converged one');
  assertClose(selectedStats.range, 8, 1e-9, 'the newer stationary block must win despite its wider spread');
  assert.ok(selectedStats.range > earlierStats.range);
  assert.equal(selected.windowStability.stationary, true);
});

test('severe clock stretching is suspect even below the preferred sample count', async api => {
  const headers = [
    'Core 0 Clock [MHz]',
    'Core 0 T0 Effective Clock [MHz]'
  ];
  const rows = Array.from({ length: 50 }, () => ({
    'Core 0 Clock [MHz]': 5000,
    'Core 0 T0 Effective Clock [MHz]': 3000
  }));

  const result = await api.calculateClockStretchAsync(rows, headers, [0], 0);
  assert.equal(result.summaries[0].status, 'suspect');
  assert.equal(result.suspectCount, 1);
});

test('recommendation gate separates target, practical, and actionable spread zones', api => {
  const stableConsensus = {
    stationary: true,
    windows: [{}, {}, {}],
    agreedCores: [6],
    maxCoreDrift: 0.2,
    maxVectorRms: 0.2,
    recommendations: { 6: -24 }
  };
  const noStretch = { suspectCount: 0 };

  const converged = api.evaluateRecommendationGate(75, noStretch, 3.5, stableConsensus);
  assert.equal(converged.actionable, false);
  assert.equal(converged.state, 'converged');

  const practical = api.evaluateRecommendationGate(75, noStretch, 4.07, stableConsensus);
  assert.equal(practical.actionable, false);
  assert.equal(practical.state, 'practical');
  assert.match(practical.reason, /Keep the current offsets/);

  const practicalBoundary = api.evaluateRecommendationGate(75, noStretch, 4.5, stableConsensus);
  assert.equal(practicalBoundary.actionable, false);
  assert.equal(practicalBoundary.state, 'practical');

  const invalid = api.evaluateRecommendationGate(75, noStretch, NaN, stableConsensus);
  assert.equal(invalid.actionable, false);
  assert.equal(invalid.state, 'invalid');

  const actionable = api.evaluateRecommendationGate(75, noStretch, 4.5001, stableConsensus);
  assert.equal(actionable.actionable, true);
  assert.equal(actionable.state, 'actionable');
});

test('recommendation gate requires 75 rows and stationary same-core direction agreement', api => {
  const noStretch = { suspectCount: 0 };
  const stableConsensus = {
    stationary: true,
    windows: [{}, {}, {}],
    agreedCores: [6],
    recommendations: { 6: -24 }
  };

  const short = api.evaluateRecommendationGate(74, noStretch, 5.2, stableConsensus);
  assert.equal(short.actionable, false);
  assert.match(short.reason, /75/);

  const drifting = api.evaluateRecommendationGate(75, noStretch, 5.2, {
    ...stableConsensus,
    stationary: false,
    agreedCores: []
  });
  assert.equal(drifting.actionable, false);
  assert.match(drifting.reason, /remeasure|stationary|window/i);

  const noDirectionAgreement = api.evaluateRecommendationGate(75, noStretch, 5.2, {
    ...stableConsensus,
    agreedCores: []
  });
  assert.equal(noDirectionAgreement.actionable, false);
  assert.match(noDirectionAgreement.reason, /agree|direction|window/i);
});

test('stationary windows approve only the core and direction repeated in every window', async api => {
  const residuals = [-0.320, -0.623, -0.737, 1.456, 0.285, 1.026, -3.026, 1.939];
  const cores = residuals.map((_, core) => core);
  const vidCols = cores.map(core => `Core ${core} VID [V]`);
  const rows = [
    ...makeVidWindow(residuals, 25, 'window-a'),
    ...makeVidWindow(residuals.map((value, core) => value + (core % 2 ? 0.04 : -0.04)), 25, 'window-b'),
    ...makeVidWindow(residuals.map((value, core) => value + (core % 2 ? -0.03 : 0.03)), 25, 'window-c')
  ];
  const current = { 0: -19, 1: -12, 2: -19, 3: -20, 4: -19, 5: -13, 6: -25, 7: -23 };
  const overallRecommendations = { ...current, 6: -24 };

  const consensus = await api.evaluateWindowConsensus(
    rows,
    vidCols,
    { CPU: cores },
    3.0,
    current,
    overallRecommendations
  );

  assert.equal(consensus.windows.length, 3);
  assert.equal(consensus.stationary, true);
  assert.deepEqual(plain(consensus.agreedCores), [6]);
  assert.equal(consensus.recommendations[6], -24);
});

test('window consensus treats a practical-zone window as no directional vote', async api => {
  const actionable = [-0.320, -0.623, -0.737, 1.456, 0.285, 1.026, -3.026, 1.939];
  const practical = [...actionable];
  practical[6] = -2.400;
  const cores = actionable.map((_, core) => core);
  const vidCols = cores.map(core => `Core ${core} VID [V]`);
  const rows = [
    ...makeVidWindow(actionable, 25, 'actionable-a'),
    ...makeVidWindow(practical, 25, 'practical'),
    ...makeVidWindow(actionable, 25, 'actionable-c')
  ];
  const current = { 0: -19, 1: -12, 2: -19, 3: -20, 4: -19, 5: -13, 6: -25, 7: -23 };
  const consensus = await api.evaluateWindowConsensus(
    rows,
    vidCols,
    { CPU: cores },
    3.0,
    current,
    { ...current, 6: -24 }
  );

  assert.equal(consensus.stationary, true, 'the small range change must remain a stationary fixture');
  assert.ok(consensus.windows[0].residualRange > 4.5);
  assert.ok(consensus.windows[1].residualRange <= 4.5);
  assert.ok(consensus.windows[2].residualRange > 4.5);
  assert.deepEqual(plain(consensus.directionByCore[6]), [1, 0, 1]);
  assert.deepEqual(plain(consensus.agreedCores), [], 'a practical-zone window must prevent three-window agreement');
  assert.equal(consensus.recommendations[6], current[6]);
});

test('window consensus does not manufacture votes when all windows are in the practical zone', async api => {
  const residuals = [-0.320, -0.623, -0.737, 1.456, 0.285, 1.026, -2.400, 1.939];
  const cores = residuals.map((_, core) => core);
  const vidCols = cores.map(core => `Core ${core} VID [V]`);
  const rows = [
    ...makeVidWindow(residuals, 25, 'practical-a'),
    ...makeVidWindow(residuals, 25, 'practical-b'),
    ...makeVidWindow(residuals, 25, 'practical-c')
  ];
  const current = { 0: -19, 1: -12, 2: -19, 3: -20, 4: -19, 5: -13, 6: -25, 7: -23 };
  const consensus = await api.evaluateWindowConsensus(
    rows,
    vidCols,
    { CPU: cores },
    3.0,
    current,
    { ...current, 6: -24 }
  );

  assert.equal(consensus.stationary, true);
  assert.ok(consensus.windows.every(window => window.residualRange <= 4.5));
  assert.deepEqual(plain(consensus.directionByCore[6]), [0, 0, 0]);
  assert.deepEqual(plain(consensus.agreedCores), []);
  assert.deepEqual(plain(consensus.recommendations), current);
});

test('window consensus rejects a core whose correction reverses between stationary-sized windows', async api => {
  const base = [-0.320, -0.623, -0.737, 1.456, 0.285, 1.026, -3.026, 1.939];
  const reversed = [-0.320, -0.623, -0.737, 1.456, 0.285, 1.026, 3.100, -2.100];
  const cores = base.map((_, core) => core);
  const vidCols = cores.map(core => `Core ${core} VID [V]`);
  const rows = [
    ...makeVidWindow(base, 25, 'window-a'),
    ...makeVidWindow(reversed, 25, 'window-b'),
    ...makeVidWindow(base, 25, 'window-c')
  ];
  const current = { 0: -19, 1: -12, 2: -19, 3: -20, 4: -19, 5: -13, 6: -25, 7: -23 };
  const overallRecommendations = { ...current, 6: -24 };

  const consensus = await api.evaluateWindowConsensus(
    rows,
    vidCols,
    { CPU: cores },
    3.0,
    current,
    overallRecommendations
  );

  assert.equal(consensus.windows.length, 3);
  assert.equal(consensus.stationary, false);
  assert.ok(!plain(consensus.agreedCores).includes(6), 'C6 must not be approved when its measured direction reverses');
  assert.equal(consensus.recommendations[6], current[6], 'a disputed correction must be suppressed');
});

test('window consensus rejects one drifting core even when aggregate window metrics pass', async api => {
  const base = [-0.320, -0.623, -0.737, 1.456, 0.285, 1.026, -3.026, 1.939];
  const shifted = base.map((value, core) => value + (core === 0 ? 1.2 : 0));
  const cores = base.map((_, core) => core);
  const vidCols = cores.map(core => `Core ${core} VID [V]`);
  const rows = [
    ...makeVidWindow(base, 25, 'stable-a'),
    ...makeVidWindow(shifted, 25, 'drifted-b'),
    ...makeVidWindow(shifted, 25, 'drifted-c')
  ];
  const current = { 0: -19, 1: -12, 2: -19, 3: -20, 4: -19, 5: -13, 6: -25, 7: -23 };
  const consensus = await api.evaluateWindowConsensus(
    rows,
    vidCols,
    { CPU: cores },
    3.0,
    current,
    { ...current, 6: -24 }
  );

  assert.ok(consensus.maxCoreDrift > 1.0, 'the shifted core must exceed the per-core drift cap');
  assert.ok(consensus.maxCoreStdDev <= 0.75, 'the fixture must pass the aggregate per-core SD cap');
  assert.ok(consensus.maxVectorRms <= 0.75, 'the fixture must pass the aggregate vector RMS cap');
  assert.equal(consensus.stationary, false);
  assert.match(consensus.reason, /max core drift/i);
});

test('V1 harmonizer uses the arithmetic group mean', api => {
  const vidMeans = {
    'Core 0 VID [V]': 1.100,
    'Core 1 VID [V]': 1.100,
    'Core 2 VID [V]': 1.060
  };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, { CPU: [0, 1, 2] });
  const expected = (1.100 + 1.100 + 1.060) / 3;
  assert.equal(referenceBaselines[0], expected);
  assert.equal(referenceBaselines[2], expected);
});

test('an individual outlier uses the smallest sufficient correction', api => {
  const cores = Array.from({ length: 16 }, (_, core) => core);
  const vidMeans = Object.fromEntries(cores.map(core => [
    `Core ${core} VID [V]`,
    core === 0 ? 1.009 : 1.000
  ]));
  const groups = { CPU: cores };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const stats = api.calculateVidStats(vidMeans, referenceBaselines);
  const current = Object.fromEntries(cores.map(core => [core, 0]));
  const recommendations = api.calculateOffsets(
    vidMeans,
    referenceBaselines,
    3.0,
    current,
    stats.range,
    groups
  );

  assert.ok(stats.stdDev < 3.0, 'fixture must exercise the low-RMS stop condition');
  assert.ok(stats.maxHighDelta > 8.0, 'fixture must retain the high outlier');
  assert.equal(recommendations[0], -2, 'two steps already bring the complete field within one CO step');
  cores.slice(1).forEach(core => assert.equal(recommendations[core], 0));
});

test('opposite residuals wider than one step change only one sufficient core', api => {
  const vidMeans = {
    'Core 0 VID [V]': 1.00155,
    'Core 1 VID [V]': 0.99801
  };
  const groups = { CPU: [0, 1] };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const stats = api.calculateVidStats(vidMeans, referenceBaselines);
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, { 0: -10, 1: -10 }, stats.range, groups
  );

  assert.ok(stats.stdDev < 3.0, 'fixture must be hidden by the old global RMS criterion');
  assertClose(stats.range, 3.54, 1e-9);
  assert.equal(recommendations[0], -11, 'one higher-requesting core move is sufficient');
  assert.equal(recommendations[1], -10, 'the second borderline core must remain untouched');
});

test('fixed 3.5 mV optimizer target is independent of CO response and avoids a 3.0 mV cleanup move', api => {
  const vidMeans = {
    'Core 0 VID [V]': 0.9982,
    'Core 1 VID [V]': 1.0018
  };
  const referenceBaselines = { 0: 1, 1: 1 };
  const current = { 0: -10, 1: -10 };
  const groups = { CPU: [0, 1] };

  const fixedAtThreeMvResponse = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, current, 3.6, groups, 3.5
  );
  const fixedAtSixMvResponse = api.calculateOffsets(
    vidMeans, referenceBaselines, 6.0, current, 3.6, groups, 3.5
  );
  const legacyThreeMvTarget = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, current, 3.6, groups, 3.0
  );

  assert.deepEqual(plain(fixedAtThreeMvResponse), current);
  assert.deepEqual(plain(fixedAtSixMvResponse), current, 'changing response must not change the fixed convergence target');
  assert.equal(
    Object.keys(legacyThreeMvTarget).filter(core => legacyThreeMvTarget[core] !== current[core]).length,
    1,
    'the old 3.0 mV target would chase one extra core move'
  );
});

test('the user example raises only C2 and leaves borderline C1 untouched', api => {
  const residuals = [-0.97, 1.51, -1.86, 0.40, -0.31, -0.49, 0.37, 1.34];
  const cores = residuals.map((_, core) => core);
  const vidMeans = Object.fromEntries(cores.map(core => [`Core ${core} VID [V]`, 1 + residuals[core] / 1000]));
  const referenceBaselines = Object.fromEntries(cores.map(core => [core, 1]));
  const current = { 0: -19, 1: -11, 2: -19, 3: -20, 4: -19, 5: -13, 6: -24, 7: -23 };
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, current, 3.37, { CPU: cores }
  );

  assert.deepEqual(plain(recommendations), { ...current, 2: -18 });
  const predictedMeans = Object.fromEntries(cores.map(core => [
    `Core ${core} VID [V]`,
    vidMeans[`Core ${core} VID [V]`] + (recommendations[core] - current[core]) * 3 / 1000
  ]));
  const predictedBaselines = api.calculateReferenceBaselines(predictedMeans, { CPU: cores }).referenceBaselines;
  const predictedStats = api.calculateVidStats(predictedMeans, predictedBaselines);
  const next = api.calculateOffsets(
    predictedMeans, predictedBaselines, 3.0, recommendations, predictedStats.range, { CPU: cores }
  );
  assert.deepEqual(plain(next), plain(recommendations), 'the selected one-step move must be a fixed point in the ideal response model');
});

test('the user example is deterministic when VID columns are inserted in reverse order', api => {
  const residuals = [-0.97, 1.51, -1.86, 0.40, -0.31, -0.49, 0.37, 1.34];
  const cores = residuals.map((_, core) => core);
  const entries = cores.map(core => [`Core ${core} VID [V]`, 1 + residuals[core] / 1000]);
  const forwardMeans = Object.fromEntries(entries);
  const reverseMeans = Object.fromEntries([...entries].reverse());
  const referenceBaselines = Object.fromEntries(cores.map(core => [core, 1]));
  const current = { 0: -19, 1: -11, 2: -19, 3: -20, 4: -19, 5: -13, 6: -24, 7: -23 };
  const groups = { CPU: cores };

  const forward = api.calculateOffsets(
    forwardMeans, referenceBaselines, 3.0, current, 3.37, groups
  );
  const reverse = api.calculateOffsets(
    reverseMeans, referenceBaselines, 3.0, current, 3.37, groups
  );

  assert.deepEqual(plain(forward), { ...current, 2: -18 });
  assert.deepEqual(plain(reverse), plain(forward));
});

test('a narrow field just outside the guides is held inside the hysteresis band', api => {
  const residuals = [-0.83, -1.73, -1.28, 1.04, 0.03, 0.03, 1.14, 1.60];
  const cores = residuals.map((_, core) => core);
  const vidMeans = Object.fromEntries(cores.map(core => [`Core ${core} VID [V]`, 1 + residuals[core] / 1000]));
  const referenceBaselines = Object.fromEntries(cores.map(core => [core, 1]));
  const current = { 0: -19, 1: -12, 2: -19, 3: -20, 4: -19, 5: -13, 6: -24, 7: -23 };
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, current, 3.33, { CPU: cores }
  );

  assert.deepEqual(plain(recommendations), current);
});

test('a field less than 0.25 mV beyond target does not trigger a marginal move', api => {
  const vidMeans = {
    'Core 0 VID [V]': 0.998,
    'Core 1 VID [V]': 1.0012
  };
  const referenceBaselines = { 0: 1, 1: 1 };
  const current = { 0: -10, 1: -10 };
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, current, 3.2, { CPU: [0, 1] }
  );

  assert.deepEqual(plain(recommendations), current);
});

test('the established profile changes only C6 when that single move closes the field', api => {
  const residuals = [-0.320, -0.623, -0.737, 1.456, 0.285, 1.026, -3.026, 1.939];
  const cores = residuals.map((_, core) => core);
  const vidMeans = Object.fromEntries(cores.map(core => [`Core ${core} VID [V]`, 1 + residuals[core] / 1000]));
  const referenceBaselines = Object.fromEntries(cores.map(core => [core, 1]));
  const current = { 0: -19, 1: -12, 2: -19, 3: -20, 4: -19, 5: -13, 6: -25, 7: -23 };
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, current, 4.965, { CPU: cores }
  );

  assert.deepEqual(plain(recommendations), { ...current, 6: -24 });
  const predictedMeans = Object.fromEntries(cores.map(core => [
    `Core ${core} VID [V]`,
    vidMeans[`Core ${core} VID [V]`] + (recommendations[core] - current[core]) * 3 / 1000
  ]));
  const predictedBaselines = api.calculateReferenceBaselines(predictedMeans, { CPU: cores }).referenceBaselines;
  const predictedStats = api.calculateVidStats(predictedMeans, predictedBaselines);
  const next = api.calculateOffsets(
    predictedMeans, predictedBaselines, 3.0, recommendations, predictedStats.range, { CPU: cores }
  );
  assert.deepEqual(plain(next), plain(recommendations), 'the one-core correction must not create another idealized pass');
});

test('field optimizer can solve a coarse outlier without moving the other cores', api => {
  const vidMeans = {
    'Core 0 VID [V]': 1.100,
    'Core 1 VID [V]': 1.000,
    'Core 2 VID [V]': 1.000,
    'Core 3 VID [V]': 1.000
  };
  const groups = { CPU: [0, 1, 2, 3] };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const stats = api.calculateVidStats(vidMeans, referenceBaselines);
  const current = { 0: -10, 1: -10, 2: -10, 3: -10 };
  const recommendations = api.calculateOffsets(
    vidMeans,
    referenceBaselines,
    3.0,
    current,
    stats.range,
    groups
  );

  assert.equal(recommendations[0], -43, 'the high requester moves directly into the shared target field');
  assert.equal(recommendations[1], -10, 'unnecessary low-side movement is avoided');
});

test('zero-bound rebasing preserves relative movement', api => {
  const vidMeans = {
    'Core 0 VID [V]': 1.012,
    'Core 1 VID [V]': 1.002,
    'Core 2 VID [V]': 1.000,
    'Core 3 VID [V]': 1.000
  };
  const groups = { CPU: [0, 1, 2, 3] };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const stats = api.calculateVidStats(vidMeans, referenceBaselines);
  const current = { 0: 0, 1: -5, 2: 0, 3: 0 };
  const recommendations = api.calculateOffsets(
    vidMeans,
    referenceBaselines,
    3.0,
    current,
    stats.range,
    groups
  );

  assert.ok(stats.maxHighDelta > 3.0, 'another core must keep the pass active');
  assert.ok(recommendations[0] < current[0], 'large high-side residual should move');
  assert.equal(recommendations[1], -5, 'a core on the guide stays unchanged when another move solves the field');
  assert.equal(recommendations[2], 0, 'the lowest requesting zero-bound core remains the anchor');
});

test('a blocked low extreme is solved by rebasing the other cores into one CO-step field', api => {
  const cores = Array.from({ length: 16 }, (_, core) => core);
  const residuals = Object.fromEntries(cores.map(core => [core, core === 0 ? -9.0 : 0.6]));
  const vidMeans = Object.fromEntries(cores.map(core => [
    `Core ${core} VID [V]`,
    1 + residuals[core] / 1000
  ]));
  const referenceBaselines = Object.fromEntries(cores.map(core => [core, 1]));
  const current = Object.fromEntries(cores.map(core => [core, core === 0 ? 0 : -10]));
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, current, 9.6, { CPU: cores }
  );

  assert.equal(recommendations[0], 0, 'the low extreme is already blocked at the zero CO bound');
  cores.slice(1).forEach(core => {
    assert.equal(recommendations[core], -13, `C${core} should share the minimal three-step rebase`);
  });

  const predictedResiduals = cores.map(core =>
    residuals[core] + (recommendations[core] - current[core]) * 3.0
  );
  const predictedRange = Math.max(...predictedResiduals) - Math.min(...predictedResiduals);
  assert.ok(predictedRange <= 3.0 + 1e-9, `rebased field must close to one CO step, got ${predictedRange} mV`);
});

test('multiple equally low requesting cores can share the zero anchor', api => {
  const vidMeans = {
    'Core 0 VID [V]': 0.990,
    'Core 1 VID [V]': 0.990,
    'Core 2 VID [V]': 1.002,
    'Core 3 VID [V]': 1.005
  };
  const groups = { CPU: [0, 1, 2, 3] };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const stats = api.calculateVidStats(vidMeans, referenceBaselines);
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, { 0: 0, 1: 0, 2: 0, 3: 0 }, stats.range
  );

  assert.equal(recommendations[0], 0);
  assert.equal(recommendations[1], 0);
  assert.ok(recommendations[2] < 0);
  assert.ok(recommendations[3] < recommendations[2]);
});

test('fresh measurements converge iteratively around a zero-bound low-VID core', api => {
  const zeroOffsetMeans = {
    'Core 0 VID [V]': 1.021,
    'Core 1 VID [V]': 1.000,
    'Core 2 VID [V]': 1.021,
    'Core 3 VID [V]': 1.027
  };
  const groups = { CPU: [0, 1, 2, 3] };
  let current = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let measured = { ...zeroOffsetMeans };
  let previousStdDev = Infinity;
  let converged = false;

  for (let pass = 0; pass < 10; pass++) {
    const baselines = api.calculateReferenceBaselines(measured, groups).referenceBaselines;
    const stats = api.calculateVidStats(measured, baselines);
    assert.ok(stats.stdDev <= previousStdDev + 1e-9, 'each idealized fresh pass must reduce spread');
    previousStdDev = stats.stdDev;
    const next = plain(api.calculateOffsets(measured, baselines, 3.0, current, stats.range));
    if (JSON.stringify(next) === JSON.stringify(current)) {
      converged = true;
      break;
    }
    current = next;
    measured = Object.fromEntries(Object.entries(zeroOffsetMeans).map(([column, vid]) => {
      const core = Number(column.match(/Core (\d+)/)[1]);
      return [column, vid + current[core] * 3.0 / 1000];
    }));
  }

  assert.ok(converged, 'the idealized fresh-log loop must reach a fixed profile');
  assert.ok(previousStdDev < 3.0, 'the per-core loop must drive standard deviation below one CO step');
  assert.equal(current[1], 0, 'the lowest-VID core remains the zero anchor');
});

test('zero-bound rebasing is independent for each CCD', api => {
  const vidMeans = {
    'Core 0 VID [V]': 0.990,
    'Core 1 VID [V]': 1.005,
    'Core 2 VID [V]': 1.100,
    'Core 3 VID [V]': 1.100
  };
  const groups = { CCD1: [0, 1], CCD2: [2, 3] };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const stats = api.calculateVidStats(vidMeans, referenceBaselines);
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, { 0: 0, 1: 0, 2: -7, 3: -7 }, stats.range
  );

  assert.equal(recommendations[0], 0);
  assert.ok(recommendations[1] < 0);
  assert.equal(recommendations[2], -7);
  assert.equal(recommendations[3], -7);
});

test('explicit CCD groups evaluate their residual ranges independently', api => {
  const residuals = { 0: -1, 1: 1, 2: -10, 3: -8 };
  const vidMeans = Object.fromEntries(Object.entries(residuals).map(([core, residual]) => [
    `Core ${core} VID [V]`,
    1 + residual / 1000
  ]));
  const referenceBaselines = { 0: 1, 1: 1, 2: 1, 3: 1 };
  const current = { 0: -10, 1: -10, 2: -10, 3: -10 };
  const groups = { CCD1: [0, 1], CCD2: [2, 3] };
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, current, 11.0, groups
  );

  assert.deepEqual(
    plain(recommendations),
    current,
    'each CCD is already within one step even though the whole-CPU residual range is 11 mV'
  );
});

test('V1 low-side residual relaxes an existing negative offset', api => {
  const vidMeans = {
    'Core 0 VID [V]': 1.000,
    'Core 1 VID [V]': 0.991,
    'Core 2 VID [V]': 1.000
  };
  const groups = { CPU: [0, 1, 2] };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const stats = api.calculateVidStats(vidMeans, referenceBaselines);
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, { 0: -10, 1: -10, 2: -10 }, stats.range
  );

  assert.equal(recommendations[1], -8, 'the group-mean residual rounds to a two-step relaxation');
});
test('V1 bounds every recommendation to the supported negative range', api => {
  const vidMeans = {
    'Core 0 VID [V]': 1.000,
    'Core 1 VID [V]': 0.980,
    'Core 2 VID [V]': 1.020,
    'Core 3 VID [V]': 1.000
  };
  const groups = { CPU: [0, 1, 2, 3] };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const stats = api.calculateVidStats(vidMeans, referenceBaselines);
  const current = { 0: 5, 1: 4, 2: 3, 3: 0 };
  const recommendations = api.calculateOffsets(
    vidMeans,
    referenceBaselines,
    3.0,
    current,
    stats.range
  );

  Object.values(recommendations).forEach(recommendation => {
    assert.ok(recommendation >= -50 && recommendation <= 0);
  });
});

async function main() {
  const api = loadAnalyzerApi();
  let failures = 0;

  for (const item of tests) {
    try {
      await item.run(api);
      console.log(`PASS ${item.name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${item.name}`);
      console.error(`  ${error.stack || error.message}`);
    }
  }

  console.log(`\n${tests.length - failures}/${tests.length} tests passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
