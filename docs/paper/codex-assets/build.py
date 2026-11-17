"""One CPU command for the complete numerical/figure rebuild. Optional frozen-source event replay."""
import argparse
from pathlib import Path
import subprocess
import sys
from common import HERE


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--replay',action='store_true');args=ap.parse_args()
    commands=[['-m','unittest','-v','test_assets'],['analyze.py']]
    if args.replay:commands.append(['replay.py'])
    commands += [['figures.py'],['gallery.py'],['verify.py','--write-manifest'],['verify.py']]
    for command in commands:
        print('+',sys.executable,*command,flush=True)
        subprocess.run([sys.executable,*command],cwd=HERE,check=True)
    print('DONE: open index.html; use figures/*.pdf in LaTeX and figures/*.png in Joplin.')

if __name__=='__main__':main()
