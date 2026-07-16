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
