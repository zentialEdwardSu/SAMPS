"""Inspect the Hybrid manifest and x64 PE without executing code in Photoshop."""
import hashlib
import json
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]


def main():
    dist = ROOT / 'dist'
    manifest_data = (dist / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_data)
    assert manifest['manifestVersion'] >= 6
    assert manifest['requiredPermissions']['enableAddon'] is True
    assert manifest['host']['app'] == 'PS' and manifest['host']['data']['apiVersion'] == 2
    assert (dist / manifest['main']).is_file()
    name = manifest['addon']['name']
    assert Path(name).name == name and name.endswith('.uxpaddon')
    binary = dist / 'win/x64' / name
    data = binary.read_bytes()
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    assert data[:2] == b'MZ' and data[pe:pe+4] == b'PE\0\0'
    machine, count, _, _, _, optional_size, _ = struct.unpack_from('<HHIIIHH', data, pe+4)
    assert machine == 0x8664
    optional = pe+24
    assert struct.unpack_from('<H', data, optional)[0] == 0x20b
    sections = []
    for i in range(count):
        offset = optional+optional_size+40*i
        size, address, raw_size, raw = struct.unpack_from('<IIII', data, offset+8)
        sections.append((address, max(size, raw_size), raw))

    def file_offset(rva):
        for address, size, raw in sections:
            if address <= rva < address+size:
                return raw+rva-address
        raise ValueError(f'Invalid PE RVA {rva}')

    def string(rva):
        pos = file_offset(rva)
        return data[pos:data.index(b'\0', pos)].decode('ascii')

    export = file_offset(struct.unpack_from('<I', data, optional+112)[0])
    names_count = struct.unpack_from('<I', data, export+24)[0]
    names = file_offset(struct.unpack_from('<I', data, export+32)[0])
    exports = [string(struct.unpack_from('<I', data, names+4*i)[0]) for i in range(names_count)]
    assert {'uxp_addon_init', 'uxp_addon_terminate'} <= set(exports)
    imports = []
    pos = file_offset(struct.unpack_from('<I', data, optional+120)[0])
    while any(data[pos:pos+20]):
        imports.append(string(struct.unpack_from('<I', data, pos+12)[0]))
        pos += 20
    assert not any(term in name.lower() for name in imports for term in ['python', 'torch', 'onnx', 'vcruntime140d', 'msvcp140d', 'ucrtbased'])
    result = {'passed': True, 'binary': str(binary), 'sha256': hashlib.sha256(data).hexdigest(),
              'manifestSha256': hashlib.sha256(manifest_data).hexdigest(), 'version': manifest['version'],
              'architecture': 'Windows x64', 'exports': exports, 'imports': imports,
              'photoshopExecutionTested': False}
    (ROOT / 'artifacts').mkdir(exist_ok=True)
    (ROOT / 'artifacts/hybrid-binary-check.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
