function includes(text, pattern) { return pattern.test(String(text || '')); }

export function classifyCapabilities(action = {}) {
  const tool = String(action.tool || '');
  const command = String(action.command || '');
  const file = String(action.path || '').replaceAll('\\', '/');
  const caps = new Set();

  if (/^mcp__/.test(tool)) caps.add('mcp.invoke');
  if (/Read|Grep|Glob|Search/i.test(tool)) caps.add('code.read');
  if (/Write|Edit|MultiEdit|NotebookEdit|apply_patch/i.test(tool)) caps.add('code.modify');
  if (/WebFetch|WebSearch/i.test(tool) || includes(command, /\b(?:curl|wget)\b/i)) caps.add('network.fetch');

  if (includes(command, /\bgit\s+(?:status|diff|log|show|branch)\b/i)) caps.add('scm.read');
  if (includes(command, /\bgit\s+(?:add|commit)\b/i)) caps.add('scm.commit');
  if (includes(command, /\bgit\s+push\b/i)) caps.add('scm.push');
  if (includes(command, /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f)\b/i)) caps.add('scm.history_rewrite');
  if (includes(command, /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f)/i)) caps.add('scm.local_destroy');

  if (includes(command, /(?:^|\s)(?:sudo\s+)?rm\s+(?:-[^\s]*r[^\s]*f[^\s]*|-[^\s]*f[^\s]*r[^\s]*)\s+(?:\/|~|\$HOME|\.git)(?:\s|$)/i)) caps.add('filesystem.catastrophic_delete');
  if (includes(command, /(?:curl|wget)[^\n|]{0,500}\|\s*(?:sudo\s+)?(?:bash|sh|zsh|fish)\b/i)) caps.add('shell.remote_exec');

  if (includes(command, /\b(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|install)|yarn\s+add|pip(?:3)?\s+install|uv\s+add|cargo\s+add)\b/i)) caps.add('dependency.install');
  if (includes(command, /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+test)|\b(?:pytest|vitest|jest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)\b/i)) caps.add('test.execute');
  if (includes(command, /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:cargo|go|mvn|gradle)\s+build\b/i)) caps.add('build.execute');

  if (includes(command, /\b(?:SELECT|EXPLAIN)\b/i)) caps.add('database.read');
  if (includes(command, /\b(?:INSERT|UPDATE|UPSERT|ALTER\s+TABLE|CREATE\s+TABLE)\b/i)) caps.add('database.mutate');
  if (includes(command, /\b(?:DROP\s+(?:DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+[^;\n]+(?:;|$))\b/i)) caps.add('database.destructive');

  if (includes(command, /\b(?:deploy|release|promote)\b[^\n]*(?:prod|production)|\b(?:vercel|netlify|fly|railway|render)\b[^\n]*(?:--prod|production)/i)) caps.add('deploy.production');
  else if (includes(command, /\b(?:deploy|release|promote|vercel|netlify|fly|railway|render)\b/i)) caps.add('deploy.nonproduction');

  if (/(?:^|\/)(?:\.env(?:\.[^/]+)?|credentials?(?:\.[^/]+)?|secrets?(?:\.[^/]+)?)$/i.test(file)) caps.add('secrets.write');
  if (/(?:^|\/)\.github\/workflows\/|(?:^|\/)\.gitlab-ci\.yml$/i.test(file)) caps.add('ci.modify');
  if (/(?:^|\/)(?:migrations?|prisma\/migrations|supabase\/migrations)\//i.test(file)) caps.add('database.migration');
  if (/(?:^|\/)(?:auth|authorization|permissions?|rbac|iam)\//i.test(file)) caps.add('identity.modify');
  if (/(?:^|\/)(?:billing|payments?|checkout|stripe)\//i.test(file)) caps.add('financial.modify');

  if (/Bash/i.test(tool) && !caps.size) caps.add('shell.execute');
  return [...caps].sort();
}
