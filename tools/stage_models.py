"""Copy validated ONNX bundles into dist/models/<folder> for UDT loading and packaging.

Model bundles live in the model-pipeline repo (git submodule at model-pipeline/),
not in this repo. Only files listed in each model.json (plus model.json itself) are
copied; torch references and validation scratch files stay in the submodule. Folder
names match plugin-src/src/ui/models.ts.

    git submodule update --init
    python tools/stage_models.py
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
BUNDLE_NAMES = {'sam3': 'models/sam3.1-vision-fp16s', 'yoloe26x': 'models/yoloe26x-onnx'}


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 24), b''):
            h.update(block)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dist', type=Path, default=ROOT / 'dist')
    parser.add_argument('--models-root', type=Path, default=ROOT / 'model-pipeline',
                        help='Root containing models/<bundle>/ (the model-pipeline submodule by default)')
    args = parser.parse_args()
    if not args.models_root.is_dir():
        raise RuntimeError(f'{args.models_root} is missing; run: git submodule update --init')
    bundles = {folder: args.models_root / relative for folder, relative in BUNDLE_NAMES.items()}
    for folder, source in bundles.items():
        manifest = json.loads((source / 'model.json').read_text(encoding='utf-8'))
        if not manifest.get('validation', {}).get('passed'):
            raise RuntimeError(f'{source} has not passed validation')
        target = args.dist / 'models' / folder
        target.mkdir(parents=True, exist_ok=True)
        for stale in target.iterdir():
            if stale.name != 'model.json' and stale.name not in manifest['files']:
                stale.unlink()
        for name, expected in manifest['files'].items():
            if Path(name).name != name:
                raise ValueError(f'Unexpected path in {source}: {name}')
            destination = target / name
            if not destination.exists() or destination.stat().st_size != (source / name).stat().st_size \
                    or digest(destination) != expected:
                shutil.copyfile(source / name, destination)
            if digest(destination) != expected:
                raise RuntimeError(f'Checksum mismatch after copy: {destination}')
        (target / 'model.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        size = sum(p.stat().st_size for p in target.iterdir()) / 2**20
        print(f'{folder}: {manifest["modelName"]} {manifest["precision"]} → {target} ({size:.0f} MiB)')


if __name__ == '__main__':
    main()
