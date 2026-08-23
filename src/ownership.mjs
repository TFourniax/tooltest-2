import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectPaths } from './paths.mjs';
import { canonicalJson, ensureIdentity, signBytes, verifyBytes } from './provenance.mjs';

const CODEOWNERS_LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
const SENSITIVE = [
  { pattern: /(^|\/)(auth|authorization|permissions?|rbac|iam)(\/|$)/i, risk: 5, domain: 'identity-access' },
  { pattern: /(^|\/)(billing|payments?|checkout|stripe|invoices?)(\/|$)/i, risk: 5, domain: 'financial' },
  { pattern: /(^|\/)(migrations?|prisma\/migrations|supabase\/migrations)(\/|$)/i, risk: 5, domain: 'data-migration' },
  { pattern: /(^|\/)(infra|terraform|k8s|kubernetes|deploy)(\/|$)|(^|\/)\.github\/workflows\//i, risk: 5, domain: 'delivery-infrastructure' },
  { pattern: /(^|\/)(security|crypto|secrets?|credentials?)(\/|$)|(^|\/)\.env(?:\.|$)/i, risk: 5, domain: 'security-secrets' },
  { pattern: /(^|\/)(database|db|schema|api)(\/|$)/i, risk: 4, domain: 'data-api' },
  { pattern: /(^|\/)(tests?|specs?)(\/|$)|\.(?:test|spec)\.[^/]+$/i, risk: 2, domain: 'verification' }
];
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
function writeJson(file, value, mode = 0o600) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode }); }
function gitValue(cwd, key) { try { return execFileSync('git', ['config', '--get', key], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).trim(); } catch { return ''; } }
export function localHumanIdentity(cwd = process.cwd()) { return { name: gitValue(cwd, 'user.name') || process.env.USER || process.env.USERNAME || 'local-user', email: gitValue(cwd, 'user.email') || '', source: 'git-config' }; }
function regexEscape(char) { return /[.()+^$|{}\[\]\\]/.test(char) ? `\\${char}` : char; }
export function codeownersPatternToRegex(pattern) {
  let input = String(pattern || '').trim(); if (!input) return null; const anchored = input.startsWith('/'); if (anchored) input = input.slice(1); const directory = input.endsWith('/'); if (directory) input += '**'; const hasSlash = input.includes('/'); let source = '';
  for (let i = 0; i < input.length; i += 1) { const char = input[i]; if (char === '*') { if (input[i + 1] === '*') { source += '.*'; i += 1; } else source += '[^/]*'; } else if (char === '?') source += '[^/]'; else source += regexEscape(char); }
  return new RegExp(`${anchored || hasSlash ? '^' : '(?:^|.*/)'}${source}${directory ? '' : '$'}`);
}
export function parseCodeowners(cwd = process.cwd()) {
  const location = CODEOWNERS_LOCATIONS.find((relative) => fs.existsSync(path.join(cwd, relative))); if (!location) return { source: null, rules: [] };
  const rules = []; for (const raw of fs.readFileSync(path.join(cwd, location), 'utf8').split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith('#')) continue; const parts = line.split(/\s+/); if (parts.length < 2) continue; const pattern = parts.shift(); const owners = parts.filter((owner) => owner.startsWith('@') || owner.includes('@')); const regex = codeownersPatternToRegex(pattern); if (regex && owners.length) rules.push({ pattern, owners, regex }); }
  return { source: location, rules };
}
export function ownersForPath(file, parsed) { let owners = []; for (const rule of parsed.rules || []) if (rule.regex.test(String(file).replaceAll('\\', '/'))) owners = rule.owners; return owners; }
function riskForPath(file) { return SENSITIVE.find((item) => item.pattern.test(file)) || { risk: 3, domain: 'application' }; }
function acceptanceFile(cwd) { return path.join(projectPaths(cwd).dir, 'acceptances.json'); }
export function loadAcceptances(cwd = process.cwd()) { return readJson(acceptanceFile(cwd), { schema: 'idleproof.acceptances.v1', items: [] }); }
function normalizePrincipal(value) { return String(value || '').trim().toLowerCase(); }
function principalMatchesOwners(principal, identity, owners) { if (!owners.length) return true; const candidates = new Set([normalizePrincipal(principal), normalizePrincipal(identity?.email), normalizePrincipal(identity?.name)].filter(Boolean)); return owners.some((owner) => candidates.has(normalizePrincipal(owner))); }
export function acceptResponsibility(cwd = process.cwd(), { principal = '', note = '' } = {}) {
  const receipt = readJson(projectPaths(cwd).receipt, null); const digest = receipt?.session?.proof?.diffSha256; if (!/^[a-f0-9]{64}$/.test(String(digest || ''))) throw new Error('No completed diff proof is available to accept.');
  const identity = localHumanIdentity(cwd); const acceptedBy = principal || identity.email || identity.name;
  const statement = { schema: 'idleproof.responsibility-acceptance.v1', diffSha256: digest, sourceHead: receipt?.session?.proof?.head || null, acceptedAt: new Date().toISOString(), acceptedBy, localIdentity: identity, method: 'local-cli', note: String(note || '').slice(0, 1000), disclaimer: 'Local acceptance is witnessed by the IdleProof recorder; acceptedBy is self-asserted unless externally federated.' };
  const signature = signBytes(cwd, Buffer.from(canonicalJson(statement))); const acceptance = { ...statement, recorderSignature: { keyid: signature.keyid, sig: signature.sig, publicKey: signature.publicKey } };
  const store = loadAcceptances(cwd); store.items = (store.items || []).filter((item) => !(item.diffSha256 === digest && normalizePrincipal(item.acceptedBy) === normalizePrincipal(acceptedBy))); store.items.push(acceptance); store.items = store.items.slice(-200); writeJson(acceptanceFile(cwd), store); return acceptance;
}
export function verifyAcceptance(acceptance, expectedPublicKey = null) { if (!acceptance?.recorderSignature?.publicKey || !acceptance?.recorderSignature?.sig) return false; const { recorderSignature, ...statement } = acceptance; return verifyBytes(Buffer.from(canonicalJson(statement)), recorderSignature.sig, expectedPublicKey || recorderSignature.publicKey); }
export function responsibilityReport(cwd = process.cwd()) {
  const receipt = readJson(projectPaths(cwd).receipt, null); const digest = receipt?.session?.proof?.diffSha256 || null; const files = receipt?.session?.files || []; const parsed = parseCodeowners(cwd); const identity = localHumanIdentity(cwd); const recorderPublicKey = ensureIdentity(cwd).publicKey;
  const acceptances = (loadAcceptances(cwd).items || []).filter((item) => item.diffSha256 === digest && verifyAcceptance(item, recorderPublicKey));
  const rows = files.map((file) => { const owners = ownersForPath(file, parsed); const risk = riskForPath(file); const fallbackOwner = !parsed.source ? (identity.email || identity.name) : null; const effectiveOwners = owners.length ? owners : fallbackOwner ? [fallbackOwner] : []; const acceptance = acceptances.find((item) => principalMatchesOwners(item.acceptedBy, item.localIdentity, effectiveOwners)); return { file, domain: risk.domain, risk: risk.risk, owners: effectiveOwners, ownerSource: owners.length ? parsed.source : fallbackOwner ? 'local-git-fallback' : null, accepted: Boolean(acceptance), acceptedBy: acceptance?.acceptedBy || null, acceptedAt: acceptance?.acceptedAt || null }; });
  const totalWeight = rows.reduce((sum, row) => sum + row.risk, 0) || 1; const ownerWeight = rows.filter((row) => row.owners.length).reduce((sum, row) => sum + row.risk, 0); const acceptedWeight = rows.filter((row) => row.accepted).reduce((sum, row) => sum + row.risk, 0); const obligations = rows.filter((row) => row.risk >= 4 && (!row.owners.length || !row.accepted));
  return { schema: 'idleproof.responsibility-report.v1', generatedAt: new Date().toISOString(), diffSha256: digest, codeowners: parsed.source, identity, ownerCoverage: Math.round((ownerWeight / totalWeight) * 100), responsibilityCoverage: Math.round((acceptedWeight / totalWeight) * 100), files: rows, obligations, acceptances: acceptances.map((item) => ({ acceptedBy: item.acceptedBy, acceptedAt: item.acceptedAt, method: item.method, keyid: item.recorderSignature?.keyid })) };
}
