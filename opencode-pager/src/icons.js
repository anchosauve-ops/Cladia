// App icons generated at runtime so the package ships no binary files.
// A ring with a notification dot: the pager is ringing. PNG via zlib, no dependencies.

import { deflateSync } from 'node:zlib'

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

export function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const BG = [15, 23, 42] // slate-900
const RING = [226, 232, 240] // slate-200
const DOT = [245, 158, 11] // amber-500

/** Render the icon at `size` px. `maskable` adds safe-zone padding for Android adaptive icons. */
export function iconPNG(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4)
  const c = size / 2
  const radius = maskable ? size : size * 0.22 // rounded-square corner radius (full = square for maskable)
  const scale = maskable ? 0.8 : 1
  const ringR = size * 0.30 * scale, ringW = size * 0.085 * scale
  const dotX = c + size * 0.24 * scale, dotY = c - size * 0.24 * scale, dotR = size * 0.115 * scale
  const aa = 1.0
  const coverage = (d) => Math.max(0, Math.min(1, 0.5 - d / aa))
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = x + 0.5, fy = y + 0.5
    // rounded square SDF
    const qx = Math.abs(fx - c) - (c - radius), qy = Math.abs(fy - c) - (c - radius)
    const dBox = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
    const aBox = maskable ? 1 : coverage(dBox)
    const dr = Math.abs(Math.hypot(fx - c, fy - c) - ringR) - ringW / 2
    const dd = Math.hypot(fx - dotX, fy - dotY) - dotR
    const dCut = Math.hypot(fx - dotX, fy - dotY) - (dotR + ringW * 0.9) // gap between dot and ring
    let r = BG[0], g = BG[1], b = BG[2]
    const aRing = coverage(dr) * (1 - coverage(dCut))
    r = r + (RING[0] - r) * aRing; g = g + (RING[1] - g) * aRing; b = b + (RING[2] - b) * aRing
    const aDot = coverage(dd)
    r = r + (DOT[0] - r) * aDot; g = g + (DOT[1] - g) * aDot; b = b + (DOT[2] - b) * aDot
    const i = (y * size + x) * 4
    px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b); px[i + 3] = Math.round(255 * aBox)
  }
  return encodePNG(size, size, px)
}

export function iconSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0f172a"/><circle cx="50" cy="50" r="30" fill="none" stroke="#e2e8f0" stroke-width="8.5"/><circle cx="74" cy="26" r="16" fill="#0f172a"/><circle cx="74" cy="26" r="11.5" fill="#f59e0b"/></svg>`
}
