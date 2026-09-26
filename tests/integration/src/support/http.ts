// 用新连接发请求：不复用 fetch 连接池里的长连接，用来确认服务器是否还在接受新连接。
import { request } from 'node:http'

export async function statusOnNewConnection(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { agent: false }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}
