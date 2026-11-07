"""Generate evidence-labelled manuscript figures; no fitted models or simulated telemetry.
Run: uv run --isolated --no-project --with matplotlib --with numpy python docs/paper/revision-assets/make_figures.py
"""
from pathlib import Path
import csv
import json
import math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Patch
import numpy as np
from audit_evidence import ROOT, OUT, rows, effective

plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,
                     'axes.spines.right':False,'pdf.fonttype':42,'svg.fonttype':'none','svg.hashsalt':'paper-q2-audit'})
COLORS={'pinch_in':'#0072B2','pinch_hold':'#E69F00','pinch_out':'#009E73','':'#E8E8E8','left_out':'#888888'}


def save(fig,name):
    for ext in ('png','pdf','svg'):
        metadata = {'Date':None} if ext == 'svg' else {'CreationDate':None,'ModDate':None} if ext == 'pdf' else None
        path=OUT/f'{name}.{ext}'
        fig.savefig(path,dpi=300,bbox_inches='tight',facecolor='white',metadata=metadata)
        if ext == 'svg':
            path.write_text('\n'.join(line.rstrip() for line in path.read_text().splitlines())+'\n')
    plt.close(fig)


def box(ax,x,y,w,h,text,color='#EAF2F8'):
    ax.add_patch(FancyBboxPatch((x,y),w,h,boxstyle='round,pad=0.012',facecolor=color,edgecolor='#444444',linewidth=.8))
    ax.text(x+w/2,y+h/2,text,ha='center',va='center',fontsize=10)


def arrow(ax,a,b):
    ax.add_patch(FancyArrowPatch(a,b,arrowstyle='-|>',mutation_scale=13,color='#444444',lw=1.2))


def lineage(audit):
    fig,ax=plt.subplots(figsize=(11,5));ax.set(xlim=(0,1),ylim=(0,1));ax.axis('off')
    ax.set_title('Evidence lineage: historical results are not current-model results',fontsize=14,pad=16)
    box(ax,.025,.60,.28,.24,'Historical cue/camera labels\nOctober–early November\nMixed benchmarks; multiple protocols')
    box(ax,.37,.60,.26,.24,'Existing manuscript tables\nFusion, CNN / trees, LODO\nRetain as historical evidence')
    arrow(ax,(.317,.72),(.358,.72))
    box(ax,.025,.12,.28,.29,f'Hand-labelled directory\n{len(audit["records"])} exports → {audit["unique_sensor_pairs"]} unique sensor pairs\n14 have manual-label PPG rows\nFreeze sensor + annotation hashes','#E7F3EF')
    box(ax,.37,.12,.26,.29,'pinch_in-ae0a22bf manifest\n20 train + 8 evaluation IDs\n82.46% recorded event recall\n0 observed false activations/h','#E7F3EF')
    arrow(ax,(.317,.26),(.358,.26))
    box(ax,.70,.12,.27,.29,'Needed before headline update\nRecover event log + exposure\nAudit label versions and all tuning\nRun a prospective frozen test','#FFF2D5')
    arrow(ax,(.642,.26),(.688,.26))
    ax.text(.50,.49,'No direct improvement claim across different cohorts, labels or thresholds',ha='center',fontsize=10,fontweight='bold')
    ax.text(.5,.015,'Solid boxes: verified repository evidence. Yellow box: proposed verification, not a completed study.',ha='center',fontsize=9)
    save(fig,'evidence-lineage')


def spans(t,labels):
    if not len(t):return []
    starts=np.r_[0,np.flatnonzero(labels[1:]!=labels[:-1])+1]
    ends=np.r_[starts[1:],len(t)-1]
    return [(t[i],t[j],labels[i]) for i,j in zip(starts,ends)]


def annotation_figure():
    sid='gesture-dataset-pinch_hold-2026-11-03T01-05-59.434Z'
    folder=ROOT/'data/recordings/Hand labeled'/sid
    ppg=list(rows(folder/'ppg.csv')); imu=list(rows(folder/'imu.csv'))
    origin=int(ppg[0]['timestamp_ns'])
    t=np.array([(int(r['timestamp_ns'])-origin)/1e9 for r in ppg])
    old=np.array([r.get('label','') for r in ppg])
    new=np.array([effective(r.get('label',''),r.get('manual_label','')) for r in ppg])
    changes=np.flatnonzero(old!=new)
    assert len(changes)>0
    centre=t[changes[0]]
    lo,hi=max(0,centre-2),centre+5
    use=(t>=lo)&(t<=hi)
    fig,axes=plt.subplots(4,1,figsize=(10,6.2),sharex=True,gridspec_kw={'height_ratios':[2,1.5,.7,.7]},layout='constrained')
    for key,color,label in [('ppg_green','#0072B2','Green'),('ppg_red','#D55E00','Red'),('ppg_ir','#CC79A7','IR')]:
        x=np.array([float(r[key]) for r in ppg]); x=x[use]
        median=np.median(x);scale=np.median(np.abs(x-median))
        assert scale>0
        axes[0].plot(t[use],(x-median)/scale,color=color,lw=1,label=label)
    axes[0].set_ylabel('PPG\n(display MAD units)');axes[0].legend(ncol=3,loc='upper right')
    it=np.array([(int(r['timestamp_ns'])-origin)/1e9 for r in imu]); iu=(it>=lo)&(it<=hi)
    gyro=np.array([[float(r[k]) for k in ('gyro_x','gyro_y','gyro_z')] for r in imu])
    axes[1].plot(it[iu],np.linalg.norm(gyro[iu],axis=1),color='#333333',lw=1)
    axes[1].set_ylabel('Gyro norm\n(rad/s)')
    for ax,labels,title in zip(axes[2:],[old,new],['Original label','Effective label']):
        for a,b,label in spans(t,labels):
            if b>=lo and a<=hi:ax.axvspan(max(a,lo),min(b,hi),facecolor=COLORS.get(label,'#AAAAAA'),edgecolor='none')
        ax.set_yticks([]);ax.set_ylabel(title,rotation=0,ha='right',va='center');ax.set_ylim(0,1)
    axes[-1].set_xlim(lo,hi);axes[-1].set_xlabel('Seconds from first saved PPG timestamp (watch clock)')
    axes[0].set_title('Observed telemetry and saved annotation revision — not model output',fontsize=13)
    fig.legend(handles=[Patch(color=COLORS[x],label=x) for x in ('pinch_in','pinch_hold','pinch_out')],loc='outside lower center',ncol=3)
    save(fig,'annotation-telemetry')
    return dict(recording=sid,origin_timestamp_ns=origin,range_s=[lo,hi],normalization='each PPG channel centred by displayed-window median and divided by displayed-window unscaled MAD; visualisation only; not model preprocessing',source='saved ppg.csv and imu.csv; manual_label overrides label; no time shifts')


def historical():
    source=ROOT/'docs/research/artifacts/cnn-all-days-2026-11/results.md'
    found=[]
    for line in source.read_text().splitlines():
        parts=[s.strip() for s in line.split('|')]
        if len(parts)>6 and parts[2]=='all moments, no still-hand gate':
            caught,total=parts[4].split('(')[0].strip().split('/')
            far_pinch=parts[4].split('·')[1].strip();far_noise=parts[5].split('(')[0].strip()
            found.append((parts[1],int(caught),int(total),far_pinch,far_noise))
    assert len(found)==4
    fig,ax=plt.subplots(figsize=(9,4.5),layout='constrained')
    pct=[100*c/n for _,c,n,_,_ in found]
    ax.bar(range(4),pct,color=['#D55E00','#D55E00','#0072B2','#0072B2'],width=.58)
    for i,(date,c,n,p,noise) in enumerate(found):
        ax.text(i,pct[i]+2,f'{c}/{n}\n{pct[i]:.1f}%',ha='center',fontsize=10)
    ax.set_xticks(range(4),[f'{d}\nFAR pinch {p}\nFAR noise {noise}' for d,_,_,p,noise in found])
    ax.set_ylim(0,100);ax.set_ylabel('Caught pinch-in starts (%)')
    ax.set_title('Historical camera-label transfer varies sharply by held-out day',fontsize=13)
    ax.axhline(100*sum(x[1] for x in found)/sum(x[2] for x in found),ls='--',color='#333333',lw=1)
    ax.text(3.43,43.28,'Pooled\n161/372\n43.3%',va='center',fontsize=9)
    ax.set_xlim(-.6,3.9)
    fig.text(.5,-.02,'FAR: events/hour of no-gesture time. Historical explored LODO; not the hand-labelled model or a new test.',ha='center',fontsize=9)
    save(fig,'historical-day-transfer')


def protocol():
    fig,ax=plt.subplots(figsize=(11,4.8));ax.set(xlim=(0,1),ylim=(0,1));ax.axis('off')
    ax.set_title('Proposed confirmatory protocol — not yet performed',fontsize=14,pad=16)
    steps=[(.02,'1. Canonical recording groups\nSensor hashes + label versions\nKeep aliases in the same group'),(.36,'2. Development only\nGrouped inner validation\nChoose architecture + thresholds'),(.70,'3. Freeze before new collection\nModels, code, matching, exclusions\nDeclare hypotheses + budgets')]
    for x,text in steps:box(ax,x,.62,.28,.24,text)
    arrow(ax,(.312,.74),(.348,.74));arrow(ax,(.652,.74),(.688,.74))
    box(ax,.70,.13,.28,.28,'4. New participants / new days\nStrap refits + realistic negatives\nNo fitting or threshold changes','#E7F3EF')
    arrow(ax,(.84,.608),(.84,.422))
    box(ax,.36,.13,.28,.28,'5. Continuous replay + live tasks\nCatch / miss / repeat / late\nRaw decision and action latency','#E7F3EF')
    arrow(ax,(.688,.27),(.652,.27))
    box(ax,.02,.13,.28,.28,'6. Report all outcomes\nPer-label and per-person results\nExposure + uncertainty + failures','#E7F3EF')
    arrow(ax,(.348,.27),(.312,.27))
    save(fig,'prospective-protocol')


def main():
    audit=json.loads((OUT/'evidence-audit.json').read_text())
    lineage(audit); provenance=annotation_figure();historical();protocol()
    (OUT/'figure-provenance.json').write_text(json.dumps({'annotation-telemetry':provenance,'historical-day-transfer':{'source':'docs/research/artifacts/cnn-all-days-2026-11/results.md','configuration':'all moments, no still-hand gate','evidence':'historical exploratory camera-label results'},'evidence-lineage':{'source':'evidence-audit.json and checked manifests','evidence':'audit schematic, not performance comparison'},'prospective-protocol':{'evidence':'proposed future design, no measured results'}},indent=2)+'\n')
    print('Generated 4 figures in PNG, PDF and SVG; recorded figure provenance.')

if __name__=='__main__': main()
