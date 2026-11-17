"""Verify every input hash, figure signature/dimension and referenced artifact; record build hashes."""
import argparse
import importlib.metadata
import platform
import re
from pathlib import Path
import xml.etree.ElementTree as ET
from PIL import Image
from common import HERE, digest, read_json, write_json


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--write-manifest',action='store_true');args=ap.parse_args()
    inputs=read_json(HERE/'sources.json')
    for item in inputs['files']:
        assert digest(HERE/item['path'])==item['sha256'],item['path']
    catalog=read_json(HERE/'figure-catalog.json')
    assert len(catalog)==16 and len({f['id'] for f in catalog})==16
    generated={}
    for f in catalog:
        assert all(f[k] for k in ['caption','alt','sources','evidence_status','transformations'])
        assert len(f['files'])==3
        for rel in f['files']:
            p=HERE/rel;assert p.is_file() and p.stat().st_size>1000,rel
            if p.suffix=='.png':
                with Image.open(p) as im:
                    im.verify()
                with Image.open(p) as im:
                    assert abs(im.width-300*f['width_inches'])<=2 and abs(im.height-300*f['height_inches'])<=2,rel
            elif p.suffix=='.svg':
                root=ET.parse(p).getroot();assert root.tag.endswith('svg')
                assert 'DejaVu Sans' in p.read_text(),rel
                for e in root.iter():
                    for k,v in e.attrib.items():
                        if k.endswith('href'):assert v.startswith(('#','data:')),('external SVG resource',rel,v)
            elif p.suffix=='.pdf':assert p.read_bytes().startswith(b'%PDF-'),rel
            generated[rel]=digest(p)
    # PDFs/vector files must be present even if a repository-wide ignore rule normally excludes PDFs.
    assert len(generated)==48
    for name in ['derived/metrics.json','derived/multiclass-metrics.csv','CAPTIONS.md']:
        assert (HERE/name).is_file();generated[name]=digest(HERE/name)
    metrics=read_json(HERE/'derived/metrics.json')
    assert all(r['test']['decisions']==103347 for r in metrics['multiclass'])
    replay=HERE/'derived/event-replay-verification.json'
    replay_status=read_json(replay)['status'] if replay.exists() else 'not run; needs full repository raw recordings'
    if replay.exists():generated[str(replay.relative_to(HERE))]=digest(replay)
    for optional in ('derived/clean-rebuild-verification.json','derived/training-stage-verification.json','index.html','OVERVIEW.png'):
        if (HERE/optional).is_file():generated[optional]=digest(HERE/optional)
    if args.write_manifest:
        write_json(HERE/'BUILD.json',{'python':platform.python_version(),'packages':{p:importlib.metadata.version(p) for p in ['numpy','matplotlib','pillow','scikit-learn']},'source_snapshot':inputs['source_commit'],'verified_inputs':len(inputs['files']),'figures':len(catalog),'formats':['png','svg','pdf'],'frozen_source_event_replay':replay_status,'scripts':{p.name:digest(p) for p in sorted(HERE.glob('*.py'))},'outputs':generated,'scope':'Existing evidence reanalysis/rendering; no new training, participants or physical interaction results.'})
    else:
        manifest=read_json(HERE/'BUILD.json')
        assert manifest['outputs']==generated,'Outputs differ from the recorded build. Regenerate deliberately, then write a new manifest.'
        assert manifest['scripts']=={p.name:digest(p) for p in sorted(HERE.glob('*.py'))},'Scripts differ from the recorded build.'
    print(f'VERIFIED {len(inputs["files"])} input hashes, 16 figures / 48 files, source provenance and dimensions; event replay: {replay_status}')

if __name__=='__main__':main()
