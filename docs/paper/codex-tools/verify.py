"""Focused paper checks, not a runtime or training suite.
Run: uv run --isolated --no-project --with pymupdf python docs/paper/codex-tools/verify.py
"""
from pathlib import Path
from urllib.parse import unquote
import hashlib,json,re,subprocess
import pymupdf

P=Path(__file__).resolve().parents[1]
A=P/'ieee codex';B=P/'springer codex'


def main():
    for name in ('body.tex','abstract.tex','refs.bib','manuscript-source.md','manuscript.md'):
        assert (A/name).read_bytes()==(B/name).read_bytes(),name
    body=(A/'body.tex').read_text();md=(A/'manuscript.md').read_text()
    assert body.count('\\begin{codexfigure}')==4
    assert body.count('\\caption{')==7  # 4 figures + 3 tables (replayed hand-labelled outcomes added 8 Nov)
    assert len(re.findall(r'!\[[^]]*\]\(figures/',md))==4
    assert '# References' in md and '$$' in md
    assert '[@' not in md and 'csl-entry' not in md and '<img' not in md
    citations=set(re.findall(r'\\cite\{([^}]+)\}',body))
    bibliography=set(re.findall(r'@\w+\{([^,]+),',(A/'refs.bib').read_text()))
    assert citations==bibliography and len(citations)==6
    inventory=json.loads((P/'revision-assets/evidence-audit.json').read_text())
    hand=next(m for m in inventory['models'] if 'hand-labeled' in m['path'])
    assert hand['provenance']['evaluationGestureRecall']==0.8245614035087719
    assert hand['train_count']==20 and hand['evaluation_count']==8
    assert hand['model_sha256'] in body
    assert '300--900' in body
    assert 680-880+500==300 and 1280-880+500==900
    link_count=0
    for directory in (A,B):
        for textfile in (directory/'README.md',directory/'manuscript.md'):
            for target in re.findall(r'!?\[[^]]*\]\(([^)]+)\)',textfile.read_text()):
                if '://' in target or target.startswith('#'):continue
                assert (textfile.parent/unquote(target.split('#')[0])).exists(),target
                link_count+=1
        log=(directory/'main.log').read_text(errors='replace')
        assert 'Overfull' not in log and 'undefined' not in log.lower()
        assert '???' not in (directory/'main.bbl').read_text()
        doc=pymupdf.open(directory/'main.pdf')
        text='\n'.join(page.get_text() for page in doc)
        assert '[?]' not in text and 'References' in text.upper().title()
        assert sum(len(page.get_images()) for page in doc)==4
        for page in doc:
            assert page.get_text().strip()
            assert all(x0>=0 and y0>=0 and x1<=page.rect.width+1 and y1<=page.rect.height+1 for x0,y0,x1,y1,*_ in page.get_text('words'))
        print(directory.name,':',len(doc),'pages; 4 figures; 6 references; no unresolved citations, overfull boxes or off-page text')
    for name in ('annotation-telemetry.png','historical-day-transfer.png','prospective-protocol.png'):
        expected=(P/'revision-assets'/name).read_bytes()
        assert (A/'figures'/name).read_bytes()==(B/'figures'/name).read_bytes()==expected
    for directory in ('ieee','springer','ieee-journal','springer-journal'):
        # main.tex, body.tex and main.pdf were intentionally revised on 8 Nov 2026 (evidence corrections and the replayed
        # hand-labelled result, see revision-assets/HAND_LABELLED_REPLAY.md); only the bibliography is still pinned.
        for name in ('refs.bib',):
            relative=f'docs/paper/{directory}/{name}'
            original=subprocess.check_output(['git','show','6709b2a:'+relative],cwd=P)
            assert (P/directory/name).read_bytes()==original
    print('PASS: identical scientific sources, evidence invariants,',link_count,'local links, exact inherited images and original bibliographies preserved (manuscripts revised 8 Nov).')

if __name__=='__main__':main()
