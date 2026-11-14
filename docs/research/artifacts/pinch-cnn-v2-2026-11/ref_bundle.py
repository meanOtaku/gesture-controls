"""Score a trained pinch_in bundle (model.cnn) on the benchmark's test set, with the activation from its manifest.
Usage: TRAINER_SRC=<the trainer it was trained with> python ref_bundle.py <bundle dir> <name>"""
import hashlib, json, sys
import bench
from label_trainer import cnn

B, NAME = sys.argv[1], sys.argv[2]
man = json.load(open(f"{B}/manifest.json")); mb = open(f"{B}/model.cnn", "rb").read()
assert hashlib.sha256(mb).hexdigest() == man["model"]["sha256"]
hz = man.get("preprocessing", {}).get("motionHz")
res = bench.score(lambda x: cnn.predict(mb, x), name=f"trainer-{hz}", hz=hz)
bench.save(NAME, res, man["thresholds"]["activation"], {"model": man["modelId"], "motionHz": hz},
           notes=f"`{man['modelId']}`, activation {man['thresholds']['activation']} from its manifest, inputs {hz or 'trainer default'} Hz.")
