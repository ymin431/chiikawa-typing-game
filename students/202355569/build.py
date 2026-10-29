"""Pack src/ into ConfigMap YAML files under k8s/ and point the Deployment at them.

Usage: python3 build.py

`oc apply` stores the whole object in the last-applied-configuration annotation,
which is limited to 262144 bytes. Code, three.js and media therefore go into
separate ConfigMaps (media is split into as many as needed), and the Deployment
mounts them all into /app with one projected volume.

Every file in src/assets/ except three.js is treated as media, so replacing or
adding character images (fall-<name>-<n>.png, profile-<name>.png) only needs a rebuild.
"""
import base64
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / 'src'
ASSETS = SRC / 'assets'
K8S = HERE / 'k8s'
LIMIT = 250_000
TEXTS = ['server.py', 'index.html', 'style.css', 'app.js', 'favicon.svg']
THREE = 'three.module.min.js.gz'


def block(text):
    return '|\n' + ''.join('    ' + line if line.strip() else '\n' for line in text.splitlines(keepends=True))


def write(filename, name, texts=(), binaries=()):
    out = ['apiVersion: "v1"', 'kind: "ConfigMap"', 'metadata:', f'  name: "{name}"']
    data, binary_data, size = [], [], 0
    for path in texts:
        text = path.read_text(encoding='utf-8')
        if not text.endswith('\n'):
            text += '\n'
        data.append(f'  {path.name}: {block(text).rstrip(chr(10))}')
        size += len(json.dumps(text))
    for path in binaries:
        encoded = base64.b64encode(path.read_bytes()).decode()
        binary_data.append(f'  {path.name}: "{encoded}"')
        size += len(encoded)
    if data:
        out += ['data:', *data]
    if binary_data:
        out += ['binaryData:', *binary_data]
    if size > LIMIT:
        raise SystemExit(f'{filename}: {size:,} bytes is over the {LIMIT:,} byte apply limit')
    (K8S / filename).write_text('\n'.join(out) + '\n', encoding='utf-8')
    print(f'{filename}: {name} ({size:,} bytes)')


def media_chunks():
    files = sorted(p for p in ASSETS.iterdir() if p.is_file() and p.name != THREE and not p.name.startswith('.'))
    chunks, current, size = [], [], 0
    for path in files:
        cost = len(base64.b64encode(path.read_bytes())) + len(path.name) + 8
        if cost > LIMIT:
            raise SystemExit(f'{path.name} is too large ({cost:,} bytes encoded); compress it below ~180KB')
        if current and size + cost > LIMIT:
            chunks.append(current)
            current, size = [], 0
        current.append(path)
        size += cost
    if current:
        chunks.append(current)
    return chunks


def update_deployment(names):
    path = K8S / 'deployment.yaml'
    text = path.read_text(encoding='utf-8')
    sources = ''.join(f'              -\n                configMap:\n                  name: "{n}"\n' for n in names)
    new, count = re.subn(r'(          projected:\n            sources:\n)(?:              -\n                configMap:\n                  name: "[^"]+"\n)+',
                         lambda m: m.group(1) + sources, text)
    if count != 1:
        raise SystemExit('deployment.yaml: projected volume sources not found')
    path.write_text(new, encoding='utf-8')


if __name__ == '__main__':
    for old in K8S.glob('configmap-media*.yaml'):
        old.unlink()
    write('configmap.yaml', 'typing-garden-app', texts=[SRC / t for t in TEXTS])
    write('configmap-three.yaml', 'typing-garden-three', binaries=[ASSETS / THREE])
    names = ['typing-garden-app', 'typing-garden-three']
    for i, chunk in enumerate(media_chunks(), 1):
        name = 'typing-garden-media' if i == 1 else f'typing-garden-media-{i}'
        write(f'configmap-media{"" if i == 1 else f"-{i}"}.yaml', name, binaries=chunk)
        names.append(name)
    update_deployment(names)
    print('deployment.yaml: mounts ' + ', '.join(names))
