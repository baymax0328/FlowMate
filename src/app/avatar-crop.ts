export type AvatarCrop = { x: number; y: number; zoom: number };

/** 裁剪坐标记录在原图尺寸上，这样任何显示尺寸下裁出来的结果都一致。 */
export function avatarCropRect(width: number, height: number, crop: AvatarCrop) {
  const zoom = Math.min(4, Math.max(1, crop.zoom));
  const side = Math.min(width, height) / zoom;
  const x = Math.max(side / 2, Math.min(width - side / 2, crop.x));
  const y = Math.max(side / 2, Math.min(height - side / 2, crop.y));
  return { x: x - side / 2, y: y - side / 2, side, center: { x, y, zoom } };
}

export function drawAvatarCrop(canvas: HTMLCanvasElement, image: ImageBitmap, crop: AvatarCrop) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器无法处理图片');
  const rect = avatarCropRect(image.width, image.height, crop);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, rect.x, rect.y, rect.side, rect.side, 0, 0, canvas.width, canvas.height);
}
