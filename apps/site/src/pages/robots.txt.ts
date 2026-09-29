import { robotsTxt } from '../lib/seo.js'

export function GET(): Response {
  return new Response(robotsTxt(), { headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
