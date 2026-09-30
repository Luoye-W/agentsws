#!/usr/bin/env node
/**
 * WP48 的抓图脚本，WP210 起并进 `fetch-provider-favicons.mjs`（连接目录每一家都去官网取 favicon）。
 * 这个文件只留着转过去，免得老文档里的命令跑不动。
 */
import { main } from './fetch-provider-favicons.mjs'

await main()
