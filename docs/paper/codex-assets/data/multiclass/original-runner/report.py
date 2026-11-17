"""Independently verify prediction metrics, then plot and report the completed three-seed study."""
from pathlib import Path
import json,hashlib,csv
import numpy as np
from sklearn.metrics import confusion_matrix,classification_report,accuracy_score,balanced_accuracy_score,f1_score
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
H=Path(__file__).parent
r=json.loads((H/'results.json').read_text());snap=json.loads((H/'snapshot.json').read_text())
assert [x['seed'] for x in r['seeds']]==[17,18,19]
assert hashlib.sha256((H/'snapshot.json').read_bytes()).hexdigest()==r['snapshot_sha256']
classes=r['classes'];split=snap['split']
verified=[]
for s in r['seeds']:
 assert hashlib.sha256((H/f"model-seed-{s['seed']}.pt").read_bytes()).hexdigest()==s['sha256']
 for role in ['validation','test']:
  yy=[];pp=[]
  for rid in split[role]:
   z=np.load(H/'predictions'/f"{s['seed']}-{rid}.npz")
   assert z['p'].shape==(len(z['y']),4)
   assert np.all(np.isfinite(z['p'])) and np.allclose(z['p'].sum(1),1.,atol=2e-6)
   assert np.all(np.diff(z['t'])>=0)
   yy.append(z['y']);pp.append(z['p'])
  y=np.concatenate(yy);p=np.concatenate(pp);pred=p.argmax(1)
  cm=confusion_matrix(y,pred,labels=range(4));assert cm.tolist()==s[role]['confusion_matrix']
  assert abs(f1_score(y,pred,labels=range(4),average='macro')-s[role]['macro_f1'])<1e-12
  assert abs(accuracy_score(y,pred)-s[role]['accuracy'])<1e-12
  assert abs(balanced_accuracy_score(y,pred)-s[role]['balanced_accuracy'])<1e-12
  if role=='test':
   verified.append({'seed':s['seed'],'decisions':len(y),'macro_f1':s['test']['macro_f1']})
   with (H/f"confusion-matrix-seed-{s['seed']}.csv").open('w') as f:
    w=csv.writer(f);w.writerow(['actual/predicted']+classes)
    for name,row in zip(classes,cm):w.writerow([name]+row.tolist())
# Seed 17 is the predeclared primary run, not selected using held-out performance.
s=r['seeds'][0];cm=np.array(s['test']['confusion_matrix']);pct=100*cm/cm.sum(1,keepdims=True)
labels=['No gesture','Pinch-in','Pinch-out','Pinch-hold']
plt.rcParams.update({'font.size':12,'axes.titleweight':'bold'})
fig,ax=plt.subplots(figsize=(9,7.4),layout='constrained')
im=ax.imshow(pct,cmap='Blues',vmin=0,vmax=100)
for i in range(4):
 for j in range(4):ax.text(j,i,f'{pct[i,j]:.1f}%\n({cm[i,j]:,})',ha='center',va='center',color='white' if pct[i,j]>55 else '#14243c',fontsize=12)
ax.set_xticks(range(4),labels);ax.set_yticks(range(4),[f'{n}\nn = {v:,}' for n,v in zip(labels,cm.sum(1))])
ax.set_xlabel('Predicted class',labelpad=10);ax.set_ylabel('Annotated class',labelpad=10)
ax.set_title('One CNNv2 · four classes\nRecording-held-out confusion matrix (seed 17)',pad=16)
fig.colorbar(im,ax=ax,label='Percentage within actual class',shrink=.78)
fig.supxlabel('Percentages are row-normalized; parentheses show decision counts.\n1 s past-only sensor window · 500 ms label delay · no stillness/jerk gate',fontsize=10)
fig.savefig(H/'confusion-matrix.png',dpi=200);fig.savefig(H/'confusion-matrix.svg');plt.close(fig)
# Robustness diagram across seeds, each evaluated as a standalone model (no ensemble).
fig,axs=plt.subplots(1,3,figsize=(15,5),layout='constrained')
for ax,s in zip(axs,r['seeds']):
 c=np.array(s['test']['confusion_matrix']);q=c/c.sum(1,keepdims=True)*100
 ax.imshow(q,cmap='Blues',vmin=0,vmax=100)
 for i in range(4):
  for j in range(4):ax.text(j,i,f'{q[i,j]:.1f}',ha='center',va='center',color='white' if q[i,j]>55 else '#14243c',fontsize=10)
 ax.set_xticks(range(4),['None','In','Out','Hold']);ax.set_yticks(range(4),labels)
 ax.set_xlabel('Predicted');ax.set_ylabel('Actual');ax.set_title(f"Seed {s['seed']} · macro-F1 {s['test']['macro_f1']:.3f}")
fig.suptitle('Three independent single CNNv2 models · row-normalized %',fontsize=16)
fig.savefig(H/'confusion-matrices-three-seeds.png',dpi=180);plt.close(fig)
s=r['seeds'][0];cr=s['test']['classification_report'];mfs=[q['test']['macro_f1'] for q in r['seeds']];acc=[q['test']['accuracy'] for q in r['seeds']]
lines=['# Single multi-gesture CNNv2 experiment','',
'## Scope and protocol','',
'- One CNNv2 backbone with a four-logit softmax head: no gesture, pinch-in, pinch-out, pinch-hold. Three independent training seeds (17, 18, 19); **no ensemble**.',
'- Reused the current 100 Hz, 10-channel CNNv2 causal feature builder: accelerometer, gyroscope, green/red/IR PPG, accelerometer jerk envelope. One-second input, approximately eleven seconds of required history for scaling.',
'- **State-classification adaptation:** targets are the effective annotated state at decision time minus 500 ms. Pinch-hold uses its entire annotated interval. This is NOT identical to the production binary onset target (positive only 400–600 ms after each onset), and is not a drop-in deployment bundle.',
'- Existing CNNv2 benchmark recording pool: 18 training, 4 validation, 16 test recordings. Four validation recordings were removed from the original 22 training recordings. No test labels selected weights, epochs or thresholds. Test data has been used in earlier project research: this is an exploratory held-out comparison, NOT a newly collected untouched release test.',
'- The four explicit state labels are used without boundary trimming. The loader uses manual_label when populated, otherwise the recorded label. Background includes unlabeled inter-gesture time, still, supported and everyday-noise labels. Fist and other unassigned gestures are not included.',
'- Raw PPG and IMU sample fingerprints verified disjoint across training/validation/test, not merely different filenames. Existing overlapping alternate exports are excluded by the original benchmark cohort. Input gaps over 250 ms and missing initial normalization history cannot be scored.',
'- 20 epochs; Adam 0.001, weight decay 0.0001, cosine schedule, batch 128, existing v2 magnitude/time warping, noise, temporal shift and PPG blanking. Background training capped at 40,000 examples; inverse-frequency class weighting capped at 3. Seeds are fixed, but CUDA cumsum in the existing time-warp augmentation lacks a deterministic kernel: bitwise repeatability is not claimed.',
'- No stillness or jerk gate: this measures the network, including genuine everyday negatives, not a gate hiding classifier mistakes.',
'- The older repository recording manifest does not register the hand-labelled cohort. A separate SHA-256 snapshot was made for this exploratory study; source recordings and the repository baseline manifest were not changed.','',
'## Results','',
f"Primary predeclared seed 17: accuracy **{100*s['test']['accuracy']:.2f}%**, balanced accuracy **{100*s['test']['balanced_accuracy']:.2f}%**, macro-F1 **{s['test']['macro_f1']:.4f}** over {cm.sum():,} valid held-out decisions.",'',
'Class precision / recall / F1:','']
for c in classes:
 d=cr[c];lines.append(f"- {c}: {100*d['precision']:.2f}% / {100*d['recall']:.2f}% / {d['f1-score']:.4f} (n={int(d['support']):,}).")
lines+=['',f"Across three independent seeds, macro-F1 mean {np.mean(mfs):.4f}, range {min(mfs):.4f}–{max(mfs):.4f}; accuracy mean {100*np.mean(acc):.2f}%, range {100*min(acc):.2f}–{100*max(acc):.2f}%. These are seed-variation summaries on the same split, not confidence intervals.",'','Per-seed results:','']
for q in r['seeds']:
 lines.append(f"- Seed {q['seed']}: accuracy {100*q['test']['accuracy']:.2f}%, balanced accuracy {100*q['test']['balanced_accuracy']:.2f}%, macro-F1 {q['test']['macro_f1']:.4f}; validation-selected confidence threshold {q['threshold']}.")
lines+=['','## Continuous event replay','',
'The standard trainer temporal detector and event accounting were reused, with a class score suppressed whenever another class wins. A shared confidence threshold was selected by four-class macro-F1 on validation only, NOT by test results or a false-activation-budget sweep. Pinch-hold event recall here means recognizing entry into hold; it does not validate physical hold-duration accuracy. Predictions represent a 500 ms-delayed annotated state; latency is still measured from the original label onset.','']
for c,d in s['test_event_replay'].items():
 recall=d['gestureRecall'];fa=d['falseActivationsPerHour'];lat=d['medianLatencyMs']
 lines.append(f"- {c}: {d['caught']}/{d['gestures']} caught ({100*recall:.2f}%), miss rate {100*(1-recall):.2f}%; {d['falseActivations']} false activations / {d['negativeSeconds']/3600:.4f} negative hours = {fa:.2f}/h; median matched onset latency {lat} ms; repeats {d['repeats']}; late {d.get('late',0)}.")
lines+=['','## Context sensitivity (seed 17)','']
for group,d in s['test_by_group'].items():
 lines.append(f"- {group}: accuracy {100*d['accuracy']:.2f}%, macro-F1 {d['macro_f1']:.4f}. Macro-F1 includes zero-support gesture classes in pure-negative groups; use accuracy and false activations to interpret those groups.")
lines+=['','## Interpretation limits','',
'- Do not equate high overall accuracy with safe live control: background dominates this corpus. Use per-gesture recall, macro-F1 and continuous false activations.',
'- This experiment establishes how a single state classifier performs on this cohort. It does not establish superiority over separately trained production onset models: no matched binary controls were trained, and the target definitions differ.',
'- Labels are the current annotations; optical/motion morphology is not independent physical onset/offset ground truth. The 500 ms label delay is intentional and is not zero-latency recognition.',
'- One fixed recording-held-out split, three seeds. No cross-day-grouped cross-validation or untouched deployment test. Live-model settings and artifacts were not modified.','',
'## Verification and artifacts','',
'- Independently recomputed confusion matrices, accuracy, balanced accuracy and macro-F1 from saved per-recording prediction vectors for all three seeds and validation/test roles.',
'- Verified class-probability sums, timestamp order, snapshot SHA-256, all checkpoint hashes, checkpoint save/reload parity, and a runnable delayed-label mapping self-test.',
'- `confusion-matrix.png`: seed-17 percentages and counts. `confusion-matrices-three-seeds.png`: seed robustness. CSV matrices, results JSON, audit JSON, snapshot, checkpoints and prediction vectors retain the underlying evidence.',
f"- GPU: {r['device']}; PyTorch {r['torch_version']}; parameters {s['parameters']:,}; measured training time seed 17 {s['training_seconds']:.1f} s; peak PyTorch allocated memory {s['peak_gpu_allocated_mb']:.1f} MiB.",
'']
(H/'REPORT.md').write_text('\n'.join(lines))
(H/'verification.json').write_text(json.dumps({'status':'passed','runs':verified,'checks':['checkpoint hashes','snapshot hash','probability shapes/sums','timestamp order','recomputed confusion matrices','recomputed macro-F1/accuracy/balanced accuracy']},indent=2)+'\n')
print('\n'.join(lines[lines.index('## Results'):lines.index('## Interpretation limits')]))
print('VERIFIED all three runs; figures and REPORT.md written')
