const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const rootPath = path.join(root, 'index.html');
const v1Path = path.join(root, 'index-v1.html');
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
    this.queryResults = [];
    this.className = '';
    this.classList = { add: () => {}, remove: () => {} };
  }

  addEventListener() {}

  appendChild(child) {
    this.children.push(child);
  }

  querySelectorAll() {
    return this.queryResults;
  }

  matches(selector) {
    return selector === 'input[id^="offset"]' && this.id.startsWith('offset');
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
    querySelectorAll: selector => selector === '#offsetInputs input'
      ? getElementById('offsetInputs').queryResults
      : []
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
    `${scripts[0]}\nglobalThis.__v2 = { displayResultsV2, showErrorV2, refreshRecommendationsFromCurrentOffsets, calculateOffsets, document };`,
    context,
    { filename: 'index-v2.html' }
  );
  return context.__v2;
}

function loadV1Harmonizer() {
  const html = fs.readFileSync(v1Path, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.equal(scripts.length, 1, 'V1 must retain one self-contained analysis script');
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
    `${scripts[0]}\nglobalThis.__v1 = { calculateOffsets };`,
    context,
    { filename: 'index-v1.html' }
  );
  return context.__v1;
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
    residualRange: 2.95,
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

function plain(value) {
  return JSON.parse(JSON.stringify(value));
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
  const v1Html = fs.readFileSync(v1Path, 'utf8');
  const html = fs.readFileSync(v2Path, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.equal(rootHtml, html, 'Pages root must publish the V2 interface');
  assert.match(v1Html, /<title>CO Offset Analyzer<\/title>/, 'the original V1 interface must remain available');
  assert.match(v1Html, /function calculateOffsets\(vidMeans, referenceMeans, mvStep, currentOffsets, residualRange, groups = null\)/, 'V1 must retain the shared field harmonizer');
  assert.match(html, /<title>CO Offset Analyzer — V2<\/title>/);
  assert.match(html, /href="v2\.css"/);
  assert.match(html, /offsetInputs'\)\.addEventListener\('input'/);
  assert.match(html, /getElementById\('mvStep'\)\.addEventListener\('input', refreshRecommendationsFromCurrentOffsets\)/);
  assert.match(html, /function refreshRecommendationsFromCurrentOffsets\(\)/);
  assert.match(html, /const groupBaseline = values\.reduce\(\(sum, value\) => sum \+ value, 0\) \/ values\.length/);
  assert.match(html, /function calculateOffsets\(vidMeans, referenceBaselines, mvStep, currentOffsets, residualRange, groups = null\)/);
  assert.match(html, /if \(magnitude <= actionThreshold \+ 1e-9\) return 0/);
  assert.match(html, /CO offsets used for this log/);
  assert.match(html, /Enter the values that were active while this CSV was recorded\./);
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
  const v1Api = loadV1Harmonizer();
  const userResiduals = [-0.97, 1.51, -1.86, 0.40, -0.31, -0.49, 0.37, 1.34];
  const userCores = userResiduals.map((_, core) => core);
  const userMeans = Object.fromEntries(userCores.map(core => [`Core ${core} VID [V]`, 1 + userResiduals[core] / 1000]));
  const userBaselines = Object.fromEntries(userCores.map(core => [core, 1]));
  const userCurrent = { 0: -19, 1: -11, 2: -19, 3: -20, 4: -19, 5: -13, 6: -24, 7: -23 };
  const v2UserResult = plain(api.calculateOffsets(userMeans, userBaselines, 3.0, userCurrent, 3.37, { CPU: userCores }));
  const v1UserResult = plain(v1Api.calculateOffsets(userMeans, userBaselines, 3.0, userCurrent, 3.37, { CPU: userCores }));
  assert.deepEqual(v2UserResult, { ...userCurrent, 2: -18 }, 'the user example must change only C2');
  assert.deepEqual(v1UserResult, v2UserResult, 'V1 and V2 must share the same harmonization result');
  const noChange = render(api, baseResults());
  assert.match(noChange, /No changes recommended/);
  assert.match(noChange, /Core VID residuals/);
  assert.match(noChange, /Current offsets unchanged/);
  assert.match(noChange, /Keep C0 at 0<\/strong><small>unchanged · zero anchor/);
  assert.match(noChange, /Keep C7 at 0<\/strong><small>unchanged · zero anchor/);
  assert.match(noChange, /id="copyText"/);
  assert.doesNotMatch(noChange, /residual-dot high/);
  assert.equal((noChange.match(/class="residual-guide lower"/g) || []).length, 8, 'each core row must render the lower half-step guide');
  assert.equal((noChange.match(/class="residual-guide upper"/g) || []).length, 8, 'each core row must render the upper half-step guide');
  assert.match(noChange, /−1\.5 mV/, 'the lower guide must be half a CO step below zero');
  assert.match(noChange, /\+1\.5 mV/, 'the upper guide must be half a CO step above zero');
  assert.doesNotMatch(noChange, /rail context|LLC|experimental/i);

  const changedResults = baseResults();
  changedResults.maxDelta = 4.5;
  changedResults.vidMeans['Core 3 VID [V]'] = 1.1045;
  changedResults.recommendations[3] = -1;
  const changed = render(api, changedResults);
  assert.match(changed, /1 offset to apply/);
  assert.match(changed, /Set C3 to -1<\/strong><small>from 0 · 1 step more negative/);
  assert.match(changed, /Keep C0 at 0<\/strong><small>unchanged · zero anchor/);
  assert.match(changed, /Keep C7 at 0<\/strong><small>unchanged · zero anchor/);
  assert.match(changed, /Set these final values/);
  assert.match(changed, /fresh HWiNFO log/);
  assert.match(changed, /Copy offsets/);
  assert.match(changed, /I applied them/);
  assert.doesNotMatch(changed, /Trial offsets ready|Use trial/);
  assert.match(changed, /residual-dot high/);

  const liveResults = api.document.getElementById('results');
  const offsetInputs = api.document.getElementById('offsetInputs');
  offsetInputs.queryResults = Array.from({ length: 8 }, (_, core) => {
    const input = api.document.getElementById(`offset${core}`);
    input.value = core === 3 ? '-15' : '0';
    return input;
  });
  changedResults.currentOffsets[3] = -15;
  changedResults.measuredVidMeans = { ...changedResults.vidMeans };
  changedResults.vidMeans['Core 3 VID [V]'] += 0.045;
  changedResults.maxDelta = 49.5;
  changedResults.recommendations[3] = -16;
  api.displayResultsV2(liveResults, changedResults);
  offsetInputs.queryResults[3].value = '-30';
  api.refreshRecommendationsFromCurrentOffsets();
  assert.match(liveResults.innerHTML, /\+4\.81 mV/, 'editing offsets must retain the residuals measured in the loaded log');
  assert.match(liveResults.innerHTML, /Keep C1 at 0<\/strong><small>unchanged · zero anchor/, 'a low residual pinned at CO zero must remain the rebase anchor');
  assert.match(liveResults.innerHTML, /Set C3 to -33<\/strong><small>from -30 · 3 steps more negative/, 'the bounded field must rebase C3 toward the pinned low anchor');
  assert.match(liveResults.innerHTML, /Set C7 to -2<\/strong><small>from 0 · 2 steps more negative/, 'the bounded field must rebase the other movable cores needed to close the interval');

  const beforeMvStepChange = liveResults.innerHTML;
  const beforeLowerGuide = beforeMvStepChange.match(/class="residual-guide lower" style="left:([0-9.]+)%"/);
  const beforeUpperGuide = beforeMvStepChange.match(/class="residual-guide upper" style="left:([0-9.]+)%"/);
  assert.ok(beforeLowerGuide && beforeUpperGuide, 'both plot guides must expose their rendered positions');
  api.document.getElementById('mvStep').value = '6.0';
  api.refreshRecommendationsFromCurrentOffsets();
  assert.notEqual(liveResults.innerHTML, beforeMvStepChange, 'changing mV per CO step must recompute the rendered result');
  const afterLowerGuide = liveResults.innerHTML.match(/class="residual-guide lower" style="left:([0-9.]+)%"/);
  const afterUpperGuide = liveResults.innerHTML.match(/class="residual-guide upper" style="left:([0-9.]+)%"/);
  assert.ok(afterLowerGuide && afterUpperGuide, 'both recomputed plot guides must expose their rendered positions');
  assert.notEqual(afterLowerGuide[1], beforeLowerGuide[1], 'the lower plot guide must move when mV per CO step changes');
  assert.notEqual(afterUpperGuide[1], beforeUpperGuide[1], 'the upper plot guide must move when mV per CO step changes');
  assert.match(liveResults.innerHTML, /−3\.0 mV/, 'the lower plot guide must move to half the edited mV per CO step value');
  assert.match(liveResults.innerHTML, /\+3\.0 mV/, 'the upper plot guide must move to half the edited mV per CO step value');
  assert.doesNotMatch(liveResults.innerHTML, /[−+]1\.5 mV/, 'the old half-step guide labels must be replaced after recomputation');

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
  console.log('PASS V1 and V2 shared harmonizer');
  console.log('PASS V2 no-change renderer');
  console.log('PASS V2 actionable renderer');
  console.log('PASS V2 live current-offset recomputation');
  console.log('PASS V2 gated renderer');
  console.log('PASS V2 alert semantics');
}

main();
