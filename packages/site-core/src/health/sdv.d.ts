/**
 * WP448：`@adobe/structured-data-validator`（Apache-2.0）没带类型——只声明我们用到的那一点。
 * 只在 `tech-audit.ts` 里按需 `import()`，不进公开签名。
 */
declare module '@adobe/structured-data-validator' {
  export default class Validator {
    constructor(schemaOrgJson?: unknown)
    validate(data: unknown): Promise<
      {
        issueMessage?: string
        severity?: string
        rootType?: string
        fieldNames?: string[]
      }[]
    >
  }
}
