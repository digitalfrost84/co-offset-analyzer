const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const rootPath = path.join(root, 'index.html');
const v2Path = path.join(root, 'index-v2.html');
const cssPath = path.join(root, 'v2.css');

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
      if (Object.prototype.hasOwnProperty.call(defaults, id)) element.value = defaults[id];
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

function loadV2Renderer() {
  const html = fs.readFileSync(v2Path, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.equal(scripts.length, 1, 'V2 must retain one self-contained analysis script');

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
  vm.runInNewContext(
    `${scripts[0]}\nglobalThis.__v2 = { displayResultsV2, showErrorV2 };`,
    context,
    { filename: 'index-v2.html' }
  );
  return context.__v2;
}

function baseResults() {
  const means = [1.10005, 1.09404, 1.09995, 1.10263, 1.10080, 1.09787, 1.09874, 1.10160];
  const cores = Array.from({ length: 8 }, (_, core) => core);
  return {
    totalRows: 50,
    validRows: 50,
    minCurrent: 78.4,
    loadThreshold: {
      mode: 'auto',
      method: 'cpuUsage',
      current: 78.4,
      usageThreshold: 80,
      maxCurrent: 89.4
    },
    stdDev: 2.5,
    maxDelta: 2.63,
    correlation: 0.95,
    mvStep: 3.0,
    vidMeans: Object.fromEntries(cores.map(core => [`Core ${core} VID [V]`, means[core]])),
    referenceBaselines: Object.fromEntries(cores.map(core => [core, 1.1])),
    groupBaselines: { CPU: 1.1 },
    groups: { CPU: cores },
    currentOffsets: Object.fromEntries(cores.map(core => [core, 0])),
    recommendations: Object.fromEntries(cores.map(core => [core, 0])),
    recommendationGate: { actionable: true, reason: '' },
    clockStretch: { available: false, summaries: {}, suspectCount: 0, watchCount: 0, worstP95: 0 },
    limitHeadroom: {
      available: true,
      status: 'bound',
      analysis: {
        summaries: [
          { key: 'ppt', label: 'PPT', p95: 99 },
          { key: 'tdc', label: 'TDC', p95: 72 },
          { key: 'edc', label: 'EDC', p95: 58 },
          { key: 'thermal', label: 'Thermal', p95: 92 }
        ]
      }
    },
    loadSensor: { kind: 'current' },
    railContext: { available: true, meanCurrent: 84.2, meanVoltage: 1.1459 }
  };
}

function render(api, results) {
  const container = new TestElement('results');
  api.displayResultsV2(container, results);
  return container.innerHTML;
}

function assertStaticContract(html) {
  const staticHtml = html.split('<script>')[0];
  const requiredIds = [
    'status', 'coreCount', 'coreDetect', 'loadThresholdMode', 'loadThresholdNote',
    'minCurrent', 'mvStep', 'analysisScope', 'scopeDetect', 'csvFile', 'fileName',
    'progressWrap', 'progressPhase', 'progressDetail', 'progressBar', 'offsetInputs',
    'csvText', 'analyzeButton', 'results'
  ];
  requiredIds.forEach(id => {
    const matches = staticHtml.match(new RegExp(`id=["']${id}["']`, 'g')) || [];
    assert.equal(matches.length, 1, `V2 DOM contract requires one #${id}`);
  });
}

function main() {
  const rootHtml = fs.readFileSync(rootPath, 'utf8');
  const html = fs.readFileSync(v2Path, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.equal(rootHtml, html, 'Pages root must publish the V2 interface');
  assert.match(html, /<title>CO Offset Analyzer — V2<\/title>/);
  assert.match(html, /href="v2\.css"/);
  assert.match(html, /family=Inter:wght@400\.\.700&amp;family=Recursive:MONO,wght@1,400\.\.700/);
  assert.match(css, /--accent:\s*#d58f0b/i);
  assert.match(css, /--font-sans:\s*"Inter"/);
  assert.match(css, /--font-mono:\s*"Recursive"/);
  assert.match(css, /\.offset-input input\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
  assert.match(css, /\.trial-list-v2\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
  assert.match(css, /#minCurrent,[^}]*#mvStep\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
  assert.match(css, /\.summary-stat-value\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
  assert.match(css, /\.residual-core\s*\{[^}]*white-space:\s*nowrap/s);
  assertStaticContract(html);

  const api = loadV2Renderer();
  const noChange = render(api, baseResults());
  assert.match(noChange, /No changes recommended/);
  assert.match(noChange, /Core VID residuals/);
  assert.match(noChange, /Current offsets unchanged/);
  assert.match(noChange, /id="copyText"/);
  assert.doesNotMatch(noChange, /residual-dot high/);
  assert.doesNotMatch(noChange, /rail context|LLC|experimental/i);

  const changedResults = baseResults();
  changedResults.maxDelta = 4.5;
  changedResults.vidMeans['Core 3 VID [V]'] = 1.1045;
  changedResults.recommendations[3] = -1;
  const changed = render(api, changedResults);
  assert.match(changed, /1 offset to apply/);
  assert.match(changed, /C3<\/strong> 0 → -1/);
  assert.match(changed, /Apply these offsets/);
  assert.match(changed, /fresh HWiNFO log/);
  assert.match(changed, /Copy offsets/);
  assert.match(changed, /I applied them/);
  assert.doesNotMatch(changed, /Trial offsets ready|Use trial/);
  assert.match(changed, /residual-dot high/);

  const gatedResults = baseResults();
  gatedResults.validRows = 20;
  gatedResults.recommendationGate = {
    actionable: false,
    reason: 'Only 20 complete load rows; at least 30 are required.'
  };
  const gated = render(api, gatedResults);
  assert.match(gated, /No trial generated/);
  assert.doesNotMatch(gated, /Use trial|Copy values/);

  const errorContainer = new TestElement('results');
  api.showErrorV2(errorContainer, 'Bad input');
  assert.match(errorContainer.innerHTML, /role="alert"/);

  console.log('PASS Pages root publishes V2');
  console.log('PASS V2 DOM contract');
  console.log('PASS V2 no-change renderer');
  console.log('PASS V2 actionable renderer');
  console.log('PASS V2 gated renderer');
  console.log('PASS V2 alert semantics');
}

main();
