"""Render the two Codex manuscript formats from one Markdown source.
Run from any cwd: uv run --isolated --no-project --with pypandoc_binary==1.17 python docs/paper/codex-tools/render.py
LaTeX compilation is deliberately separate: latexmk -pdf main.tex in each paper folder.
"""
from pathlib import Path
import copy
import json
import re
import shutil
import subprocess
import pypandoc

PAPER=Path(__file__).resolve().parents[1]
IEEE=PAPER/'ieee codex'
SPRINGER=PAPER/'springer codex'


def convert(document, target, args=()):
    return pypandoc.convert_text(json.dumps(document),target,format='json',extra_args=list(args))


def fragment(ast, blocks, target='latex'):
    doc={'pandoc-api-version':ast['pandoc-api-version'],'meta':{},'blocks':blocks}
    return convert(doc,target,['--natbib','--wrap=none'] if target=='latex' else []).strip()


def table_tex(ast, block, number):
    c=block['c']
    header=c[3][1]
    body=[row for group in c[4] for row in group[3]]
    assert len(c[2])==3
    def row_tex(row,head=False):
        cells=[fragment(ast,cell[4]) for cell in row[1]]
        if head:cells=['\\textbf{'+cell+'}' for cell in cells]
        return ' & '.join(cells)+r' \\'
    caption=('Source-directory audit. Counts concern exported files or exact stream pairs, not independent human sessions.' if number==1 else 'Stored pinch-in manifest fields. Event values are development evidence, not a reconstructed prospective test.')
    content=['\\begin{table}[t]','\\centering\\small','\\caption{'+caption+'}',r'\begin{tabularx}{\linewidth}{@{}>{\raggedright\arraybackslash}Xr>{\raggedright\arraybackslash}X@{}}',r'\toprule']
    content += [row_tex(r,True) for r in header]
    content += [r'\midrule']+[row_tex(r) for r in body]+[r'\bottomrule',r'\end{tabularx}',r'\end{table}']
    return {'t':'RawBlock','c':['latex','\n'.join(content)]}


def main():
    source=IEEE/'manuscript-source.md'
    raw=source.read_text()
    ast=json.loads(pypandoc.convert_text(raw,'json',format='markdown'))
    blocks=ast['blocks']
    intro=next(i for i,b in enumerate(blocks) if b['t']=='Header' and b['c'][0]==1 and b['c'][2]==[{'t':'Str','c':'Introduction'}])
    abstract_header=next(i for i,b in enumerate(blocks) if b['t']=='Header' and b['c'][2]==[{'t':'Str','c':'Abstract'}])
    abstract_blocks=blocks[abstract_header+1:intro-1]
    assert len(abstract_blocks)==1 and abstract_blocks[0]['t']=='Para'
    (IEEE/'abstract.tex').write_text(fragment(ast,abstract_blocks)+'\n')
    body=copy.deepcopy(blocks[intro:])
    table_number=0
    rendered=[]
    i=0
    while i<len(body):
        b=body[i]
        if b['t']=='Table':
            table_number+=1;b=table_tex(ast,b,table_number)
        if b['t']=='Figure':
            following=body[i+1]
            assert following['t']=='Para' and following['c'][0]['t']=='Emph'
            inlines=copy.deepcopy(following['c'][0]['c'])
            assert inlines[0]['c']=='Figure'
            inlines=inlines[4:]
            b['c'][1]=[None,[{'t':'Plain','c':inlines}]]
            i+=1
        rendered.append(b);i+=1
    def break_code(node):
        if isinstance(node,list):return [break_code(v) for v in node]
        if isinstance(node,dict):
            if node.get('t')=='Code':return {'t':'RawInline','c':['latex',r'\nolinkurl{'+node['c'][1]+'}']}
            return {k:break_code(v) for k,v in node.items()}
        return node
    latex=fragment(ast,break_code(rendered))
    latex=latex.replace('\\begin{figure}','\\begin{codexfigure}').replace('\\end{figure}','\\end{codexfigure}')
    latex=latex.replace('\\citep{','\\cite{').replace('\\citet{','\\cite{')
    (IEEE/'body.tex').write_text(latex+'\n')
    cited=json.loads(pypandoc.convert_text(raw,'json',format='markdown',extra_args=['--citeproc','--bibliography='+str(IEEE/'refs.bib'),'--csl='+str(PAPER/'codex-tools/ieee.csl')]))
    def flatten(node):
        if isinstance(node,list):
            result=[]
            for value in node:
                cleaned=flatten(value)
                result.extend(cleaned) if isinstance(value,dict) and value.get('t') in ('Div','Span','Cite') else result.append(cleaned)
            return result
        if isinstance(node,dict):
            if node.get('t')=='Div':
                contents=flatten(node['c'][1])
                if node['c'][0][0]=='refs':contents=[{'t':'Header','c':[1,['',[],[]],[{'t':'Str','c':'References'}]]}]+contents
                return contents
            if node.get('t') in ('Span','Cite'):return flatten(node['c'][1])
            if node.get('t') in ('Image','Figure'):node['c'][0]=['',[],[]]
            return {k:flatten(v) for k,v in node.items()}
        return node
    cited['blocks']=flatten(cited['blocks'])
    cited['meta']={}
    md=convert(cited,'markdown+pipe_tables+tex_math_dollars-raw_html-native_divs-native_spans-grid_tables-multiline_tables-simple_tables',['--wrap=none'])
    title='Failure-Aware Spatial Interaction with Consumer Wearables: A Source-Audited Study of Head Targeting and Smartwatch Pinch Detection'
    md='# '+title+'\n\n**Vaibhav Bisht · 8 November 2026**\n\n'+md
    (IEEE/'manuscript.md').write_text(md)
    SPRINGER.mkdir(exist_ok=True)
    for filename in ('body.tex','abstract.tex','refs.bib','manuscript-source.md','manuscript.md'):
        shutil.copyfile(IEEE/filename,SPRINGER/filename)
    assert (IEEE/'body.tex').read_bytes()==(SPRINGER/'body.tex').read_bytes()
    for folder in (IEEE,SPRINGER):
        assert '[@' not in (folder/'manuscript.md').read_text()
        assert 'References' in (folder/'manuscript.md').read_text()
        for file in re.findall(r'\\includegraphics(?:\[[^]]*\])?\{([^}]+)\}',(folder/'body.tex').read_text()):
            assert (folder/file).exists(), file
    print('Rendered identical scientific body and complete cited Markdown for IEEE and Springer; two source tables converted to column-safe tabularx.')


if __name__=='__main__':main()
