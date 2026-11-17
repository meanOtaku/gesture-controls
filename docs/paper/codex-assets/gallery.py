"""Offline visual review gallery/contact sheet of the actual rendered assets."""
from html import escape
from PIL import Image,ImageOps,ImageDraw
from common import HERE,read_json


def main():
    catalog=read_json(HERE/'figure-catalog.json')
    html=['<!doctype html><html lang="en"><meta charset="utf-8"><title>Codex paper assets</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:1rem;background:#f5f6f8}article{background:white;padding:1.5rem;margin:1rem 0;border-radius:8px}img{max-width:100%;height:auto}small{color:#46505c}a{color:#0066a6}</style><h1>Paper assets — existing evidence, not new studies</h1><p>Original SVG text remains editable. Click a PNG to inspect it at full size. Read each caption and evidence status before using a figure.</p>']
    sheet=Image.new('RGB',(2560,2000),'white');draw=ImageDraw.Draw(sheet)
    for i,f in enumerate(catalog):
        png=next(p for p in f['files'] if p.endswith('.png'))
        html += [f'<article><h2>{escape(f["id"])} — {escape(f["title"])}</h2><strong>{escape(f["evidence_status"])}</strong>',f'<a href="{escape(png)}"><img src="{escape(png)}" alt="{escape(f["alt"])}"></a>',f'<p>{escape(f["caption"])}</p><small>{escape(f["transformations"])}</small><p>']
        html += [f'<a href="{escape(p)}">{p.rsplit(".",1)[-1].upper()}</a>' for p in f['files']]
        html += ['</p></article>']
        with Image.open(HERE/png) as image:
            preview=ImageOps.contain(image.convert('RGB'),(620,450))
            x=(i%4)*640+(640-preview.width)//2;y=(i//4)*500+32
            sheet.paste(preview,(x,y));draw.text(((i%4)*640+12,(i//4)*500+10),f['id'],fill='#111111')
    html += ['</html>']
    (HERE/'index.html').write_text('\n'.join(html)+'\n')
    sheet.save(HERE/'OVERVIEW.png',optimize=True)
    print('Created offline index.html and OVERVIEW.png contact sheet.')

if __name__=='__main__':main()
