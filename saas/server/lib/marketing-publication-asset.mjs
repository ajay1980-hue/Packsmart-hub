import { types } from 'node:util';
import { inflateSync } from 'node:zlib';
import { creativeDigest } from './creative-safety.mjs';

export const LEGACY_LOCAL_PUBLICATION_ASSET_SCHEMA = 'runvara-local-publication-asset/v1';
export const LOCAL_PUBLICATION_ASSET_SCHEMA = 'runvara-local-publication-asset/v2';
export const LOCAL_PUBLICATION_ASSET_MAX_BYTES = 8 * 1024 * 1024;
export const LOCAL_PUBLICATION_DECODE_MAX_BYTES = 64 * 1024 * 1024;
export const LOCAL_PUBLICATION_DECODER = 'png8-noninterlaced-basic/v1';
const fail = () => Object.assign(new Error('Local publication image snapshot is invalid'),
  { code: 'META_PUBLICATION_LOCAL_ASSET_INVALID', status: 409, definitive: true });
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const viewField = name => Object.getOwnPropertyDescriptor(typedArray, name).get;
const bufferOf = viewField('buffer'), lengthOf = viewField('byteLength'), offsetOf = viewField('byteOffset');
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}

function decodePixels(compressed, width, height, colorType) {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType], stride = width * channels;
  const expected = (stride + 1) * height;
  if (expected > LOCAL_PUBLICATION_DECODE_MAX_BYTES) throw fail();
  let decoded;
  try { decoded = inflateSync(compressed, { info: true, maxOutputLength: expected }); }
  catch { throw fail(); }
  // Zlib validates its checksum/end marker. Also reject concatenated streams,
  // unused trailing input and shorter/longer scanlines, even with valid CRCs.
  if (decoded.buffer.length !== expected || decoded.engine.bytesWritten !== compressed.length) throw fail();
  const filtered = decoded.buffer, pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = filtered[row * (stride + 1)], base = row * stride;
    if (filter > 4) throw fail();
    for (let column = 0; column < stride; column++) {
      const left = column >= channels ? pixels[base + column - channels] : 0;
      const above = row ? pixels[base - stride + column] : 0;
      const upperLeft = row && column >= channels ? pixels[base - stride + column - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = above;
      else if (filter === 3) prediction = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const p = left + above - upperLeft, a = Math.abs(p - left), b = Math.abs(p - above), c = Math.abs(p - upperLeft);
        prediction = a <= b && a <= c ? left : b <= c ? above : upperLeft;
      }
      pixels[base + column] = (filtered[row * (stride + 1) + column + 1] + prediction) & 255;
    }
  }
  return { pixelSha256: creativeDigest(pixels), pixelByteLength: pixels.length, colorType, decoder: LOCAL_PUBLICATION_DECODER };
}

// Fully decode the deliberately narrow PNG subset that we admit: 8-bit,
// non-interlaced grayscale/RGB with optional alpha; no palette or ancillary data.
// Unsupported PNG variants are refused, never labelled decoded. This does not
// qualify a provider format, fetch a URL or attest ownership/remote delivery.
export function snapshotPublicationImage(input, mediaType) {
  if (types.isProxy(input) || !types.isUint8Array(input) || mediaType !== 'image/png') throw fail();
  // Intrinsic getters cannot be replaced by subclass/accessor metadata. Shared
  // buffers are refused because another thread could race the snapshot copy.
  const buffer = bufferOf.call(input), length = lengthOf.call(input), start = offsetOf.call(input);
  if (types.isSharedArrayBuffer(buffer) || length < 57 || length > LOCAL_PUBLICATION_ASSET_MAX_BYTES) throw fail();
  const bytes = Buffer.from(new Uint8Array(buffer, start, length));
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw fail();
  let offset = 8, width, height, colorType, seenData = false, ended = false, chunks = 0;
  const imageData = [];
  while (offset < bytes.length) {
    if (++chunks > 4096 || offset + 12 > bytes.length) throw fail();
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length || size > LOCAL_PUBLICATION_ASSET_MAX_BYTES) throw fail();
    const kind = bytes.toString('latin1', offset + 4, offset + 8);
    // Ancillary, palette and animation semantics are outside this contract.
    if (!['IHDR', 'IDAT', 'IEND'].includes(kind)
      || crc(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw fail();
    if (chunks === 1) {
      if (kind !== 'IHDR' || size !== 13) throw fail();
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      colorType = bytes[offset + 17];
      if (!width || !height || width > 16384 || height > 16384 || width * height > 40000000
        || bytes[offset + 16] !== 8 || ![0, 2, 4, 6].includes(bytes[offset + 17])
        || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) throw fail();
    } else if (kind === 'IHDR') throw fail();
    if (kind === 'IDAT') { if (!size) throw fail(); seenData = true; imageData.push(bytes.subarray(offset + 8, end - 4)); }
    if (kind === 'IEND') { if (size || !seenData || end !== bytes.length) throw fail(); ended = true; }
    offset = end;
  }
  if (!ended) throw fail();
  const decoded = decodePixels(Buffer.concat(imageData), width, height, colorType);
  return { bytes, descriptor: Object.freeze({ schema: LOCAL_PUBLICATION_ASSET_SCHEMA,
    sha256: creativeDigest(bytes), byteLength: bytes.length, mediaType, width, height,
    mimeEvidence: 'png_signature_structure_crc_zlib_pixels', decoded: true, ...decoded, providerDeliveryVerified: false }) };
}
