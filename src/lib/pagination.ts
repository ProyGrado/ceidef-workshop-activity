// Cada consulta permanece por debajo del límite habitual de la Data API.
// Necesario para 1.000 ideas y sus 6.000 filas de resultados (más organizadores).
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const rows: T[] = []
  const pageSize = 500
  for (let start = 0; ; start += pageSize) {
    const response = await page(start, start + pageSize - 1)
    if (response.error) throw response.error
    const batch = (response.data ?? []) as T[]
    rows.push(...batch)
    if (batch.length < pageSize) return rows
  }
}
