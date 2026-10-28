from pathlib import Path
import json

import numpy as np
from PIL import Image, ImageFilter


root = Path(__file__).resolve().parents[1]
branding = root / 'assets' / 'branding'
source = Image.open(branding / 'whomi-symbol.png').convert('RGB')
rgb = np.asarray(source, dtype=np.float64)
nearby_color = np.asarray(source.filter(ImageFilter.MinFilter(9)), dtype=np.float64)


def extract_layer(seed):
    core = Image.fromarray((seed * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5))
    support = np.asarray(core.filter(ImageFilter.MaxFilter(9))) > 0
    interior = np.asarray(core) > 0
    contrast = 255 - nearby_color
    alpha = np.max(np.divide(255 - rgb, contrast, out=np.zeros_like(rgb), where=contrast >= 16), axis=2)
    alpha = np.maximum(alpha, np.max(255 - rgb, axis=2) / 255)
    alpha = np.clip(alpha, 0, 1) * support
    alpha[interior] = 1
    alpha_byte = np.ceil(alpha * 255).astype(np.uint8)
    alpha = alpha_byte.astype(np.float64) / 255

    # 从抗锯齿边缘去除白色底，保持在浅色和深色背景上的轮廓。
    foreground = np.divide(
        rgb - 255 * (1 - alpha[..., None]),
        alpha[..., None],
        out=np.zeros_like(rgb),
        where=alpha[..., None] > 0,
    )
    rgba = np.dstack((np.rint(np.clip(foreground, 0, 255)).astype(np.uint8), alpha_byte))
    if not np.array_equal(rgba[interior, :3], rgb[interior].astype(np.uint8)):
        raise RuntimeError('分层颜色校验失败，请检查原图。')
    return Image.fromarray(rgba), support


red, green, blue = np.moveaxis(rgb, -1, 0)
lens, lens_support = extract_layer((red - green > 40) & (red - blue > 60))
face, face_support = extract_layer(np.max(rgb, axis=2) < 192)
if np.any((np.asarray(lens)[..., 3] > 0) & (np.asarray(face)[..., 3] > 0)):
    raise RuntimeError('分层区域重叠，请检查原图。')

combined = Image.alpha_composite(lens, face)
check = Image.new('RGBA', source.size, 'white')
check.alpha_composite(combined)
error = np.abs(np.asarray(check.convert('RGB'), dtype=np.int16) - rgb)
max_error = int(np.max(error[lens_support | face_support]))
if max_error > 1:
    raise RuntimeError('叠合校验失败，请检查透明边缘。')

lens_path = branding / 'whomi-lens-layer.png'
face_path = branding / 'whomi-face-layer.png'
lens.save(lens_path, optimize=True)
face.save(face_path, optimize=True)
print(json.dumps({
    '放大镜图片': str(lens_path),
    '小脸图片': str(face_path),
    '画布尺寸': list(source.size),
    '前景叠合最大色阶误差': max_error,
}, ensure_ascii=False))
