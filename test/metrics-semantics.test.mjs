import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, freshState } from '../src/state.mjs';

test('an explanation without an understanding check is unverified, not Knowledge Debt',()=>{
  const state=freshState('/tmp/example');
  state.ledger.auth.exposures=4;
  state.ledger.auth.confidence=0;
  const metrics=computeMetrics(state);
  assert.equal(metrics.conceptsSeen,1);
  assert.equal(metrics.conceptsChecked,0);
  assert.equal(metrics.conceptsUnverified,1);
  assert.equal(metrics.debt,0);
  assert.equal(metrics.coverageStatus,'unverified');
  assert.ok(metrics.unverifiedExposure>0);
});

test('explicitly weak demonstrated understanding can create Knowledge Debt',()=>{
  const state=freshState('/tmp/example');
  Object.assign(state.ledger.auth,{exposures:4,correct:0,wrong:2,confidence:0.1});
  const metrics=computeMetrics(state);
  assert.equal(metrics.conceptsChecked,1);
  assert.equal(metrics.conceptsUnverified,0);
  assert.ok(metrics.debt>0);
  assert.equal(metrics.coverageStatus,'demonstrated');
  assert.equal(metrics.coverage,10);
});

test('feature exposure without a check is not scored as feature debt',()=>{
  const state=freshState('/tmp/example');
  state.features.example={featureKey:'example',exposures:3,checks:0,confidence:0,needsRefresh:false};
  let metrics=computeMetrics(state);
  assert.equal(metrics.featuresSeen,1);
  assert.equal(metrics.featuresUnverified,1);
  assert.equal(metrics.featureDebt,0);
  state.features.example.checks=2;
  state.features.example.wrong=1;
  state.features.example.confidence=0.25;
  metrics=computeMetrics(state);
  assert.ok(metrics.featureDebt>0);
  assert.equal(metrics.featuresChecked,1);
});
