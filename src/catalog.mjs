export const CONCEPTS = [
  {
    id: 'auth', title: 'Authentication & sessions', level: 'high-risk', risk: 5, seconds: 42,
    patterns: [/\bauth(?:entication|orization)?\b/i, /\bsessions?\b/i, /\bjwts?\b/i, /\boauth(?:2)?\b/i, /\bcookies?\b/i, /\blog(?:in|out)\b/i, /\bbcrypt\b/i, /\bargon(?:2)?\b/i],
    lesson: 'Authentication proves identity; authorization decides what that identity may do. Keep those checks server-side, scope sessions narrowly, and treat cookies/tokens as credentials rather than UI state.',
    why: 'Auth bugs often look fine in happy-path demos but become account-takeover or privilege-escalation bugs in production.',
    review: 'Verify the server rejects an authenticated user who lacks the specific permission—not only an unauthenticated user.',
    question: 'Which check must still happen after a user is successfully authenticated?',
    options: ['Authorization for the requested action', 'CSS validation', 'Client-side route rendering'], answer: 0
  },
  {
    id: 'sql', title: 'SQL & transactions', level: 'high-risk', risk: 5, seconds: 38,
    patterns: [/\bsql\b/i, /select\s/i, /insert\s/i, /update\s/i, /delete\s+from/i, /transaction/i, /postgres/i, /mysql/i, /sqlite/i],
    lesson: 'A transaction groups related writes into one atomic unit. Parameterized queries protect values from becoming executable SQL; constraints protect invariants even when application code is wrong.',
    why: 'Data bugs can survive tests, corrupt state permanently, and are expensive to unwind.',
    review: 'Check whether multi-step writes can leave partial state if the second step fails.',
    question: 'What is the strongest default defense against SQL injection in application queries?', options: ['Parameterized queries', 'Escaping in the UI', 'Longer table names'], answer: 0
  },
  {
    id: 'migration', title: 'Database migrations', level: 'high-risk', risk: 5, seconds: 45,
    patterns: [/migration/i, /migrate/i, /schema\.sql/i, /prisma/i, /drizzle/i, /alter\s+table/i, /create\s+table/i],
    lesson: 'A safe migration is compatible with both the old and new application during rollout. Prefer expand → migrate data → switch reads/writes → contract over one destructive jump.',
    why: 'Schema changes are one of the easiest ways for a seemingly correct agent patch to become irreversible production damage.',
    review: 'Ask whether the deploy can be rolled back while the new schema is already present.',
    question: 'Why is expand-and-contract safer than a one-step destructive migration?', options: ['It preserves compatibility during rollout', 'It makes SQL shorter', 'It removes the need for backups'], answer: 0
  },
  {
    id: 'async', title: 'Async JavaScript', level: 'core', risk: 3, seconds: 30,
    patterns: [/async/i, /await/i, /promise/i, /settimeout/i, /allsettled/i],
    lesson: 'await pauses the current async function, not the whole process. Parallel work needs explicit concurrency; shared mutable state still needs careful sequencing.',
    why: 'Agent-written async code often works in a single test and fails under overlapping requests.',
    review: 'Look for work that could race, be forgotten because it is not awaited, or fail without being observed.',
    question: 'What does `await` pause?', options: ['The current async function', 'The entire Node.js process', 'All network requests'], answer: 0
  },
  {
    id: 'react-state', title: 'React state & effects', level: 'core', risk: 3, seconds: 34,
    patterns: [/useeffect/i, /usestate/i, /usereducer/i, /react/i, /\.tsx\b/i, /jsx/i],
    lesson: 'Render should stay pure. State describes data that changes UI; effects synchronize with systems outside React. An effect that only derives one piece of state from another is often unnecessary.',
    why: 'Redundant state and broad effects create stale data, loops, and UI behavior that is hard to reason about.',
    review: 'Check whether every effect genuinely synchronizes with something external.',
    question: 'What is the best use of a React effect?', options: ['Synchronizing with an external system', 'Computing every derived value', 'Replacing normal event handlers'], answer: 0
  },
  {
    id: 'typescript', title: 'TypeScript contracts', level: 'core', risk: 2, seconds: 28,
    patterns: [/typescript/i, /\.ts\b/i, /\.tsx\b/i, /interface\s/i, /type\s+[A-Z]/i, /unknown/i],
    lesson: 'TypeScript checks assumptions at compile time, but runtime inputs remain untrusted. Use narrow types internally and runtime validation at network, storage, and user-input boundaries.',
    why: 'A green type-check does not prove that API payloads or persisted data match the declared type.',
    review: 'Find the boundary where untyped external data enters and verify it is validated there.',
    question: 'Where is runtime validation most important in a TypeScript app?', options: ['At external data boundaries', 'Only inside CSS files', 'Nowhere if `strict` is enabled'], answer: 0
  },
  {
    id: 'testing', title: 'Testing strategy', level: 'core', risk: 3, seconds: 32,
    patterns: [/\btests?\b/i, /vitest/i, /jest/i, /playwright/i, /cypress/i, /pytest/i, /spec\./i],
    lesson: 'Good tests protect behavior, not implementation trivia. The highest-value tests cover important user or system outcomes and failure paths that would be expensive to discover in production.',
    why: 'Agents can generate many passing tests that simply mirror their own implementation assumptions.',
    review: 'Look for one test that would fail if the implementation were subtly wrong but still syntactically valid.',
    question: 'What should a robust test primarily protect?', options: ['Observable behavior and invariants', 'Exact internal variable names', 'The agent prompt wording'], answer: 0
  },
  {
    id: 'secrets', title: 'Secrets & configuration', level: 'high-risk', risk: 5, seconds: 36,
    patterns: [/\.env/i, /secret/i, /api[_-]?key/i, /token/i, /credential/i, /process\.env/i],
    lesson: 'Secrets belong outside source control and outside client bundles. Environment variables are a delivery mechanism, not a permission system; production access still needs least privilege and rotation.',
    why: 'Leaked credentials can turn one bad commit into a full infrastructure incident.',
    review: 'Verify no secret value is committed, logged, serialized to the browser, or exposed through an error response.',
    question: 'Which statement is safest?', options: ['Client-delivered code cannot safely contain a secret', 'An obfuscated frontend key is secret', 'A `.env` file is always safe to commit'], answer: 0
  },
  {
    id: 'http', title: 'HTTP & API contracts', level: 'core', risk: 3, seconds: 31,
    patterns: [/fetch\(/i, /axios/i, /route/i, /endpoint/i, /api\//i, /request/i, /response/i, /status\(/i],
    lesson: 'An API contract includes method, path, input validation, authorization, status semantics, idempotency, and error shape. Happy-path JSON is only one part of it.',
    why: 'Contract drift is a common source of “works locally” failures between independently changed components.',
    review: 'Check one invalid-input case and one retry/duplicate-request case.',
    question: 'What property matters when the same write request may be retried?', options: ['Idempotency', 'Font weight', 'Source-map size'], answer: 0
  },
  {
    id: 'packages', title: 'Dependencies & supply chain', level: 'high-risk', risk: 4, seconds: 33,
    patterns: [/npm\s+(i|install|add)/i, /pnpm\s+add/i, /yarn\s+add/i, /pip\s+install/i, /package\.json/i, /requirements\.txt/i],
    lesson: 'Every dependency adds code you did not review, update work, and supply-chain exposure. Prefer platform primitives or established packages when the maintenance tradeoff is favorable.',
    why: 'AI agents can introduce unnecessary or even hallucinated packages because adding a dependency is cheap for the model.',
    review: 'For each new package, ask whether the repository already has a primitive that solves the same problem.',
    question: 'What is a hidden cost of adding a small dependency?', options: ['Maintenance and supply-chain surface', 'Fewer lockfile lines', 'Guaranteed performance'], answer: 0
  },
  {
    id: 'git', title: 'Git & change boundaries', level: 'core', risk: 2, seconds: 24,
    patterns: [/\bgit\b/i, /commit/i, /branch/i, /rebase/i, /merge/i],
    lesson: 'Small, coherent changes are easier to verify and revert. A commit is most useful when it represents one understandable idea and leaves the repository in a valid state.',
    why: 'Agent speed can hide scope creep inside a task that sounded small.',
    review: 'Scan for unrelated files; if you cannot state the change in one sentence, the boundary may be too broad.',
    question: 'Why are small coherent commits valuable with coding agents?', options: ['They are easier to verify and revert', 'They make agents use more tokens', 'They eliminate testing'], answer: 0
  },
  {
    id: 'ci', title: 'CI/CD & deployment', level: 'high-risk', risk: 4, seconds: 40,
    patterns: [/\.github\/workflows/i, /github actions/i, /deploy/i, /docker/i, /ci\/cd/i, /netlify/i, /vercel/i, /production/i],
    lesson: 'Deployment automation is executable production policy. Pin critical actions, scope credentials, make failures visible, and design deploys so a bad release can be stopped or rolled back quickly.',
    why: 'A tiny CI edit can change what reaches production or which credentials an action can access.',
    review: 'Inspect permissions, secret exposure, trigger conditions, and rollback behavior—not only whether YAML parses.',
    question: 'What should CI credentials follow?', options: ['Least privilege', 'Maximum convenience', 'Repository-wide write by default'], answer: 0
  },
  {
    id: 'concurrency', title: 'Concurrency & shared state', level: 'advanced', risk: 4, seconds: 43,
    patterns: [/concurr/i, /parallel/i, /worker/i, /mutex/i, /lock/i, /queue/i, /race/i, /atomic/i],
    lesson: 'Concurrency bugs happen when correctness depends on timing. Make ownership explicit, minimize shared mutable state, and enforce invariants atomically where the shared resource lives.',
    why: 'These failures are intermittent, load-dependent, and difficult to reproduce after launch.',
    review: 'Identify the shared resource and ask what prevents two workers from making the same transition simultaneously.',
    question: 'What makes a race condition hard to reproduce?', options: ['Correctness depends on timing/interleaving', 'The code has comments', 'The function is typed'], answer: 0
  },
  {
    id: 'accessibility', title: 'Web accessibility', level: 'core', risk: 2, seconds: 29,
    patterns: [/aria-/i, /accessib/i, /<button/i, /tabindex/i, /role=/i, /keyboard/i],
    lesson: 'Semantic HTML gives keyboard behavior and assistive technology meaning for free. Prefer native controls first, then add ARIA only when native semantics cannot express the interaction.',
    why: 'Visual success does not prove the UI is operable with a keyboard or screen reader.',
    review: 'Try the changed interaction without a mouse and check focus remains visible and logical.',
    question: 'What is usually better than recreating a button with a clickable `<div>`?', options: ['A native `<button>`', 'More ARIA on the `<div>`', 'A larger z-index'], answer: 0
  },
  {
    id: 'cache', title: 'Caching & invalidation', level: 'advanced', risk: 3, seconds: 37,
    patterns: [/cache/i, /redis/i, /valkey/i, /ttl/i, /memo/i, /revalidate/i],
    lesson: 'A cache is a second copy of truth. You need an explicit key, freshness policy, invalidation rule, and behavior for misses/failures—or stale data becomes a correctness bug.',
    why: 'Caching often speeds up the happy path while quietly making updates inconsistent.',
    review: 'Ask exactly when this cached value becomes invalid and what forces readers to observe the new value.',
    question: 'What is the hardest part of most caches?', options: ['Invalidation and freshness', 'Choosing a variable name', 'Adding JSON.stringify'], answer: 0
  }
];

export const CONCEPT_BY_ID = Object.fromEntries(CONCEPTS.map((concept) => [concept.id, concept]));
