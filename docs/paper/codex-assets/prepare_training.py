"""Stage the ORIGINAL multiclass training experiment in a NEW directory.
Does not train. Original runner requires CUDA; saved-result figure reproduction does not.
"""
import argparse
from pathlib import Path
import shutil
from common import HERE, ROOT, digest, read_json


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo-root',type=Path,default=ROOT)
    ap.add_argument('--output',type=Path)
    ap.add_argument('--check-only',action='store_true')
    args=ap.parse_args()
    snapshot_path=HERE/'data/multiclass/snapshot.json';snapshot=read_json(snapshot_path)
    sources=[]
    for rel,sha in snapshot['files'].items():
        if rel.startswith('src/'):
            p=HERE/'data/multiclass/frozen-trainer'/rel
        elif rel.startswith('data/'):
            p=args.repo_root/'data/recordings/Hand labeled'/Path(rel).relative_to('data')
        else:
            raise ValueError('Unexpected snapshot path: '+rel)
        assert p.is_file() and digest(p)==sha,'Missing or changed training input: '+str(p)
        sources.append((p,rel))
    if args.check_only:
        print('Original training inputs/source hashes verified:',len(sources));return
    if args.output is None:
        ap.error('give --output NEW_DIRECTORY or --check-only')
    out=args.output.expanduser().resolve()
    if out.exists():
        raise FileExistsError('Refusing to overwrite an existing training directory: '+str(out))
    out.mkdir(parents=True)
    for p,rel in sources:
        dst=out/rel;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dst)
    shutil.copyfile(snapshot_path,out/'snapshot.json')
    for name in ('run.py','report.py'):
        shutil.copyfile(HERE/'data/multiclass/original-runner'/name,out/name)
    print('Staged original runner, frozen source and exact raw inputs:',out)
    print('No training started. Read README.md for the separate CUDA environment and nondeterminism caveat.')

if __name__=='__main__':main()
