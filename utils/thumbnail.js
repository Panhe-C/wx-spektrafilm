// WeChat-specific thumbnail export path.
//
// The renderer returns raw RGBA8 pixels (utils/lut-renderer.js renderToPixels).
// This module turns those pixels into something an <image> component can show:
// a temp file path, a data URL, or nothing at all when every export route
// fails (the page then shows a coloured placeholder).
//
// The order is deliberate:
//   1. wx.canvasToTempFilePath({ canvas })  -> smallest payload, a real file
//   2. canvas.toDataURL('image/png')        -> data URL fallback
//   3. a self-contained PNG encoder written to USER_DATA_PATH
//   4. null                                 -> the caller shows a placeholder
(function registerThumbnails(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SpektrafilmThumbnails = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function thumbnailFactory() {
  // Preset cards are fixed 16:9 and centre-cropped, never contain-fitted or
  // squeezed. Keep the renderer, <image mode>, WXSS padding, and diagnostics
  // tied to this one geometry policy.
  const THUMBNAIL_ASPECT = 16 / 9;
  const THUMBNAIL_WIDTH = 240;
  const THUMBNAIL_HEIGHT = 135;

  function thumbnailGeometry(photoWidth, photoHeight) {
    const width = Number(photoWidth);
    const height = Number(photoHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('Invalid photo dimensions');
    }
    const sourceAspect = width / height;
    let cropWidth;
    let cropHeight;
    let x;
    let y;
    if (sourceAspect > THUMBNAIL_ASPECT) {
      cropHeight = height;
      cropWidth = height * THUMBNAIL_ASPECT;
      x = (width - cropWidth) / 2;
      y = 0;
    } else {
      cropWidth = width;
      cropHeight = width / THUMBNAIL_ASPECT;
      x = 0;
      y = (height - cropHeight) / 2;
    }
    return {
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      boxAspect: THUMBNAIL_ASPECT,
      imageMode: 'aspectFill',
      cropRect: { x, y, width: cropWidth, height: cropHeight },
      imageUvOffset: [x / width, y / height],
      imageUvScale: [cropWidth / width, cropHeight / height],
    };
  }

  const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  const CRC_TABLE = (function buildCrcTable() {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  }());

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function adler32(bytes) {
    let a = 1;
    let b = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      a = (a + bytes[index]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  function toBase64(bytes) {
    let output = '';
    let index = 0;
    for (; index + 2 < bytes.length; index += 3) {
      const triplet = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
      output += BASE64_ALPHABET[(triplet >> 18) & 63];
      output += BASE64_ALPHABET[(triplet >> 12) & 63];
      output += BASE64_ALPHABET[(triplet >> 6) & 63];
      output += BASE64_ALPHABET[triplet & 63];
    }
    const remaining = bytes.length - index;
    if (remaining === 1) {
      const value = bytes[index] << 16;
      output += BASE64_ALPHABET[(value >> 18) & 63];
      output += BASE64_ALPHABET[(value >> 12) & 63];
      output += '==';
    } else if (remaining === 2) {
      const value = (bytes[index] << 16) | (bytes[index + 1] << 8);
      output += BASE64_ALPHABET[(value >> 18) & 63];
      output += BASE64_ALPHABET[(value >> 12) & 63];
      output += BASE64_ALPHABET[(value >> 6) & 63];
      output += '=';
    }
    return output;
  }

  function pngChunk(type, data) {
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    for (let index = 0; index < 4; index += 1) {
      chunk[4 + index] = type.charCodeAt(index);
    }
    chunk.set(data, 8);
    view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    return chunk;
  }

  /**
   * Minimal but standards-correct PNG encoder (8-bit RGBA, filter 0, stored
   * deflate blocks). It exists only as the last-resort export route, so it
   * favours simplicity over compression.
   */
  function encodePng(rgba, width, height) {
    const size = Math.round(Number(width));
    const rows = Math.round(Number(height));
    if (!Number.isFinite(size) || !Number.isFinite(rows) || size < 1 || rows < 1) {
      throw new Error('Invalid PNG dimensions');
    }
    const stride = size * 4;
    if (rgba.length < stride * rows) {
      throw new Error('Not enough pixels for the requested PNG size');
    }
    const raw = new Uint8Array(rows * (stride + 1));
    for (let row = 0; row < rows; row += 1) {
      const target = row * (stride + 1);
      raw[target] = 0;
      raw.set(rgba.subarray(row * stride, row * stride + stride), target + 1);
    }
    const blockCount = Math.max(1, Math.ceil(raw.length / 65535));
    const zlib = new Uint8Array(2 + raw.length + blockCount * 5 + 4);
    zlib[0] = 0x78;
    zlib[1] = 0x01;
    let position = 2;
    let offset = 0;
    for (let block = 0; block < blockCount; block += 1) {
      const length = Math.min(65535, raw.length - offset);
      zlib[position] = block === blockCount - 1 ? 1 : 0;
      zlib[position + 1] = length & 0xff;
      zlib[position + 2] = (length >>> 8) & 0xff;
      zlib[position + 3] = (~length) & 0xff;
      zlib[position + 4] = ((~length) >>> 8) & 0xff;
      position += 5;
      zlib.set(raw.subarray(offset, offset + length), position);
      position += length;
      offset += length;
    }
    const checksum = adler32(raw);
    zlib[position] = (checksum >>> 24) & 0xff;
    zlib[position + 1] = (checksum >>> 16) & 0xff;
    zlib[position + 2] = (checksum >>> 8) & 0xff;
    zlib[position + 3] = checksum & 0xff;
    const header = new Uint8Array(13);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, size);
    headerView.setUint32(4, rows);
    header[8] = 8; // bit depth
    header[9] = 6; // colour type: truecolour with alpha
    header[10] = 0; // deflate
    header[11] = 0; // adaptive filtering
    header[12] = 0; // no interlace
    const chunks = [
      new Uint8Array(PNG_SIGNATURE),
      pngChunk('IHDR', header),
      pngChunk('IDAT', zlib),
      pngChunk('IEND', new Uint8Array(0)),
    ];
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let cursor = 0;
    chunks.forEach((chunk) => {
      output.set(chunk, cursor);
      cursor += chunk.length;
    });
    return output;
  }

  function getWx() {
    return typeof wx !== 'undefined' ? wx : null;
  }

  function createCanvas(width, height) {
    const api = getWx();
    if (!api || typeof api.createOffscreenCanvas !== 'function') {
      return null;
    }
    try {
      const canvas = api.createOffscreenCanvas({ type: '2d', width, height });
      canvas.width = width;
      canvas.height = height;
      return canvas;
    } catch (error) {
      try {
        const canvas = api.createOffscreenCanvas(width, height);
        canvas.width = width;
        canvas.height = height;
        return canvas;
      } catch (fallbackError) {
        return null;
      }
    }
  }

  function writePngFile(api, pixels, width, height, fileName) {
    return new Promise((resolve) => {
      try {
        const manager = api.getFileSystemManager && api.getFileSystemManager();
        const base = api.env && api.env.USER_DATA_PATH;
        if (!manager || !base) {
          resolve(null);
          return;
        }
        const filePath = `${base}/wx-spektrafilm-${fileName}.png`;
        manager.writeFile({
          filePath,
          data: toBase64(encodePng(pixels, width, height)),
          success: () => resolve({ kind: 'file', src: filePath }),
          fail: () => resolve(null),
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  /**
   * Export RGBA pixels for an <image> component.
   * Resolves with { kind, src } or with null when every route failed.
   */
  function exportPixels(options) {
    const api = getWx();
    if (!api) {
      return Promise.resolve(null);
    }
    const pixels = options.pixels;
    const width = Math.round(Number(options.width));
    const height = Math.round(Number(options.height));
    const fileName = String(options.fileName || 'thumb').replace(/[^\w-]/g, '');
    if (!pixels || !Number.isFinite(width) || !Number.isFinite(height)) {
      return Promise.resolve(null);
    }
    const canvas = createCanvas(width, height);
    if (!canvas || typeof canvas.getContext !== 'function') {
      return Promise.resolve(null);
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return Promise.resolve(null);
    }
    let imageData = null;
    try {
      imageData = context.createImageData(width, height);
      imageData.data.set(pixels);
      context.putImageData(imageData, 0, 0);
    } catch (error) {
      return Promise.resolve(null);
    }
    const steps = [];
    if (typeof api.canvasToTempFilePath === 'function') {
      steps.push(() => new Promise((done) => {
        try {
          api.canvasToTempFilePath({
            canvas,
            fileType: 'png',
            success: (result) => {
              done(result && result.tempFilePath
                ? { kind: 'file', src: result.tempFilePath }
                : null);
            },
            fail: () => done(null),
          });
        } catch (error) {
          done(null);
        }
      }));
    }
    if (typeof canvas.toDataURL === 'function') {
      steps.push(() => {
        try {
          const dataUrl = canvas.toDataURL('image/png');
          return Promise.resolve(dataUrl ? { kind: 'data', src: dataUrl } : null);
        } catch (error) {
          return Promise.resolve(null);
        }
      });
    }
    steps.push(() => writePngFile(api, pixels, width, height, fileName));
    return steps.reduce(
      (chain, step) => chain.then((result) => (result ? result : step())),
      Promise.resolve(null)
    );
  }

  return {
    THUMBNAIL_ASPECT,
    THUMBNAIL_WIDTH,
    THUMBNAIL_HEIGHT,
    thumbnailGeometry,
    toBase64,
    encodePng,
    createCanvas,
    exportPixels,
  };
}));
