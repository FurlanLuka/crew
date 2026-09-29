# Builds the speaker models the offline comparison (eval-recordings.ts) weighs against ECAPA. Local
# only: they are never packed or shipped, and the live gate stays on ECAPA until the recordings say
# otherwise.
#
#   uv run --python 3.12 --with torch==2.14.0 --with torchaudio==2.11.0 --with onnx==1.23.0 \
#     --with onnxscript==0.7.2 --with onnxruntime==1.30.0 --with transformers==5.17.0 \
#     python scripts/voice-gate/export_candidates.py [out dir]
#
# Out dir defaults to ~/.crew/voiceos/voice-gate-candidates (beside the pack folder, whose stale
# sweep would delete it). Each model becomes one graph with ecapa.onnx's contract — `wav` [1, samples]
# of raw 16 kHz audio in [-1, 1] → `embedding` [1, D], L2-normalized — plus <name>.reference.json, its
# Python embedding of the reference clip, which the live test checks Bun against. A graph's weights
# may sit beside it as <name>.onnx.data: the two travel together.
#
# - campplus: CAM++ (3D-Speaker, VoxCeleb, Apache-2.0), sherpa-onnx's export of the network. Its front
#   end is the one 3D-Speaker trained with — Kaldi fbank, 80 bins, dither 0, the time mean
#   subtracted — rebuilt in torch so it exports, and merged in front of the network.
# - wavlm-sv: WavLM base plus, speaker verification head (Microsoft, MIT), read raw.

import json
import math
import os
import shutil
import sys
import tempfile
import urllib.request
import wave
import hashlib

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnx import compose, version_converter
from torchaudio.compliance import kaldi

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
FIXTURES = os.path.join(ROOT, "evals", "audio", "fixtures")
REFERENCE_CLIP = json.load(open(os.path.join(ROOT, "src", "voice-gate", "testdata", "references.json")))["clip"]
OPSET = 18
# The gate's first decision (0.8 s), the same off the conv stride, and the longest voiceprint piece: a
# trace that baked in one length fails here.
PARITY_LENGTHS = [12800, 12833, 48000]

CAMPPLUS_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"
    "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"
)
CAMPPLUS_SHA256 = "357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b"
WAVLM = "microsoft/wavlm-base-plus-sv"
WAVLM_REVISION = "feb593a6c23c1cc3d9510425c29b0a14d2b07b1e"


def load(path):
    with wave.open(path) as clip:
        assert clip.getframerate() == 16000 and clip.getnchannels() == 1, path
        return np.frombuffer(clip.readframes(clip.getnframes()), dtype="<i2").astype(np.float32) / 32768


def unit(vector):
    return vector / np.linalg.norm(vector)


def check_parity(name, session, reference, audio):
    for length in PARITY_LENGTHS:
        clip = audio[:length]
        exported = session.run(None, {"wav": clip[None]})[0][0]
        parity = float(unit(exported) @ unit(reference(clip)))
        print(f"{name}: {length} samples, onnx vs reference cosine {parity:.5f}")
        assert parity > 0.999, f"{name} does not match its reference at {length} samples"


# Only a graph that passed its parity check reaches the out dir, with its weights and its reference:
# the comparison loads every .onnx it finds there.
def publish(out, work, name, session, audio):
    embedding = session.run(None, {"wav": audio[None]})[0][0]
    with open(os.path.join(out, f"{name}.reference.json"), "w") as file:
        json.dump({"clip": REFERENCE_CLIP, "embedding": [round(float(v), 6) for v in embedding]}, file)
        file.write("\n")
    for suffix in (".onnx.data", ".onnx"):
        if os.path.exists(os.path.join(work, name + suffix)):
            shutil.move(os.path.join(work, name + suffix), os.path.join(out, name + suffix))


# torchaudio's kaldi.fbank at 3D-Speaker's settings, written with ops the exporter keeps dynamic: frames
# by unfold, the 512-point DFT as a matmul. Defaults it relies on: 25 ms frames every 10 ms, snip
# edges, DC removed, preemphasis 0.97, Povey window, power spectrum, mel 20 Hz–Nyquist, log.
class KaldiFbank(torch.nn.Module):
    def __init__(self):
        super().__init__()
        length, fft = 400, 512
        n = torch.arange(length, dtype=torch.float64)
        self.register_buffer("window", (0.5 - 0.5 * torch.cos(2 * math.pi * n / (length - 1))).pow(0.85).float())
        k = torch.arange(fft // 2 + 1, dtype=torch.float64)[:, None]
        t = torch.arange(fft, dtype=torch.float64)[None]
        self.register_buffer("cos", torch.cos(2 * math.pi * k * t / fft).float()[:, :length].T.contiguous())
        self.register_buffer("sin", torch.sin(2 * math.pi * k * t / fft).float()[:, :length].T.contiguous())
        banks, _ = kaldi.get_mel_banks(80, fft, 16000.0, 20.0, 0.0, 100.0, -500.0, 1.0)
        self.register_buffer("banks", torch.nn.functional.pad(banks, (0, 1)).T.contiguous().float())

    def forward(self, wav):
        frames = wav[0].unfold(0, 400, 160)
        frames = frames - frames.mean(dim=1, keepdim=True)
        previous = torch.cat([frames[:, :1], frames[:, :-1]], dim=1)
        frames = (frames - 0.97 * previous) * self.window
        power = (frames @ self.cos) ** 2 + (frames @ self.sin) ** 2
        mel = torch.log(torch.clamp(power @ self.banks, min=torch.finfo(torch.float32).eps))
        return (mel - mel.mean(dim=0, keepdim=True))[None]


class Normalize(torch.nn.Module):
    def forward(self, embedding):
        return embedding / embedding.norm(dim=-1, keepdim=True)


def download(url, sha256, path):
    urllib.request.urlretrieve(url, path)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    assert digest == sha256, f"{url}: sha256 {digest}, expected {sha256}"


def export_campplus(out, work, audio):
    network_path = os.path.join(work, "campplus-network.onnx")
    download(CAMPPLUS_URL, CAMPPLUS_SHA256, network_path)
    network = onnx.load(network_path)
    metadata = {prop.key: prop.value for prop in network.metadata_props}
    assert metadata.get("feature_normalize_type") == "global-mean", metadata
    assert metadata.get("normalize_samples") == "1", metadata

    sample = torch.from_numpy(audio)[None]
    front_path = os.path.join(work, "fbank.onnx")
    norm_path = os.path.join(work, "normalize.onnx")
    torch.onnx.export(
        KaldiFbank().eval(), (sample,), front_path, input_names=["wav"], output_names=["features"],
        dynamic_axes={"wav": {1: "samples"}}, opset_version=OPSET, dynamo=True,
    )
    torch.onnx.export(
        Normalize(), (torch.randn(1, int(metadata["output_dim"])),), norm_path,
        input_names=["raw"], output_names=["embedding"], opset_version=OPSET, dynamo=False,
    )
    front, norm = onnx.load(front_path), onnx.load(norm_path)
    network = version_converter.convert_version(network, OPSET)
    ir_version = max(model.ir_version for model in (front, network, norm))
    for model in (front, network, norm):
        model.ir_version = ir_version

    # Prefixes keep the network's own `embedding` apart; the merged graph's ends take the contract's names.
    merged = compose.merge_models(
        compose.add_prefix(front, "fbank/"),
        compose.add_prefix(network, "campplus/"),
        io_map=[("fbank/features", "campplus/x")],
    )
    merged = compose.merge_models(
        merged, compose.add_prefix(norm, "norm/"), io_map=[("campplus/embedding", "norm/raw")]
    )
    rename_value(merged, "fbank/wav", "wav")
    rename_value(merged, "norm/embedding", "embedding")
    path = os.path.join(work, "campplus.onnx")
    onnx.save(merged, path)

    reference_network = ort.InferenceSession(network_path)

    def reference(clip):
        features = kaldi.fbank(torch.from_numpy(clip)[None], num_mel_bins=80, sample_frequency=16000, dither=0.0)
        features = features - features.mean(dim=0, keepdim=True)
        return reference_network.run(None, {"x": features.numpy()[None]})[0][0]

    session = ort.InferenceSession(path)
    check_parity("campplus", session, reference, audio)
    publish(out, work, "campplus", session, audio)


class WavlmEmbed(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, wav):
        embedding = self.model(input_values=wav).embeddings
        return embedding / embedding.norm(dim=-1, keepdim=True)


def rename_value(model, current, name):
    for node in model.graph.node:
        for values in (node.input, node.output):
            for index, value in enumerate(values):
                if value == current:
                    values[index] = name
    for values in (model.graph.input, model.graph.output, model.graph.value_info):
        for info in values:
            if info.name == current:
                info.name = name


def export_wavlm(out, work, audio):
    from transformers import AutoFeatureExtractor, WavLMForXVector

    extractor = AutoFeatureExtractor.from_pretrained(WAVLM, revision=WAVLM_REVISION)
    # Raw samples in, as the contract says: a model that wanted them normalized would need it in-graph.
    assert extractor.do_normalize is False, "wavlm-sv expects normalized input now"
    model = WavLMForXVector.from_pretrained(WAVLM, revision=WAVLM_REVISION).eval()
    traced_path = os.path.join(work, "wavlm-traced.onnx")
    torch.onnx.export(
        WavlmEmbed(model).eval(), (torch.from_numpy(audio)[None],), traced_path,
        input_names=["wav"], output_names=["traced_embedding"],
        dynamic_axes={"wav": {1: "samples"}}, opset_version=OPSET, dynamo=True,
    )
    graph = onnx.load(traced_path)
    # The dynamo exporter names an inner value `embedding` too: it is moved aside first.
    rename_value(graph, "embedding", "embedding_inner")
    rename_value(graph, "traced_embedding", "embedding")
    path = os.path.join(work, "wavlm-sv.onnx")
    onnx.save(graph, path, save_as_external_data=True, location="wavlm-sv.onnx.data")

    def reference(clip):
        inputs = extractor(clip, sampling_rate=16000, return_tensors="pt")
        with torch.no_grad():
            return model(**inputs).embeddings[0].numpy()

    session = ort.InferenceSession(path)
    check_parity("wavlm-sv", session, reference, audio)
    publish(out, work, "wavlm-sv", session, audio)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.crew/voiceos/voice-gate-candidates")
    os.makedirs(out, exist_ok=True)
    audio = load(os.path.join(FIXTURES, REFERENCE_CLIP))
    with tempfile.TemporaryDirectory() as work:
        export_campplus(out, work, audio)
        export_wavlm(out, work, audio)
    print(f"wrote {sorted(os.listdir(out))} to {out}")


if __name__ == "__main__":
    main()
