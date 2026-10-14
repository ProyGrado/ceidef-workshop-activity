import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AREAS, IDEA_FIELDS, buildCsv, csvCell } from '../src/lib/workshop.ts'

test('CSV escapa comillas, saltos de línea y fórmulas', () => {
  assert.equal(csvCell('Una "idea",\nsegunda línea'), '"Una ""idea"",\nsegunda línea"')
  for (const value of ['=1+2', '+SUM(1)', '-2', '@SUM(1)', ' \t=1']) assert.ok(csvCell(value).startsWith('"\''))
})
test('CSV incluye seis áreas, ceros, respuestas sin áreas, total y organizador', () => {
  const snapshot = {
    ideas: [{ id: 'id1', title: 'Idea predeterminada', preset: true, position: 'Farmacia', task: 'Idea', information: 'Historia clínica', supervisor: 'Equipo clínico', boundaries: 'No prescribir', success_criteria: 'Menos errores', author_id: null, organizer: true }],
    progress: [], results: [{ idea_id: 'id1', area_id: 2, votes: 3, total: 5, no_area: 2 }],
  }
  const csv = buildCsv(snapshot, true)
  for (const area of AREAS) assert.ok(csv.includes(area))
  for (const field of IDEA_FIELDS) assert.ok(csv.includes(field.label))
  for (const field of IDEA_FIELDS) assert.ok(csv.includes(snapshot.ideas[0][field.key]))
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes('Equipo organizador'))
  assert.ok(csv.includes('Título'))
  assert.ok(csv.includes('Idea predeterminada'))
  assert.ok(csv.includes('Sin áreas'))
  assert.ok(csv.includes('Visibilidad'))
  assert.ok(csv.includes('Visible'))
  const archived = buildCsv({ ...snapshot, hiddenIdeaIds: ['id1'] }, true)
  assert.ok(archived.includes('Oculta'))
  assert.ok(archived.endsWith('"0","3","0","0","0","0","2","5"'))
  assert.ok(!csv.includes('Transversal'))
  assert.ok(csv.endsWith('"0","3","0","0","0","0","2","5"'))
})
