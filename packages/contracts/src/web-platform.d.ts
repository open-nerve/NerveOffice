// contracts 只按 ES 的标准库做类型检查（tsconfig.base.json：lib 只有 es2023、types 为空），既没有 DOM、也没有 Node 的类型。
// 前后端共用的判定要用到两个 Web 平台的全局：WHATWG 的 URL（链接地址的判定，documents/link-address.ts）与 TextEncoder
// （规范化内容的 UTF-8 字节，documents/content-canonical.ts）。Node、浏览器与 Web Worker 都有它们。
// 这里只为 contracts 自己的类型检查声明用到的那几项：这个文件不被任何模块引用，web 与 api 经源码引用 contracts 时不经过它，
// 用的是各自环境的完整声明（DOM 的 lib、@types/node）

declare class URL {
  constructor(url: string, base?: string)
  readonly href: string
  readonly origin: string
  readonly protocol: string
  readonly username: string
  readonly password: string
  readonly hostname: string
  readonly pathname: string
  readonly search: string
  readonly hash: string
}

declare class TextEncoder {
  encode(input?: string): Uint8Array
}
