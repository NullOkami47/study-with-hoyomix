import type { D1Database, D1PreparedStatement, D1ReadValue, D1WriteValue, Env } from './env'

export type Database = D1Database
export type DatabaseStatement = D1PreparedStatement
export type DatabaseReadValue = D1ReadValue
export type DatabaseWriteValue = D1WriteValue
export type DatabaseBindings = Pick<Env, 'DB'>
