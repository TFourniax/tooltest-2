import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { processHookLifecycle } from '../src/hook.mjs';
import { loadState } from '../src/state.mjs';

function fixture() {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-task-journey-'));
  execFileSync('git',['init','-q'],{cwd});
  execFileSync('git',['config','user.email','task@example.test'],{cwd});
  execFileSync('git',['config','user.name','Task Journey'],{cwd});
  fs.mkdirSync(path.join(cwd,'payments'),{recursive:true});
  fs.writeFileSync(path.join(cwd,'payments','refund.js'),"export function refund(amount) { return amount; }\n");
  execFileSync('git',['add','.'],{cwd});
  execFileSync('git',['commit','-qm','baseline'],{cwd});
  return cwd;
}

test('IDE journey keeps one precise task through loading, weak follow-up, work and handoff',()=>{
  const cwd=fixture();
  const session_id='ide-task-session';
  try {
    const first=processHookLifecycle({
      cwd,session_id,source:'claude',hook_event_name:'UserPromptSubmit',
      prompt:'Implement partial refunds in payments/refund.js and keep retries idempotent'
    });
    const taskId=first.state.sessions[session_id].task.id;
    assert.match(taskId,/^dwtask_[a-f0-9]{24}$/);
    assert.match(first.hookOutput.systemMessage,new RegExp(taskId));
    assert.match(first.hookOutput.systemMessage,/Implement partial refunds/);
    assert.equal(first.hookOutput.hookSpecificOutput.hookEventName,'UserPromptSubmit');
    assert.match(first.hookOutput.hookSpecificOutput.additionalContext,new RegExp(taskId));
    assert.match(first.hookOutput.hookSpecificOutput.additionalContext,/Primary objective: Implement partial refunds/);

    const follow=processHookLifecycle({
      cwd,session_id,source:'claude',hook_event_name:'UserPromptSubmit',prompt:'yes, continue'
    });
    assert.equal(follow.state.sessions[session_id].task.id,taskId);
    assert.equal(follow.state.sessions[session_id].task.anchor,'Implement partial refunds in payments/refund.js and keep retries idempotent');
    assert.equal(follow.state.sessions[session_id].lastTaskBoundary,'continued');
    assert.doesNotMatch(follow.hookOutput.systemMessage,/Task: yes, continue/i);
    assert.match(follow.hookOutput.systemMessage,/Task: Implement partial refunds/i);

    processHookLifecycle({
      cwd,session_id,source:'claude',hook_event_name:'PreToolUse',tool_name:'Edit',
      tool_input:{file_path:path.join(cwd,'payments','refund.js')}
    });
    fs.writeFileSync(path.join(cwd,'payments','refund.js'),"export function refund(amount, alreadyRefunded = 0) { return Math.max(0, amount - alreadyRefunded); }\n");
    const post=processHookLifecycle({
      cwd,session_id,source:'claude',hook_event_name:'PostToolUse',tool_name:'Edit',
      tool_input:{file_path:path.join(cwd,'payments','refund.js')}
    });
    if (post.hookOutput?.systemMessage) assert.doesNotMatch(post.hookOutput.systemMessage,/yes, continue/i);

    const handoff=processHookLifecycle({cwd,session_id,source:'claude',hook_event_name:'Stop'});
    const state=loadState(cwd);
    const session=state.sessions[session_id];
    assert.equal(session.task.id,taskId);
    assert.equal(session.task.completedAt!=null,true);
    assert.ok(session.featureModel?.featureKey);
    const memory=state.features?.[session.featureModel.featureKey];
    assert.ok(memory);
    assert.equal(memory.taskId,taskId);
    assert.match(memory.task,/Implement partial refunds/);
    assert.doesNotMatch(memory.task,/yes, continue/i);
    if (handoff.hookOutput?.systemMessage) {
      assert.match(handoff.hookOutput.systemMessage,new RegExp(taskId));
      assert.match(handoff.hookOutput.systemMessage,/Implement partial refunds/);
      assert.doesNotMatch(handoff.hookOutput.systemMessage,/yes, continue/i);
      assert.match(handoff.hookOutput.systemMessage,/does not claim the code is correct/i);
    }
  } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
});
