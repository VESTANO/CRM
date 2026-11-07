"""Inventory the local candidate and every reachable commit without reading secrets.

Only allowlisted source/configuration paths are hashed; no dotenv, database,
backup, node_modules or generated application data is read. This does not commit,
tag, contact a remote, run a migration or deploy anything.
"""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode('utf-8').strip()

files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0')
prefixes = ('frontend/src/', 'frontend/e2e/', 'frontend/public/', 'supabase/functions/',
            'supabase/migrations/', '.github/workflows/', 'scripts/', 'docs/')
explicit = {'frontend/package.json','frontend/package-lock.json','frontend/index.html',
            'frontend/vite.config.js','frontend/playwright.config.js',
            'frontend/playwright.phase4-frontend.config.js','supabase/config.toml',
            'requirements.txt','Dockerfile','render.yaml'}
allowed = {'.js','.jsx','.mjs','.ts','.tsx','.sql','.toml','.json','.md','.yml','.yaml','.py','.html','.css','.svg','.webmanifest','.ps1'}
inventory=[]
for name in sorted(set(files)):
    path = ROOT / name
    if not path.is_file() or not (name in explicit or name.startswith(prefixes)):
        continue
    if path.suffix.lower() not in allowed and name not in explicit:
        continue
    if path.name.startswith('.env') or any(part in {'.git','node_modules','tmp','__pycache__'} for part in path.parts):
        continue
    contents=path.read_bytes()
    inventory.append(dict(path=name, bytes=len(contents), sha256=hashlib.sha256(contents).hexdigest()))

history=[]
for line in git('log','--all','--format=%H%x09%P%x09%ad%x09%s','--date=iso-strict').splitlines():
    commit, parents, date, subject = line.split('\t',3)
    changed=git('diff-tree','--root','--no-commit-id','--name-status','-r','-m',commit).splitlines()
    history.append(dict(commit=commit, parents=parents.split(), date=date, subject=subject, changes=changed))

migrations=[item for item in inventory if item['path'].startswith('supabase/migrations/')]
versions=[Path(m['path']).name.split('_',1)[0] for m in migrations]
assert len(set(versions))==len(versions), 'Duplicate migration IDs'
fingerprint=hashlib.sha256(json.dumps(inventory,sort_keys=True,separators=(',',':')).encode()).hexdigest()
report=dict(head=git('rev-parse','HEAD'), branch=git('branch','--show-current'),
    dirty=bool(git('status','--porcelain')), candidateSourceSha256=fingerprint,
    note='Uncommitted local candidate; this manifest is evidence, not a release tag. No secret/environment/provider state is included.',
    commits=history, commitCount=len(history), sourceFileCount=len(inventory),
    migrationCount=len(migrations), migrations=migrations, files=inventory)
destination=ROOT/'tmp/phase5/release-manifest.json'
destination.parent.mkdir(parents=True,exist_ok=True)
destination.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(dict(head=report['head'],branch=report['branch'],dirty=report['dirty'],
    commits=len(history),sourceFiles=len(inventory),migrations=len(migrations),
    candidateSourceSha256=fingerprint,evidence=str(destination)),indent=2))
