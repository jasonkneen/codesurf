/**
 * Creates an ICO file from the source PNG icon.
 * ICO format embeds PNG data at multiple sizes.
 */
const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

async function createIco() {
  const input = path.join(__dirname, '..', 'resources', 'icon.png')
  const output = path.join(__dirname, '..', 'resources', 'icon.ico')

  const sizes = [16, 32, 48, 64, 128, 256]
  const buffers = []
  for (const size of sizes) {
    const buf = await sharp(input).resize(size, size).png().toBuffer()
    buffers.push(buf)
  }

  const numImages = buffers.length
  const headerSize = 6 + numImages * 16
  let offset = headerSize

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)    // reserved
  header.writeUInt16LE(1, 2)    // type: 1 = ICO
  header.writeUInt16LE(numImages, 4)

  const entries = []
  for (let i = 0; i < numImages; i++) {
    const entry = Buffer.alloc(16)
    const s = sizes[i]
    entry.writeUInt8(s === 256 ? 0 : s, 0)   // width (0 = 256)
    entry.writeUInt8(s === 256 ? 0 : s, 1)   // height
    entry.writeUInt8(0, 2)    // color palette
    entry.writeUInt8(0, 3)    // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(buffers[i].length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += buffers[i].length
    entries.push(entry)
  }

  const ico = Buffer.concat([header, ...entries, ...buffers])
  fs.writeFileSync(output, ico)
  console.log(`Created ${output} (${ico.length} bytes, ${numImages} sizes)`)
}

createIco().catch(err => {
  console.error('Failed to create ICO:', err)
  process.exit(1)
})
