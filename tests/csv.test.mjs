import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AREAS, buildCsv, csvCell } from '../src/lib/workshop.ts'

test('CSV escapa comillas, saltos de línea y fórmulas', () => {
  assert.equal(csvCell('Una "idea",\nsegunda línea'), '"Una ""idea"",\nsegunda línea"')
  for (const value of ['=1+2', '+SUM(1)', '-2', '@SUM(1)', ' \t=1']) assert.ok(csvCell(value).startsWith('"\''))
})
test('CSV de resultados incluye las siete áreas, ceros, total y organizador', () => {
  const snapshot = {
    ideas: [{ id: 'id1', content: 'Idea', author_id: 'team', organizer: true }],
    progress: [], results: [{ idea_id: 'id1', area_id: 2, votes: 3, total: 3 }],
  }
  const csv = buildCsv(snapshot, true)
  for (const area of AREAS) assert.ok(csv.includes(area))
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes('Equipo organizador'))
  assert.ok(csv.endsWith('"0","3","0","0","0","0","0","3"'))
})
