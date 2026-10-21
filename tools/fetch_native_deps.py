"""Download official, version-pinned native build inputs into .deps only.

Fetches the NuGet packages CMakeLists.txt expects (ONNX Runtime DirectML, DirectML
itself), the nlohmann/json single header and the UXP Hybrid SDK sources from a pinned
bolt-uxp commit on GitHub, verifies their SHA256 against pinned values, and extracts
the archives (.nupkg files are plain zips) into the directory layout CMakeLists.txt
reads from. The Hybrid SDK root is printed for UXP_SDK_ROOT.
"""
from pathlib import Path
import hashlib
import json
import zipfile
import requests

ROOT = Path(__file__).resolve().parents[1]
DEPS = ROOT / '.deps'

# Pinned SHA256 of the .nupkg (zip) downloads themselves, checked before extraction.
# Both packages are Microsoft-signed; see THIRD_PARTY_NOTICES.md for provenance notes.
PACKAGES = [
    {
        'name': 'onnxruntime-dml-1.24.4',
        'url': 'https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.directml/1.24.4/microsoft.ml.onnxruntime.directml.1.24.4.nupkg',
        'sha256': '57e9f11b73437bef7a309496135d4c1f96b1a8e9ddba60013fa27bfc1d788681',
    },
    {
        'name': 'directml-1.15.4',
        'url': 'https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg',
        'sha256': '4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9',
    },
]

# Adobe's UXP Hybrid SDK (src/api + src/utilities, SDK 0.1.0) as redistributed by bolt-uxp.
HYBRID_SDK = {
    'name': 'bolt-uxp-8dca0be1010070883a4cb3b4de6af38509a4c4e4',
    'url': 'https://github.com/hyperbrew/bolt-uxp/archive/8dca0be1010070883a4cb3b4de6af38509a4c4e4.zip',
    'sha256': 'a77f33f5e33482ec6e564a7baf6e74466729e24ac0c43b61d15db4763f2bfe22',
}


def download(url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        with requests.get(url, stream=True, timeout=120) as response:
            response.raise_for_status()
            with path.open('wb') as stream:
                for chunk in response.iter_content(1024 * 1024):
                    stream.write(chunk)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract(archive, destination):
    if destination.is_dir():
        return
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            target = (destination / entry.filename).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise ValueError('Unsafe archive path')
        bundle.extractall(destination)


def main():
    hashes = {}
    for package in PACKAGES:
        archive = DEPS / 'downloads-ort' / (package['name'] + '.nupkg')
        digest = download(package['url'], archive)
        if digest != package['sha256']:
            raise ValueError(f"{package['name']} checksum mismatch: got {digest}")
        hashes[archive.name] = digest
        extract(archive, DEPS / package['name'])

    header = DEPS / 'include/nlohmann/json.hpp'
    hashes['json.hpp'] = download(
        'https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp', header)
    if hashes['json.hpp'] != 'aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63':
        raise ValueError('JSON header checksum mismatch')

    archive = DEPS / 'downloads-ort' / (HYBRID_SDK['name'] + '.zip')
    digest = download(HYBRID_SDK['url'], archive)
    if digest != HYBRID_SDK['sha256']:
        raise ValueError(f"Hybrid SDK checksum mismatch: got {digest}")
    hashes[archive.name] = digest
    if not (DEPS / HYBRID_SDK['name']).is_dir():
        extract(archive, DEPS / 'hybrid-sdk-tmp')  # holds a single bolt-uxp-<commit>/ folder
        (DEPS / 'hybrid-sdk-tmp' / HYBRID_SDK['name']).rename(DEPS / HYBRID_SDK['name'])
        (DEPS / 'hybrid-sdk-tmp').rmdir()

    (DEPS / 'downloads.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
    print('Native dependencies:', DEPS)
    print('UXP_SDK_ROOT:', DEPS / HYBRID_SDK['name'] / 'src/hybrid')


if __name__ == '__main__':
    main()
