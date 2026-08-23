import assert from 'node:assert/strict';
import { buildPlainExplanation } from '../src/explain.mjs';

const scenarios = [
  {name:'generic webhook',prompt:'Handle Acme webhook retries safely',file:'src/odd/acme_receiver_v2.ts',symbol:'receiveAcmeEvent',route:'/hooks/acme-v2',table:'incoming_events',dependencies:['@acme/events-sdk'],concept:'http'},
  {name:'image upload',prompt:'Resize uploaded avatars before saving them',file:'app/media/avatar_pipeline.go',symbol:'ResizeAvatar',dependencies:['github.com/disintegration/imaging']},
  {name:'email delivery',prompt:'Retry failed transactional emails without duplicates',file:'workers/mail/retry_dispatcher.rb',symbol:'dispatch_retry',dependencies:['postmark']},
  {name:'search indexing',prompt:'Reindex changed catalog products',file:'services/catalog/search_reindexer.py',symbol:'reindex_changed_products',dependencies:['meilisearch']},
  {name:'queue consumer',prompt:'Make order events safe to process more than once',file:'src/queues/order_consumer.rs',symbol:'consume_order_event',dependencies:['rdkafka'],concept:'concurrency'},
  {name:'scheduled cleanup',prompt:'Delete expired sessions every night',file:'jobs/nightly/session_cleanup.ts',symbol:'deleteExpiredSessions'},
  {name:'csv import',prompt:'Import customer CSV rows and report invalid records',file:'src/imports/customer_csv_ingestor.php',symbol:'importCustomers'},
  {name:'pdf generation',prompt:'Generate monthly invoice PDFs',file:'billing/pdf/MonthlyInvoiceRenderer.java',symbol:'MonthlyInvoiceRenderer',dependencies:['com.vendor.pdf']},
  {name:'inventory reservation',prompt:'Prevent overselling the same inventory item',file:'domain/inventory/reservation_service.kt',symbol:'reserveInventory',table:'stock_reservations',concept:'concurrency'},
  {name:'feature flags',prompt:'Add a rollout flag for the new checkout',file:'config/feature_flags.yml',symbol:null},
  {name:'analytics event',prompt:'Track completed onboarding without blocking the request',file:'src/analytics/onboarding_tracker.swift',symbol:'trackCompletedOnboarding'},
  {name:'file storage',prompt:'Store generated exports in object storage',file:'src/storage/archive_gateway.py',symbol:'put_export',dependencies:['minio']},
  {name:'graphql resolver',prompt:'Return account usage from the GraphQL API',file:'graphql/resolvers/account_usage.ts',symbol:'accountUsage',route:null},
  {name:'cli command',prompt:'Add a command to rotate local project keys',file:'cmd/rotate_keys.go',symbol:'runRotateKeys'},
  {name:'terraform',prompt:'Add a private queue for background reconciliation',file:'infra/queues/reconcile.tf',symbol:null,concept:'ci'},
  {name:'github workflow',prompt:'Publish release artifacts after tags',file:'.github/workflows/release.yml',symbol:null,concept:'ci'},
  {name:'database migration',prompt:'Add organization ownership to existing projects',file:'db/migrations/20260821_add_owner.sql',symbol:null,table:'projects',concept:'migration'},
  {name:'react ui',prompt:'Show retry status on the import screen',file:'src/screens/imports/RetryStatusPanel.tsx',symbol:'RetryStatusPanel',concept:'react-state'},
  {name:'accessibility',prompt:'Make the custom modal usable by keyboard',file:'src/components/legacy/FancyModal.vue',symbol:null,concept:'accessibility'},
  {name:'cache invalidation',prompt:'Invalidate profile cache after an update',file:'src/cache/user_profile_store.cs',symbol:'InvalidateUserProfile',dependencies:['StackExchange.Redis'],concept:'cache'},
  {name:'authz',prompt:'Restrict invoice export to finance admins',file:'src/security/export_policy.ex',symbol:null,concept:'auth'},
  {name:'unknown naming',prompt:'Adjust the frobnication path',file:'src/x7/frobnicator.zzz',symbol:null},
  {name:'odd orchestrator',prompt:'Settle pending invoices after provider confirmation',file:'src/payments/weird_invoice_orchestrator_v7.py',symbol:'settle_pending_invoice',dependencies:['weirdpay']},
  {name:'mobile persistence',prompt:'Persist offline drafts and resync later',file:'ios/Data/OfflineDraftStore.swift',symbol:'saveDraft',concept:'sql'},
  {name:'c++ pipeline',prompt:'Skip corrupt frames instead of terminating capture',file:'native/capture/frame_pipeline.cpp',symbol:'ProcessFrame'},
  {name:'middleware',prompt:'Attach a request correlation id to every API call',file:'server/middleware/request_context.ts',symbol:'requestContext'},
  {name:'types contract',prompt:'Represent a partially fulfilled shipment',file:'src/contracts/shipment.types.ts',symbol:null,concept:'typescript'},
  {name:'test-only task',prompt:'Add a regression test for duplicate reservations',file:'tests/booking/reservation_race.test.ts',symbol:null,concept:'testing'},
  {name:'worker config',prompt:'Increase reconciliation worker concurrency carefully',file:'deploy/workers/reconcile-config.yaml',symbol:null,concept:'concurrency'},
  {name:'custom sdk',prompt:'Bridge to a vendor-specific signing service',file:'src/vendor/strange_bridge.mjs',symbol:'signWithVendor',dependencies:['@unknown-co/signing-kit']}
];

const forbiddenByDefault = /\bStripe\b|\bOAuth\b|\bPostgreSQL\b|\bRedis\b/;
let exactNames = 0;
let safeFallbacks = 0;
for (const s of scenarios) {
  const out=buildPlainExplanation({
    phase:'implement', concept:s.concept ? {id:s.concept} : null,
    session:{ prompt:s.prompt, currentResource:s.file, touchedFiles:[s.file], taskSignals:{ file:s.file, symbol:s.symbol, route:s.route||null, table:s.table||null, technologies:[], dependencies:s.dependencies||[] } }
  });
  assert.equal(out.schema,'idleproof.explanation.v1',`${s.name}: schema`);
  assert.ok(out.doing.includes(`\`${s.file}\``),`${s.name}: doing must use exact filename`);
  assert.ok(out.project.includes(`\`${s.file}\``),`${s.name}: project must use exact filename`);
  assert.ok(out.doing.length >= 70,`${s.name}: doing too thin`);
  assert.ok(out.project.length >= 90,`${s.name}: project too thin`);
  assert.ok(out.why.length >= 80,`${s.name}: why too thin`);
  assert.equal(out.optionalCheck,true,`${s.name}: check must be optional`);
  assert.ok(out.certainty.limitations.some((v)=>/DiffWitness/.test(v)),`${s.name}: explanation must not claim proof`);
  const combined=`${out.doing} ${out.project} ${out.why} ${out.watch.join(' ')}`;
  if (!s.prompt.match(forbiddenByDefault) && !(s.dependencies||[]).join(' ').match(forbiddenByDefault)) assert.doesNotMatch(combined,forbiddenByDefault,`${s.name}: hallucinated known stack`);
  if (s.symbol) assert.ok(out.doing.includes(s.symbol),`${s.name}: symbol missing`);
  if (s.route) assert.ok(out.doing.includes(s.route),`${s.name}: route missing`);
  if (s.table) assert.ok(out.doing.includes(s.table),`${s.name}: table missing`);
  if ((s.dependencies||[]).length) for (const dep of s.dependencies) assert.ok(out.project.includes(dep),`${s.name}: dependency ${dep} missing`);
  if (out.files[0]?.path===s.file) exactNames+=1;
  if (/instead of inventing a business role/i.test(out.files[0]?.explanation||'')) safeFallbacks+=1;
}
assert.equal(exactNames,scenarios.length,'every scenario must retain exact project path');
assert.ok(safeFallbacks>=1,'corpus must exercise an explicit non-hallucinating fallback');
console.log(`ExplainBench PASS · ${scenarios.length} cross-domain scenarios · exact paths ${exactNames}/${scenarios.length} · safe fallbacks ${safeFallbacks}`);
