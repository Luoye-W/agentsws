import type { ErrorCode } from '@agentsws/contracts'

/** 模拟回路统一错误（28 §2 的错误码，不自造同义码）。 */
export class SimulationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'SimulationError'
  }
}

/** 场景文件的 schema 错误：带文件与字段路径，报错能指到那一行的键。 */
export class ScenarioSchemaError extends SimulationError {
  constructor(
    readonly source: string,
    readonly path: string,
    message: string,
  ) {
    super('invalid_input', `${source}${path ? ` @ ${path}` : ''}: ${message}`)
    this.name = 'ScenarioSchemaError'
  }
}
