import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAll } from '../src/lib/pagination.ts'

test('paginación conserva todos los resultados de 1.001 ideas y sus seis áreas', async () => {
  const expected = Array.from({ length: 1001 * 6 }, (_, index) => ({ idea: Math.floor(index / 6), area: index % 6 + 1 }))
  const calls = []
  const actual = await fetchAll(async (start, end) => {
    calls.push([start, end])
    return { data: expected.slice(start, end + 1), error: null }
  })
  assert.deepEqual(actual, expected)
  assert.equal(calls.length, 13)
  assert.ok(calls.every(([start, end]) => end - start + 1 <= 500))
})
test('una página fallida no se convierte en resultados parciales ni ceros', async () => {
  await assert.rejects(fetchAll(async start => start === 0
    ? { data: new Array(500).fill({}), error: null }
    : { data: null, error: new Error('Sin conexión') }), /Sin conexión/)
})
