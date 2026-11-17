"""Exploratory four-class CNNv2; no runtime/source/default model modifications.
Labels are annotated states 500ms before a decision, not binary onset targets.
Run: python run.py [--prepare-only | --self-test].
"""
from pathlib import Path
import sys, os, json, time, hashlib, csv
from dataclasses import replace
import numpy as np
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE/'src'))
from label_trainer import csv_io, cnn_input, cnn_v2, cnn, label_train, ppg_onset, events
CLASSES=['no_gesture','pinch_in','pinch_out','pinch_hold']
NEG={'','everyday_noise','still','supported'}
DELAY=500_000_000
SEEDS=[17,18,19]
EPOCHS=20
BATCH=128

def labels_at(rec,t):
    ix=np.searchsorted(rec.timestamps_ns,t-DELAY,side='right')-1
    labels=rec.raw_labels[np.maximum(ix,0)]
    y=np.full(len(t),-1,dtype=np.int64)
    for k,name in enumerate(CLASSES):
        y[np.isin(labels,list(NEG)) if k==0 else labels==name]=k
    y[ix<0]=-1
    return y

def self_test():
    from types import SimpleNamespace
    r=SimpleNamespace(timestamps_ns=np.array([0,1000000000,2000000000]),raw_labels=np.array(['','pinch_in','pinch_hold']))
    assert labels_at(r,np.array([0,500000000,1500000000,2500000000])).tolist()==[-1,0,1,3]
    assert len(set(CLASSES))==4
    print('self-test: delayed annotation mapping and explicit class order passed',flush=True)

def load_data(snapshot):
    records={}; cache=HERE/'cache';cache.mkdir(exist_ok=True)
    audit=[]; seen_streams={'ppg.csv':{},'imu.csv':{}}
    # Prove disjointness of exact raw sensor samples, independently of filenames.
    for role in ['train','validation','test']:
        for rid in snapshot['split'][role]:
            for stream in seen_streams:
                path=HERE/'data'/rid/stream
                with path.open() as f:
                    rows=list(csv.DictReader(l for l in f if not l.startswith('#')))
                for row in rows:
                    key=tuple((k,v) for k,v in row.items() if k not in {'label','manual_label'})
                    previous=seen_streams[stream].get(key)
                    if previous is not None and previous!=role:
                        raise AssertionError(f'cross-role shared sensor sample: {stream} {rid} {previous}/{role}')
                    seen_streams[stream][key]=role
    print('audit: raw PPG and IMU samples disjoint across train/validation/test',flush=True)
    for role in ['train','validation','test']:
        for rid in snapshot['split'][role]:
            rec=csv_io.repair_millisecond_ppg_timestamps(csv_io.load_recording(HERE/'data'/rid))
            records[rid]=replace(rec,session_id=rid)
            ts,_=label_train.pulse_of(rec)
            p=cache/(rid+'.npz')
            if not p.exists():
                mt,m=label_train.motion_of(rec);pt,pulse=label_train.pulse_of(rec)
                parts=[]
                for start in range(0,len(ts),256):
                    parts.append(cnn_input.inputs(mt,m,pt,pulse,ts[start:start+256],hz=100,envelope=True).astype(np.float32))
                x=np.concatenate(parts); y=labels_at(rec,ts)
                ok=np.isfinite(x).all(1)&(y>=0)
                np.savez_compressed(p,x=x[ok],y=y[ok],t=ts[ok])
            z=np.load(p)
            audit.append({'id':rid,'role':role,'rows':len(z['y']),'counts':np.bincount(z['y'],minlength=4).tolist(),
                'ppg_nonmonotonic':int(np.sum(np.diff(ts)<0)),
                'ppg_gaps_over_250ms':int(np.sum(np.diff(ts)>250000000)),
                'raw_label_counts':{str(l):int(n) for l,n in zip(*np.unique(rec.raw_labels,return_counts=True))}})
            assert audit[-1]['ppg_nonmonotonic']==0
            print('input',role,rid,len(z['y']),flush=True)
    (HERE/'audit.json').write_text(json.dumps(audit,indent=2))
    return records

def combined(ids):
    xs=[];ys=[]
    for rid in ids:
        z=np.load(HERE/'cache'/(rid+'.npz'));xs.append(z['x']);ys.append(z['y'])
    return np.concatenate(xs),np.concatenate(ys)

def new_net():
    import torch
    net=cnn_v2._net()
    net.head[-1]=torch.nn.Linear(cnn.HIDDEN,4)
    return net

def predict(net,x):
    import torch
    out=[];net.eval()
    with torch.no_grad():
        for i in range(0,len(x),256):
            a=torch.from_numpy(x[i:i+256].reshape(-1,10,100)).to('cuda')
            out.append(torch.softmax(net(a),dim=1).cpu().numpy())
    return np.concatenate(out)

def fit(seed,x,y):
    import torch
    from torch import nn
    torch.manual_seed(seed);np.random.seed(seed)
    torch.set_num_threads(4)
    torch.cuda.set_per_process_memory_fraction(0.35)
    torch.backends.cudnn.benchmark=False
    # Existing CUDA time-warp augmentation uses cumsum, which lacks a deterministic CUDA kernel.
    torch.use_deterministic_algorithms(True, warn_only=True)
    rng=np.random.default_rng(seed)
    background=np.flatnonzero(y==0)
    if len(background)>cnn.MAX_NEGATIVES:
        keep=np.sort(np.r_[np.flatnonzero(y>0),rng.choice(background,cnn.MAX_NEGATIVES,replace=False)])
        x=x[keep];y=y[keep]
    counts=np.bincount(y,minlength=4)
    # Same capped inverse-frequency weighting policy as binary v2, extended to four classes.
    weights=np.minimum(3.,counts[0]/np.maximum(counts,1)).astype(np.float32)
    net=new_net().cuda()
    opt=torch.optim.Adam(net.parameters(),lr=cnn.LEARNING_RATE,weight_decay=cnn.WEIGHT_DECAY)
    sch=torch.optim.lr_scheduler.CosineAnnealingLR(opt,EPOCHS*((len(y)+BATCH-1)//BATCH))
    lossfn=nn.CrossEntropyLoss(weight=torch.tensor(weights,device='cuda'))
    gen=torch.Generator(device='cuda').manual_seed(seed)
    start=time.monotonic()
    for epoch in range(EPOCHS):
        net.train();losses=[]
        order=rng.permutation(len(y))
        for i in range(0,len(order),BATCH):
            p=order[i:i+BATCH]
            if len(p)<2:continue
            a=torch.from_numpy(x[p].reshape(-1,10,100)).cuda()
            b=torch.from_numpy(y[p]).cuda()
            loss=lossfn(net(cnn_v2._augmented(a,gen)),b)
            opt.zero_grad();loss.backward();opt.step();sch.step();losses.append(loss.item())
        print('epoch',seed,epoch+1,'loss',round(float(np.mean(losses)),5),'sec',round(time.monotonic()-start,1),flush=True)
    path=HERE/f'model-seed-{seed}.pt'
    torch.save({'state_dict':net.cpu().state_dict(),'classes':CLASSES,'seed':seed,'delay_ns':DELAY,'epochs':EPOCHS},path)
    check=new_net();check.load_state_dict(torch.load(path,map_location='cpu',weights_only=True)['state_dict']);check.cuda().eval()
    expected=predict(net.cuda().eval(),x[:16]);actual=predict(check,x[:16]);assert np.allclose(expected,actual,atol=1e-7)
    return check,{'seed':seed,'training_seconds':time.monotonic()-start,'training_counts':counts.tolist(),'weights':weights.tolist(),
        'parameters':sum(p.numel() for p in net.parameters()),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'peak_gpu_allocated_mb':torch.cuda.max_memory_allocated()/1024**2,'reload_max_abs_error':float(np.max(np.abs(expected-actual)))}

def classification(y,p):
    from sklearn.metrics import confusion_matrix,classification_report,accuracy_score,balanced_accuracy_score,f1_score
    pred=p.argmax(1)
    return {'accuracy':accuracy_score(y,pred),'balanced_accuracy':balanced_accuracy_score(y,pred),
        'macro_f1':f1_score(y,pred,labels=range(4),average='macro',zero_division=0),
        'confusion_matrix':confusion_matrix(y,pred,labels=range(4)).tolist(),
        'classification_report':classification_report(y,pred,labels=range(4),target_names=CLASSES,output_dict=True,zero_division=0)}

def replay(records,ids,predictions,threshold):
    """Exclusive winner scores, standard trainer replay/policy per class, delayed state truth.
    Pinch hold is scored as a hold-entry event here; matrix uses every annotated state sample.
    """
    out={}; byclass=[]
    for k in [1,2,3]:
        rows=[]
        for rid in ids:
            z=np.load(HERE/'cache'/(rid+'.npz'));p=predictions[rid]
            score=np.where(p.argmax(1)==k,p[:,k],0.)
            rec=records[rid]
            spec=label_train.parse_spec({'version':1,'backend':label_train.CNN_V2_BACKEND,'target':CLASSES[k],
                'negatives':list(NEG|set(CLASSES[1:])-{CLASSES[k]}),'excludes':['left_out'],
                'recordings':{rid:str(rec.source_path)},'train':[],'evaluation':[rid],
                'sources':list(label_train.MOTION_SOURCES),'motionHz':100})
            r=label_train.detections(spec,rec,z['t'],score,label_train.policy_for(threshold,spec.trigger))
            rows.append(r)
        total=events.summarise(rows);out[CLASSES[k]]=total;byclass.append(total)
    return out

def main():
    import torch
    self_test()
    assert torch.cuda.is_available()
    snapshot=json.loads((HERE/'snapshot.json').read_text())
    for rel,h in snapshot['files'].items():assert hashlib.sha256((HERE/rel).read_bytes()).hexdigest()==h,rel
    records=load_data(snapshot)
    if '--prepare-only' in sys.argv:return
    split=snapshot['split'];x,y=combined(split['train'])
    (HERE/'predictions').mkdir(exist_ok=True)
    results={'classes':CLASSES,'protocol':'CNNv2 backbone, 4-way softmax; classify annotated state at decision time minus 500ms. Every valid PPG decision; no stillness or jerk gate. Same fixed 22/16 benchmark pool, four training recordings reserved for validation. Exploratory reused historical test cohort, not an untouched deployment test.',
        'snapshot_sha256':hashlib.sha256((HERE/'snapshot.json').read_bytes()).hexdigest(),'device':torch.cuda.get_device_name(0),
        'torch_version':torch.__version__,'seeds':[]}
    for seed in SEEDS:
        net,info=fit(seed,x,y);preds={}
        for role in ['validation','test']:
            ps=[];ys=[]
            for rid in split[role]:
                z=np.load(HERE/'cache'/(rid+'.npz'));p=predict(net,z['x']);preds[rid]=p
                np.savez_compressed(HERE/'predictions'/f'{seed}-{rid}.npz',t=z['t'],y=z['y'],p=p)
                ps.append(p);ys.append(z['y'])
            info[role]=classification(np.concatenate(ys),np.concatenate(ps))
        # Threshold selected exclusively on validation; macro-F1 of the four state classes.
        vx,vy=combined(split['validation']);vp=np.concatenate([preds[r] for r in split['validation']])
        from sklearn.metrics import f1_score
        options=[]
        for th in [.25,.35,.45,.5,.6,.7,.8,.9,.95,.98,.99,.995,.999]:
            v=vp.argmax(1);v=np.where(vp.max(1)>=th,v,0)
            options.append((float(f1_score(vy,v,labels=range(4),average='macro',zero_division=0)),th))
        valf1,threshold=max(options,key=lambda a:(a[0],a[1]))
        info['threshold']=threshold;info['validation_thresholded_macro_f1']=valf1
        info['test_event_replay']=replay(records,split['test'],preds,threshold)
        info['test_by_group']={}
        for group,ids in split['test_groups'].items():
            yy=np.concatenate([np.load(HERE/'cache'/(r+'.npz'))['y'] for r in ids]);pp=np.concatenate([preds[r] for r in ids])
            info['test_by_group'][group]=classification(yy,pp)
        results['seeds'].append(info)
        (HERE/'results.json').write_text(json.dumps(results,indent=2))
        print('RESULT',json.dumps(info),flush=True)
        del net;torch.cuda.empty_cache()
    assert len(results['seeds'])==len(SEEDS)
    print('COMPLETE',flush=True)

if __name__=='__main__':
    if '--self-test' in sys.argv:self_test()
    else:main()
