"""只生成自有几何测试样本；已提交的产物无需在普通验证中重新生成。需要 Pillow。"""
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw, __version__

root = Path(__file__).parent / 'fixtures'
root.mkdir(exist_ok=True)
image = Image.new('RGB', (160, 96), '#f6d559')
draw = ImageDraw.Draw(image)
draw.rectangle((4, 4, 155, 91), outline='#162d54', width=4)
draw.rectangle((15, 20, 60, 70), fill='#2878b5')
draw.ellipse((80, 20, 130, 70), fill='#cb394c')
draw.text((67, 75), 'M5 TEST', fill='#162d54')
image.save(root / 'sample.png')
image.save(root / 'sample.jpg', quality=90)
image.save(root / 'sample.webp', lossless=True)
second = image.copy()
ImageDraw.Draw(second).rectangle((15, 20, 60, 70), fill='#42a05b')
image.save(root / 'sample.gif', save_all=True, append_images=[second], duration=300, loop=0)
manifest = {'generator': 'Pillow ' + __version__, 'width': 160, 'height': 96, 'gifFrames': 2, 'files': {}}
for path in sorted(root.glob('sample.*')):
    data = path.read_bytes()
    manifest['files'][path.name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
