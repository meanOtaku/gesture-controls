"""Replay archived multiclass predictions using their ORIGINAL trainer and raw labels.
CPU-only; no fitting and no checkpoint loading. Requires the matching repository recordings.
"""
import argparse
import dataclasses
from pathlib import Path
import sys
import numpy as np
from common import HERE, ROOT, digest, read_json, write_json


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--repo-root',type=Path,default=ROOT);args=ap.parse_args()
    frozen=HERE/'data/multiclass/frozen-trainer/src'
    snapshot=read_json(HERE/'data/multiclass/snapshot.json')
    for rel,expected in snapshot['files'].items():
        if rel.startswith('src/'):
            assert digest(HERE/'data/multiclass/frozen-trainer'/rel)==expected,rel
    sys.path.insert(0,str(frozen))
    from label_trainer import csv_io,label_train,events
    original=read_json(HERE/'data/multiclass/results.json');split=snapshot['split'];records={}
    classes=original['classes'];negative={'','everyday_noise','still','supported'}
    for rid in split['test']:
        folder=args.repo_root/'data/recordings/Hand labeled'/rid
        for name in ('ppg.csv','imu.csv'):
            assert digest(folder/name)==snapshot['files'][f'data/{rid}/{name}'],f'raw data changed: {rid}/{name}'
        r=csv_io.repair_millisecond_ppg_timestamps(csv_io.load_recording(folder))
        records[rid]=dataclasses.replace(r,session_id=rid)
    verified=[]
    for seed in original['seeds']:
        report={'seed':seed['seed'],'classes':{}}
        for k in (1,2,3):
            rows=[]
            for rid in split['test']:
                rec=records[rid]
                folder=args.repo_root/'data/recordings/Hand labeled'/rid
                with np.load(HERE/f'data/multiclass/predictions/{seed["seed"]}-{rid}.npz',allow_pickle=False) as z:
                    p=z['p'];times=z['t'];target_time=times-500_000_000
                    ix=np.searchsorted(rec.timestamps_ns,target_time,side='right')-1
                    raw=rec.raw_labels[np.maximum(ix,0)];truth=np.full(len(ix),-1,dtype=np.int64)
                    for j,name in enumerate(classes):truth[np.isin(raw,list(negative)) if j==0 else raw==name]=j
                    truth[ix<0]=-1
                    assert np.array_equal(truth,z['y']),f'annotation target mismatch: {rid}'
                    score=np.where(p.argmax(1)==k,p[:,k],0.)
                    spec=label_train.parse_spec({'version':1,'backend':label_train.CNN_V2_BACKEND,'target':classes[k],'negatives':list(negative|set(classes[1:])-{classes[k]}),'excludes':['left_out'],'recordings':{rid:str(folder)},'train':[],'evaluation':[rid],'sources':list(label_train.MOTION_SOURCES),'motionHz':100})
                    rows.append(label_train.detections(spec,rec,times,score,label_train.policy_for(seed['threshold'],spec.trigger)))
            actual=events.summarise(rows);expected=seed['test_event_replay'][classes[k]]
            for key in ('gestures','caught','falseActivations','late','repeats'):
                assert actual[key]==expected[key],(seed['seed'],classes[k],key,actual[key],expected[key])
            for key in ('negativeSeconds','falseActivationsPerHour','medianLatencyMs','gestureRecall'):
                assert np.isclose(actual[key],expected[key],rtol=1e-12,atol=1e-8),(seed['seed'],classes[k],key)
            report['classes'][classes[k]]=actual
        verified.append(report)
        print('Frozen-source event replay verified seed',seed['seed'])
    write_json(HERE/'derived/event-replay-verification.json',{'status':'passed','method':'original frozen trainer, original saved probabilities, raw labels and exact raw-file hashes; no training','runs':verified})

if __name__=='__main__':main()
