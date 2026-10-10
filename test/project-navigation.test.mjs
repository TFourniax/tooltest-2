import test from 'node:test';
import assert from 'node:assert/strict';
import {declaredIntentMap,projectNavigation} from '../src/project-navigation.mjs';

test('owner declarations, Core relations and historical assurance remain separate through navigation',()=>{
  const model={header:{snapshotId:'captured'},files:[
    {path:'POLICY.md',role:'declared-document',sourceSha256:'document-hash',extraction:{description:{intent:[{line:2,text:'module.py must reject negative inputs.'},{line:3,text:'Unimplemented requirement.'}]}}},
    {path:'module.py',role:'production',sourceSha256:'code-hash',componentId:'component-1'},
    {path:'checks/case.py',role:'test',sourceSha256:'test-hash',componentId:'component-2'}],
    edges:[{from:'checks/case.py',to:'module.py',line:1}]};
  const intent=declaredIntentMap(model);
  assert.equal(intent.statements[0].components[0].path,'module.py');
  assert.equal(intent.statements[0].implementation,'UNKNOWN');
  assert.equal(intent.statements[1].components.length,0);
  const memory={objectives:[{id:'OBJ-1',kind:'objective',label:'Reject invalid input',epistemicStatus:'DECLARED',source:{eventId:'source-event',eventHash:'event-hash'}}],relations:[{source:'OBJ-1',target:'component-1',predicate:'affects',epistemicStatus:'DECLARED'}],recentRelatedChanges:[{changeId:'historical-change',files:['module.py'],proof:{claim:'causal',accepted:true}}]};
  const nav=projectNavigation(model,memory,{id:'task-1',matchedFiles:['module.py']});
  assert.equal(nav.recordedItems[0].source.eventId,'source-event');assert.equal(nav.recordedItems[0].authority,'DECLARED');
  assert.equal(nav.recordedItems[0].testCandidates[0].path,'checks/case.py');
  assert.match(nav.recordedItems[0].changes[0].meaning,/not verification/);
  assert.equal(nav.activeTask.id,'task-1');assert.equal(nav.activeTask.components[0].sourceSha256,'code-hash');
});
