"""Schematic of implemented architecture, not measured outcomes.
Run: uv run --isolated --no-project --with matplotlib==3.11.2 python docs/paper/codex-tools/system_figure.py
"""
from pathlib import Path
import shutil
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch,FancyArrowPatch
P=Path(__file__).resolve().parents[1]
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11})
fig,ax=plt.subplots(figsize=(11,5.6));ax.set(xlim=(0,1),ylim=(0,1));ax.axis('off')
def box(x,y,w,h,text,color):
 ax.add_patch(FancyBboxPatch((x,y),w,h,boxstyle='round,pad=0.008',facecolor=color,edgecolor='#444444',linewidth=1))
 ax.text(x+w/2,y+h/2,text,ha='center',va='center')
def edge(a,b,dashed=False):ax.add_patch(FancyArrowPatch(a,b,arrowstyle='-|>',mutation_scale=14,color='#444444',lw=1.3,linestyle='--' if dashed else '-'))
box(.02,.72,.25,.20,'Sony headset\nHead orientation\n(sensor source)','#E6F2F8')
box(.375,.72,.25,.20,'Desktop targeting\nCalibration + target hold','#E7F3EF')
box(.73,.72,.25,.20,'Paired interaction state\nEngage / release / cancel','#FFF2D5')
edge((.278,.82),(.367,.82));edge((.633,.82),(.722,.82))
box(.02,.37,.25,.21,'Galaxy Watch\nPPG + accelerometer\n+ gyroscope (sensors)','#E6F2F8')
box(.375,.37,.25,.21,'Desktop causal inference\nInput eligibility + scaling\nScores → emitted events','#E7F3EF')
box(.73,.37,.25,.21,'Bounded wrist mapping\nPaced native volume writes\nCancel obsolete queued work','#FFF2D5')
edge((.278,.475),(.367,.475))
ax.plot([.633,.69,.69,.78],[.475,.475,.66,.66],color='#444444',lw=1.3)
edge((.78,.66),(.78,.712));edge((.90,.712),(.90,.588))
box(.02,.045,.25,.17,'Camera landmarks\nReference annotation only','#F0F0F0')
box(.375,.045,.25,.17,'Saved sensor recordings\nOriginal + manual labels\nOffline training / audit','#F0F0F0')
edge((.278,.13),(.367,.13),True);edge((.50,.223),(.50,.362),True)
ax.text(.85,.13,'Off / Monitor / Live\nQuality and freshness checks\nExplicit fault cancellation',ha='center',va='center',fontsize=10)
path=P/'ieee codex/figures/system-overview.png';path.parent.mkdir(exist_ok=True)
fig.savefig(path,dpi=300,bbox_inches='tight',facecolor='white');plt.close(fig)
other=P/'springer codex/figures';other.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,other/path.name)
print('Created system-overview.png in both self-contained formats.')
