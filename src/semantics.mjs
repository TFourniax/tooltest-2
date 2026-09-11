import path from 'node:path';

const NORMALIZE = (value = '') => String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');

const ROLE_DESCRIPTIONS = {
  api: 'an entry point where requests or events enter the application',
  middleware: 'a boundary that runs around requests or other operations before they reach the main logic',
  service: 'application logic that coordinates work between other parts of the project',
  integration: 'a boundary between this project and another service or library',
  data: 'code close to stored data, database access, or persistent models',
  migration: 'a change to the shape or contents of persistent data',
  worker: 'background or queued work that can run separately from the user-facing request',
  ui: 'user-facing interface or presentation code',
  test: 'code used to check that behavior stays correct',
  config: 'configuration that changes how the project behaves without being normal feature code',
  infra: 'build, deployment, or infrastructure code that affects how the software is run',
  cli: 'a command-line entry point used to invoke project behavior',
  types: 'contracts or shared data shapes used by other code',
  docs: 'documentation rather than executable product code',
  core: 'project code involved in the current task'
};

function matchAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

export function inferFileRole(file = '', signals = {}) {
  const normalized = NORMALIZE(file);
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);

  if (signals.route) return { role:'api', confidence:'high', evidence:`route ${signals.route}` };
  if (signals.table) return { role:'data', confidence:'high', evidence:`data surface ${signals.table}` };

  if (matchAny(lower, [/(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/, /\.(test|spec)\.[^.]+$/, /(^|\/)test_[^/]+\.[^.]+$/, /_test\.[^.]+$/])) {
    return { role:'test', confidence:'high', evidence:'test-like path' };
  }
  if (matchAny(lower, [/migration/, /migrations/, /(^|\/)schema(?:\.|\/|$)/, /alembic/, /flyway/, /liquibase/])) {
    return { role:'migration', confidence:'high', evidence:'migration/schema path' };
  }
  if (matchAny(lower, [/(^|\/)(middleware|middlewares)(\/|\.|$)/, /middleware\.[^.]+$/, /interceptor/, /filter\.[^.]+$/])) {
    return { role:'middleware', confidence:'medium', evidence:'middleware-like path' };
  }
  if (matchAny(lower, [/(^|\/)(worker|workers|jobs|tasks|queues|consumers|producers)(\/|$)/, /(worker|job|consumer|producer|queue|scheduler|cron)\.[^.]+$/])) {
    return { role:'worker', confidence:'medium', evidence:'background-work path' };
  }
  if (matchAny(lower, [/(^|\/)(api|routes?|controllers?|handlers?|endpoints?)(\/|$)/, /(route|router|controller|handler|endpoint)\.[^.]+$/, /views\.py$/])) {
    return { role:'api', confidence:'medium', evidence:'request-handler path' };
  }
  if (matchAny(lower, [/(^|\/)(repositories?|models?|entities|database|db|persistence)(\/|$)/, /(repository|repo|dao|model|entity|store)\.[^.]+$/])) {
    return { role:'data', confidence:'medium', evidence:'data-access path' };
  }
  if (matchAny(lower, [/(^|\/)(components?|pages?|screens?|views?|widgets)(\/|$)/, /\.(tsx|jsx|vue|svelte)$/])) {
    return { role:'ui', confidence:'medium', evidence:'user-interface path' };
  }
  if (matchAny(lower, [/(^|\/)(integrations?|adapters?|clients?|gateways?|connectors?)(\/|$)/, /(client|adapter|gateway|connector|integration|webhook)\.[^.]+$/])) {
    return { role:'integration', confidence:'medium', evidence:'integration-like path' };
  }
  if (matchAny(lower, [/(^|\/)(services?|usecases?|use-cases|application)(\/|$)/, /(service|orchestrator|manager|coordinator|usecase|use-case)\.[^.]+$/])) {
    return { role:'service', confidence:'medium', evidence:'application-service path' };
  }
  if (matchAny(lower, [/(^|\/)(\.github\/workflows|deploy|deployment|infra|infrastructure|terraform|k8s|kubernetes|helm|docker)(\/|$)/, /(dockerfile|compose\.ya?ml|terraform|\.tf$|\.github\/workflows)/])) {
    return { role:'infra', confidence:'high', evidence:'deployment/infrastructure path' };
  }
  if (matchAny(lower, [/(^|\/)(config|configs|settings|configuration)(\/|$)/, /(^|\/)[^/]*(config|settings)\.(json|ya?ml|toml|ini|js|ts|py)$/, /(^|\/)package\.json$/, /(^|\/)pyproject\.toml$/])) {
    return { role:'config', confidence:'medium', evidence:'configuration path' };
  }
  if (matchAny(lower, [/(^|\/)(cli|commands?)(\/|$)/, /(cli|command)\.[^.]+$/])) {
    return { role:'cli', confidence:'medium', evidence:'command-line path' };
  }
  if (matchAny(lower, [/(^|\/)(types?|schemas?|contracts?)(\/|$)/, /\.d\.ts$/, /(types?|contracts?)\.[^.]+$/])) {
    return { role:'types', confidence:'medium', evidence:'contract/type path' };
  }
  if (matchAny(lower, [/(^|\/)(docs?|documentation)(\/|$)/, /(^|\/)readme(?:\.|$)/, /\.md$/])) {
    return { role:'docs', confidence:'high', evidence:'documentation path' };
  }
  if ((signals.dependencies || []).length || (signals.technologies || []).length) {
    return { role:'integration', confidence:'low', evidence:'external dependency references' };
  }
  return { role:'core', confidence:'low', evidence:base ? `observed file ${base}` : 'observed project code' };
}

export function roleDescription(role = 'core') {
  return ROLE_DESCRIPTIONS[role] || ROLE_DESCRIPTIONS.core;
}

export function roleLabel(role = 'core') {
  const labels = {
    api:'request / event entry point', middleware:'middleware boundary', service:'application service', integration:'external integration',
    data:'data / persistence', migration:'database migration', worker:'background work', ui:'user interface', test:'test', config:'configuration',
    infra:'deployment / infrastructure', cli:'command-line entry point', types:'shared contract', docs:'documentation', core:'project code'
  };
  return labels[role] || labels.core;
}

export function normalizedProjectPath(file = '') {
  return NORMALIZE(file);
}
