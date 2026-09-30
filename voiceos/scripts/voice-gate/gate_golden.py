# Regenerates src/voice-gate/testdata/gate-golden.json from the research prototype, the source of
# truth for the gate port: python gate_golden.py <research/voice-gate dir> > .../gate-golden.json
import json, sys
sys.path.insert(0, sys.argv[1])
import numpy as np
from gate import FRAME, Gate

# (frame value, speech prob, count): the value stands in for who speaks, the scorer maps it to a score.
SCRIPT = [
    [0.01, 0.0, 20], [0.5, 0.9, 40], [0.3, 0.9, 80], [0.01, 0.2, 30],
    [0.4, 0.9, 5], [0.01, 0.1, 30], [0.3, 0.9, 30], [0.5, 0.9, 70], [0.01, 0.4, 5], [0.01, 0.0, 40],
    [0.5, 0.9, 15], [0.01, 0.0, 20],
]
SCORES = {"0.5": 0.8, "0.3": 0.1, "0.4": 0.9, "0.01": 0.0}
gate = Gate(lambda audio: SCORES[str(round(float(audio[-1]), 2))])
out = []
for value, prob, count in SCRIPT:
    for _ in range(count):
        out += [round(float(f[0]), 2) for f in gate.push(np.full(FRAME, value, dtype=np.float32), prob)]
print(json.dumps({
    "script": SCRIPT, "scores": SCORES,
    "verdicts": [{"accepted": v.accepted, "score": v.score, "isFirst": v.first} for v in gate.verdicts],
    "out": out,
}))
