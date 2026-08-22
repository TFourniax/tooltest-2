import { inferFileRole, normalizedProjectPath, roleDescription, roleLabel } from './semantics.mjs';

const uniq = (values) => [...new Set((values || []).filter(Boolean))];
const compact = (value = '', max = 220) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
};

const CONCEPT_PLAIN = {
  auth:{ name:'identity and permissions', meaning:'This part decides who the user is and what that user is allowed to do.', risk:'If these checks are incomplete, someone can sometimes reach data or actions they should not have access to.', watch:'The important distinction is that being logged in does not automatically mean being allowed to perform every action.' },
  sql:{ name:'stored data and transactions', meaning:'This part reads or changes data that the application keeps over time.', risk:'A mistake here can leave persistent data in a partially updated or incorrect state.', watch:'Related writes should normally succeed together or fail together, and user-controlled values should not become executable query text.' },
  migration:{ name:'database structure changes', meaning:'This task changes the shape of data that already exists, not only the application code around it.', risk:'A bad migration can break old and new versions of the application or make existing data difficult to recover.', watch:'The safe question is whether deployment and rollback still work while old and new code may briefly coexist.' },
  async:{ name:'work that can overlap or finish later', meaning:'This code can continue while other work is happening, so completion order is not always obvious.', risk:'A bug may only appear when two operations overlap, a promise is forgotten, or an error is never observed.', watch:'Think about what happens if the same path runs twice at nearly the same time or one operation fails halfway through.' },
  'react-state':{ name:'interface state and effects', meaning:'This part controls what the interface remembers and when it synchronizes with things outside a render.', risk:'Duplicated state or overly broad effects can make the screen stale, trigger work twice, or create update loops.', watch:'A useful rule is to keep one source of truth and use effects only when the interface must synchronize with something external.' },
  typescript:{ name:'data contracts', meaning:'The code describes what shape it expects data to have while developers are writing the program.', risk:'Real network, database, or user input can still have the wrong shape even when TypeScript reports no compile-time error.', watch:'External data still needs runtime validation at the point where it enters trusted code.' },
  testing:{ name:'behavior verification', meaning:'The agent is adding or running checks intended to catch a wrong implementation before it reaches a user.', risk:'A test can be green while still checking the wrong thing or simply repeating the same assumption as the implementation.', watch:'The strongest test is one that would fail for a plausible wrong implementation while protecting behavior a user or system depends on.' },
  secrets:{ name:'credentials and private configuration', meaning:'This task touches values that can grant access to another system or privileged capability.', risk:'If a credential reaches source control, browser code, logs, or an error response, someone else may be able to use it.', watch:'Treat secret values as credentials: keep them out of client-delivered code and give them only the permissions they need.' },
  http:{ name:'request and API behavior', meaning:'This code defines what happens when another part of the system sends a request or event to this application.', risk:'Retries, duplicate delivery, invalid input, or unexpected status handling can make an endpoint behave differently from the happy path.', watch:'A complete contract includes validation, permissions, error behavior, and what happens if the same request arrives again.' },
  packages:{ name:'third-party dependencies', meaning:'The project is depending on code maintained outside this repository.', risk:'Every dependency adds update work and code that the project itself did not review or control.', watch:'Keep a package only when it provides enough value to justify the maintenance and supply-chain surface it adds.' },
  git:{ name:'change boundaries', meaning:'This is about keeping one agent-authored change understandable as a single unit.', risk:'Fast agent work can mix unrelated edits into one task, making review and rollback much harder.', watch:'Unrelated files in the same change are a signal to check whether scope creep has slipped in.' },
  ci:{ name:'build and deployment automation', meaning:'This code controls how changes are tested, packaged, or allowed to reach a running environment.', risk:'A small workflow change can alter production behavior or which credentials an automated job can access.', watch:'Check triggers, permissions, secret access, and how a failed release can be stopped or rolled back.' },
  concurrency:{ name:'simultaneous work on shared state', meaning:'Two pieces of work may try to read or change the same thing at nearly the same time.', risk:'The code may work every time in a sequential test and still fail intermittently under real load.', watch:'The shared resource needs an invariant that is enforced where that resource is actually owned.' },
  accessibility:{ name:'keyboard and assistive-technology access', meaning:'This task affects whether people can operate the interface without relying only on a mouse or visual cues.', risk:'A screen can look correct while remaining unusable with a keyboard or screen reader.', watch:'Prefer native semantic controls and make sure focus order and focus visibility still make sense.' },
  cache:{ name:'cached copies of data', meaning:'The application is keeping a faster copy of information that exists somewhere else as the source of truth.', risk:'The fast copy can become stale and show an old answer after the underlying data has changed.', watch:'The key questions are when the cached value stops being valid and what forces readers to see the new value.' }
};

const TERM_GLOSSARY = {
  idempotency:'Doing the same operation more than once has the same business effect as doing it once.', webhook:'A message one service sends to another service when an event happens.',
  authorization:'The decision about what an identified user is allowed to do.', authentication:'The process of establishing who a user or system is.',
  transaction:'A group of data changes that should normally succeed together or be rolled back together.', migration:'A controlled change to the structure or contents of persistent data.',
  'race condition':'A bug whose result depends on the timing or ordering of overlapping work.', cache:'A faster copy of data kept so the application does not need to recompute or reload it every time.',
  rollback:'Returning the system to a previous working version or state after a change goes wrong.', invariant:'A rule that must remain true even while the system is changing state.'
};

function phaseSentence(phase, task) {
  const quoted = task ? `“${compact(task,150)}”` : 'the current task';
  if (phase==='inspect') return `The agent is reading the project to understand how to carry out ${quoted}.`;
  if (phase==='verify') return `The agent is checking whether the changes for ${quoted} behave as intended.`;
  if (phase==='recover') return `The agent hit a problem while working on ${quoted} and is now trying to recover or correct it.`;
  if (phase==='handoff') return `The agent has finished a turn for ${quoted}. IdleProof is summarizing what changed before you accept it.`;
  if (phase==='plan') return `The agent is deciding how to approach ${quoted} before changing the project.`;
  if (phase==='reason') return `The agent is reasoning about the next step for ${quoted} using the code it has already inspected.`;
  if (phase==='implement') return `The agent is changing the project to carry out ${quoted}.`;
  return `The agent is working on ${quoted}.`;
}

function fileObservation(file, session, currentFile) {
  const normalized = normalizedProjectPath(file);
  const related = (session.taskSignals?.relatedFiles || []).find((item) => normalizedProjectPath(item.file) === normalized);
  const signals = normalized === currentFile ? (session.taskSignals || {}) : (related || {});
  const inferred = inferFileRole(normalized, signals);
  const exact = `\`${normalized}\``;
  const facts=[];
  if (signals.symbol) facts.push(`the observed symbol is \`${signals.symbol}\``);
  if (signals.route) facts.push(`it exposes or references route \`${signals.route}\``);
  if (signals.table) facts.push(`it references data surface \`${signals.table}\``);
  if ((signals.dependencies||[]).length) facts.push(`it references ${signals.dependencies.slice(0,3).map((value)=>`\`${value}\``).join(', ')}`);
  if ((signals.technologies||[]).length) facts.push(`IdleProof recognized ${signals.technologies.slice(0,3).join(', ')}`);

  let explanation;
  if (facts.length) {
    const prefix = normalized === currentFile ? 'is the file IdleProof can currently inspect most precisely' : 'was also inspected from the files touched in this task';
    explanation=`${exact} ${prefix}. It looks like ${roleDescription(inferred.role)}; ${facts.join('; ')}.`;
  } else if (inferred.confidence==='high') explanation=`${exact} was touched in this task and looks like ${roleDescription(inferred.role)}.`;
  else if (inferred.confidence==='medium') explanation=`${exact} was touched in this task. Its path suggests ${roleDescription(inferred.role)}, but IdleProof treats that as an inference rather than a proven runtime responsibility.`;
  else explanation=`${exact} was touched in this task. IdleProof will keep its exact name instead of inventing a business role that the available evidence does not support.`;
  return { path:normalized, role:inferred.role, roleLabel:roleLabel(inferred.role), confidence:inferred.confidence, evidence:inferred.evidence, explanation };
}

function conceptPlain(concept) { return CONCEPT_PLAIN[concept?.id] || null; }
function detectedTerms(text) { const lower=String(text||'').toLowerCase(); return Object.entries(TERM_GLOSSARY).filter(([term])=>lower.includes(term)).map(([term,meaning])=>({term,meaning})).slice(0,5); }
function surfaceSentence(signals={}) {
  const parts=[];
  if (signals.symbol) parts.push(`the work is currently centered on \`${signals.symbol}\``);
  if (signals.route) parts.push(`the task touches route \`${signals.route}\``);
  if (signals.table) parts.push(`the task touches stored data named \`${signals.table}\``);
  if ((signals.dependencies||[]).length) parts.push(`the current file references ${signals.dependencies.slice(0,3).map((value)=>`\`${value}\``).join(', ')}`);
  if ((signals.technologies||[]).length) parts.push(`recognized stack signals include ${signals.technologies.slice(0,3).join(', ')}`);
  return parts.length ? `${parts.join('; ')}.` : '';
}
function watchItems(concept,files,signals={}) {
  const items=[]; const plain=conceptPlain(concept); if (plain?.watch) items.push(plain.watch); const roles=new Set(files.map((item)=>item.role));
  if (roles.has('migration')) items.push('Because a migration is involved, a rollback or mixed old/new deployment deserves explicit attention.');
  if (roles.has('infra')) items.push('Because deployment or infrastructure files are involved, check permissions, triggers, and rollback behavior before treating the task as low risk.');
  if (roles.has('worker')) items.push('Background work can fail or retry away from the screen the user is looking at, so duplicate execution and recovery paths matter.');
  if (roles.has('test')) items.push('A touched test is evidence of verification work, but a green test only proves the behavior that test actually discriminates.');
  if (signals.table) items.push(`Changes around \`${signals.table}\` can outlive the current process because that data is persistent.`);
  return uniq(items).slice(0,4);
}

export function buildPlainExplanation({session={},concept=null,phase='work'}={}) {
  const task=compact(session.prompt||'',180);
  const currentFile=normalizedProjectPath(session.taskSignals?.file || session.currentResource || [...(session.touchedFiles||[])].at(-1) || '');
  const touched=uniq([currentFile,...(session.touchedFiles||[]).map(normalizedProjectPath)]).filter(Boolean).slice(0,10);
  const files=touched.map((file)=>fileObservation(file,session,currentFile));
  const current=files.find((item)=>item.path===currentFile)||files[0]||null;
  const plain=conceptPlain(concept); const signals=session.taskSignals||{};
  const doing=[phaseSentence(phase,task),current?`Right now, the clearest local evidence is in \`${current.path}\`${signals.symbol?` around \`${signals.symbol}\``:''}.`:'',surfaceSentence(signals)].filter(Boolean).join(' ');
  const fileDetails=files.slice(0,6).map((item)=>item.explanation).join(' ');
  const project=files.length ? `IdleProof observed ${files.length===1?'this file':`${files.length} files`} in the current task: ${files.map((item)=>`\`${item.path}\``).join(', ')}. ${fileDetails}` : 'IdleProof has the task context but has not yet observed a project-local file closely enough to make a file-specific claim.';
  const why=plain ? `${plain.meaning} ${plain.risk}` : 'This matters because the agent is changing behavior inside your project. IdleProof can explain the observed files and boundaries, but it will not invent a more specific business meaning until the code provides stronger evidence.';
  const expectedOutcome=phase==='handoff' ? 'At this point, the useful question is whether the finished change matches the task and whether the important boundaries have actually been verified.' : `If the agent succeeds, the project should satisfy ${task?`the requested outcome “${task}”`:'the current requested outcome'} while preserving the surrounding behavior that this task depends on.`;
  const watch=watchItems(concept,files,signals);
  const terms=detectedTerms(`${doing} ${project} ${why} ${watch.join(' ')} ${concept?.lesson||''}`);
  return {
    schema:'idleproof.explanation.v1', title:task?'What this task means in your project':'What the agent is doing in your project', doing, project, why, expectedOutcome, watch, files,
    concept:plain?{id:concept.id,name:plain.name}:null, terms,
    certainty:{ level:current&&signals.symbol?'observed-plus-inferred':'bounded-inference', limitations:[
      'File roles are inferred from observed paths and static local context; they are not a proven runtime call graph.',
      'IdleProof distinguishes observed facts from inferred responsibility and keeps exact project names when evidence is weak.',
      'Whether the change is actually correct is a proof question for tests and DiffWitness, not something this explanation claims by itself.'
    ]}, optionalCheck:true
  };
}
