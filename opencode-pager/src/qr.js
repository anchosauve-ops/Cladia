// QR code encoder (ISO/IEC 18004), byte mode, versions 1-40, all four error-correction levels.
// Zero dependencies. Verified against python-qrcode fixtures in test/qr.test.js.
//
// encode(text, { ecl }) -> { size, modules: Uint8Array[size*size] (1 = dark), version, mask }
// toTerminal(qr) -> string using ANSI colours and half-block characters (two rows per line)
// toSVG(qr, { scale, margin }) -> string

const ECL = { L: 1, M: 0, Q: 3, H: 2 } // format-info bits

// Indexed by version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
}
const NUM_ERROR_CORRECTION_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
}

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function numDataCodewords(ver, ecl) {
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
}

function alignmentPositions(ver) {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const size = ver * 4 + 17
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

// --- Reed-Solomon over GF(2^8) with primitive polynomial 0x11D ---
function gfMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}
function rsGenerator(degree) {
  const result = new Uint8Array(degree)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return result
}
function rsRemainder(data, gen) {
  const result = new Uint8Array(gen.length)
  for (const b of data) {
    const factor = b ^ result[0]
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let i = 0; i < gen.length; i++) result[i] ^= gfMul(gen[i], factor)
  }
  return result
}

// --- Bit buffer ---
class Bits {
  constructor() { this.bits = [] }
  push(val, len) { for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1) }
  get length() { return this.bits.length }
}

export function encode(text, opts = {}) {
  const ecl = opts.ecl || 'M'
  if (!(ecl in ECL)) throw new Error('bad ecl')
  const data = typeof text === 'string' ? new TextEncoder().encode(text) : new Uint8Array(text)
  // choose smallest version
  let version = -1
  for (let v = 1; v <= 40; v++) {
    const cci = v <= 9 ? 8 : 16
    const needed = 4 + cci + data.length * 8
    if (needed <= numDataCodewords(v, ecl) * 8) { version = v; break }
  }
  if (version < 0) throw new Error('data too long for QR (max 2953 bytes at level L)')
  const cci = version <= 9 ? 8 : 16
  const bb = new Bits()
  bb.push(0b0100, 4)
  bb.push(data.length, cci)
  for (const b of data) bb.push(b, 8)
  const capBits = numDataCodewords(version, ecl) * 8
  bb.push(0, Math.min(4, capBits - bb.length))
  while (bb.length % 8 !== 0) bb.push(0, 1)
  for (let pad = 0xec; bb.length < capBits; pad ^= 0xec ^ 0x11) bb.push(pad, 8)
  const dataCodewords = new Uint8Array(bb.length / 8)
  bb.bits.forEach((bit, i) => { dataCodewords[i >>> 3] |= bit << (7 - (i & 7)) })

  // split into blocks, compute ECC, interleave
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][version]
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version]
  const rawCodewords = Math.floor(numRawDataModules(version) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const blocks = []
  const gen = rsGenerator(blockEccLen)
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1)
    const dat = dataCodewords.slice(k, k + datLen)
    k += datLen
    const ecc = rsRemainder(dat, gen)
    const block = new Uint8Array(shortBlockLen + 1)
    block.set(dat)
    if (i < numShortBlocks) block[shortBlockLen - blockEccLen] = 0 // placeholder, skipped below
    block.set(ecc, shortBlockLen + 1 - blockEccLen)
    blocks.push({ block, datLen })
  }
  const result = []
  for (let i = 0; i < blocks[0].block.length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(b.block[i])
    })
  }
  const allCodewords = new Uint8Array(result)

  // build matrix
  const size = version * 4 + 17
  const modules = new Uint8Array(size * size)
  const isFunction = new Uint8Array(size * size)
  const set = (x, y, dark) => { modules[y * size + x] = dark ? 1 : 0; isFunction[y * size + x] = 1 }

  drawFunctionPatterns(version, size, ecl, 0, set)
  drawCodewords(allCodewords, version, size, modules, isFunction)

  // choose mask by penalty
  let best = -1, bestPenalty = Infinity, bestModules = null
  for (let m = 0; m < 8; m++) {
    const trial = new Uint8Array(modules)
    applyMask(trial, isFunction, size, m)
    drawFormatBits(ecl, m, size, trial)
    const p = penalty(trial, size)
    if (p < bestPenalty) { bestPenalty = p; best = m; bestModules = trial }
  }
  if (opts.mask !== undefined) {
    best = opts.mask
    bestModules = new Uint8Array(modules)
    applyMask(bestModules, isFunction, size, best)
    drawFormatBits(ecl, best, size, bestModules)
  }
  return { size, modules: bestModules, version, mask: best, ecl }
}

function drawFunctionPatterns(version, size, ecl, mask, set) {
  // timing
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  // finders
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      const x = cx + dx, y = cy + dy
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4)
    }
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4)
  // alignment
  const ap = alignmentPositions(version)
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }
  // format bits (placeholders, real values drawn per mask) -- mark as function modules
  const fmtSet = (x, y) => set(x, y, false)
  for (let i = 0; i <= 5; i++) fmtSet(8, i)
  fmtSet(8, 7); fmtSet(8, 8); fmtSet(7, 8)
  for (let i = 9; i < 15; i++) fmtSet(14 - i, 8)
  for (let i = 0; i < 8; i++) fmtSet(size - 1 - i, 8)
  for (let i = 8; i < 15; i++) fmtSet(8, size - 15 + i)
  set(8, size - 8, true) // dark module
  // version info
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1
      const a = size - 11 + (i % 3), b = Math.floor(i / 3)
      set(a, b, bit); set(b, a, bit)
    }
  }
}

function drawFormatBits(ecl, mask, size, modules) {
  const data = (ECL[ecl] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  const set = (x, y, dark) => { modules[y * size + x] = dark ? 1 : 0 }
  const bit = (i) => ((bits >>> i) & 1) === 1
  for (let i = 0; i <= 5; i++) set(8, i, bit(i))
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
  set(8, size - 8, true)
}

function drawCodewords(cw, version, size, modules, isFunction) {
  let i = 0
  const total = cw.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFunction[y * size + x] && i < total) {
          modules[y * size + x] = (cw[i >>> 3] >>> (7 - (i & 7))) & 1
          i++
        }
      }
    }
  }
}

function applyMask(modules, isFunction, size, mask) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let invert
    switch (mask) {
      case 0: invert = (x + y) % 2 === 0; break
      case 1: invert = y % 2 === 0; break
      case 2: invert = x % 3 === 0; break
      case 3: invert = (x + y) % 3 === 0; break
      case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
      case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break
      case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break
      case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break
    }
    if (!isFunction[y * size + x] && invert) modules[y * size + x] ^= 1
  }
}

function penalty(m, size) {
  const N1 = 3, N2 = 3, N3 = 40, N4 = 10
  let result = 0
  const get = (x, y) => m[y * size + x] === 1
  const finderPenalty = (hist) => {
    const n = hist[1]
    const core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n
    return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) + (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0)
  }
  const addHist = (hist, len) => { if (hist[0] === 0) len += size; hist.shift(); hist.push(len); return hist }
  // rows
  for (let y = 0; y < size; y++) {
    let runColor = false, runX = 0
    let hist = [0, 0, 0, 0, 0, 0, 0]
    for (let x = 0; x < size; x++) {
      if (get(x, y) === runColor) {
        runX++
        if (runX === 5) result += N1
        else if (runX > 5) result++
      } else {
        hist = addHist(hist, runX)
        if (!runColor) result += finderPenalty(hist) * N3
        runColor = get(x, y)
        runX = 1
      }
    }
    // terminate
    if (runColor) { hist = addHist(hist, runX); runX = 0 }
    runX += size
    hist = addHist(hist, runX)
    result += finderPenalty(hist) * N3
  }
  // columns
  for (let x = 0; x < size; x++) {
    let runColor = false, runY = 0
    let hist = [0, 0, 0, 0, 0, 0, 0]
    for (let y = 0; y < size; y++) {
      if (get(x, y) === runColor) {
        runY++
        if (runY === 5) result += N1
        else if (runY > 5) result++
      } else {
        hist = addHist(hist, runY)
        if (!runColor) result += finderPenalty(hist) * N3
        runColor = get(x, y)
        runY = 1
      }
    }
    if (runColor) { hist = addHist(hist, runY); runY = 0 }
    runY += size
    hist = addHist(hist, runY)
    result += finderPenalty(hist) * N3
  }
  // 2x2 blocks
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = get(x, y)
    if (c === get(x + 1, y) && c === get(x, y + 1) && c === get(x + 1, y + 1)) result += N2
  }
  // balance
  let dark = 0
  for (const v of m) dark += v
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  result += k * N4
  return result
}

export function toMatrix(qr) {
  const rows = []
  for (let y = 0; y < qr.size; y++) rows.push(Array.from(qr.modules.subarray(y * qr.size, (y + 1) * qr.size)))
  return rows
}

// Two modules per character row using half blocks; light modules are white, dark are black,
// with explicit colours so it reads on any terminal background.
export function toTerminal(qr, opts = {}) {
  const margin = opts.margin ?? 2
  const size = qr.size + margin * 2
  const at = (x, y) => {
    const qx = x - margin, qy = y - margin
    if (qx < 0 || qy < 0 || qx >= qr.size || qy >= qr.size) return 0
    return qr.modules[qy * qr.size + qx]
  }
  const lines = []
  for (let y = 0; y < size; y += 2) {
    let line = '\x1b[37;40m'
    for (let x = 0; x < size; x++) {
      const top = at(x, y), bot = y + 1 < size ? at(x, y + 1) : 0
      line += top ? (bot ? ' ' : '▄') : (bot ? '▀' : '█')
    }
    lines.push(line + '\x1b[0m')
  }
  return lines.join('\n')
}

export function toSVG(qr, opts = {}) {
  const margin = opts.margin ?? 4
  const scale = opts.scale ?? 4
  const size = (qr.size + margin * 2) * scale
  let path = ''
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
    if (qr.modules[y * qr.size + x]) path += `M${(x + margin) * scale} ${(y + margin) * scale}h${scale}v${scale}h-${scale}z`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}
