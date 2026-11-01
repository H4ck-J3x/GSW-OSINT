# Dump every metadata field of an image as JSON: format, size, EXIF (Image, Exif and GPS IFDs), PNG/WebP text chunks,
# plus decimal GPS when present. Run: uv run -q --with pillow python -I meta.py <image>
import json
import sys

from PIL import ExifTags, Image


def clean(v):
    if isinstance(v, bytes):
        s = v.rstrip(b'\0')
        try:
            return s.decode('utf-8') if len(s) < 300 else f'<{len(v)} octets>'
        except UnicodeDecodeError:
            return f'<{len(v)} octets>'
    if isinstance(v, str):
        return v.strip('\x00 ')[:2000]
    if isinstance(v, (tuple, list)):
        return [clean(x) for x in v]
    if isinstance(v, (int, type(None))):
        return v
    try:
        return round(float(v), 6)  # IFDRational
    except (TypeError, ValueError, ZeroDivisionError):
        return str(v)


def dms(v, ref):
    d, m, s = (float(x) for x in v)
    x = d + m / 60 + s / 3600
    return -x if ref in ('S', 'W') else x


def read(path):
    im = Image.open(path)
    ex = im.getexif()
    out = {'format': im.format, 'size': list(im.size), 'mode': im.mode, 'tags': {}}
    groups = {
        'Image': {ExifTags.TAGS.get(k, k): v for k, v in ex.items() if k not in (0x8769, 0x8825)},
        'Exif': {ExifTags.TAGS.get(k, k): v for k, v in ex.get_ifd(0x8769).items()},
        'GPS': {ExifTags.GPSTAGS.get(k, k): v for k, v in ex.get_ifd(0x8825).items()},
    }
    for group, tags in groups.items():
        for k, v in tags.items():
            out['tags'][f'{group}.{k}'] = clean(v)
    for k, v in im.info.items():  # PNG tEXt/iTXt, WebP chunks, dpi...
        if k in ('exif', 'icc_profile', 'xmp'):
            out['tags'][f'Fichier.{k}'] = f'<{len(v)} octets>' if isinstance(v, (bytes, str)) else str(v)
        else:
            out['tags'][f'Fichier.{k}'] = clean(v)
    g = ex.get_ifd(0x8825)
    if 2 in g and 4 in g:
        lat, lon = dms(g[2], g.get(1, 'N')), dms(g[4], g.get(3, 'E'))
        if -90 <= lat <= 90 and -180 <= lon <= 180 and (lat, lon) != (0, 0):  # 0,0 is a blank field, not a place
            out['gps'] = {'lat': round(lat, 7), 'lon': round(lon, 7)}
            if 6 in g:
                out['gps']['alt'] = round(float(g[6]), 1)
            if 17 in g:
                out['gps']['direction'] = round(float(g[17]), 1)
    return out


if __name__ == '__main__':
    try:
        print(json.dumps(read(sys.argv[1]), ensure_ascii=False, default=str))
    except Exception as e:  # noqa: BLE001 - unreadable image: report, don't crash the job
        print(json.dumps({'error': str(e), 'tags': {}}))
