import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Synthetic source only. The scanner must never execute any of these modules.
export function createProjectCorpus() {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'idleproof-corpus-disposable-'));
  const files={
    'rules.py':`def adjusted(value):
    return value * 0.9 if value >= 100 else value
def dispatch_cost(value):
    return 0 if value >= 80 else 7
def units(value):
    return int(value // 10)
`,
    'access_policy.py':`def permitted(role, active):
    if not active:
        return False
    return role == "operator"
`,
    'access_variant.py':`def permitted(role, active):
    return role == "operator"
`,
    'service.py':`from rules import adjusted
from access_policy import permitted
def process(value, role, active):
    if not permitted(role, active):
        raise PermissionError("inactive")
    return adjusted(value)
`,
    'view.py':`from service import process
def render(value, role, active):
    return {"result": process(value, role, active)}
`,
    'interface.py':`from service import process
@router.get("/compute")
def calculate(value):
    return process(value, "operator", True)
`,
    'dynamic_loader.py':`import importlib
def load(name):
    return importlib.import_module(name)
`,
    'side_effect.py':`from pathlib import Path
Path("SCAN_MUST_NOT_EXECUTE").write_text("failure")
`,
    'copies/one.py':`def normalize(value):
    if value is None:
        return 0
    return max(0, value)
`,
    'copies/two.py':`def normalize(value):
    if value is None:
        return 0
    return max(0, value)
`,
    'tests/test_rules.py':`from rules import adjusted, dispatch_cost, units
def test_adjusted_boundary():
    assert adjusted(99) == 99
    assert adjusted(100) == 90
def test_dispatch_boundary():
    assert dispatch_cost(79) == 7
    assert dispatch_cost(80) == 0
def test_units_boundary():
    assert units(9) == 0
    assert units(10) == 1
`,
    'tests/test_service.py':`from service import process
def test_operator():
    assert process(100, "operator", True) == 90
`,
    'package.json':JSON.stringify({name:'synthetic-map',scripts:{danger:'node side-effect.mjs'},dependencies:{'example-runtime':'1.0.0'},devDependencies:{'example-test-runner':'1.0.0'}}),
    'pyproject.toml':'[project]\nname = "synthetic-map"\nversion = "0.0.0"\ndependencies = []\n',
    'migrations/001.sql':'CREATE TABLE sample_values (id INTEGER PRIMARY KEY, amount INTEGER);\n',
    'settings.yaml':'mode: fixture\n',
    '.github/workflows/check.yml':'name: fixture\njobs:\n  inspect:\n    runs-on: ubuntu-latest\n',
    'docs/OWNER_INTENT.md':'# Owner declarations\nrules.py must keep three independent numeric rules.\nservice.py must refuse inactive callers using access_policy.py.\nview.py is a presentation adapter over service.py.\nA report exporter is planned; no implementation is claimed.\n',
    'docs/DECISIONS.md':'# Owner decisions\nKeep rules.py independent from deployment choices.\nDo not infer successful requests from interface.py syntax.\n',
    '.env':'PRIVATE_CORPUS_SENTINEL=never-export\n',
    'credentials.json':'{"secret":"PRIVATE_CORPUS_SENTINEL"}',
    'node_modules/downloaded/index.py':'raise RuntimeError("not part of the project")\n',
  };
  for(const [relative,content] of Object.entries(files)){const p=path.join(cwd,relative);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,content);}
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q','-b','main');git('config','user.name','Synthetic Corpus');git('config','user.email','corpus@example.invalid');git('config','core.autocrlf','false');git('config','gc.auto','0');git('add','.');git('commit','-qm','synthetic multi-layer corpus');
  return {cwd,git,files,documents:['docs/OWNER_INTENT.md','docs/DECISIONS.md']};
}
