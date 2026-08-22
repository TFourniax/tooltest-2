import test from 'node:test';
import assert from 'node:assert/strict';
import { assuranceFromChangeEnvelope } from '../src/portal-snapshot.mjs';

const id='dwchg_0123456789abcdef01234567';
const sample={schema_version:'change-envelope-1',change_id:id,privacy:{code_uploaded:false,contains_prompt_text:false},proof:{tool:'diffwitness',certificate_id:'dw2_0123456789abcdef01234567',claim:'causal',accepted:true},debt:{report_schema:'debt-report-1',points:5,open_lineages:['DW-0123456789AB'],budget_passed:true}};

test('bounded assurance keeps exact identity',()=>{
  const value=assuranceFromChangeEnvelope(sample,id);
  assert.equal(value.proof.claim,'causal');
  assert.equal(value.softwareDebt.points,5);
  assert.equal(value.softwareDebt.obligations,1);
  assert.equal(JSON.stringify(value).includes('DW-0123456789AB'),false);
});

test('wrong change id is rejected',()=>{
  assert.throws(()=>assuranceFromChangeEnvelope(sample,'dwchg_aaaaaaaaaaaaaaaaaaaaaaaa'),/does not match/);
});
