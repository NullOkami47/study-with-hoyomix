export type D1ReadValue = ArrayBuffer | null | number | string
export type D1WriteValue = ArrayBuffer | ArrayBufferView | boolean | null | number | string

export interface D1Meta {
  duration: number
  size_after: number
  rows_read: number
  rows_written: number
  last_row_id: number
  changed_db: boolean
  changes: number
  served_by_region?: string
  served_by_primary?: boolean
  timings?: { sql_duration_ms: number }
  total_attempts?: number
}

export interface D1Result<T = Record<string, D1ReadValue>> {
  success: true
  meta: D1Meta & Record<string, unknown>
  results: T[]
  error?: never
}

export interface D1PreparedStatement {
  bind(...values: D1WriteValue[]): D1PreparedStatement
  first<T = D1ReadValue>(column: string): Promise<T | null>
  first<T = Record<string, D1ReadValue>>(): Promise<T | null>
  run<T = Record<string, D1ReadValue>>(): Promise<D1Result<T>>
  all<T = Record<string, D1ReadValue>>(): Promise<D1Result<T>>
  raw<T extends D1ReadValue[] = D1ReadValue[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
  raw<T extends D1ReadValue[] = D1ReadValue[]>(options?: { columnNames?: false }): Promise<T[]>
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = Record<string, D1ReadValue>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(query: string): Promise<{ count: number; duration: number }>
}

export interface Env {
  DB: D1Database
}
