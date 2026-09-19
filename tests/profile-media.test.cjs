const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { deflateSync } = require('node:zlib')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'lib/profile-media.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const mediaModule = { exports: {} }
new Function('module', 'exports', compiled)(mediaModule, mediaModule.exports)
const { inspectProfileImage, validateProfileMedia, prepareProfileMedia, PROFILE_MEDIA_LIMITS } = mediaModule.exports

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(tag, data = Buffer.alloc(0)) {
  const output = Buffer.alloc(data.length + 12)
  output.writeUInt32BE(data.length); output.write(tag, 4); data.copy(output, 8)
  output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4)
  return output
}
function png({ width = 1, height = 1, extras = [], compressed } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...extras,
    chunk('IDAT', compressed ?? deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND')])
}
function gif({ frames = 2, width = 1, height = 1, delay = 10, metadata = false, badLzw = false } = {}) {
  const header = Buffer.from([71, 73, 70, 56, 57, 97, width & 255, width >> 8, height & 255, height >> 8, 128, 0, 0, 255, 0, 0, 0, 0, 255])
  const parts = [header, Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0])]
  if (metadata) {
    const comment = Buffer.from('private comment GPS XMP')
    parts.push(Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0]))
    parts.push(Buffer.from([0x21, 0xff, 11]), Buffer.from('PRIVATEINFO'), Buffer.from([4, 1, 2, 3, 4, 0]))
  }
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from([0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0]),
      Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, badLzw ? 0 : (i % 2 ? 0x4c : 0x44), 1, 0]))
  }
  return Buffer.concat([...parts, Buffer.from([0x3b])])
}
function asMedia(image = png()) {
  const info = inspectProfileImage(image)
  return { mime: info.mime, data: Buffer.from(info.bytes).toString('base64'), still: png().toString('base64'),
    width: info.width, height: info.height, animated: info.frames > 1, position: 50 }
}

test('actual image bytes, not names, MIME labels or URLs, determine acceptance', async () => {
  for (const input of ['https://example.com/photo.png', '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', '<html>image</html>', 'GIF89a']) {
    assert.throws(() => inspectProfileImage(Buffer.from(input)))
    await assert.rejects(prepareProfileMedia(new Blob([input], { type: 'image/png' }), 'avatar'))
  }
  assert.equal(inspectProfileImage(png()).mime, 'image/png')
  assert.equal(inspectProfileImage(gif()).mime, 'image/gif')
})

test('PNG metadata is removed and critical pixels are retained', () => {
  const privateImage = png({ extras: [chunk('tEXt', Buffer.from('GPS\0private location')), chunk('eXIf', Buffer.from('personal metadata'))] })
  const sanitized = inspectProfileImage(privateImage)
  assert.deepEqual(Buffer.from(sanitized.bytes), png())
  assert.equal(sanitized.width, 1)
  assert.equal(sanitized.height, 1)
  const unprocessed = { ...asMedia(), data: privateImage.toString('base64') }
  assert.equal(validateProfileMedia(unprocessed), false, 'peers must send sanitized bytes')
})

test('PNG malformed chunks, bad checksums, oversized dimensions and animation are rejected', () => {
  const corrupt = png(); corrupt[29] ^= 1
  for (const image of [corrupt, png().subarray(0, -1), png({ width: 4097 }), png({ height: 0 }),
    png({ extras: [chunk('acTL', Buffer.alloc(8))] }), Buffer.concat([png(), Buffer.from('<script>')])]) {
    assert.throws(() => inspectProfileImage(image))
  }
  assert.throws(() => inspectProfileImage(new Uint8Array(PROFILE_MEDIA_LIMITS.inputBytes + 1)))
})

test('GIF keeps every image, timing and loop control while stripping comments and app metadata', () => {
  const original = gif({ frames: 3, metadata: true, delay: 17 })
  const result = inspectProfileImage(original)
  assert.equal(result.frames, 3)
  assert.equal(result.durationMs, 510)
  assert.deepEqual(Buffer.from(result.bytes), gif({ frames: 3, delay: 17 }))
  assert.equal(Buffer.from(result.bytes).includes('NETSCAPE2.0'), true)
  assert.equal(Buffer.from(result.bytes).includes('private'), false)
  assert.equal(inspectProfileImage(result.firstFrame).frames, 1)
  assert.equal(inspectProfileImage(result.firstFrame).durationMs, 170)
  assert.equal(validateProfileMedia(asMedia(original)), true)
})

test('GIF limits bound frames, frame duration, canvas size and cumulative decoded pixels', () => {
  for (const image of [gif({ frames: 81 }), gif({ delay: 1001 }), gif({ width: 1025 }), gif({ height: 513 }),
    gif({ frames: 65, width: 1024, height: 512 })]) assert.throws(() => inspectProfileImage(image))
  assert.equal(inspectProfileImage(gif({ frames: 80, delay: 2 })).frames, 80)
  assert.equal(inspectProfileImage(gif({ delay: 0 })).durationMs, 200, 'zero-delay frames count browser minimum playback time')
})

test('GIF rejects incomplete LZW, out-of-bounds frames and trailing polyglots', () => {
  const frameOutside = gif(); frameOutside[49] = 2
  for (const image of [gif({ badLzw: true }), gif().subarray(0, -1), frameOutside,
    Buffer.concat([gif(), Buffer.from('<svg/>')])]) assert.throws(() => inspectProfileImage(image))
  const missingEnd = gif(); missingEnd[59] = 0
  assert.throws(() => inspectProfileImage(missingEnd))
})

test('GIF streams must decode to exactly the claimed pixel count and valid palette indices', () => {
  const extraPixel = gif({ width: 2 }); extraPixel[51] = 2
  assert.throws(() => inspectProfileImage(extraPixel))
  const badColor = gif(); badColor[58] = 0x54 // clear, palette index 2, stop
  assert.throws(() => inspectProfileImage(badColor))
})

test('JPEG APP/EXIF/comment data is stripped before decoding', () => {
  const jpeg = Buffer.from([255,216, 255,225,0,8,69,88,73,70,0,0, 255,254,0,6,71,80,83,0,
    255,192,0,11,8,0,1,0,1,1,1,17,0, 255,218,0,8,1,1,0,0,63,0, 10,255,0,10,255,217])
  const result = inspectProfileImage(jpeg)
  assert.equal(result.mime, 'image/jpeg')
  assert.equal(result.width, 1)
  assert.equal(Buffer.from(result.bytes).includes('EXIF'), false)
  assert.equal(Buffer.from(result.bytes).includes('GPS'), false)
  assert.throws(() => inspectProfileImage(jpeg.subarray(0, -2)))
})

test('stored media rejects foreign keys, remote sources, inconsistent sizes and animation claims', () => {
  const valid = asMedia()
  assert.equal(validateProfileMedia(valid), true)
  for (const changes of [{ data: 'https://example.com/p.png' }, { mime: 'image/svg+xml' }, { animated: true }, { width: 2 },
    { url: 'https://example.com' }, { position: NaN }, { position: -1 }, { position: 101 }, { still: gif().toString('base64') },
    { data: `${valid.data}\n` }, { data: 'AAAA'.repeat(PROFILE_MEDIA_LIMITS.outputBytes) }]) {
    assert.equal(validateProfileMedia({ ...valid, ...changes }), false)
  }
  assert.equal(validateProfileMedia(null), false)
  assert.equal(validateProfileMedia([]), false)
})

test('upload byte limit is checked before reading the file', async () => {
  const file = new Blob([new Uint8Array(PROFILE_MEDIA_LIMITS.inputBytes + 1)])
  file.arrayBuffer = () => { throw new Error('must not read an oversized file') }
  await assert.rejects(prepareProfileMedia(file, 'avatar'), /4 MiB/)
})

test('browser normalizes static formats and verifies animated/still content', {
  skip: !process.env.SEROTINE_CHROMIUM_PATH,
}, async () => {
  const { chromium } = require('playwright')
  const esbuild = require('esbuild')
  const bundle = (await esbuild.build({ entryPoints: [path.join(root, 'lib/profile-media.ts')], bundle: true, write: false,
    platform: 'browser', format: 'iife', globalName: 'ProfileMediaTest' })).outputFiles[0].text
  const browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'], headless: true })
  try {
    const page = await browser.newPage()
    await page.addScriptTag({ content: bundle })
    const result = await page.evaluate(async fixtures => {
      /* global ProfileMediaTest */
      const staticResults = []
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 800
      const context = canvas.getContext('2d'); context.fillStyle = '#aabbcc'; context.fillRect(0, 0, 1200, 800)
      for (const format of ['image/png', 'image/jpeg', 'image/webp']) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, format))
        const spoofed = new Blob([blob], { type: 'text/html' })
        const normalized = await ProfileMediaTest.prepareProfileMedia(spoofed, 'avatar')
        staticResults.push(await ProfileMediaTest.verifyProfileMedia(normalized))
      }
      const animated = await ProfileMediaTest.prepareProfileMedia(new Blob([new Uint8Array(fixtures.gif)], { type: 'image/svg+xml' }), 'banner')
      await ProfileMediaTest.verifyProfileMedia(animated)
      const stillBitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(animated.still), c => c.charCodeAt(0))], { type: 'image/png' }))
      canvas.width = 1; canvas.height = 1; context.drawImage(stillBitmap, 0, 0); stillBitmap.close()
      const pixel = Array.from(context.getImageData(0, 0, 1, 1).data)
      let malformedRejected = false
      try { await ProfileMediaTest.verifyProfileMedia(fixtures.badPng) } catch { malformedRejected = true }
      return { staticResults, animated, pixel, malformedRejected }
    }, { gif: Array.from(gif({ metadata: true })), badPng: asMedia(png({ compressed: Buffer.from([1, 2, 3]) })) })
    for (const image of result.staticResults) {
      assert.equal(image.width, 512); assert.equal(image.height, 341)
      assert.equal(image.animated, false); assert.equal(validateProfileMedia(image), true)
    }
    assert.equal(result.animated.animated, true)
    assert.equal(inspectProfileImage(Buffer.from(result.animated.data, 'base64')).frames, 2)
    assert.deepEqual(result.pixel, [255, 0, 0, 255], 'still is the first frame, not animation timing dependent')
    assert.equal(result.malformedRejected, true, 'browser decoding rejects invalid compressed raster data')
  } finally { await browser.close() }
})
