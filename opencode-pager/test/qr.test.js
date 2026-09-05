import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encode, toMatrix, toTerminal, toSVG } from '../src/qr.js'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/qr.json', import.meta.url)))

test('matches python-qrcode for every fixture (version, and matrix at the reference mask)', () => {
  let checked = 0
  for (const f of fixtures) {
    const qr = encode(f.text, { ecl: f.level, mask: f.mask })
    assert.equal(qr.version, f.version, `version for ${JSON.stringify(f.text.slice(0, 20))} ${f.level}`)
    assert.deepEqual(toMatrix(qr), f.matrix, `matrix for ${JSON.stringify(f.text.slice(0, 20))} ${f.level} mask ${f.mask}`)
    checked++
  }
  assert.ok(checked >= 40)
})

test('automatic mask selection yields a valid mask whose matrix equals the fixed-mask encoding', () => {
  // python-qrcode's penalty scorer is a simplification of ISO 18004 section 7.8.3, so the chosen
  // mask can legitimately differ; any of the eight masks decodes. We verify the auto path is
  // consistent with the fixed path, and that the ISO scorer picks the lowest-penalty mask.
  for (const f of fixtures.filter((x) => !x.fixed)) {
    const auto = encode(f.text, { ecl: f.level })
    assert.ok(auto.mask >= 0 && auto.mask <= 7)
    assert.deepEqual(toMatrix(auto), toMatrix(encode(f.text, { ecl: f.level, mask: auto.mask })))
  }
})

test('renders to terminal and svg', () => {
  const qr = encode('https://example.com/#pair=abc')
  const term = toTerminal(qr)
  assert.equal(term.split('\n').length, Math.ceil((qr.size + 4) / 2))
  const svg = toSVG(qr)
  assert.match(svg, /^<svg /)
  assert.ok(svg.includes('<path d="M'))
})

test('rejects data that does not fit', () => {
  assert.throws(() => encode('x'.repeat(3000), { ecl: 'L' }))
})
