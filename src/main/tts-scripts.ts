// Written into the isolated deployment directory; never loaded by dsh automatically.
export const downloadModelScript = `import hashlib, json, os
from pathlib import Path
from huggingface_hub import snapshot_download

root = Path(__file__).resolve().parent
manifest = json.loads((root / "model-manifest.json").read_text(encoding="utf-8"))
target = root / "model"
snapshot_download(repo_id=manifest["modelId"], revision=manifest["revision"],
    local_dir=str(target), allow_patterns=[f["path"] for f in manifest["files"]],
    max_workers=2, token=False)
for entry in manifest["files"]:
    file = target / entry["path"]
    if file.is_symlink():
        raise RuntimeError("Model symbolic link refused: " + entry["path"])
    if not file.is_file():
        raise RuntimeError("Model file missing or invalid: " + entry["path"])
    with file.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if file.stat().st_size != entry["bytes"] or digest != entry["sha256"]:
        # Remove only this corrupt downloaded file so retry can fetch it again.
        file.unlink()
        metadata = target / ".cache" / "huggingface" / "download" / (entry["path"] + ".metadata")
        metadata.unlink(missing_ok=True)
        raise RuntimeError("Model SHA-256 mismatch: " + entry["path"])
    print("Verified: " + entry["path"], flush=True)
`

export const synthesizeScript = `import argparse, json, os
from pathlib import Path

root = Path(__file__).resolve().parent
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HOME"] = str(root / "cache" / "huggingface")
import torch
import soundfile as sf
from qwen_tts import Qwen3TTSModel

parser = argparse.ArgumentParser(description="Local Qwen3-TTS CustomVoice synthesis")
parser.add_argument("--text", default="你好，本地语音模型已经部署完成。")
parser.add_argument("--text-file", help="UTF-8 text file; preferred for dsh integration")
parser.add_argument("--output", default=str(root / "sample.wav"))
parser.add_argument("--speaker", default="Vivian")
parser.add_argument("--language", default="Chinese")
parser.add_argument("--instruct", default="")
args = parser.parse_args()
config = json.loads((root / "runtime.json").read_text(encoding="utf-8"))
device = config["device"]
if device.startswith("cuda"):
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA runtime unavailable; rescan device or select CPU mode")
    index = int(device.split(":")[1])
    if index >= torch.cuda.device_count():
        raise RuntimeError("Selected NVIDIA GPU is no longer available")
    with torch.cuda.device(index):
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
else:
    dtype = torch.float32
model = Qwen3TTSModel.from_pretrained(str(root / "model"), device_map=device,
    dtype=dtype, attn_implementation="sdpa", local_files_only=True)
text = Path(args.text_file).read_text(encoding="utf-8-sig") if args.text_file else args.text
wavs, sr = model.generate_custom_voice(text=text, language=args.language,
    speaker=args.speaker, instruct=args.instruct, max_new_tokens=256)
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
sf.write(str(output), wavs[0], sr)
audio, sample_rate = sf.read(str(output))
if audio.size == 0 or sample_rate <= 0:
    raise RuntimeError("Generated WAV is empty")
print(json.dumps({"output": str(output), "sampleRate": sample_rate,
    "samples": len(audio), "device": device}, ensure_ascii=False), flush=True)
`
