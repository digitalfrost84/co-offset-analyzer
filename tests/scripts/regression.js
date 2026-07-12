const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const fixtureDir = path.join(root, 'tests', 'fixtures');
const expectedDir = path.join(root, 'tests', 'expected');
const update = process.argv.includes('--update');
const pageArgIndex = process.argv.indexOf('--page');
const pageFile = pageArgIndex >= 0 ? process.argv[pageArgIndex + 1] : 'index.html';

if (!pageFile || !/^[\w.-]+\.html$/i.test(pageFile)) {
  throw new Error('--page requires an HTML filename in the repository root');
}

const fixtures = [
  'bench_for_CO_Offset_Analyzer.CSV',
  'hohohaha_deutsch.CSV',
  'hwinfo_16core_deutsch.csv',
  'hohohaha6-large.csv'
];

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
    this.classList = {
      add: () => {},
      remove: () => {}
    };
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
  const html = fs.readFileSync(path.join(root, pageFile), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  if (scripts.length !== 1) {
    throw new Error(`Expected one script block, found ${scripts.length}`);
  }

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
    'parseCSVAsync',
    'detectCCDGroups',
    'resolveLoadSensor',
    'detectCoreCount',
    'isCoreVidColumn',
    'getCoreIndexFromVidColumn',
    'resolveLoadThresholdAsync',
    'filterRowsByCurrentAsync',
    'filterRowsWithCompleteVidsAsync',
    'calculateVidMeansAsync',
    'calculateAvgCorrelationAsync',
    'resolveAnalysisGroups',
    'calculateReferenceBaselines',
    'calculateVidStats',
    'calculateClockStretchAsync',
    'calculateLimitHeadroom',
    'calculateOffsets'
  ];

  const exportBlock = `\nglobalThis.__api = { ${exports.join(', ')} };\n`;
  vm.runInNewContext(scripts[0] + exportBlock, context, { filename: pageFile });
  return context.__api;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundMap(values, digits = 6) {
  return Object.fromEntries(
    Object.entries(values)
      .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
      .map(([key, value]) => [key, round(value, digits)])
  );
}

function sortedObject(values) {
  return Object.fromEntries(
    Object.entries(values).sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
  );
}

async function analyzeFixture(api, fixture) {
  const fixturePath = path.join(fixtureDir, fixture);
  const csvText = fs.readFileSync(fixturePath, 'utf8');
  const analysisId = 0;
  const data = await api.parseCSVAsync(csvText, analysisId);
  if (!data) throw new Error(`${fixture}: failed to parse CSV`);

  const detected = api.detectCoreCount(data.headers);
  const selectedCoreCount = detected || 8;
  const vidCols = data.headers
    .filter(api.isCoreVidColumn)
    .filter(header => {
      const coreIdx = api.getCoreIndexFromVidColumn(header);
      return coreIdx !== null && coreIdx < selectedCoreCount;
    });
  const coreIndexes = vidCols
    .map(api.getCoreIndexFromVidColumn)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const loadSensor = api.resolveLoadSensor(data.headers);
  if (!loadSensor) throw new Error(`${fixture}: no load sensor detected`);

  const loadThreshold = await api.resolveLoadThresholdAsync(
    data.rows,
    data.headers,
    loadSensor,
    coreIndexes,
    selectedCoreCount,
    'auto',
    70,
    analysisId
  );
  const loadRows = await api.filterRowsByCurrentAsync(
    data.rows,
    loadSensor,
    loadThreshold.current,
    analysisId,
    loadThreshold.usageSensor,
    loadThreshold.usageThreshold
  );
  if (loadRows.length === 0) throw new Error(`${fixture}: no rows passed load threshold`);
  const validRows = await api.filterRowsWithCompleteVidsAsync(loadRows, vidCols, analysisId);
  if (validRows.length === 0) throw new Error(`${fixture}: no complete VID rows passed`);

  const vidMeans = await api.calculateVidMeansAsync(validRows, vidCols, analysisId);
  const correlation = await api.calculateAvgCorrelationAsync(validRows, vidCols, analysisId);
  const groups = api.resolveAnalysisGroups(data.headers, coreIndexes);
  const { referenceBaselines, groupBaselines } = api.calculateReferenceBaselines(vidMeans, groups);
  const vidStats = api.calculateVidStats(vidMeans, referenceBaselines);
  const clockStretch = await api.calculateClockStretchAsync(validRows, data.headers, coreIndexes, analysisId);
  const limitHeadroom = api.calculateLimitHeadroom(data.rows, validRows, data.headers);
  const currentOffsets = Object.fromEntries(coreIndexes.map(core => [core, 0]));
  const recommendations = api.calculateOffsets(vidMeans, referenceBaselines, 3.0, currentOffsets, vidStats, groups);

  return {
    fixture,
    headers: data.headers.length,
    totalRows: data.rows.length,
    validRows: validRows.length,
    validPercent: round((validRows.length / data.rows.length) * 100, 3),
    detectedCoreCount: detected,
    analyzedCores: coreIndexes,
    loadSensor: {
      kind: loadSensor.kind,
      label: loadSensor.label,
      note: loadSensor.note
    },
    loadThreshold: {
      mode: loadThreshold.mode,
      method: loadThreshold.method || null,
      current: round(loadThreshold.current, 1),
      usageThreshold: loadThreshold.usageThreshold,
      usageSensorLabel: loadThreshold.usageSensorLabel || '',
      highUsageRows: loadThreshold.highUsageRows || 0,
      maxCurrent: round(loadThreshold.maxCurrent, 3),
      p90: round(loadThreshold.p90, 3),
      p95: round(loadThreshold.p95, 3)
    },
    stats: {
      stdDev: round(vidStats.stdDev, 6),
      maxHighDelta: round(vidStats.maxHighDelta, 6),
      correlation: round(correlation, 6)
    },
    groups: sortedObject(groups),
    groupBaselines: roundMap(groupBaselines),
    vidMeans: roundMap(vidMeans),
    recommendations: sortedObject(recommendations),
    limitHeadroom: limitHeadroom.available
      ? {
          status: limitHeadroom.status,
          primary: limitHeadroom.primary.key,
          wholeLogRows: limitHeadroom.wholeLog.primary.rows,
          wholeLogMax: round(limitHeadroom.wholeLog.primary.max, 3)
        }
      : null,
    clockStretch: clockStretch
      ? {
          available: clockStretch.available,
          suspectCount: clockStretch.suspectCount,
          watchCount: clockStretch.watchCount,
          worstP95Pct: round(clockStretch.worstP95, 3),
          checkedCores: Object.keys(clockStretch.summaries).map(Number).sort((a, b) => a - b)
        }
      : null
  };
}

function expectedPathFor(fixture) {
  return path.join(expectedDir, `${fixture}.json`);
}

async function main() {
  const api = loadAnalyzerApi();
  fs.mkdirSync(expectedDir, { recursive: true });
  const multiline = await api.parseCSVAsync('Name,Value\n"line one\nline two",42\n', 0);
  if (multiline.rows.length !== 1 || multiline.rows[0].Name !== 'line one\nline two') {
    throw new Error('quoted multiline CSV fields are not parsed as one record');
  }

  const topologyFallback = api.detectCCDGroups([], Array.from({ length: 16 }, (_, core) => core));
  if (Object.keys(topologyFallback).length !== 1 || !topologyFallback.CPU) {
    throw new Error('unknown CPU topology must use a whole-CPU baseline');
  }

  let failures = 0;
  for (const fixture of fixtures) {
    const actual = await analyzeFixture(api, fixture);
    const expectedPath = expectedPathFor(fixture);
    const actualJson = `${JSON.stringify(actual, null, 2)}\n`;

    if (update) {
      fs.writeFileSync(expectedPath, actualJson);
      console.log(`updated ${path.relative(root, expectedPath)}`);
      continue;
    }

    if (!fs.existsSync(expectedPath)) {
      failures++;
      console.error(`FAIL ${fixture}: missing expected snapshot`);
      console.error('  create it explicitly with: node tests/scripts/regression.js --update');
      continue;
    }

    const expectedJson = fs.readFileSync(expectedPath, 'utf8');
    const expected = JSON.parse(expectedJson);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures++;
      console.error(`FAIL ${fixture}: regression snapshot changed`);
      console.error(`  update with: node tests/scripts/regression.js --update`);
    } else {
      console.log(`PASS ${fixture}`);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
