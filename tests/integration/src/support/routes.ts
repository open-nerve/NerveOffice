// 应用注册的全部路由（M2-P6 第 6 片复核 S5）：从运行中的应用取 Express 的路由表——Nest 的每个控制器方法都注册在这里，
// 与真正处理请求的是同一张表。核对每个接口的认证、"看不到与不存在"的覆盖时用它，不手写接口清单：新加的接口自动在列。
import type { TestApp } from './api-app.ts'
import { HttpAdapterHost } from '@nerve-office/api/testing'
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

/** 路径模板里的参数（:id 之类） */
export function pathParameters(route: Route): string[] {
  return [...route.path.matchAll(/:(\w+)/g)].map(match => match[1] ?? '')
}

/** 实际的请求路径（去掉查询串）是不是这个路径模板：参数是一段不含 / 的文字 */
export function matchesRoute(route: Route, method: string, path: string): boolean {
  const pattern = new RegExp(`^${route.path.split('/').map(part => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`)
  return route.method === method.toUpperCase() && pattern.test(path.split('?')[0] ?? '')
}
