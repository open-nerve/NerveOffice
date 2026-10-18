# coding: utf-8
"""Self-owned, deterministic image fixtures; no external/user image input."""
from pathlib import Path
from PIL import Image, ImageCms, ImageDraw, ImageOps, PngImagePlugin, features
import hashlib, io, json, random, struct, sys, zlib

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / 'fixtures'
root.mkdir(parents=True, exist_ok=True)
cases = []

def digest(data):
    return hashlib.sha256(data).hexdigest()

def save_case(name, data, kind, status='accept', reason=None, large=False, exact=False):
    extension = {'jpeg': 'jpg'}.get(kind, kind)
    file = name + '.' + extension
    expected = {'status': status}
    if reason:
        expected['reason'] = reason
    if status == 'accept':
        with Image.open(io.BytesIO(data)) as image:
            frames, delays, hashes, points = image.n_frames if hasattr(image, 'n_frames') else 1, [], [], []
            dimensions = ImageOps.exif_transpose(image).size
            for frame in range(frames):
                image.seek(frame)
                pixels = ImageOps.exif_transpose(image).convert('RGBA')
                # Force full independent decode; metadata alone does not count.
                pixels.load()
                hashes.append(digest(pixels.tobytes()))
                positions = [(0, 0), (pixels.width - 1, 0), (0, pixels.height - 1), (pixels.width // 2, pixels.height // 2)]
                points.append([{'x': x, 'y': y, 'rgba': list(pixels.getpixel((x, y)))} for x, y in positions])
                delays.append(image.info.get('duration', 0))
            expected.update(width=dimensions[0], height=dimensions[1], frames=frames, points=points)
            if frames > 1:
                expected.update(delay=delays, loop=image.info.get('loop', 0))
            if exact:
                expected['rgbaSha256'] = hashes
    (root / file).write_bytes(data)
    cases.append({'id': name, 'file': file, 'sha256': digest(data), 'bytes': len(data),
                  'declaredType': 'image/' + kind, 'extension': extension, 'large': large, 'expected': expected})

def encoded(image, kind, **options):
    out = io.BytesIO()
    image.save(out, format=kind, **options)
    return out.getvalue()

image = Image.new('RGBA', (48, 32), (30, 80, 160, 255))
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 15, 15), fill=(240, 20, 60, 255))
draw.rectangle((30, 0, 47, 15), fill=(30, 160, 70, 90))
meta = PngImagePlugin.PngInfo(); meta.add_text('Comment', 'NERVE_TEST_PRIVATE_METADATA')
png = encoded(image, 'PNG', pnginfo=meta)
save_case('rgba-text', png, 'png', exact=True)
save_case('palette', encoded(image.convert('P'), 'PNG'), 'png', exact=True)
save_case('minimum', encoded(Image.new('RGB', (1, 1), 'red'), 'PNG'), 'png', exact=True)
exif = Image.Exif(); exif[274] = 6; exif[270] = 'NERVE_TEST_PRIVATE_METADATA'; exif[315] = 'Controlled Fixture'
exif[34853] = {1: 'N', 2: (1.0, 2.0, 3.0), 3: 'E', 4: (4.0, 5.0, 6.0)}
icc = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes())
# lcms otherwise stamps the wall clock into the generated profile header.
icc[24:36] = struct.pack('>6H', 2026, 10, 18, 0, 0, 0)
icc[84:100] = bytes(16)
jpeg = encoded(image.convert('RGB'), 'JPEG', exif=exif, quality=92, icc_profile=bytes(icc))
save_case('orientation', jpeg, 'jpeg')
save_case('progressive', encoded(image.convert('RGB'), 'JPEG', progressive=True, quality=90), 'jpeg')
save_case('static', encoded(image, 'WEBP', lossless=True), 'webp')
frames = [Image.new('RGBA', (48, 32), c) for c in ['red', 'green', 'blue']]
gif = encoded(frames[0], 'GIF', save_all=True, append_images=frames[1:], duration=[80, 160, 240], loop=2, disposal=2, comment=b'NERVE_TEST_PRIVATE_METADATA')
webp = encoded(frames[0], 'WEBP', save_all=True, append_images=frames[1:], duration=[80, 160, 240], loop=2, lossless=True)
save_case('animated', gif, 'gif', exact=True)
save_case('animated', webp, 'webp')
cases[-1]['id'] = 'animated-webp'
cases[-2]['id'] = 'animated-gif'
save_case('single', encoded(frames[0], 'GIF'), 'gif', exact=True)
for kind, data in [('png', png), ('jpeg', jpeg), ('webp', webp), ('gif', gif)]:
    save_case('truncated-' + kind, data[:len(data) * 3 // 4], kind, 'reject', 'invalid')
save_case('missing-iend', png[:-12], 'png', 'reject', 'invalid')
save_case('missing-eoi', jpeg[:-2], 'jpeg', 'reject', 'invalid')
save_case('missing-gif-trailer', gif[:-1], 'gif', 'reject', 'invalid')
save_case('riff-length', webp[:-1], 'webp', 'reject', 'invalid')
save_case('apng', encoded(frames[0], 'PNG', save_all=True, append_images=frames[1:], duration=[80, 160, 240], loop=2), 'png', 'reject', 'animation')
save_case('html-disguised', b'<html><body>controlled non-image</body></html>', 'png', 'reject', 'type')
save_case('svg-disguised', b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 'png', 'reject', 'type')
save_case('wrong-mime', png, 'jpeg', 'reject', 'type')
bad = bytearray(png); bad[16:20] = b'\0' * 4; bad[29:33] = struct.pack('>I', zlib.crc32(bad[12:29]))
save_case('zero-width', bad, 'png', 'reject', 'invalid')
save_case('above-side', encoded(Image.new('RGB', (8193, 1)), 'PNG'), 'png', 'reject', 'dimensions')
save_case('above-pixels', encoded(Image.new('RGB', (4001, 4000)), 'PNG'), 'png', 'reject', 'pixels', large=True)
save_case('at-pixels', encoded(Image.new('RGB', (4000, 4000), (40, 100, 160)), 'PNG'), 'png', large=True)
many = [Image.new('RGB', (64, 64), (i * 2, 40, 80)) for i in range(101)]
save_case('above-frames', encoded(many[0], 'GIF', save_all=True, append_images=many[1:], duration=40, loop=0), 'gif', 'reject', 'frames', large=True)
total = [Image.new('RGB', (800, 800), (i * 4, 100, 80)) for i in range(51)]
save_case('above-total-pixels', encoded(total[0], 'GIF', save_all=True, append_images=total[1:], duration=40, loop=0), 'gif', 'reject', 'pixels', large=True)
save_case('near-total-pixels', encoded(total[0], 'GIF', save_all=True, append_images=total[1:50], duration=40, loop=0), 'gif', large=True)
noise = Image.frombytes('RGB', (2800, 2800), random.Random(20261018).randbytes(2800 * 2800 * 3))
save_case('output-growth', encoded(noise, 'JPEG', quality=65), 'jpeg', 'reject', 'output', large=True)
save_case('above-input', png + bytes(5 * 1024 * 1024 + 1 - len(png)), 'png', 'reject', 'bytes', large=True)
manifest = {'schemaVersion': 1, 'generator': {'pillow': Image.__version__, 'jpeg': features.version('jpg'), 'webp': features.version('webp'), 'seed': 20261018}, 'cases': cases}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'cases': len(cases), 'totalBytes': sum(c['bytes'] for c in cases), 'generator': manifest['generator']}))
