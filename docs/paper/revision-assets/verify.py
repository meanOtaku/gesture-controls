"""Small publication check: links, figure exports and evidence identities (stdlib only)."""
from pathlib import Path
import csv
import hashlib
import json
import re
import struct
from urllib.parse import unquote
from audit_evidence import ROOT, OUT, effective


def main():
    paper=ROOT/'docs/paper'
    docs=[paper/'README.md',paper/'EVIDENCE_AUDIT.md',paper/'Q2_RESEARCH_PLAN.md',OUT/'README.md']
    docs += [paper/x/'IMPROVEMENTS.md' for x in ('ieee','springer','ieee-journal','springer-journal')]
    checked_links=0
    for doc in docs:
        assert doc.is_file(), doc
        text=doc.read_text()
        for destination in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)',text):
            if '://' in destination or destination.startswith('#'):
                continue
            target=unquote(destination.split('#')[0])
            assert (doc.parent/target).exists(), (doc,destination)
            checked_links += 1
    for first,second in [('ieee','springer'),('ieee-journal','springer-journal')]:
        assert (paper/first/'body.tex').read_bytes()==(paper/second/'body.tex').read_bytes()
    audit=json.loads((OUT/'evidence-audit.json').read_text())
    import subprocess
    for folder in ('ieee','springer','ieee-journal','springer-journal'):
        # main.tex, body.tex and main.pdf were intentionally revised on 8 Nov 2026 (evidence corrections and the replayed
        # hand-labelled result, see revision-assets/HAND_LABELLED_REPLAY.md); only the bibliography is still pinned.
        for name in ('refs.bib',):
            relative=f'docs/paper/{folder}/{name}'
            original=subprocess.check_output(['git','show',f'{audit["audited_commit"]}:{relative}'],cwd=ROOT)
            assert (ROOT/relative).read_bytes()==original, relative
    assert len(audit['records'])==37
    assert audit['unique_sensor_pairs']==28
    assert len(audit['duplicate_sensor_groups'])==9
    assert sum(r['ppg']['changed_label_rows'] for r in audit['records'])==4931
    assert sum(any(k for k in r['ppg']['manual_label_rows']) for r in audit['records'])==14
    for m in audit['models']:
        manifest=ROOT/m['path']; metadata=json.loads(manifest.read_text())
        digest=hashlib.sha256((manifest.parent/metadata['model']['file']).read_bytes()).hexdigest()
        assert digest==metadata['model']['sha256']==m['model_sha256']
        assert not m['id_overlap']
    hand=next(m for m in audit['models'] if 'hand-labeled' in m['path'])
    assert hand['sensor_alias_check_complete']
    assert not hand['sensor_alias_overlap_resolved_subset']
    assert hand['train_count']==20 and hand['evaluation_count']==8
    assert hand['provenance']['thresholdChosenOnEvaluationRecordings'] is False
    assert effective('pinch','-')=='' and effective('pinch','')=='pinch'
    with (OUT/'hand-labelled-inventory.csv').open(newline='') as f:
        assert len(list(csv.DictReader(f)))==37
    figure_names=['annotation-telemetry','evidence-lineage','historical-day-transfer','prospective-protocol']
    for name in figure_names:
        png=(OUT/(name+'.png')).read_bytes()
        assert png[:8]==b'\x89PNG\r\n\x1a\n'
        width,height=struct.unpack('>II',png[16:24]);assert width>=2000 and height>=1000
        assert (OUT/(name+'.pdf')).read_bytes().startswith(b'%PDF')
        assert '<svg' in (OUT/(name+'.svg')).read_text()
        print(name, width, height)
    provenance=json.loads((OUT/'figure-provenance.json').read_text())
    assert set(provenance)==set(figure_names)
    literature=json.loads((OUT/'literature-sources.json').read_text())
    assert len(literature['sources'])==7
    print(f'PASS: {len(docs)} documents; {checked_links} local links; 4 figures × 3 formats; 7 model hashes; annotation/split invariants; paired LaTeX bodies equal.')


if __name__=='__main__': main()
