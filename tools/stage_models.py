"""Fetch validated ONNX bundles and copy them into dist/models/<folder>.

Model bundles are published separately (ModelScope / Hugging Face Hub), not
vendored into this repo. Each bundle is fetched into a local cache directory
(default: a sibling `model-cache/` next to this repo) and then copied into
`dist/models/<folder>/` for UDT loading and packaging. Folder names match
plugin-src/src/ui/models.ts.

If a bundle is already present as a local directory (e.g. you built it
yourself with the model-pipeline repo, or downloaded it by hand), pass
--models-root pointing at the directory that contains `models/<bundle-name>/`
and the download step is skipped for bundles found there.

    python tools/stage_models.py
    python tools/stage_models.py --models-root ../samps-model-pipeline/models
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]

# folder: the name the plugin UI uses (plugin-src/src/ui/models.ts) and the
# subdirectory under dist/models/.
# source: where to fetch the bundle from when it is not already available
# locally. Fill in the real repo id once the bundles are published; until
# then, use --models-root to point at a local models/ directory instead
# (e.g. the model-pipeline repo's own models/ directory).
BUNDLES = {
    'sam3': {'local_name': 'sam3.1-vision-fp16s', 'hub': None},
    'yoloe26x': {'local_name': 'yoloe26x-onnx', 'hub': None},
}


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 24), b''):
            h.update(block)
    return h.hexdigest()


def fetch(bundle, cache_dir):
    """Returns the local directory for `bundle`, downloading into `cache_dir` if needed."""
    destination = cache_dir / bundle['local_name']
    if destination.is_dir():
        return destination
    if not bundle['hub']:
        raise RuntimeError(
            f"{bundle['local_name']} is not cached at {destination} and no hub source is configured yet. "
            "Pass --models-root pointing at a directory containing models/<bundle>/, "
            "or wait for the published model repo id to be filled in here.")
    # Placeholder for the eventual ModelScope/Hugging Face download, e.g.:
    #   from huggingface_hub import snapshot_download
    #   snapshot_download(repo_id=bundle['hub'], local_dir=destination)
    raise NotImplementedError('Hub download not wired up yet; see BUNDLES in this file.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dist', type=Path, default=ROOT / 'dist')
    parser.add_argument('--models-root', type=Path, default=None,
                        help='A directory containing models/<bundle>/ to use instead of the download cache '
                             '(e.g. a local checkout of the model-pipeline repo)')
    parser.add_argument('--cache-dir', type=Path, default=ROOT.parent / 'model-cache',
                        help='Where downloaded bundles are cached (default: sibling model-cache/ directory)')
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)

    for folder, bundle in BUNDLES.items():
        if args.models_root:
            source = args.models_root / bundle['local_name']
            if not source.is_dir():
                raise RuntimeError(f'{source} not found under --models-root')
        else:
            source = fetch(bundle, args.cache_dir)
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
