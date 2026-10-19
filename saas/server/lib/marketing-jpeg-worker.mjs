import { parentPort, workerData } from 'node:worker_threads';
import crypto from 'node:crypto';
import jpeg from 'jpeg-js';

const fail = () => { throw new Error('Unsupported or malformed JPEG'); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// jpeg-js deliberately recovers some malformed inputs. This independent parser
// admits only one complete baseline interleaved YCbCr scan and checks every
// entropy-coded block, its coefficient bounds, final padding and exact EOI.
function strictStructure(bytes) {
  const u16 = p => bytes[p] * 256 + bytes[p + 1];
  if (u16(0) !== 0xffd8) fail();
  let p = 2, frame, jfif = false, segments = 0;
  const quant = new Map(), tables = new Map();
  while (p < bytes.length && ++segments <= 20) {
    if (bytes[p++] !== 255) fail();
    const marker = bytes[p++], size = u16(p), end = p + size;
    if (!Number.isInteger(size) || size < 2 || end > bytes.length) fail();
    p += 2;
    if (marker === 0xe0) {
      if (jfif || size !== 16 || bytes.subarray(p, p + 5).toString('hex') !== '4a46494600'
        || bytes[p+5] !== 1 || ![1,2].includes(bytes[p+6]) || bytes[p+7] > 2
        || !u16(p+8) || !u16(p+10) || bytes[p+12] || bytes[p+13]) fail();
      jfif = true; p = end;
    } else if (marker === 0xdb) {
      while (p < end) {
        const id = bytes[p++];
        if (id > 3 || quant.has(id) || p + 64 > end) fail();
        const values=[];for (let i = 0; i < 64; i++) {if (!bytes[p]) fail();values.push(bytes[p++]);}
        quant.set(id,values);
      }
    } else if (marker === 0xc0) {
      if (frame || size !== 17 || bytes[p] !== 8 || u16(p+1) !== 1080 || u16(p+3) !== 1080 || bytes[p+5] !== 3) fail();
      frame = [];
      for (let i = 0; i < 3; i++) {
        const at = p + 6 + i * 3, sample = bytes[at+1];
        if (bytes[at] !== i + 1 || (i === 0 ? ![0x11,0x21,0x22].includes(sample) : sample !== 0x11) || bytes[at+2] > 3) fail();
        frame.push({ id:i+1, h:sample >> 4, v:sample & 15, q:bytes[at+2], predictor:0 });
      }
      p = end;
    } else if (marker === 0xc4) {
      while (p < end) {
        const id = bytes[p++];
        if (![0,1,2,3,16,17,18,19].includes(id) || tables.has(id) || p + 16 > end) fail();
        const counts = [...bytes.subarray(p,p+16)]; p += 16;
        const count = counts.reduce((a,b)=>a+b,0);
        if (!count || count > 256 || p + count > end) fail();
        const table = new Map(); let code = 0;
        for (let length = 1; length <= 16; length++) {
          for (let i = 0; i < counts[length-1]; i++) {
            if (code >= (1 << length) - 1) fail(); // no all-one code, including oversubscription
            const symbol = bytes[p++], category = symbol & 15;
            if (id < 16 ? symbol > 11 : category > 10 || (category === 0 && ![0,240].includes(symbol))) fail();
            table.set(length + ':' + code++, symbol);
          }
          code *= 2;
        }
        tables.set(id, table);
      }
    } else if (marker === 0xda) {
      if (!jfif || !frame || size !== 12 || bytes[p++] !== 3) fail();
      for (const component of frame) {
        if (bytes[p++] !== component.id) fail();
        const ids = bytes[p++]; component.dc = tables.get(ids >> 4); component.ac = tables.get(16 + (ids & 15));
        if (!component.dc || !component.ac || !quant.has(component.q)) fail();
      }
      if (bytes[p++] !== 0 || bytes[p++] !== 63 || bytes[p++] !== 0 || p !== end) fail();
      let bits = 0, byte = 0;
      const bit = () => {
        if (!bits) { if (p >= bytes.length) fail(); byte = bytes[p++]; if (byte === 255 && bytes[p++] !== 0) fail(); bits = 8; }
        return byte >> --bits & 1;
      };
      const magnitude = n => {if(!n)return 0;let value=0;for(let i=0;i<n;i++)value=value*2+bit();return value < 2**(n-1) ? value-(2**n-1) : value;};
      const symbol = table => { let code = 0; for (let n = 1; n <= 16; n++) { code = code * 2 + bit(); const value = table.get(n + ':' + code); if (value !== undefined) return value; } fail(); };
      const mcus = Math.ceil(1080/(8*frame[0].h)) * Math.ceil(1080/(8*frame[0].v));
      for (let m = 0; m < mcus; m++) for (const c of frame) for (let b = 0; b < c.h*c.v; b++) {
        c.predictor+=magnitude(symbol(c.dc));
        if(c.predictor < -1024 || c.predictor > 1023 || Math.abs(c.predictor*quant.get(c.q)[0])>2048)fail();
        let k = 1;
        while (k < 64) {
          const value = symbol(c.ac), n = value & 15;
          if (value === 0) break;
          if (value === 240) { k += 16; if (k > 64) fail(); continue; }
          k += value >> 4; if (k >= 64) fail();
          if(Math.abs(magnitude(n)*quant.get(c.q)[k])>2048)fail();k++;
        }
      }
      while (bits) if (bit() !== 1) fail();
      if (p + 2 !== bytes.length || u16(p) !== 0xffd9) fail();
      return;
    } else fail(); // progressive, restart markers, metadata and multiple scans are closed
    if (p !== end) fail();
  }
  fail();
}
try {
  const bytes = Buffer.from(workerData);
  if (bytes.length > 2 * 1024 * 1024) fail();
  strictStructure(bytes);
  const decoded = jpeg.decode(bytes, { tolerantDecoding:false, useTArray:true, formatAsRGBA:true,
    colorTransform:true, maxResolutionInMP:1.2, maxMemoryUsageInMB:48 });
  if (decoded.width !== 1080 || decoded.height !== 1080 || decoded.data.length !== 1080*1080*4) fail();
  parentPort.postMessage({ ok:true, descriptor:{ schema:'runvara-local-jpeg-1080-baseline/v1', mediaType:'image/jpeg',
    sha256:hash(bytes), byteLength:bytes.length, width:1080, height:1080, pixelSha256:hash(decoded.data), pixelByteLength:decoded.data.length,
    decoder:'jpeg-js@0.4.4/strict-baseline-ycbcr/v1', decoded:true, providerDeliveryVerified:false } });
} catch { parentPort.postMessage({ ok:false }); }
