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
    'filterRowsByCurrentAsync',
    'filterRowsWithCompleteVidsAsync',
    'calculateVidMeansAsync',
    'calculateAvgCorrelationAsync',
    'calculateReferenceBaselines',
    'calculateVidStats',
    'calculateClockStretchAsync',
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

test('one low-VID outlier does not pull every normal peer negative', api => {
  const cores = Array.from({ length: 8 }, (_, core) => core);
  const vidMeans = Object.fromEntries(cores.map(core => [
    `Core ${core} VID [V]`,
    core === 7 ? 1.060 : 1.100
  ]));
  const groups = { CPU: cores };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const stats = api.calculateVidStats(vidMeans, referenceBaselines);
  const current = Object.fromEntries(cores.map(core => [core, 0]));
  const recommendations = api.calculateOffsets(vidMeans, referenceBaselines, 3.0, current, stats, groups);

  assert.equal(referenceBaselines[0], 1.100, 'median baseline should stay with the normal cluster');
  cores.slice(0, 7).forEach(core => {
    assert.equal(recommendations[core], 0, `normal core ${core} should not chase the low outlier`);
  });
});

test('one-of-sixteen high-VID outlier is not frozen by low RMS spread', api => {
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
    stats,
    groups
  );

  assert.ok(stats.stdDev < 3.0, 'fixture must exercise the low-RMS stop condition');
  assert.ok(stats.maxHighDelta > 8.0, 'fixture must retain the high outlier');
  assert.ok(recommendations[0] < current[0], 'high-VID outlier should move more negative');
});

test('a high residual maps to its full number of complete CO steps', api => {
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
    stats,
    groups
  );

  assert.equal(recommendations[0], -43, '100 mV residual at 3 mV per step should apply 33 complete steps');
  assert.equal(recommendations[1], -10, 'baseline core should remain unchanged');
});

test('each core must clear the full VID-step deadband before moving', api => {
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
    stats,
    groups
  );

  assert.ok(stats.maxHighDelta > 3.0, 'another core must keep the pass active');
  assert.ok(recommendations[0] < current[0], 'large high-side residual should move');
  assert.equal(recommendations[1], current[1], 'sub-step residual should remain unchanged');
});

test('fractional VID response uses only complete estimated CO steps', api => {
  const vidMeans = {
    'Core 0 VID [V]': 1.0045,
    'Core 1 VID [V]': 1.0000,
    'Core 2 VID [V]': 1.0000,
    'Core 3 VID [V]': 1.0000
  };
  const groups = { CPU: [0, 1, 2, 3] };
  const { referenceBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const stats = api.calculateVidStats(vidMeans, referenceBaselines);
  const recommendations = api.calculateOffsets(
    vidMeans, referenceBaselines, 3.0, { 0: 0, 1: 0, 2: 0, 3: 0 }, stats, groups
  );

  assert.equal(recommendations[0], -1, '4.5 mV must not round up to two 3 mV steps');
});
test('positive offsets are preserved but never created or increased', api => {
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
    stats,
    groups
  );

  assert.equal(recommendations[0], 5, 'zero-step positive baseline should be preserved');
  assert.equal(recommendations[1], 4, 'a requested positive adjustment must not increase positive CO');
  assert.ok(recommendations[2] < 3, 'a high-VID core with positive CO may move downward');
  Object.entries(recommendations).forEach(([core, recommendation]) => {
    const upperBound = Math.max(0, current[core]);
    assert.ok(recommendation <= upperBound, `core ${core} increased above ${upperBound}`);
    if (current[core] <= 0) {
      assert.ok(recommendation <= 0, `core ${core} created a positive offset`);
    }
  });
});

test('a residual in one CCD does not change another CCD recommendation', api => {
  const combinedMeans = {
    'Core 0 VID [V]': 0.980,
    'Core 1 VID [V]': 1.020,
    'Core 2 VID [V]': 1.008,
    'Core 3 VID [V]': 1.000
  };
  const combinedGroups = { CCD0: [0, 1], CCD1: [2, 3] };
  const current = { 0: 0, 1: 0, 2: 0, 3: -5 };
  const combinedRefs = api.calculateReferenceBaselines(combinedMeans, combinedGroups).referenceBaselines;
  const combinedStats = api.calculateVidStats(combinedMeans, combinedRefs);
  const combined = api.calculateOffsets(
    combinedMeans,
    combinedRefs,
    3.0,
    current,
    combinedStats,
    combinedGroups
  );

  const isolatedMeans = {
    'Core 2 VID [V]': 1.008,
    'Core 3 VID [V]': 1.000
  };
  const isolatedGroups = { CCD1: [2, 3] };
  const isolatedRefs = api.calculateReferenceBaselines(isolatedMeans, isolatedGroups).referenceBaselines;
  const isolatedStats = api.calculateVidStats(isolatedMeans, isolatedRefs);
  const isolated = api.calculateOffsets(
    isolatedMeans,
    isolatedRefs,
    3.0,
    { 2: 0, 3: -5 },
    isolatedStats,
    isolatedGroups
  );

  assert.equal(combined[2], isolated[2]);
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
