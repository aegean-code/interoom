function invalid(message) { return { photoMessage: message }; }
export async function validatePhotoFile(file) {
  if (!file?.size || file.size > 8 * 1024 * 1024) throw invalid('Choose a photo smaller than 8 MB.');
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n);
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (!jpeg && !png && !webp) throw invalid('Choose a JPG, PNG or WebP photo.');
}
export async function decodePhoto(file) {
  await validatePhotoFile(file);
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw invalid('This image couldn’t be opened. Try another JPG, PNG or WebP photo.'); }
  if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) {
    bitmap.close(); throw invalid('Choose a photo under 40 megapixels.');
  }
  return bitmap;
}
export function cropRectangle(width, height, zoom = 1, horizontal = 50, vertical = 50) {
  const side = Math.min(width, height) / Math.max(1, Math.min(3, zoom));
  return { x: (width - side) * Math.max(0, Math.min(100, horizontal)) / 100,
    y: (height - side) * Math.max(0, Math.min(100, vertical)) / 100, side };
}
export function drawPhoto(canvas, bitmap, zoom, horizontal, vertical) {
  const { x, y, side } = cropRectangle(bitmap.width, bitmap.height, zoom, horizontal, vertical);
  canvas.width = canvas.height = 512;
  const context = canvas.getContext('2d');
  context.fillStyle = '#f7f4ed'; context.fillRect(0, 0, 512, 512);
  context.drawImage(bitmap, x, y, side, side, 0, 0, 512, 512);
}
export function encodePhoto(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(invalid('Couldn’t prepare this image. Try another photo.')), 'image/jpeg', 0.86));
}
