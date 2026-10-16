import type { D1PreparedStatement } from '../env'

declare const statement: D1PreparedStatement

async function assertD1PreparedStatementContract() {
  const first: { id: string } | null = await statement.first<{ id: string }>()
  const rows: Array<[string, number]> = await statement.raw<[string, number]>()
  const rowsWithColumns: [string[], ...Array<[string, number]>] = await statement.raw<
    [string, number]
  >({ columnNames: true })

  statement.bind(true, new Uint8Array([1, 2, 3]))

  return { first, rows, rowsWithColumns }
}

void assertD1PreparedStatementContract
