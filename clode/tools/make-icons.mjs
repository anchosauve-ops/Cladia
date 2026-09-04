// Generates clode's icons: a "c" (a ring with a gap) on dark indigo. Run: node tools/make-icons.mjs
import { writeFileSync } from 'node:fs'
import { encodePNG } from '../../opencode-pager/src/icons.js'
const BG = [11, 15, 26], FG = [129, 140, 248], DOT = [45, 212, 191]
function icon(size, maskable) {
  const px = Buffer.alloc(size * size * 4)
  const c = size / 2, scale = maskable ? 0.78 : 1
  const R = size * 0.30 * scale, W = size * 0.11 * scale
  const radius = maskable ? size : size * 0.22
  const cov = (d) => Math.max(0, Math.min(1, 0.5 - d))
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = x + 0.5 - c, fy = y + 0.5 - c
    const qx = Math.abs(fx) - (c - radius), qy = Math.abs(fy) - (c - radius)
    const dBox = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
    const aBox = maskable ? 1 : cov(dBox)
    const r = Math.hypot(fx, fy), ang = Math.atan2(fy, fx) // 0 = right
    const gap = Math.abs(ang) < 0.62 // opening on the right, like a "c"
    const dRing = Math.abs(r - R) - W / 2
    // round the ring ends
    const endA = [R * Math.cos(0.62), R * Math.sin(0.62)], endB = [R * Math.cos(-0.62), R * Math.sin(-0.62)]
    const dEnds = Math.min(Math.hypot(fx - endA[0], fy - endA[1]), Math.hypot(fx - endB[0], fy - endB[1])) - W / 2
    const aRing = Math.max(gap ? 0 : cov(dRing), cov(dEnds))
    const dDot = Math.hypot(fx - R * 1.02, fy) - W * 0.42
    const aDot = cov(dDot)
    let [rr, gg, bb] = BG
    rr += (FG[0] - rr) * aRing; gg += (FG[1] - gg) * aRing; bb += (FG[2] - bb) * aRing
    rr += (DOT[0] - rr) * aDot; gg += (DOT[1] - gg) * aDot; bb += (DOT[2] - bb) * aDot
    const i = (y * size + x) * 4
    px[i] = rr; px[i + 1] = gg; px[i + 2] = bb; px[i + 3] = Math.round(255 * aBox)
  }
  return encodePNG(size, size, px)
}
const dir = new URL('../', import.meta.url).pathname
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-192-maskable.png', 192, true], ['icon-512-maskable.png', 512, true]]) writeFileSync(dir + name, icon(size, maskable))
writeFileSync(dir + 'icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0b0f1a"/><path d="M 67.4 32.6 A 30 30 0 1 0 67.4 67.4" fill="none" stroke="#818cf8" stroke-width="11" stroke-linecap="round"/><circle cx="80.6" cy="50" r="4.6" fill="#2dd4bf"/></svg>`)
console.log('icons written')
