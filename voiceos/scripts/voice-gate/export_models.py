# Builds the voice gate's two models and the reference numbers the live test checks Bun against.
#
#   uv run --python 3.12 --with speechbrain==1.1.1 --with torch==2.14.0 --with torchaudio==2.11.0 \
#     --with silero-vad==6.2.3 --with onnx==1.23.0 --with onnxscript==0.7.2 \
#     --with onnxruntime==1.30.0 python scripts/voice-gate/export_models.py <out dir>
#
# Writes <out>/ecapa.onnx (+ ecapa.onnx.data, its weights), <out>/silero_vad.onnx and the licenses
# they ship under, then src/voice-gate/testdata/references.json. build-packs.ts packs <out>.
#
# ECAPA is exported with its Fbank front end and mean normalization inside the graph, through the
# dynamo exporter (the legacy one fails on the STFT), and L2-normalized, so Bun hands it raw 16 kHz
# samples and gets the embedding the prototype scored with.

import importlib.metadata
import json
import os
import shutil
import sys
import wave

import numpy as np
import onnxruntime as ort
import torch
from silero_vad import load_silero_vad
from speechbrain.inference.speaker import EncoderClassifier

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
FIXTURES = os.path.join(ROOT, "evals", "audio", "fixtures")
REFERENCES = os.path.join(ROOT, "src", "voice-gate", "testdata", "references.json")
# A few seconds of one voice, already in the repo for the audio evals.
REFERENCE_CLIP = "dictation.clean.wav"
FRAME, CONTEXT = 512, 64


class Embed(torch.nn.Module):
    def __init__(self, encoder):
        super().__init__()
        self.features = encoder.mods.compute_features
        self.norm = encoder.mods.mean_var_norm
        self.model = encoder.mods.embedding_model

    def forward(self, wav):
        lengths = torch.ones(wav.shape[0])
        embedding = self.model(self.norm(self.features(wav), lengths), lengths).squeeze(1)
        return embedding / embedding.norm(dim=-1, keepdim=True)


def load(path):
    with wave.open(path) as clip:
        assert clip.getframerate() == 16000 and clip.getnchannels() == 1, path
        return np.frombuffer(clip.readframes(clip.getnframes()), dtype="<i2").astype(np.float32) / 32768


def export_ecapa(out):
    encoder = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb", savedir=os.path.join(out, ".speechbrain")
    )
    model = Embed(encoder).eval()
    clip = torch.from_numpy(load(os.path.join(FIXTURES, REFERENCE_CLIP)))[None]
    path = os.path.join(out, "ecapa.onnx")
    torch.onnx.export(
        model, (clip,), path, input_names=["wav"], output_names=["embedding"],
        dynamic_axes={"wav": {1: "samples"}}, opset_version=18, dynamo=True,
    )
    with torch.no_grad():
        reference = model(clip)[0].numpy()
    exported = ort.InferenceSession(path).run(None, {"wav": clip.numpy()})[0][0]
    parity = float(exported @ reference)
    print(f"ecapa: onnx vs torch cosine {parity:.5f}")
    assert parity > 0.999, "the export does not match PyTorch"
    shutil.rmtree(os.path.join(out, ".speechbrain"), ignore_errors=True)
    return [round(float(value), 6) for value in reference]


def export_silero(out):
    import silero_vad

    source = os.path.join(os.path.dirname(silero_vad.__file__), "data", "silero_vad.onnx")
    shutil.copyfile(source, os.path.join(out, "silero_vad.onnx"))
    # The package's own ONNX wrapper, which prepends the 64-sample context: what Bun must match.
    vad = load_silero_vad(onnx=True)
    audio = load(os.path.join(FIXTURES, REFERENCE_CLIP))
    probs = [
        round(vad(torch.from_numpy(audio[at : at + FRAME]), 16000).item(), 5)
        for at in range(0, len(audio) - FRAME + 1, FRAME)
    ]
    print(f"silero: {sum(p >= 0.5 for p in probs)}/{len(probs)} frames speech")
    return probs


# SpeechBrain's ECAPA weights are Apache-2.0, Silero VAD and onnxruntime MIT: their texts ride along.
def copy_licenses(out):
    def licence_of(distribution):
        files = importlib.metadata.distribution(distribution).files or []
        found = next(file for file in files if file.name == "LICENSE")
        return found.locate()

    shutil.copyfile(licence_of("speechbrain"), os.path.join(out, "LICENSE-speechbrain-ecapa.txt"))
    shutil.copyfile(licence_of("silero-vad"), os.path.join(out, "LICENSE-silero-vad.txt"))
    runtime = os.path.dirname(ort.__file__)
    shutil.copyfile(os.path.join(runtime, "LICENSE"), os.path.join(out, "LICENSE-onnxruntime.txt"))
    shutil.copyfile(
        os.path.join(runtime, "ThirdPartyNotices.txt"),
        os.path.join(out, "ThirdPartyNotices-onnxruntime.txt"),
    )


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    copy_licenses(out)
    references = {
        "clip": REFERENCE_CLIP,
        "versions": {
            name: importlib.metadata.version(name)
            for name in ["speechbrain", "torch", "silero-vad", "onnxruntime"]
        },
        "ecapa": export_ecapa(out),
        "silero": export_silero(out),
    }
    with open(REFERENCES, "w") as file:
        json.dump(references, file, indent="\t")
        file.write("\n")
    print(f"wrote {REFERENCES}")


if __name__ == "__main__":
    main()
