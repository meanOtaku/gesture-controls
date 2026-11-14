import json,sys,os
sys.path.insert(0,os.path.dirname(__file__))
import numpy as np
from features import load, starts, ROOT
man=json.load(open(f"{ROOT}/trained-models/pinch_in-hand-labeled/manifest.json"))["provenance"]
gaps=[];dens=[]
for rid in man["trainRecordings"]:
    I,P=load(f"{ROOT}/data/recordings/Hand labeled/{rid}")
    s=np.array(starts(P))
    if len(s)>1: gaps+=list(np.diff(s)/1000)
    for x in s: dens.append(int(((s>x-11000)&(s<x)).sum()))
print("training: pinch-to-pinch median %.2f s (IQR %.2f-%.2f), pinches in the 11 s before each: median %d, max %d"%(np.median(gaps),*np.percentile(gaps,[25,75]),np.median(dens),max(dens)))
R=json.load(open(f"{os.path.dirname(__file__)}/misses.json"))["rows"]
pin=sorted([r for r in R if r["label"]=="pinch_in"],key=lambda r:r["t"]); ts=np.array([r["t"] for r in pin])
print("live: pinch-to-pinch median %.2f s"%np.median([d for d in np.diff(ts) if d<20]))
print("live: catch rate by pinches in the previous 11 s")
for lo,hi in [(0,2),(2,3),(3,4),(4,9)]:
    b=[r for r in pin if lo<=((ts>r["t"]-11)&(ts<r["t"])).sum()<hi]
    print(f"  {lo}-{hi-1} earlier pinches: {sum(r['detected'] for r in b)}/{len(b)} caught")
