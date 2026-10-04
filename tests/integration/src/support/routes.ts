// 应用注册的全部路由（M2-P6 第 6 片复核 S5）：从运行中的应用取 Express 的路由表——Nest 的每个控制器方法都注册在这里，
// 与真正处理请求的是同一张表。核对每个接口的认证、"看不到与不存在"的覆盖时用它，不手写接口清单：新加的接口自动在列。
// 接口上的元数据（例如 @BackgroundRequest()）路由表里没有，另从控制器读（controllerRoutesOf，M3-P2 复核 B5）
import type { Type } from '@nestjs/common'
import type { TestApp } from './api-app.ts'
import { HttpAdapterHost, MetadataScanner, ModulesContainer, Reflector } from '@nerve-office/api/testing'
import { RequestMethod } from '@nestjs/common'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { z } from 'zod'

/** 一个接口：方法（大写）与路径模板（例如 /api/documents/:id） */
export interface Route {
  readonly method: string
  readonly path: string
}

const layerSchema = z.object({
  route: z.object({ path: z.string(), methods: z.record(z.string(), z.boolean()) }).optional(),
}).loose()

/** Express 的应用与路由器本身是函数（带着属性），按属性取，取不到就报错（Express 改了内部结构时要同步这里） */
function propertyOf(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !(key in value))
    throw new Error(`取不到 Express 的 ${key}：Express 的内部结构变了，同步 support/routes.ts`)
  return (value as Record<string, unknown>)[key]
}

/** 应用的全部接口，按路径与方法排好序；同一个路径的几个方法各算一个 */
export function routesOf(app: TestApp): Route[] {
  // 写明类型参数：泛型的类当作值传进去时，它的类型参数推断成 any
  const express = app.runtime.get<HttpAdapterHost>(HttpAdapterHost).httpAdapter.getInstance<unknown>()
  const stack = z.array(layerSchema).parse(propertyOf(propertyOf(express, 'router'), 'stack'))
  const routes = stack.flatMap(({ route }) => route === undefined
    ? []
    : Object.entries(route.methods).filter(([, enabled]) => enabled).map(([method]) => ({ method: method.toUpperCase(), path: route.path })))
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
}

/** 一个接口与处理它的控制器方法上的元数据 */
export interface ControllerRoute extends Route {
  /** 按会话守卫的读法（Reflector 的 getAllAndOverride：方法上的覆盖控制器上的）读出这个键的元数据 */
  readonly metadata: (key: string) => unknown
}

/** 全局前缀：apps/api 的 configure-http.ts 的 setGlobalPrefix('api')。拼错了的话与路由表对不上，controllerRoutesOf 的用例先失败 */
const GLOBAL_PREFIX = 'api'

/** 控制器与方法上的路径（Nest 允许写成数组；没写时是 '/'） */
function pathsOf(value: unknown): string[] {
  const paths = Array.isArray(value) ? value : [value ?? '/']
  return paths.map(path => z.string().parse(path))
}

/** 拼出完整的路径模板（与 Express 的路由表同一个写法：开头一个 /，段之间一个 /，结尾不带 /） */
function joinPath(...parts: readonly string[]): string {
  return `/${parts.flatMap(part => part.split('/')).filter(segment => segment !== '').join('/')}`
}

/**
 * 应用的全部控制器方法：方法、拼好的路径模板与方法上的元数据，按路径与方法排好序（与 routesOf 同一个顺序）。
 * 从 Nest 的模块容器取每个控制器，用 Reflector 读控制器与方法上的路径（PATH_METADATA）和请求方法（METHOD_METADATA）。
 * 路由表（routesOf）才是真正处理请求的那一张：用例先核对两边列出的接口相同，再按这里的元数据判断
 */
export function controllerRoutesOf(app: TestApp): ControllerRoute[] {
  const reflector = app.runtime.get(Reflector)
  const scanner = new MetadataScanner()
  const routes: ControllerRoute[] = []
  for (const module of app.runtime.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      if (typeof wrapper.metatype !== 'function')
        continue
      const controller = wrapper.metatype as Type
      const prototype = controller.prototype as Record<string, unknown>
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name]
        if (typeof handler !== 'function')
          continue
        const method = reflector.get<RequestMethod | undefined>(METHOD_METADATA, handler)
        if (method === undefined)
          continue
        for (const prefix of pathsOf(reflector.get<unknown>(PATH_METADATA, controller))) {
          for (const path of pathsOf(reflector.get<unknown>(PATH_METADATA, handler))) {
            routes.push({
              method: RequestMethod[method],
              path: joinPath(GLOBAL_PREFIX, prefix, path),
              metadata: key => reflector.getAllAndOverride<unknown>(key, [handler, controller]),
            })
          }
        }
      }
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
}

/** 路径模板里的参数（:id 之类） */
export function pathParameters(route: Route): string[] {
  return [...route.path.matchAll(/:(\w+)/g)].map(match => match[1] ?? '')
}

/** 实际的请求路径（去掉查询串）是不是这个路径模板：参数是一段不含 / 的文字 */
export function matchesRoute(route: Route, method: string, path: string): boolean {
  const pattern = new RegExp(`^${route.path.split('/').map(part => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`)
  return route.method === method.toUpperCase() && pattern.test(path.split('?')[0] ?? '')
}
