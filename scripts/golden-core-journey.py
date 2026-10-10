"""G2-G5/G7: real Core on disposable synthetic Git history, never the HUMAN witness."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--core', required=True, type=Path)
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args()
env = {**os.environ, 'PYTHONPATH': str(args.core.resolve() / 'src'), 'GITHUB_ACTIONS': 'false', 'PYTHONUTF8': '1'}

def run(cwd, command, arguments, *, expected=0, payload=None):
    p = subprocess.run([command, *arguments], cwd=cwd, env=env, input=payload, capture_output=True, text=True, encoding='utf-8', timeout=120)
    if p.returncode != expected:
        raise RuntimeError(f'{command} {arguments}: {p.stdout}\n{p.stderr}')
    return p.stdout.strip()

def dw(cwd, *arguments):
    return run(cwd, sys.executable, ['-m', 'diffwitness.entry', *map(str, arguments)])

with tempfile.TemporaryDirectory(prefix='idleproof-golden-disposable-') as td:
    root = Path(td)
    repo = root / 'repo'
    repo.mkdir()
    git = lambda *a: run(repo, 'git', list(a))
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Synthetic Golden')
    git('config', 'user.email', 'golden@example.invalid')
    git('config', 'maintenance.auto', 'false')
    git('config', 'gc.auto', '0')
    git('config', 'core.autocrlf', 'false')
    (repo / 'tests').mkdir()
    (repo / 'calculation_a.py').write_text('def calculate(value):\n    return value\n', encoding='utf-8')
    git('add', '.')
    git('commit', '-qm', 'synthetic baseline')
    # Real native protocol on an unchanged project. No fake coding provider.
    payload=json.dumps({'cwd':str(repo),'session_id':'synthetic-unchanged','provider':'codex'})
    native=lambda action:run(repo,sys.executable,['-m','diffwitness.entry','ide-hook',action,'--provider','codex'],payload=payload)
    native('session-start')
    unchanged=json.loads(native('session-stop'))
    assert set(unchanged)=={'systemMessage'}, unchanged
    assert not (repo/'.git/diffwitness/change-envelope.json').exists()
    sources = [
        ('a', 'return value * 0.9 if value >= 100 else value', [(99, 99), (100, 90), (200, 180)]),
        ('b', 'return 0 if value >= 80 else 7', [(79, 7), (80, 0), (100, 0), (0, 7)]),
        ('c', 'return int(value // 10)', [(0, 0), (9, 0), (10, 1), (35, 3)]),
    ]
    envelopes, certificates = [], []
    for index, (key, expression, cases) in enumerate(sources):
        base = git('rev-parse', 'HEAD')
        (repo / f'calculation_{key}.py').write_text(f'def calculate(value):\n    {expression}\n', encoding='utf-8')
        test = f'import unittest\nfrom calculation_{key} import calculate\nclass T(unittest.TestCase):\n'
        test += ''.join(f'    def test_{i}(self): self.assertEqual(calculate({value}), {expected})\n' for i, (value, expected) in enumerate(cases))
        (repo / 'tests' / f'test_{key}.py').write_text(test, encoding='utf-8')
        git('add', '.')
        git('commit', '-qm', f'synthetic change {index + 1}')
        candidate = git('rev-parse', 'HEAD')
        cert, debt, envelope = (root / f'{kind}-{index}.json' for kind in ('certificate', 'debt', 'envelope'))
        dw(repo, 'prove', '--base', base, '--candidate', candidate, '--test', f'"{sys.executable}" -m unittest discover -s tests -q', '--stability-runs', '1', '--certificate', cert, '--report', root / f'proof-{index}.md', '--no-github-actions')
        original = cert.read_bytes()
        proof = json.loads(original)
        assert proof['certificate_id'].startswith('dw2_'), proof
        dw(repo, 'verify', cert, '--against', candidate, '--json')
        dw(repo, 'debt', '--base', base, '--candidate', candidate, '--certificate', cert, '--no-record', '--json', debt)
        dw(repo, 'envelope', '--base', base, '--candidate', candidate, '--proof', cert, '--debt', debt, '--out', envelope)
        value = json.loads(envelope.read_text(encoding='utf-8'))
        assert value['proof']['accepted'] is True
        assert value['proof']['claim'] == 'causal'
        assert cert.read_bytes() == original
        certificates.append({'id': proof['certificate_id'], 'sha256': hashlib.sha256(original).hexdigest()})
        envelopes.append(value)
    assert len({e['change_id'] for e in envelopes}) == 3
    dw(repo, 'decision', 'record', 'Keep calculations independent', '--id', 'DEC-GOLDEN', '--why', 'Synthetic explicit declaration')
    page = json.loads(dw(repo, 'state', 'events', '--after', '0', '--limit', '500', '--json'))
    event=next(item['event'] for item in page['events'] if item['event']['subject']['id']=='DEC-GOLDEN')
    assert event['epistemic_status']=='DECLARED'
    assert 'certificate_id' not in event['payload']
    replay=json.loads(dw(repo,'state','events','--after','0','--limit','500','--json'))
    assert replay==page
    after=json.loads(dw(repo,'state','events','--after',page['next'],'--expect-head',page['head'],'--limit','500','--json'))
    assert after['events']==[] and after['head']==page['head']
    # Positive canonical debt and a real exceeded budget, independently of Proof.
    base=git('rev-parse','HEAD')
    (repo/'.diffwitness.toml').write_text('[debt]\nmax_per_change = 0\n',encoding='utf-8')
    (repo/'calculation_a.py').write_text('def calculate(value):\n    # TODO: specify the new boundary\n    return value * 0.8\n',encoding='utf-8')
    debt_path=root/'positive-debt.json'
    run(repo,sys.executable,['-m','diffwitness.entry','debt','--base',base,'--candidate','WORKTREE','--no-record','--json',str(debt_path)],expected=1)
    positive=json.loads(debt_path.read_text(encoding='utf-8'))
    assert positive['report']['summary']['points']>0 and positive['report']['signals']
    assert positive['budget']['passed'] is False
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({'schema': 'idleproof.golden-core.v1', 'classification': 'MACHINE', 'unchangedNativeStop':unchanged, 'positiveDebt':positive, 'envelopes': envelopes, 'certificates': certificates, 'tests': 11, 'journal': page, 'journalReplayIdentical':True, 'cursorCaughtUp':True}, indent=2), encoding='utf-8')
    print(json.dumps({'classification': 'MACHINE', 'changes': 3, 'discriminating_tests': 11, 'proofs': [c['id'] for c in certificates]}))
