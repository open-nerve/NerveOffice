// 托管前端产物（P3 设计 §3.8）：挂在安全响应头之后、JSON 请求体之前，只处理 GET 与 HEAD，从不处理 /api 下的地址。
// 静态文件与入口页同样经过安全响应头的中间件：HTML、脚本与 Worker 脚本都带定稿的 CSP（US-M1-09）。
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, posix } from 'node:path'
import express from 'express'
import { AppError } from '../../shared/errors/app-error.ts'

/** 带哈希的资源（Vite 的 assets 目录）：内容变了文件名就变，可以长期缓存。 */
const HASHED_ASSETS = '/assets/'
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** 路径到入口页的映射：没有匹配的一律是平台页面。P4 把编辑器的路径映射到编辑器页（整页加载）。 */
export interface EntryPage {
  readonly pattern: RegExp
  readonly file: string
}

export const ENTRY_PAGES: readonly EntryPage[] = []
const DEFAULT_ENTRY = 'index.html'

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/')
}

/**
 * 最后一段带扩展名或以点开头的（.env、.well-known），按文件处理：找不到就交给后面得到统一的 404；
 * 其他的是页面路由。extname 不把点开头的文件名算作扩展名，要单独判断。
 */
function looksLikeFile(path: string): boolean {
  return posix.extname(path) !== '' || posix.basename(path).startsWith('.')
}

export class WebRootError extends Error {
  override readonly name = 'WebRootError'
}

/** 启动时检查：目录存在、有入口页。配置写错了应当启动失败，而不是上线后每个页面都 404。 */
export function assertWebRoot(root: string, entries: readonly EntryPage[] = ENTRY_PAGES): void {
  if (!isAbsolute(root))
    throw new WebRootError(`NERVE_WEB_ROOT 必须是绝对路径：${root}`)
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new WebRootError(`NERVE_WEB_ROOT 指向的目录不存在：${root}`)
  for (const file of [DEFAULT_ENTRY, ...entries.map(entry => entry.file)]) {
    if (!existsSync(join(root, file)))
      throw new WebRootError(`NERVE_WEB_ROOT 里没有入口页 ${file}：是否指向了前端的构建目录？`)
  }
}

/**
 * 托管前端产物的中间件。
 * - 静态文件：不列目录，不提供点开头的文件；带哈希的资源长期缓存，其他沿用安全响应头的 no-store；
 * - 页面路由：没有扩展名的路径返回对应的入口页（no-store）。
 */
export function webHosting(root: string, entries: readonly EntryPage[] = ENTRY_PAGES): RequestHandler {
  assertWebRoot(root, entries)
  const serveStatic = express.static(root, {
    index: false,
    dotfiles: 'ignore',
    redirect: false,
    fallthrough: true,
    // 不让 send 写默认的 Cache-Control（public, max-age=0），沿用安全响应头的 no-store；带哈希的资源在下面另设
    cacheControl: false,
    setHeaders: (response, path) => {
      if (path.startsWith(join(root, HASHED_ASSETS)))
        response.setHeader('Cache-Control', IMMUTABLE)
    },
  })
  return (request: Request, response: Response, next: NextFunction) => {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || isApiPath(request.path)) {
      next()
      return
    }
    serveStatic(request, response, (error?: unknown) => {
      if (error !== undefined) {
        next(error)
        return
      }
      if (looksLikeFile(request.path)) {
        next()
        return
      }
      const entry = entries.find(page => page.pattern.test(request.path))?.file ?? DEFAULT_ENTRY
      // 用 root 选项：点文件的检查只看 root 之下的相对路径。直接给绝对路径时，整条路径都被检查，
      // 部署目录的上级有点开头的目录（例如 ~/.local、worktree 的 .claude）就会被当成点文件拒绝
      response.sendFile(entry, { root, cacheControl: false, dotfiles: 'deny' }, (sendError?: Error) => {
        if (sendError !== undefined)
          next(sendError)
      })
    })
  }
}

/**
 * /api 以外、托管也没有处理的请求：统一的 404 错误响应。
 * Nest 设置了全局前缀，它的"找不到路由"只挂在 /api 下，别的路径会落到 Express 默认的 HTML 404；
 * 错误处理则在根上也挂了一份，所以交出 AppError 就能得到统一的错误响应。不托管前端时同样生效。
 */
export function notFoundOutsideApi(): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction) => {
    next(isApiPath(request.path) ? undefined : new AppError('NOT_FOUND'))
  }
}
