import { deflateSync } from 'node:zlib';

export function chunk(kind, data) {
  const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
  let crc = -1;
  for (const byte of body) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE((crc ^ -1) >>> 0, result.length - 4);
  return result;
}
export function png(pixel = 1, { width = 1, height = 1, bitDepth = 8, color = 6, interlace = 0, extra = null } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = bitDepth; header[9] = color; header[12] = interlace;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    ...(extra ? [extra] : []), chunk('IDAT', deflateSync(Buffer.from([0, pixel, 2, 3, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
