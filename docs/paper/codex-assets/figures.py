"""Publication-oriented figures from collected evidence; no training and no synthetic outcomes."""
import argparse
from pathlib import Path
import json
import re
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Patch
from matplotlib.lines import Line2D
from common import HERE, read_json, write_json, rows, effective, spans, digest

COLORS = ['#0072B2','#D55E00','#009E73','#CC79A7']
LABEL_COLORS = {'pinch_in':'#0072B2','pinch_hold':'#E69F00','pinch_out':'#009E73','left_out':'#999999','':'#eeeeee'}
STYLE = {'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False,'pdf.fonttype':42,'svg.fonttype':'none','svg.hashsalt':'gesture-codex-assets-v1','savefig.facecolor':'white'}
CATALOG = []
OUT = HERE/'figures'

def save(fig, name, title, caption, evidence, sources, alt, transformations='No transformation beyond labelled plotting of source values.'):
    OUT.mkdir(parents=True,exist_ok=True)
    fig.canvas.draw()
    bbox = fig.get_tightbbox(fig.canvas.get_renderer())
    assert bbox.x0 >= -.02 and bbox.y0 >= -.02 and bbox.x1 <= fig.get_figwidth()+.02 and bbox.y1 <= fig.get_figheight()+.02, (name, 'artist would be clipped', bbox)
    files = []
    for ext in ('png','svg','pdf'):
        path = OUT/f'{name}.{ext}'
        meta = {'Date':None} if ext=='svg' else {'CreationDate':None,'ModDate':None} if ext=='pdf' else {'Software':'codex-assets/figures.py'}
        fig.savefig(path,dpi=300,facecolor='white',metadata=meta)
        if ext=='svg':
            path.write_text('\n'.join(x.rstrip() for x in path.read_text().splitlines())+'\n')
        files.append(str(path.relative_to(OUT.parent)))
    CATALOG.append({'id':name,'title':title,'caption':caption,'evidence_status':evidence,'sources':sources,'alt':alt,'transformations':transformations,'width_inches':float(fig.get_figwidth()),'height_inches':float(fig.get_figheight()),'files':files})
    plt.close(fig)

def box(ax, x, y, w, h, text, color='#e7f1f7', size=10):
    ax.add_patch(FancyBboxPatch((x,y),w,h,boxstyle='round,pad=0',fc=color,ec='#34495e',lw=1))
    ax.text(x+w/2,y+h/2,text,ha='center',va='center',fontsize=size)

def arrow(ax, a, b, text=None, offset=(0,.025), style='-|>'):
    ax.add_patch(FancyArrowPatch(a,b,arrowstyle=style,mutation_scale=13,lw=1.25,color='#34495e',shrinkA=0,shrinkB=0))
    if text:
        ax.text((a[0]+b[0])/2+offset[0],(a[1]+b[1])/2+offset[1],text,ha='center',va='center',fontsize=8,bbox={'facecolor':'white','edgecolor':'none','pad':1})

def diagram(title, size=(11,5)):
    fig,ax=plt.subplots(figsize=size)
    fig.subplots_adjust(left=.025,right=.975,top=.88,bottom=.06)
    ax.set(xlim=(0,1),ylim=(0,1));ax.axis('off');fig.suptitle(title,fontsize=14,fontweight='bold')
    return fig,ax

def schematics():
    fig,ax=diagram('Consumer-wearable sensing → recognition → deliberate control')
    box(ax,.02,.66,.24,.23,'Consumer headphones\nHead orientation\n(no eye tracking)')
    box(ax,.02,.25,.24,.25,'Commercial watch\nGreen / red / IR PPG\nAccelerometer + gyroscope')
    box(ax,.39,.66,.23,.23,'Targeting\nCalibration + eligible target')
    box(ax,.39,.25,.23,.25,'Laptop inference\nCausal features + model\nPinch start / release')
    box(ax,.76,.43,.22,.30,'Interaction policy\nGrab / wrist adjustment\nRelease / cancellation','#e6f3eb')
    arrow(ax,(.26,.775),(.39,.775));arrow(ax,(.26,.375),(.39,.375))
    arrow(ax,(.62,.775),(.87,.73));arrow(ax,(.62,.375),(.76,.50))
    box(ax,.39,.01,.23,.13,'Camera: reference labels only','#fff0d8',9)
    arrow(ax,(.26,.25),(.39,.075),'offline annotation',offset=(0,-.015))
    ax.text(.87,.22,'Bounded output to OS\nMonitor never actuates',ha='center',fontsize=10)
    arrow(ax,(.87,.43),(.87,.29))
    save(fig,'01-system-architecture','System architecture','Implemented sensing/computation placement. Camera annotation is an offline path, not an operational input. This schematic is not a hardware-validation result.','implemented architecture schematic',['docs/architecture/label-inference.md','docs/paper/manuscript/sections/03-system-design.tex'],'Headphones and watch feed targeting and recognition on a laptop, then a separate policy controls output.')
    fig,ax=diagram('Interaction state is not the same as a momentary model prediction')
    box(ax,.02,.55,.22,.23,'Idle\nNo control ownership')
    box(ax,.39,.55,.22,.23,'Eligible target\nHead-directed selection')
    box(ax,.76,.55,.22,.23,'Grabbed\nWrist-relative adjustment','#e6f3eb')
    box(ax,.39,.10,.22,.23,'Release / cancel\nStop further output','#fff0d8')
    arrow(ax,(.24,.665),(.39,.665),'head targets control')
    arrow(ax,(.61,.665),(.76,.665),'fresh pinch-in')
    arrow(ax,(.87,.55),(.61,.215),'pinch-out / target exit / stale input',offset=(.02,.02))
    arrow(ax,(.39,.215),(.13,.55),'return to idle',offset=(-.025,0))
    ax.text(.5,.94,'Conceptual policy overview; exact guards remain authoritative in source code',ha='center',fontsize=9)
    ax.text(.5,.015,'Off / Monitor / Live are actuation modes. Classifier silence is not a physical release.',ha='center',fontsize=10)
    save(fig,'02-interaction-policy','Interaction policy','Conceptual interaction state and cancellation paths. A recognizer event is not continuous control state, and silence is not release. Physical fault and task acceptance remain unmeasured here.','implemented policy schematic',['docs/paper/manuscript/sections/03-system-design.tex'],'Fresh pinch-in starts a grab; release or cancellation ends it, independently of classifier silence.')
    fig,ax=diagram('Closest-prior-work hardware distinction — not a performance ranking',(11,5.5))
    box(ax,.03,.23,.43,.57,'μDPad: purpose-built prototype\n\nWaveshare ESP32-S3-LCD + QMI8658\nAdditional XIAO ESP32-S3\nEight-channel spatial PPG\n\nPinch close/open + wrist rotation','#fff0d8',11)
    box(ax,.54,.23,.43,.57,'This project: commercial devices\n\nUnmodified Samsung Galaxy Watch\nBuilt-in green / red / IR PPG + IMU\nConsumer headphone head tracking\n\nLaptop inference and bounded control','#e6f3eb',11)
    ax.text(.5,.08,'Spatial optical channels ≠ wavelength channels. Task, cohort and sensors differ.\nCommercial-watch PPG gesture sensing also predates this project.',ha='center',fontsize=10)
    save(fig,'03-hardware-positioning','Hardware positioning','Original comparison schematic, not product photographs. μDPad uses custom hardware; this project uses built-in commercial-watch sensors. The interaction concept overlaps. No accuracy superiority or first-commercial-watch claim is made.','literature-positioning schematic',['https://doi.org/10.1145/3776574.3831197','docs/paper/notes/PAPER_IMPROVEMENT_GUIDE.md'],'Custom spatial-PPG prototype contrasted with an unmodified commercial watch; no performance bars.')
    fig,ax=diagram('CNNv2 feature/branch overview — architecture schematic',(11,5.2))
    box(ax,.02,.35,.20,.33,'Past-only input\n1 s on 100 Hz grid\n+ scaling history')
    branches=[(.73,'Accelerometer\n+ jerk envelope'),(.43,'Gyroscope'),(.13,'Green / red / IR PPG')]
    for y,label in branches:
        box(ax,.36,y,.22,.19,label,size=10);arrow(ax,(.22,.515),(.36,y+.095))
    box(ax,.72,.35,.25,.33,'Branch features\n+ shared processing\nPooling + output head','#e6f3eb')
    for y,_ in branches:arrow(ax,(.58,y+.095),(.72,.515))
    ax.text(.5,.015,'Diagram omits layer widths. Binary onset and four-class delayed-state heads have different targets.',ha='center',fontsize=9)
    save(fig,'16-cnnv2-architecture','CNNv2 architecture','Conceptual newer input/branch structure, not a layer-exact network diagram or proof that every sensor samples at 100 Hz. Binary onset and delayed-state experiments must remain distinct.','implemented architecture schematic',['tools/label-trainer/src/label_trainer/cnn_v2.py','crates/pinch-inference/src/cnn_input.rs'],'Three sensor-specific paths feed shared processing and an output head.')

def telemetry():
    selection=read_json(HERE/'data/telemetry/selection.json');origin=selection['origin_timestamp_ns']
    pp=list(rows(HERE/'data/telemetry/ppg.csv'));im=list(rows(HERE/'data/telemetry/imu.csv'))
    t=np.array([(int(r['timestamp_ns'])-origin)/1e9 for r in pp])
    it=np.array([(int(r['timestamp_ns'])-origin)/1e9 for r in im])
    old=[r.get('label','') for r in pp];new=[effective(r.get('label',''),r.get('manual_label','')) for r in pp]
    fig,axs=plt.subplots(4,1,figsize=(11,7),sharex=True,gridspec_kw={'height_ratios':[2,1.5,.6,.6]},layout='constrained')
    for key,color,style,label in zip(['ppg_green','ppg_red','ppg_ir'],COLORS,['-','--',':'],['Green','Red','IR']):
        x=np.array([float(r[key]) for r in pp]);med=np.median(x);mad=np.median(abs(x-med));assert mad>0
        axs[0].plot(t,(x-med)/mad,color=color,ls=style,lw=1,label=label)
    axs[0].legend(ncol=3);axs[0].set_ylabel('PPG (display MAD units)')
    gyro=np.array([[float(r[k]) for k in ['gyro_x','gyro_y','gyro_z']] for r in im])
    axs[1].plot(it,np.linalg.norm(gyro,axis=1),color='#333333',lw=1);axs[1].set_ylabel('Gyro norm (rad/s)')
    for ax,labels,name in zip(axs[2:],[old,new],['Original','Effective']):
        for a,b,label in spans(t,labels):
            ax.axvspan(a,b,color=LABEL_COLORS.get(label,'#bbbbbb'))
            if label and b-a>.12:ax.text((a+b)/2,.5,label.replace('pinch_',''),ha='center',va='center',fontsize=8,rotation=30 if b-a<.7 else 0)
        ax.set(ylim=(0,1),yticks=[]);ax.set_ylabel(name)
    for ax in axs[:2]:
        for a,b,label in spans(t,new):
            if label in LABEL_COLORS and label:ax.axvspan(a,b,color=LABEL_COLORS[label],alpha=.09)
    axs[-1].set_xlabel('Seconds from first original PPG timestamp (watch clock)');axs[-1].set_xlim(t[0],t[-1])
    fig.suptitle('Observed signals and saved annotation correction — not model output',fontsize=13)
    save(fig,'04-annotation-telemetry','Observed telemetry and annotation','Unmodified recorded row subset around the first saved effective-label correction. Gesture bands are shaded and named. Green/red/IR are centred and divided by the unscaled MAD of the displayed excerpt for viewing only. No model scores, filtering or timing shifts are manufactured.','observed raw-data excerpt',['data/telemetry/ppg.csv','data/telemetry/imu.csv','data/telemetry/selection.json'],'PPG and gyroscope traces above original and corrected gesture-label bands.','Display-only median/MAD scaling per PPG channel; gyroscope Euclidean norm; original timestamp differences.')

def historical_figures(m):
    d=read_json(HERE/'data/historical/report-figure-data.json');q=d['timeline']
    fig,ax=plt.subplots(figsize=(11,4.5),layout='constrained');t=np.array(q['t_s']);s=np.array(q['score'])
    stop=min(45,float(t[-1]));use=t<=stop
    ax.plot(t[use],s[use],color=COLORS[0],lw=1,label='Stored score')
    ax.axhline(q['activation'],ls='--',color='#333333',label='Activation cutoff')
    for h in q['holds']:
        if h['start_s']<=stop:ax.axvspan(max(0,h['start_s']),min(stop,h['end_s']),alpha=.12,color=LABEL_COLORS.get(h['label'],'#aaaaaa'))
    for start in q['starts']:
        if 0<=start['t_s']<=stop:
            ax.axvline(start['t_s'],color=COLORS[2] if start['caught'] else COLORS[1],ls=':' if start['caught'] else '-.',lw=1)
    for event in q['events']:
        if 0<=event['t_s']<=stop:ax.plot(event['t_s'],.04,'v',color='#111111',ms=5)
    handles,labels=ax.get_legend_handles_labels();handles += [Line2D([],[],ls=':',color=COLORS[2],label='Caught reference start'),Line2D([],[],ls='-.',color=COLORS[1],label='Missed reference start'),Line2D([],[],marker='v',ls='',color='black',label='Emitted event')]
    handles += [Patch(facecolor=color,alpha=.25,label=label.replace('_','-')) for label,color in LABEL_COLORS.items() if label.startswith('pinch_')]
    ax.legend(handles=handles,loc='upper center',ncol=4,fontsize=8)
    ax.set(xlim=(0,stop),ylim=(-.02,1.08),xlabel='Seconds from stored first scored decision',ylabel='Model score',title='Historical model score replay — original operating point')
    save(fig,'05-historical-score-timeline','Historical score timeline','First 45 seconds of the stored pinch_in-ae0a22bf timeline. Vertical styles distinguish caught/missed reference starts; triangles mark actual stored emissions and background bands show stored gesture intervals. Scores/times were rounded by the original exporter. This is not a fresh inference run or a CNNv2 trace.','stored historical model replay',['data/historical/report-figure-data.json'],'Stored classifier score with threshold, actual emissions and caught or missed reference starts.','Original exporter rounding retained; display cropped at 45 s; no interpolation over unavailable intervals.')
    fig,axs=plt.subplots(1,2,figsize=(11,4.1),layout='constrained')
    for ax,stream,color in zip(axs,['ppg','imu'],COLORS):
        z=d['timing'][stream];bins=np.array(z['bins_ms']);counts=np.array(z['counts']);ax.bar(bins[:-1],100*counts/counts.sum(),width=np.diff(bins),align='edge',color=color)
        ax.set(xlabel='Positive inter-sample interval (ms)',ylabel='Intervals (%)',title=f'{stream.upper()}: median {z["median_ms"]:.2f} ms; p99 {z["p99_ms"]:.2f} ms',xlim=(0,100))
    fig.suptitle('Historical stream delivery timing — not the model resampling rate')
    save(fig,'06-sensor-delivery-timing','Sensor delivery timing','Stored positive timestamp-gap histograms over the historical model cohort. Equal timestamps were excluded by the original exporter. Gaps at or above 100 ms were folded into the last 99–100 ms bin; maxima and >250 ms counts remain in the source JSON.','stored historical timestamp analysis',['data/historical/report-figure-data.json'],'PPG and IMU gap histograms distinguish real sampling/delivery from the inference grid.','Counts normalized within stream; original tail clipping explicitly retained.')
    fig,ax=plt.subplots(figsize=(8.6,4.5),layout='constrained');audit=m['audit'];x=np.arange(2)
    for off,k,label,color in [(-.17,'exports','Exported folders',COLORS[0]),(.17,'unique','Distinct exact stream pairs',COLORS[2])]:
        vals=[audit[f'historical_{k}'],audit[f'current_{k}']];bars=ax.bar(x+off,vals,.32,label=label,color=color);ax.bar_label(bars,padding=3)
    ax.set(xticks=x,xticklabels=['Historical audit snapshot','Current collection snapshot'],ylabel='Count',ylim=(0,max(audit['current_exports'],37)*1.2),title='Export counts are not independent sensor streams');ax.legend()
    save(fig,'07-dataset-identity','Dataset identity audit','Historical 37-export audit and the new read-only collection audit are separate snapshots. Exact hashes ignore label columns; they do not detect partial overlap. No duplicated source was found across the historical audited model split; duplicate presence alone does not prove leakage.','historical and current dataset audits',['data/historical/evidence-audit.json','data/current-inventory.json'],'Grouped bars compare exported folders with distinct exact PPG/IMU stream pairs at two snapshots.')
    fig,ax=plt.subplots(figsize=(9,4.6),layout='constrained');rr=m['historical_transfer'];vals=[100*r['caught']/r['gestures'] for r in rr];bars=ax.bar(range(len(rr)),vals,color=COLORS)
    ax.bar_label(bars,labels=[f'{r["caught"]}/{r["gestures"]}\n{v:.1f}%' for r,v in zip(rr,vals)],padding=4)
    ax.set(xticks=range(len(rr)),xticklabels=[r['day'] for r in rr],ylabel='Caught pinch-in starts (%)',ylim=(0,105),title='Historical cross-day transfer: performance varies by held-out day')
    save(fig,'08-historical-day-transfer','Historical day transfer','Historical camera-label leave-one-day-out exploration with the all-moments/no-still-hand-gate configuration. Counts sum to 161/372. Days are not independent confidence-interval replicates; these results are not directly comparable with a newer hand-labelled or multiclass cohort.','historical exploratory results',['data/historical/day-transfer.md'],'Four bars show caught counts and recall varying across held-out days.')

def measured_and_documented(m):
    z=m['motion_documented'];fig,ax=plt.subplots(figsize=(9,4.8),layout='constrained')
    for key,label,color,marker in [('before','All-history median',COLORS[1],'s'),('after','Fast-motion history excluded',COLORS[0],'o')]:
        ax.plot(z['gaps_s'],100*np.array(z[key])/z['n'],label=label,color=color,marker=marker,lw=1.7)
        for x,n in zip(z['gaps_s'],z[key]):ax.annotate(f'{n}/50',(x,100*n/50),xytext=(0,7 if key=='after' else -15),textcoords='offset points',ha='center',fontsize=8)
    ax.set(xlabel='Seconds from end of a 6 s spliced motion burst to pinch',ylabel='Peak-window detection (%)',ylim=(0,105),title='Documented synthetic motion recovery — not a physical trial');ax.legend(loc='center right',fontsize=9)
    save(fig,'09-motion-recovery-documented','Motion-history recovery','Counts transcribed programmatically from the original motion-hangover report for its 50-start pinch-in experiment. This is peak-window detection after a synthetic splice, not standard event recall, not raw replay regeneration, and not a live physical-motion study. No confidence intervals are asserted.','documented exploratory summary only',['data/documented/motion-hangover.md'],'Before/after scaling counts show recovery at five delays after a spliced six-second movement.','Reported counts divided by 50; straight lines connect only the five documented conditions.')
    names=['Reference','V2 gated','V2 + overlay','App-trained V2']
    order=['ref-ae0a22bf','final-branches-warp-env-m3-gate600q10','final-branches-warp-env-m3-overlay2-gate600q10','app-trained-v2-pinch_in-6e2053d0']
    by={d['name']:d for d in m['v2']};fig,axs=plt.subplots(2,1,figsize=(11,7),layout='constrained');x=np.arange(3);width=.18
    for i,(name,key,color) in enumerate(zip(names,order,COLORS)):
        r=by[key];vals=[];labels=[]
        for group in ['live','moving','resting']:
            a=r['groups'][group];vals.append(100*a['caught']/a['gestures']);labels.append(f'{a["caught"]}/{a["gestures"]}')
        b=axs[0].bar(x+(i-1.5)*width,vals,width,color=color,label=f'{name} (τ={r["threshold"]})');axs[0].bar_label(b,labels=labels,padding=2,fontsize=7,rotation=60)
        groups=['moving','resting','everyday','still'];v=[]
        for group in groups:
            a=r['groups'][group];v.append(a['fa']/a['neg_h'] if a['neg_h']>0 else np.nan)
        axs[1].bar(np.arange(4)+(i-1.5)*width,v,width,color=color,label=name)
    axs[0].set(xticks=x,xticklabels=['Live-style','Moving','Resting'],ylabel='Event recall (%)',ylim=(0,115));axs[0].legend(ncol=2,fontsize=9,loc='upper center')
    axs[1].set(xticks=np.arange(4),xticklabels=['Moving','Resting','Everyday negatives','Still negatives'],ylabel='False activations / negative hour')
    fig.suptitle('Stored operating points — fixed historical benchmark, not an untouched test')
    save(fig,'10-v2-operating-points','CNNv2 operating points','Each model is plotted at its stored chosen threshold. The two final V2 operating points were independently reselected from saved training-OOF budget tables; reference/app thresholds are stored values. This is a descriptive comparison, not an isolated component ablation. Repeated historical test exploration limits confirmatory interpretation; zero observed FA is not zero long-run risk.','stored benchmark with verified OOF threshold arithmetic',['data/v2/*.json','derived/metrics.json'],'Context-specific event recall and false activations for four stored model operating points.','Recall=100*caught/gestures; FAR=fa/negative_hours; no threshold optimized against test groups.')
    rows_=m['paired_documented'];fig,axs=plt.subplots(1,3,figsize=(11,4.2),layout='constrained');labels=[r['label'].replace('_','-') for r in rows_]
    for ax,key,title in zip(axs,['recall','far_per_hour_rounded','median_latency_ms'],['Event recall (%)','Reported false activations / h','Reported median latency (ms)']):
        vals=[100*r['caught']/r['gestures'] if key=='recall' else r[key] for r in rows_];bars=ax.bar(labels,vals,color=COLORS[:2]);ax.bar_label(bars,fmt='%.1f',padding=3);ax.set_ylabel(title);ax.set_ylim(0,max(vals)*1.22)
    fig.suptitle('Later paired detector report — archived summary, not independently replayed')
    save(fig,'15-paired-model-summary','Paired detector summary','Later paired-model Markdown summary: 95/120 pinch-in and 96/127 pinch-out catches. FAR was rounded in the original summary. Corresponding original full run artifacts were not recovered; similarly named results elsewhere have different denominators and were deliberately not substituted. Do not combine these with the older 47/57 cohort or call this a freshly verified model comparison.','documented summary only',['data/documented/paired-models.md'],'Three panels reproduce documented paired-detector recall, rounded FAR and median latency.')

def multiclass(m):
    first=m['multiclass'][0];order=[0,1,3,2];cm=np.array(first['test']['confusion_matrix'])[order][:,order];pct=100*cm/cm.sum(1,keepdims=True);labels=['Background','Pinch-in','Pinch-hold','Pinch-out']  # in, hold, out: the gesture's order, as in the event confusion
    fig,ax=plt.subplots(figsize=(8.5,7),layout='constrained');im=ax.imshow(pct,vmin=0,vmax=100,cmap='Blues')
    for i in range(4):
        for j in range(4):ax.text(j,i,f'{pct[i,j]:.1f}%\n({cm[i,j]:,})',ha='center',va='center',color='white' if pct[i,j]>55 else '#14243c')
    ax.set(xticks=range(4),yticks=range(4),xticklabels=labels,yticklabels=[f'{l}\nn={n:,}' for l,n in zip(labels,cm.sum(1))],xlabel='Predicted state',ylabel='Annotated delayed state',title='Four-class CNNv2: seed 17, recording-held-out decisions')
    fig.colorbar(im,ax=ax,label='Row percentage');fig.supxlabel('500 ms label delay · no stillness/jerk gate · historical reused cohort',fontsize=9)
    save(fig,'11-multiclass-confusion','Multiclass confusion matrix','Independently recomputed from all saved seed-17 held-out decision vectors. Rows are delayed annotated states; cells show row percentage and exact decision count. This is not onset-event accuracy or physical hold-duration accuracy.','recomputed from original prediction vectors',['data/multiclass/predictions/*.npz','data/multiclass/snapshot.json','derived/confusion-seed-17.csv'],'Four-class confusion matrix exposes weaker hold recall despite high overall accuracy.','Argmax of stored probabilities; exact integer counts; row-normalized percentages.')
    fig,ax=plt.subplots(figsize=(9,4.6),layout='constrained');x=np.arange(3)
    for i,(key,label,color) in enumerate(zip(['accuracy','balanced_accuracy','macro_f1'],['Accuracy','Balanced accuracy','Macro-F1'],COLORS)):
        vals=[100*r['test'][key] for r in m['multiclass']];bars=ax.bar(x+(i-1)*.23,vals,.22,color=color,label=label);ax.bar_label(bars,fmt='%.2f',padding=3,fontsize=8)
    ax.set(xticks=x,xticklabels=[f'Seed {r["seed"]}' for r in m['multiclass']],ylabel='Score out of 100 (%)',ylim=(0,110),title='Three independent models on the same split — not confidence intervals');ax.legend(ncol=3,loc='lower center')
    save(fig,'12-multiclass-seeds','Seed variation','All three models are shown, not an ensemble or a test-selected best seed. Accuracy, balanced accuracy and macro-F1 were recomputed from saved vectors. Seed variation on one split is not participant uncertainty.','recomputed from original prediction vectors',['data/multiclass/predictions/*.npz','derived/multiclass-metrics.csv'],'Three models have high overall accuracy but lower class-balanced scores.')
    events=first['stored_test_events'];fig,axs=plt.subplots(1,3,figsize=(11,4.6),layout='constrained')
    for ax,key,title in zip(axs,['gestureRecall','falseActivationsPerHour','medianLatencyMs'],['Event recall (%)','False activations / negative h','Matched median latency (ms)']):
        vals=[events[k][key]*(100 if key=='gestureRecall' else 1) for k in ['pinch_in','pinch_hold','pinch_out']];bars=ax.bar(labels[1:],vals,color=COLORS[:3]);ax.bar_label(bars,fmt='%.1f',padding=3);ax.set_ylabel(title);ax.tick_params(axis='x',labelrotation=25);ax.set_ylim(0,max(vals)*1.22)
    fig.suptitle('Seed 17 continuous replay — delayed-state target, not production onset target')
    save(fig,'13-multiclass-events','Multiclass continuous events','Stored seed-17 event aggregates, with recall/FAR arithmetic checked in analyze.py and independently reproducible via replay.py using frozen trainer source and matching raw recordings. Hold recall means hold-entry detection, not duration accuracy. Event classes use different negative exposure denominators. No binary-superiority claim is made.','stored events; frozen-source replay verified separately',['data/multiclass/results.json','derived/event-replay-verification.json'],'Three panels report event recall, false activations and latency for pinch-in, pinch-out and hold entry.')

def protocol():
    fig,ax=diagram('Proposed next experiments — no outcome values exist yet',(11,5.8))
    boxes=[(.02,.62,'1. Declare + freeze\nLabels, groups, thresholds\nBudgets and match windows'),(.37,.62,'2. Matched ablations\nIMU / PPG / fusion\nScaling and gate variants'),(.72,.62,'3. Physical perturbations\nMovement then pinch\nHaptics on/off with logs'),(.72,.12,'4. Prospective collection\nNew days + refits + users\nCalibration kept separate'),(.37,.12,'5. Complete interaction\nSelect → grab → adjust → release\nFault and cancellation trials'),(.02,.12,'6. Report every outcome\nMiss / late / repeat / FA\nExposure, latency, availability')]
    for x,y,t in boxes:box(ax,x,y,.26,.25,t,'#fff0d8' if y>.5 else '#e6f3eb',9)
    arrow(ax,(.28,.745),(.37,.745));arrow(ax,(.63,.745),(.72,.745));arrow(ax,(.85,.62),(.85,.37));arrow(ax,(.72,.245),(.63,.245));arrow(ax,(.37,.245),(.28,.245))
    ax.text(.5,.015,'Study design schematic only. No participant outcomes, power estimates or superiority results are invented.',ha='center',fontsize=9)
    save(fig,'14-prospective-protocol','Proposed validation protocol','Proposed frozen development, physical perturbation, prospective generalisation and complete-interaction workflow. This figure contains no measured results. Required sample size/exposure must be decided from pilot variability and precision goals.','proposed protocol — not performed',['docs/paper/notes/PAPER_IMPROVEMENT_GUIDE.md'],'Six connected steps separate development, freezing, new data and interaction validation.')

def main():
    global OUT
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=OUT);args=parser.parse_args();OUT=args.output.resolve()
    m=read_json(HERE/'derived/metrics.json')
    with plt.rc_context(STYLE):
        schematics();telemetry();historical_figures(m);measured_and_documented(m);multiclass(m);protocol()
    CATALOG.sort(key=lambda x:x['id'])
    write_json(OUT.parent/'figure-catalog.json',CATALOG)
    lines=['# Figure captions and evidence status','']
    for f in CATALOG:
        lines += [f'## {f["id"]} — {f["title"]}','',f'**Evidence:** {f["evidence_status"]}', '',f['caption'],'',f'**Alt text:** {f["alt"]}','',f'**Transformations:** {f["transformations"]}','', '**Sources:** '+', '.join('`'+s+'`' for s in f['sources']),'']
    (OUT.parent/'CAPTIONS.md').write_text('\n'.join(lines))
    print(f'Generated {len(CATALOG)} figures × PNG/SVG/PDF with captions, alt text and provenance.')

if __name__=='__main__':main()
