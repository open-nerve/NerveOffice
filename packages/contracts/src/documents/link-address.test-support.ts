// 链接地址判定的跨引擎用例（M3-P3 设计 §3.2）：同一份表在 Node 的单元测试（link-address.test.ts）与三个浏览器的 E2E 里都跑，
// 要求每个引擎的 canonicalLink 都给出这里的结果，并且规范写法再判定一次不变（不动点）。
// 地址取自 P3 设计前的跨引擎实测（Node 24 与 Chromium、Chrome、WebKit 的 WHATWG URL：36 个地址里只有路径中的 | 不同，
// 判定统一编成 %7C）、门禁 addresses.test.ts 的浏览器解析边界与 SDK 自动识别写出的地址（DEF-021）。
// 这里只放数据，不引用判定本身：E2E 把输入交给页面里打包的 canonicalLink，拿结果与这里比较
import type { CanonicalLink } from './link-address.ts'

export interface LinkAddressCase {
  /** 这条用例说明什么 */
  readonly note: string
  readonly input: string
  readonly expected: CanonicalLink
}

function valid(note: string, input: string, href: string): LinkAddressCase {
  return { note, input, expected: { ok: true, href } }
}

function invalid(note: string, input: string, reason: Extract<CanonicalLink, { ok: false }>['reason']): LinkAddressCase {
  return { note, input, expected: { ok: false, reason } }
}

const LONG_PATH = 'a'.repeat(2028)

export const LINK_ADDRESS_CASES: readonly LinkAddressCase[] = [
  // http(s)：WHATWG URL 的 href
  valid('补上路径的 /', 'https://example.com', 'https://example.com/'),
  valid('协议与主机小写、去掉默认端口，路径的大小写不变', 'HTTPS://EXAMPLE.COM:443/A?B#C', 'https://example.com/A?B#C'),
  valid('http 的默认端口', 'http://example.com:80/', 'http://example.com/'),
  valid('端口的前导零', 'https://example.com:0443/', 'https://example.com/'),
  valid('非默认端口保留（SDK 键入 localhost:5173 补成 https://localhost:5173）', 'https://localhost:5173/x', 'https://localhost:5173/x'),
  valid('IDN 的主机转成 punycode，路径、查询与片段按 UTF-8 编码', 'https://例子.中国/路径?查=询#片段', 'https://xn--fsqu00a.xn--fiqs8s/%E8%B7%AF%E5%BE%84?%E6%9F%A5=%E8%AF%A2#%E7%89%87%E6%AE%B5'),
  valid('全角句号是主机的分隔', 'https://例子。中国/', 'https://xn--fsqu00a.xn--fiqs8s/'),
  valid('ß 按非过渡的 IDNA 处理', 'https://faß.example/', 'https://xn--fa-hia.example/'),
  valid('兼容字符按 NFKC 化简', 'https://ﬁ.example/', 'https://fi.example/'),
  valid('已经是 punycode 的主机不变', 'https://xn--fa-hia.example/', 'https://xn--fa-hia.example/'),
  valid('emoji 的主机', 'https://😀.example/', 'https://xn--e28h.example/'),
  valid('主机里的百分号编码被解码', 'https://exa%41mple.com/', 'https://exaample.com/'),
  valid('主机结尾的点保留', 'https://example.com./', 'https://example.com./'),
  valid('十六进制与缩写的 IPv4', 'http://0x7f.1/', 'http://127.0.0.1/'),
  valid('IPv6 压缩', 'http://[0:0::1]/', 'http://[::1]/'),
  valid('IPv4 结尾的点', 'http://192.168.0.1.:8080/', 'http://192.168.0.1:8080/'),
  valid('路径里的空白、引号、尖括号、反引号、花括号、^ 编码，单引号不编码；| 统一编成 %7C（Chromium 编码、Node 与 WebKit 保留）', 'https://example.com/a b"c<d>e\'f`g{h}i|j^k', 'https://example.com/a%20b%22c%3Cd%3Ee\'f%60g%7Bh%7Di%7Cj%5Ek'),
  valid('查询里的空白、双引号、尖括号、单引号编码，反引号与花括号不编码', 'https://example.com/?a b"c<d>e\'f`g{h}', 'https://example.com/?a%20b%22c%3Cd%3Ee%27f`g{h}'),
  valid('查询里的 | 编成 %7C', 'https://example.com/?a|b', 'https://example.com/?a%7Cb'),
  valid('片段里的空白、双引号、尖括号、反引号编码，单引号不编码', 'https://example.com/#a b"c<d>e\'f`g', 'https://example.com/#a%20b%22c%3Cd%3Ee\'f%60g'),
  valid('片段里的 | 编成 %7C', 'https://example.com/#a|b', 'https://example.com/#a%7Cb'),
  valid('空的查询与片段保留', 'https://example.com/?', 'https://example.com/?'),
  valid('空的片段保留', 'https://example.com/#', 'https://example.com/#'),
  valid('点段（含 %2e%2e）化简', 'https://example.com/%2e%2e/x/./y/../z', 'https://example.com/x/z'),
  valid('反斜杠当作斜杠', 'https://example.com\\path\\x', 'https://example.com/path/x'),
  valid('协议之后没有斜杠', 'https:example.com/x', 'https://example.com/x'),
  valid('协议之后一个斜杠', 'https:/example.com/x', 'https://example.com/x'),
  valid('协议之后四个斜杠', 'https:////example.com/p', 'https://example.com/p'),
  valid('不换行空格编码', 'https://example.com/\u00A0x', 'https://example.com/%C2%A0x'),
  valid('全角空格编码', 'https://example.com/x\u3000y', 'https://example.com/x%E3%80%80y'),
  valid('小写的百分号编码与 ~ 原样保留', 'https://EXAMPLE.com/%7e~', 'https://example.com/%7e~'),
  valid('不完整的百分号编码原样保留', 'https://example.com/%zz', 'https://example.com/%zz'),
  valid('编码过的斜杠原样保留', 'https://example.com/a%2fb', 'https://example.com/a%2fb'),
  valid('空的用户信息去掉', 'https://@example.com/', 'https://example.com/'),
  invalid('带用户名与密码', 'https://user:pw@example.com/', 'credentials'),
  invalid('带用户名', 'https://user@example.com/', 'credentials'),
  invalid('主机里有零宽连接符：各引擎都解析不了', 'https://a\u200Db.example/', 'unparsable'),

  // mailto：只接受没有主机部分的写法
  valid('邮箱', 'mailto:user@example.com', 'mailto:user@example.com'),
  valid('协议小写，地址的大小写不变，查询里的空白编码', 'MAILTO:User@Example.COM?subject=a b', 'mailto:User@Example.COM?subject=a%20b'),
  valid('多个收件人', 'mailto:a@b.example,c@d.example', 'mailto:a@b.example,c@d.example'),
  valid('空的 mailto', 'mailto:', 'mailto:'),
  valid('mailto 里的 | 编成 %7C', 'mailto:a|b@example.com', 'mailto:a%7Cb@example.com'),
  invalid('SDK 键入邮箱写出的 mailto://（页面改写成 mailto:）', 'mailto://user@example.com', 'mailto-host'),
  invalid('空的主机部分', 'mailto:///x', 'mailto-host'),

  // 协议
  invalid('javascript', 'javascript:alert(1)', 'scheme'),
  invalid('ftp（SDK 键入时照样识别成链接）', 'ftp://example.com/x', 'scheme'),
  invalid('data', 'data:text/html,x', 'scheme'),
  invalid('localhost:5173 被解析成 localhost: 协议', 'localhost:5173', 'scheme'),

  // 没有协议、也不以 / 或 # 开头
  invalid('粘贴纯文本写出的 example.org', 'example.org', 'unparsable'),
  invalid('粘贴纯文本写出的邮箱', 'user@example.com', 'unparsable'),
  invalid('粘贴 HTML 写出的相对地址', 'relative-no-slash', 'unparsable'),
  invalid('带路径的域名', 'www.example.com/路径', 'unparsable'),

  // 空白与控制字符
  valid('首尾空格去掉', ' https://example.com/ ', 'https://example.com/'),
  valid('首尾的不换行空格与全角空格去掉', '\u00A0https://example.com/\u3000', 'https://example.com/'),
  invalid('结尾的制表符：不先删掉再判断', 'https://example.com/\t', 'control-character'),
  invalid('协议里的换行', 'java\nscript:alert(1)', 'control-character'),
  invalid('删掉制表符之后成了协议相对的地址', '/\t/evil.example', 'control-character'),
  invalid('DEL', 'https://exa\u007Fmple.com', 'control-character'),
  invalid('空的', '', 'empty'),
  invalid('只有空白', '   ', 'empty'),

  // 本站相对地址
  valid('路径、查询与片段', '/a/b?c#d', '/a/b?c#d'),
  valid('路径里的空格编码', '/a b', '/a%20b'),
  valid('点段化简', '/a/../b', '/b'),
  valid('开头的点段', '/./x', '/x'),
  valid('越过根的点段', '/../x', '/x'),
  valid('路径里的 | 编成 %7C', '/a|b', '/a%7Cb'),
  valid('编码过的斜杠不会换主机', '/%2F%2Fevil.example', '/%2F%2Fevil.example'),
  invalid('协议相对的地址', '//evil.example/x', 'off-site'),
  invalid('反斜杠：浏览器当作斜杠，换了主机', '/\\evil.example', 'off-site'),
  invalid('点段化简出 //', '/..//evil.example', 'off-site'),
  invalid('协议相对、恰好是解析用的占位主机', '//relative-link.invalid/x', 'off-site'),

  // 文档内锚点：原样
  valid('表格内部链接', '#gid=sheet-1&range=A1', '#gid=sheet-1&range=A1'),
  valid('只有 #', '#', '#'),
  valid('非 ASCII 的锚点原样', '#中文', '#中文'),
  invalid('锚点里的空格', '#a b', 'anchor'),
  invalid('锚点里的双引号', '#a"b', 'anchor'),
  invalid('锚点里的单引号', '#a\'b', 'anchor'),
  invalid('锚点里的尖括号', '#a<b', 'anchor'),
  invalid('锚点里的反引号', '#a`b', 'anchor'),

  // 长度
  valid('恰好 2048 个字符', `https://example.com/${LONG_PATH}`, `https://example.com/${LONG_PATH}`),
  invalid('2049 个字符', `https://example.com/${LONG_PATH}a`, 'too-long'),
  invalid('输入不长，规范写法超过上限（双引号编成 %22）', `https://example.com/${'"'.repeat(700)}`, 'too-long'),
]
