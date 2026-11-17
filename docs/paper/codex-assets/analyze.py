"""Independently recompute saved-prediction metrics; parse, never invent, other evidence."""
import csv
from pathlib import Path
import re
import numpy as np
from common import HERE, digest, read_json, write_json

CLASSES = ['no_gesture', 'pinch_in', 'pinch_out', 'pinch_hold']
THRESHOLDS = [.25,.35,.45,.5,.6,.7,.8,.9,.95,.98,.99,.995,.999]

def classification(y, p):
    y = np.asarray(y)
    p = np.asarray(p)
    assert y.ndim == 1 and p.shape == (len(y), 4) and len(y)
    assert np.issubdtype(y.dtype, np.integer) and np.all((y >= 0) & (y < 4))
    assert np.isfinite(p).all() and np.all(p >= 0) and np.all(p <= 1)
    assert np.allclose(p.sum(1), 1, atol=2e-6)
    pred = p.argmax(1)
    cm = np.bincount(4*y+pred, minlength=16).reshape(4, 4)
    return metrics_from_cm(cm)

def metrics_from_cm(cm):
    cm = np.asarray(cm, dtype=np.int64)
    assert cm.shape == (4, 4) and (cm >= 0).all() and cm.sum() > 0
    support = cm.sum(1)
    precision = np.divide(cm.diagonal(), cm.sum(0), out=np.zeros(4), where=cm.sum(0)>0)
    recall = np.divide(cm.diagonal(), support, out=np.zeros(4), where=support>0)
    f1 = np.divide(2*precision*recall, precision+recall, out=np.zeros(4), where=precision+recall>0)
    return {'confusion_matrix': cm.tolist(), 'decisions': int(cm.sum()), 'accuracy': float(cm.trace()/cm.sum()), 'balanced_accuracy': float(recall[support>0].mean()), 'macro_f1': float(f1.mean()), 'precision': precision.tolist(), 'recall': recall.tolist(), 'f1': f1.tolist(), 'support': support.tolist()}

def load_predictions(seed, ids):
    yy, pp = [], []
    for rid in ids:
        with np.load(HERE/f'data/multiclass/predictions/{seed}-{rid}.npz', allow_pickle=False) as z:
            assert z['t'].shape == z['y'].shape and np.all(np.diff(z['t']) >= 0)
            yy.append(z['y']); pp.append(z['p'])
    return np.concatenate(yy), np.concatenate(pp)

def main():
    for f in read_json(HERE/'sources.json')['files']:
        assert digest(HERE/f['path']) == f['sha256'], f['path']
    original = read_json(HERE/'data/multiclass/results.json')
    snapshot_path = HERE/'data/multiclass/snapshot.json'
    snap = read_json(snapshot_path)
    assert digest(snapshot_path) == original['snapshot_sha256']
    assert original['classes'] == CLASSES
    split = snap['split']
    all_ids = sum((split[k] for k in ('train','validation','test')), [])
    assert len(all_ids) == len(set(all_ids))
    results = []
    for saved in original['seeds']:
        seed = saved['seed']
        assert digest(HERE/f'data/multiclass/model-seed-{seed}.pt') == saved['sha256']
        result = {'seed':seed}
        for role in ('validation','test'):
            y, p = load_predictions(seed, split[role])
            got = classification(y, p)
            assert got['confusion_matrix'] == saved[role]['confusion_matrix']
            for k in ('accuracy','balanced_accuracy','macro_f1'):
                assert abs(got[k]-saved[role][k]) < 1e-12, (seed, role, k)
            result[role] = got
        y, p = load_predictions(seed, split['validation'])
        options = []
        for threshold in THRESHOLDS:
            pred = np.where(p.max(1)>=threshold, p.argmax(1), 0)
            cm = np.bincount(4*y+pred, minlength=16).reshape(4,4)
            options.append((metrics_from_cm(cm)['macro_f1'], threshold))
        score, threshold = max(options)
        assert threshold == saved['threshold'] and abs(score-saved['validation_thresholded_macro_f1']) < 1e-12
        result['threshold'] = threshold
        # Source-event counts are retained, checked arithmetically, and optionally replayed in replay.py.
        result['stored_test_events'] = saved['test_event_replay']
        for event in result['stored_test_events'].values():
            assert abs(event['caught']/event['gestures']-event['gestureRecall']) < 1e-12
            assert abs(event['falseActivations']*3600/event['negativeSeconds']-event['falseActivationsPerHour']) < 1e-10
        result['test_groups'] = {}
        for group, ids in split['test_groups'].items():
            y, p = load_predictions(seed, ids)
            result['test_groups'][group] = classification(y,p)
            assert result['test_groups'][group]['confusion_matrix'] == saved['test_by_group'][group]['confusion_matrix']
        results.append(result)
    # CNNv2 operating points: reproduce the training-OOF budget selection, never optimize on test groups.
    v2 = []
    for path in sorted((HERE/'data/v2').glob('*.json')):
        d = read_json(path); chosen = d['chosen']; assert chosen is not None
        if 'outOfFold' in d:
            eligible = [(float(t), r) for t,r in d['outOfFold'].items() if r['fa']/r['neg_h']<=d['budget']]
            # Existing budget rule: highest recall, fewer FA, higher cutoff.
            th, row = max(eligible, key=lambda tr:(tr[1]['caught']/tr[1]['gestures'], -tr[1]['fa']/tr[1]['neg_h'], tr[0]))
            assert abs(th-chosen) < 1e-12, (d['name'],th,chosen)
        chosen_results = {}
        for group, sweep in d['results'].items():
            row = sweep.get(str(chosen))
            if row is None:
                row = next(r for t,r in sweep.items() if abs(float(t)-chosen)<1e-12)
            assert 0 <= row['caught'] <= row['gestures'] and row['neg_h']>=0
            chosen_results[group] = row
        v2.append({'name':d['name'],'threshold':chosen,'groups':chosen_results,'sweep':d['results'],'threshold_source':'training OOF budget' if 'outOfFold' in d else 'stored model threshold; selection not reconstructed'})
    # Documented-only evidence is deliberately not promoted to raw replay verification.
    motion = (HERE/'data/documented/motion-hangover.md').read_text()
    line = next(l for l in motion.splitlines() if l.startswith('| 6 s, 0.5 /'))
    parts = [x.strip() for x in line.strip('|').split('|')]
    gaps = [float(v) for v in re.findall(r'\d+(?:\.\d+)?', parts[0].split(',',1)[1])]
    before = [int(x.strip()) for x in parts[1].split('/')]
    after = [int(x.strip()) for x in parts[2].split('/')]
    assert len(gaps)==len(before)==len(after)==5 and 'the 50 pinch-in starts' in motion
    paired = []
    for line in (HERE/'data/documented/paired-models.md').read_text().splitlines():
        if not line.startswith('| pinch_'): continue
        p = [x.strip() for x in line.strip('|').split('|')]
        caught, total = map(int,p[3].split('/'))
        paired.append({'label':p[0],'threshold':float(p[2]),'caught':caught,'gestures':total,'far_per_hour_rounded':float(p[4]),'median_latency_ms':float(p[5].replace(' ms','')),'status':'documented summary only; no recovered corresponding raw run'})
    assert len(paired)==2
    historical = read_json(HERE/'data/historical/evidence-audit.json')
    assert len(historical['records'])==37 and historical['unique_sensor_pairs']==28
    current = read_json(HERE/'data/current-inventory.json')
    groups = {}
    for rec in current:
        key = (rec['ppg']['sensor_columns_sha256'],rec['imu']['sensor_columns_sha256'])
        groups.setdefault(key,[]).append(rec['id'])
    transfer = []
    for line in (HERE/'data/historical/day-transfer.md').read_text().splitlines():
        p = [x.strip() for x in line.split('|')]
        if len(p)>6 and p[2]=='all moments, no still-hand gate':
            counts = p[4].split('(')[0].strip().split('/')
            transfer.append({'day':p[1],'caught':int(counts[0]),'gestures':int(counts[1])})
    assert len(transfer)==4 and sum(x['caught'] for x in transfer)==161 and sum(x['gestures'] for x in transfer)==372
    write_json(HERE/'derived/metrics.json', {'classes':CLASSES,'multiclass':results,'v2':v2,'motion_documented':{'gaps_s':gaps,'before':before,'after':after,'n':50,'status':'transcribed original synthetic-splice summary; original per-event traces unavailable'},'paired_documented':paired,'historical_transfer':transfer,'audit':{'historical_exports':37,'historical_unique':28,'current_exports':len(current),'current_unique':len(groups),'current_duplicate_groups':[v for v in groups.values() if len(v)>1]},'split_counts':{k:len(split[k]) for k in ('train','validation','test')}})
    out = HERE/'derived'; out.mkdir(exist_ok=True)
    with (out/'multiclass-metrics.csv').open('w',newline='') as f:
        w=csv.writer(f, lineterminator='\n');w.writerow(['seed','role','decisions','accuracy_percent','balanced_accuracy_percent','macro_f1_percent'])
        for r in results:
            for role in ('validation','test'):
                d=r[role];w.writerow([r['seed'],role,d['decisions'],100*d['accuracy'],100*d['balanced_accuracy'],100*d['macro_f1']])
    for r in results:
        with (out/f'confusion-seed-{r["seed"]}.csv').open('w',newline='') as f:
            w=csv.writer(f, lineterminator='\n');w.writerow(['actual/predicted']+CLASSES)
            for label,row in zip(CLASSES,r['test']['confusion_matrix']): w.writerow([label]+row)
    print('Verified 3 seeds × validation/test confusion matrices, metrics, validation thresholds, context groups and model hashes; parsed historical/documented evidence separately.')

if __name__ == '__main__':
    main()
