/**
 * WP164：云端对外契约（`packages/contracts/cloud-openapi.json`）的生成器本体。
 *
 * **真源是 TypeScript 类型，不是这份 JSON**（docs/83 §2 第 1 条）：
 * `packages/contracts/src/cloud-api.ts` 里的 `CloudApi` 接口是一张路由表——
 * 每个键是 `'METHOD /path'`，值里的 `body` / `ok.body` / `query` … 直接引用
 * 契约里的真类型。这里用 TypeScript 编译器 API 把那张表读出来、把引用到的
 * 类型转成 JSON Schema，拼成一份 OpenAPI 3.1。
 *
 * 为什么自己转而不引一个 `ts-json-schema-generator`：
 * 1. 不加依赖（锁文件与并行的几单不打架）；`typescript` 本来就是根的开发依赖，
 *    `gen-ontology.mjs` 也是这么读契约的；
 * 2. 契约里用到的 TS 写法就那几样（接口、字面量联合、`Record`、数组、可选、
 *    泛型信封），两百行转得完，出来的 schema 形状我们自己说了算。
 *
 * 命名类型（契约里 `export` 的接口 / 类型别名，且不带泛型实参）进
 * `components.schemas`，引用处用 `$ref`；泛型实例（`CloudOkEnvelope<X>`）
 * 与匿名对象就地展开。
 */
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'

/** 契约入口文件（路由表所在）。 */
export const CLOUD_API_SOURCE = 'packages/contracts/src/cloud-api.ts'
/** 生成物。 */
export const CLOUD_CONTRACT_OUT = 'packages/contracts/cloud-openapi.json'

/** JSDoc → 第一段（summary 用第一行，description 用其余）。 */
function docOf(ts, checker, symbol) {
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
  return text
}

/** 一段注释只取第一段（空行之前），给属性的 description 用：再长就是讲道理了。 */
function firstParagraph(text) {
  const para = text.split(/\n\s*\n/)[0] ?? ''
  return para.replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * 类型 → JSON Schema 的转换器。
 *
 * `components` 是出参：遇到命名类型就登记一份，返回 `$ref`。
 */
export function createSchemaConverter(ts, checker, { isOwnDeclaration }) {
  const components = new Map()
  /** 正在转的命名类型（防递归：先占位再填）。 */
  const inProgress = new Set()

  const nameOf = (type) => {
    // 泛型实例不当命名类型：`CloudOkEnvelope<X>` 每个 X 形状都不同
    if (type.aliasSymbol !== undefined) {
      if ((type.aliasTypeArguments?.length ?? 0) > 0) return undefined
      const decl = type.aliasSymbol.declarations?.[0]
      return decl !== undefined && isOwnDeclaration(decl) ? type.aliasSymbol.name : undefined
    }
    const symbol = type.symbol
    if (symbol === undefined) return undefined
    if ((symbol.flags & ts.SymbolFlags.Interface) === 0) return undefined
    if ((type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
      if ((type.typeArguments?.length ?? 0) > 0) return undefined
    }
    const decl = symbol.declarations?.[0]
    if (decl === undefined || !isOwnDeclaration(decl)) return undefined
    if ((decl.typeParameters?.length ?? 0) > 0) return undefined
    return symbol.name
  }

  /**
   * 字面量联合按**源码里写的顺序**出 enum：编译器内部的顺序取决于字面量类型
   * 第一次被创建的时机，别处多写一个类型就可能变，`--check` 会无故红。
   */
  const orderHint = (node) => {
    if (node === undefined || !ts.isUnionTypeNode(node)) return undefined
    return node.types.map((n) =>
      ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal) ? n.literal.text : undefined,
    )
  }
  const hintOfAlias = (type) => {
    const decl = type.aliasSymbol?.declarations?.[0]
    return decl !== undefined && ts.isTypeAliasDeclaration(decl) ? orderHint(decl.type) : undefined
  }

  const convert = (type, hint) => {
    const name = nameOf(type)
    if (name !== undefined) {
      if (!components.has(name) && !inProgress.has(name)) {
        inProgress.add(name)
        const schema = convertStructure(type, hintOfAlias(type))
        const doc = firstParagraph(docOf(ts, checker, type.aliasSymbol ?? type.symbol))
        components.set(name, doc === '' ? schema : { ...schema, description: doc })
        inProgress.delete(name)
      }
      return { $ref: `#/components/schemas/${name}` }
    }
    return convertStructure(type, hint ?? hintOfAlias(type))
  }

  const convertStructure = (type, hint) => {
    const f = type.flags
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {}
    if (f & ts.TypeFlags.String) return { type: 'string' }
    if (f & ts.TypeFlags.Number) return { type: 'number' }
    if (f & ts.TypeFlags.Boolean) return { type: 'boolean' }
    if (f & ts.TypeFlags.Null) return { type: 'null' }
    if (f & ts.TypeFlags.TemplateLiteral) return { type: 'string' }
    if (f & ts.TypeFlags.StringLiteral) return { type: 'string', const: type.value }
    if (f & ts.TypeFlags.NumberLiteral) return { type: 'number', const: type.value }
    if (f & ts.TypeFlags.BooleanLiteral)
      return { type: 'boolean', const: checker.typeToString(type) === 'true' }
    if (type.isUnion()) return convertUnion(type, hint)
    if (type.isIntersection()) return convertObject(type)
    if (checker.isTupleType(type)) {
      const items = checker.getTypeArguments(type).map(convert)
      return { type: 'array', prefixItems: items, minItems: items.length, maxItems: items.length }
    }
    if (checker.isArrayType(type)) {
      const [item] = checker.getTypeArguments(type)
      return { type: 'array', items: item === undefined ? {} : convert(item) }
    }
    if (f & ts.TypeFlags.Object) return convertObject(type)
    throw new Error(`cloud-contract: 转不了的类型 ${checker.typeToString(type)}`)
  }

  const convertUnion = (type, hint) => {
    const members = type.types.filter((t) => (t.flags & ts.TypeFlags.Undefined) === 0)
    const bools = members.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral)
    const rest = members.filter((t) => (t.flags & ts.TypeFlags.BooleanLiteral) === 0)
    const parts = []
    if (bools.length === 2) parts.push({ type: 'boolean' })
    else for (const b of bools) parts.push(convert(b))
    const rank = (v) => {
      const i = hint?.indexOf(v) ?? -1
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    const strings = rest
      .filter((t) => t.flags & ts.TypeFlags.StringLiteral)
      .sort((a, b) => rank(a.value) - rank(b.value))
    const numbers = rest.filter((t) => t.flags & ts.TypeFlags.NumberLiteral)
    const others = rest.filter(
      (t) => (t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)) === 0,
    )
    if (strings.length > 0) parts.push({ type: 'string', enum: strings.map((t) => t.value) })
    if (numbers.length > 0) parts.push({ type: 'number', enum: numbers.map((t) => t.value) })
    for (const t of others) parts.push(convert(t))
    if (parts.length === 1) return parts[0]
    return { anyOf: parts }
  }

  /**
   * 可选属性的类型在 `exactOptionalPropertyTypes` 下会被并上一个"缺席"成员，
   * 别名因此丢掉（`block?: PricingBlock` 会被就地展开）。声明里写的就是一个
   * 别名时，直接用声明节点上的那个类型——泛型参数（`data: T`）不走这条。
   */
  const declaredTypeOf = (prop) => {
    const actual = checker.getTypeOfSymbol(prop)
    const node = prop.valueDeclaration?.type
    if ((prop.flags & ts.SymbolFlags.Optional) === 0 || node === undefined) return actual
    if (!ts.isTypeReferenceNode(node) || (node.typeArguments?.length ?? 0) > 0) return actual
    const declared = checker.getTypeFromTypeNode(node)
    if (declared.flags & ts.TypeFlags.TypeParameter) return actual
    return declared
  }

  const convertObject = (type) => {
    const properties = {}
    const required = []
    for (const prop of checker.getPropertiesOfType(type)) {
      const propType = declaredTypeOf(prop)
      // 方法不进 schema（契约里的端口接口不会被引用到这里，保险起见）
      if (propType.getCallSignatures().length > 0 && (propType.flags & ts.TypeFlags.Object) !== 0)
        continue
      const schema = convert(propType, orderHint(prop.valueDeclaration?.type))
      const doc = firstParagraph(docOf(ts, checker, prop))
      properties[prop.name] =
        doc === '' || schema.$ref !== undefined ? schema : { ...schema, description: doc }
      if ((prop.flags & ts.SymbolFlags.Optional) === 0) required.push(prop.name)
    }
    const out = { type: 'object', properties }
    if (required.length > 0) out.required = required
    const index = checker
      .getIndexInfosOfType(type)
      .find((info) => info.keyType.flags & ts.TypeFlags.String)
    if (index !== undefined) out.additionalProperties = convert(index.type)
    return out
  }

  return { convert, components }
}

/** 建一个只含契约包源码的 TypeScript 程序（不读 dist，不用先 `tsc -b`）。 */
export function loadCloudApiProgram(root) {
  /** @type {typeof import('typescript')} */
  const ts = createRequire(join(root, 'package.json'))('typescript')
  const entry = join(root, CLOUD_API_SOURCE)
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: true,
  })
  const contractsDir = join(root, 'packages/contracts/src') + sep
  const isOwnDeclaration = (decl) => decl.getSourceFile().fileName.startsWith(contractsDir)
  return { ts, program, entry, isOwnDeclaration, rel: (p) => relative(root, p) }
}

/**
 * 鉴权档 → OpenAPI 的 securityScheme。名字与 `CloudApiAuth` 的成员一一对上；
 * 多一档就在这里多写一行（漏了会在生成时抛）。
 */
export const SECURITY_SCHEMES = {
  session: {
    type: 'http',
    scheme: 'bearer',
    description: '云账号会话（`cs_…`，magic link 验过之后拿到）。只管账号与关联。',
  },
  workspace_token: {
    type: 'http',
    scheme: 'bearer',
    description:
      '工作区服务令牌（`wst_…`）。每条路由按 `x-scope` 查动作集，差一个就 403；撤销立刻生效。托管实例那把（`wst_hosted_…`）也走这一档。',
  },
  plugin_token: {
    type: 'http',
    scheme: 'bearer',
    description: '浏览器插件令牌（`plg_…`，插件配对时签）。只认插件上报那几条。',
  },
  hosted_instance: {
    type: 'http',
    scheme: 'bearer',
    description: '托管实例容器自己的令牌（`wst_hosted_…`）：推 / 拉快照用。',
  },
  visitor: {
    type: 'http',
    scheme: 'bearer',
    description: '聊天转发访客令牌（开会话时签，只认这一个工作区的这一个会话）。',
  },
}

/** `'POST /v1/x/{id}'` → `postV1XId`。 */
function operationIdOf(method, path) {
  const words = path
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w[0].toUpperCase() + w.slice(1))
  return `${method.toLowerCase()}${words.join('')}`
}

/** 读一个对象类型上某个属性的类型；没有就 `undefined`。 */
function fieldOf(checker, type, name) {
  const prop = checker.getPropertyOfType(type, name)
  return prop === undefined ? undefined : checker.getTypeOfSymbol(prop)
}

function literalOf(ts, checker, type, name) {
  const t = fieldOf(checker, type, name)
  if (t === undefined) return undefined
  if (t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)) return t.value
  throw new Error(`cloud-contract: ${name} 必须是字面量（现在是 ${checker.typeToString(t)}）`)
}

const CONTENT_TYPES = {
  json: 'application/json',
  sse: 'text/event-stream',
  html: 'text/html',
  javascript: 'text/javascript',
  text: 'text/plain',
  zip: 'application/zip',
}

/** 生成整份文档。`version` 取根 package.json。 */
export function buildCloudContract(root, version) {
  const { ts, program, entry, isOwnDeclaration } = loadCloudApiProgram(root)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) {
    const text = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    })
    throw new Error(`cloud-contract: 契约编译不过\n${text}`)
  }
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entry)
  const moduleSymbol = checker.getSymbolAtLocation(source)
  const apiSymbol = checker.getExportsOfModule(moduleSymbol).find((s) => s.name === 'CloudApi')
  if (apiSymbol === undefined) throw new Error('cloud-contract: cloud-api.ts 没导出 CloudApi')
  const apiType = checker.getDeclaredTypeOfSymbol(apiSymbol)
  const { convert, components } = createSchemaConverter(ts, checker, { isOwnDeclaration })

  const paramsOf = (opType, field, where) => {
    const t = fieldOf(checker, opType, field)
    if (t === undefined) return []
    return checker.getPropertiesOfType(t).map((p) => {
      const doc = firstParagraph(docOf(ts, checker, p))
      return {
        name: p.name,
        in: where,
        required: where === 'path' || (p.flags & ts.SymbolFlags.Optional) === 0,
        ...(doc === '' ? {} : { description: doc }),
        schema: convert(checker.getTypeOfSymbol(p)),
      }
    })
  }

  /** 二进制正文（快照 zip）不从类型转：TS 那边写 `unknown`，契约里就是一串字节。 */
  const schemaFor = (type, content) =>
    content === 'zip' ? { type: 'string', format: 'binary' } : convert(type)

  const paths = {}
  const tags = new Set()
  for (const prop of checker.getPropertiesOfType(apiType)) {
    const m = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(prop.name)
    if (m === null) throw new Error(`cloud-contract: 键要写成 'METHOD /path'：${prop.name}`)
    const [, method, path] = m
    const op = checker.getTypeOfSymbol(prop)
    const doc = docOf(ts, checker, prop)
    const [summary, ...rest] = doc.split('\n')
    const auth = literalOf(ts, checker, op, 'auth')
    if (auth !== 'public' && SECURITY_SCHEMES[auth] === undefined)
      throw new Error(`cloud-contract: ${prop.name} 的 auth 不认识：${auth}`)
    const scope = literalOf(ts, checker, op, 'scope')
    const tag = literalOf(ts, checker, op, 'tag')
    tags.add(tag)
    const operation = {
      operationId: operationIdOf(method, path),
      summary: (summary ?? '').trim(),
      ...(rest.join('\n').trim() === '' ? {} : { description: rest.join('\n').trim() }),
      tags: [tag],
      security: auth === 'public' ? [] : [{ [auth]: [] }],
      ...(scope === undefined ? {} : { 'x-scope': scope }),
    }
    const parameters = [
      ...paramsOf(op, 'params', 'path'),
      ...paramsOf(op, 'query', 'query'),
      ...paramsOf(op, 'headers', 'header'),
    ]
    if (parameters.length > 0) operation.parameters = parameters
    const body = fieldOf(checker, op, 'body')
    if (body !== undefined) {
      const bodyContent = literalOf(ts, checker, op, 'bodyContent') ?? 'json'
      operation.requestBody = {
        required: true,
        content: { [CONTENT_TYPES[bodyContent]]: { schema: schemaFor(body, bodyContent) } },
      }
    }
    operation.responses = responsesOf(op)
    const ws = fieldOf(checker, op, 'ws')
    if (ws !== undefined) {
      operation['x-websocket'] = {
        client: convert(fieldOf(checker, ws, 'client')),
        server: convert(fieldOf(checker, ws, 'server')),
      }
    }
    paths[path] ??= {}
    if (paths[path][method.toLowerCase()] !== undefined)
      throw new Error(`cloud-contract: 重复的路由 ${prop.name}`)
    paths[path][method.toLowerCase()] = operation
  }

  function responsesOf(op) {
    const ok = fieldOf(checker, op, 'ok')
    if (ok === undefined) throw new Error('cloud-contract: 每条路由都要有 ok')
    const status = String(literalOf(ts, checker, ok, 'status'))
    const content = literalOf(ts, checker, ok, 'content') ?? 'json'
    const okBody = fieldOf(checker, ok, 'body')
    const sse = fieldOf(checker, ok, 'sse')
    const okDoc = literalOf(ts, checker, ok, 'description')
    const responses = { [status]: { description: okDoc ?? '成功' } }
    const media = {}
    if (okBody !== undefined) media[CONTENT_TYPES[content]] = { schema: schemaFor(okBody, content) }
    if (sse !== undefined)
      media['text/event-stream'] = {
        schema: { type: 'string' },
        'x-sse-data': convert(sse),
      }
    if (Object.keys(media).length > 0) responses[status].content = media
    const okHeaders = fieldOf(checker, ok, 'headers')
    if (okHeaders !== undefined) {
      responses[status].headers = Object.fromEntries(
        checker.getPropertiesOfType(okHeaders).map((p) => {
          const doc = firstParagraph(docOf(ts, checker, p))
          return [
            p.name,
            {
              ...(doc === '' ? {} : { description: doc }),
              schema: convert(checker.getTypeOfSymbol(p)),
            },
          ]
        }),
      )
    }
    const alt = fieldOf(checker, op, 'alt')
    if (alt !== undefined) {
      const altStatus = String(literalOf(ts, checker, alt, 'status'))
      const altBody = fieldOf(checker, alt, 'body')
      const altContent = literalOf(ts, checker, alt, 'content') ?? 'json'
      responses[altStatus] = {
        description: literalOf(ts, checker, alt, 'description') ?? '成功',
        ...(altBody === undefined
          ? {}
          : {
              content: { [CONTENT_TYPES[altContent]]: { schema: schemaFor(altBody, altContent) } },
            }),
      }
    }
    const errors = fieldOf(checker, op, 'errors')
    const errorBody = fieldOf(checker, op, 'errorBody')
    if (errors !== undefined) {
      for (const p of checker.getPropertiesOfType(errors)) {
        const codes = convert(checker.getTypeOfSymbol(p))
        const list = codes.enum ?? (codes.const === undefined ? [] : [codes.const])
        const doc = firstParagraph(docOf(ts, checker, p))
        responses[p.name] = {
          description: doc !== '' ? doc : list.length > 0 ? list.join(' / ') : '错误',
          ...(list.length > 0 ? { 'x-error-codes': list } : {}),
          ...(errorBody === undefined
            ? {}
            : { content: { 'application/json': { schema: convert(errorBody) } } }),
        }
      }
    }
    return responses
  }

  const infoSymbol = checker.getExportsOfModule(moduleSymbol).find((s) => s.name === 'CloudApi')
  const sortedComponents = Object.fromEntries(
    [...components.entries()].sort(([a], [b]) => a.localeCompare(b)),
  )
  return {
    openapi: '3.1.0',
    info: {
      title: 'Agents 工坊云端对外契约',
      version,
      description: docOf(ts, checker, infoSymbol),
    },
    servers: [{ url: 'https://cloud.agentsws.com' }],
    tags: [...tags].map((name) => ({ name })),
    paths,
    components: { securitySchemes: SECURITY_SCHEMES, schemas: sortedComponents },
  }
}
