import { Worker } from 'node:worker_threads';
import { types } from 'node:util';
export const JPEG_MAX_BYTES = 2 * 1024 * 1024;
export const JPEG_CONTRACT = 'runvara-local-jpeg-1080-baseline/v1';
const invalid = () => Object.assign(new Error('Use a 1080 × 1080 baseline JFIF JPEG, at most 2 MiB, without EXIF, ICC or other metadata.'), { code: 'LOCAL_JPEG_INVALID', status: 422 });
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const field = key => Object.getOwnPropertyDescriptor(typedArray, key).get;
const getBuffer = field('buffer'), getLength = field('byteLength'), getOffset = field('byteOffset');
let active = 0;
export async function snapshotLocalJpeg(input) {
  if (types.isProxy(input) || !types.isUint8Array(input)) throw invalid();
  const buffer = getBuffer.call(input), length = getLength.call(input), offset = getOffset.call(input);
  if (types.isSharedArrayBuffer(buffer) || length < 100 || length > JPEG_MAX_BYTES) throw invalid();
  const bytes = Buffer.from(new Uint8Array(buffer, offset, length));
  if (active >= 2) throw Object.assign(new Error('Image validation is busy; retry this draft'), { code: 'LOCAL_JPEG_BUSY', status: 503 });
  active++;
  try {
    const descriptor = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./marketing-jpeg-worker.mjs', import.meta.url), {
        workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      let result, error;
      const timer = setTimeout(() => { error = invalid(); void worker.terminate(); }, 5000);
      worker.on('message', value => { if (value?.ok) result = value.descriptor; else error = invalid(); });
      worker.on('error', () => { error = invalid(); });
      worker.on('exit', code => { clearTimeout(timer); if (code || error || !result) reject(error || invalid()); else resolve(result); });
    });
    return { bytes, descriptor };
  } finally { active--; }
}
