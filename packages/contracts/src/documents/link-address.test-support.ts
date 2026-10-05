// 链接地址判定的跨引擎用例（M3-P3 设计 §3.2）：同一份表在 Node 的单元测试（link-address.test.ts）与三个浏览器的 E2E 里都跑，
// 要求每个引擎的 canonicalLink 都给出这里的结果，并且规范写法再判定一次不变（不动点）。
// 地址取自 P3 设计前的跨引擎实测（Node 24 与 Chromium、Chrome、WebKit 的 WHATWG URL：36 个地址里只有路径中的 | 不同，
// 判定统一编成 %7C）、门禁 addresses.test.ts 的浏览器解析边界、SDK 自动识别写出的地址（DEF-021），以及审查 B 的逐字符扫描找出的
// 各引擎不一致的几类（主机里的空白与 *、mailto 里 ? 之前的空格、查询里的单引号与反引号）与能改写剪贴板 HTML 结构的字符。
// 另有逐字符扫描（LINK_SCAN_INPUTS）与随机拼出的地址（randomLinkAddresses）：单元测试在 Node 里核对不抛出、不动点与规范写法里没有
// 那几个字符，E2E 交给每个浏览器、与 Node 的结果逐个比较（"浏览器判为合法的，Node 也判为合法且相等"是承重的那一条）。
// 这里只放数据，不引用判定本身：E2E 把输入交给页面里打包的 canonicalLink，拿结果与这里比较
import type { CanonicalLink, LinkAddressInvalidReason } from './link-address.ts'

export interface LinkAddressCase {
  /** 这条用例说明什么 */
  readonly note: string
  readonly input: string
  /** Node 的结果（单元测试只认它） */
  readonly expected: CanonicalLink
  /**
   * 不合法、而有的引擎在另一步拒绝时，E2E 里也接受的原因：主机里有空白时 Node 与 WebKit 解析不了（unparsable），Chromium 解析出带 %20 的
   * 主机、按主机的写法拒绝（host）。合法与否、规范写法各引擎相同
   */
  readonly alsoReason?: LinkAddressInvalidReason
}

function valid(note: string, input: string, href: string): LinkAddressCase {
  return { note, input, expected: { ok: true, href } }
}

function invalid(note: string, input: string, reason: LinkAddressInvalidReason, alsoReason?: LinkAddressInvalidReason): LinkAddressCase {
  return alsoReason === undefined ? { note, input, expected: { ok: false, reason } } : { note, input, expected: { ok: false, reason }, alsoReason }
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
  valid('IPv4 结尾的点', 'http://192.168.0.1.:8080/', 'http://192.168.0.1:8080/'),
  valid('主机里的 _ 与标签首尾的 - 照收（各引擎都原样保留）', 'https://A_b.-c-.example/', 'https://a_b.-c-.example/'),
  valid('路径里的空白、引号、尖括号、反引号、花括号、^ 编码，单引号不编码；| 统一编成 %7C（Chromium 编码、Node 与 WebKit 保留）', 'https://example.com/a b"c<d>e\'f`g{h}i|j^k', 'https://example.com/a%20b%22c%3Cd%3Ee\'f%60g%7Bh%7Di%7Cj%5Ek'),
  valid('查询里的空白、双引号、尖括号、单引号编码；反引号统一编成 %60（各引擎都不编码），花括号不编码', 'https://example.com/?a b"c<d>e\'f`g{h}', 'https://example.com/?a%20b%22c%3Cd%3Ee%27f%60g{h}'),
  valid('查询里的 | 编成 %7C', 'https://example.com/?a|b', 'https://example.com/?a%7Cb'),
  valid('单引号只在查询里编码，路径与片段里照样保留（复制时 SDK 写的是双引号的属性）', 'https://example.com/a\'b?c\'d#e\'f', 'https://example.com/a\'b?c%27d#e\'f'),
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
  // 主机只收各引擎一致的写法（LDH 标签与点、IPv4）：审查 B 的逐字符扫描里各引擎不一致的、能改写剪贴板 HTML 结构的都在这里被拒绝
  invalid('主机里有空格：Node 与 WebKit 解析不了，Chromium 编成 %20', 'https://a b.example/x', 'unparsable', 'host'),
  invalid('主机里有全角空格（映射成空格）', 'https://a\u3000b.example/', 'unparsable', 'host'),
  invalid('主机里有不换行空格（映射成空格）', 'https://a\u00A0b.example/', 'unparsable', 'host'),
  invalid('主机里编码过的空格', 'https://a%20b.example/', 'unparsable', 'host'),
  invalid('主机里有 *：Node 与 WebKit 原样保留，Chromium 编成 %2A', 'https://a*b.example/x', 'host'),
  invalid('主机里编码过的 *（Node 解码成 *，Chromium 保留 %2A）', 'https://a%2Ab.example/', 'host'),
  invalid('主机里有双引号（四个引擎都原样保留，复制时能改写剪贴板 HTML 的结构）', 'https://a"b.example/', 'host'),
  invalid('主机里有反引号', 'https://a`b.example/', 'host'),
  invalid('主机里有单引号', 'https://a\'b.example/', 'host'),
  invalid('主机里有 =', 'http://a=b/', 'host'),
  invalid('主机里有括号与花括号', 'https://a(b){c}.example/', 'host'),
  invalid('主机里有 !$&+,;~', 'https://a!$&+,;~b.example/', 'host'),
  invalid('主机里有空的标签', 'https://a..b.example/', 'host'),
  invalid('IPv6 不收（写得不规整的 IPv6 各引擎收不收不一样）', 'http://[0:0::1]/', 'host'),
  invalid('主机里有零宽连接符：各引擎都解析不了', 'https://a\u200Db.example/', 'unparsable'),

  // mailto：只接受没有主机部分的写法
  valid('邮箱', 'mailto:user@example.com', 'mailto:user@example.com'),
  valid('协议小写，地址的大小写不变，查询里的空白编码', 'MAILTO:User@Example.COM?subject=a b', 'mailto:User@Example.COM?subject=a%20b'),
  valid('多个收件人', 'mailto:a@b.example,c@d.example', 'mailto:a@b.example,c@d.example'),
  valid('空的 mailto', 'mailto:', 'mailto:'),
  valid('mailto 里的 | 编成 %7C', 'mailto:a|b@example.com', 'mailto:a%7Cb@example.com'),
  valid('mailto 的地址里的空格编码（各引擎都原样保留）', 'mailto:a b@example.com', 'mailto:a%20b@example.com'),
  valid('mailto 里 ? 之前的空格编码（Node 与 WebKit 编码，Chromium 原样保留）', 'mailto:a ?subject=x', 'mailto:a%20?subject=x'),
  valid('mailto 里 # 之前的空格编码', 'mailto:a #b', 'mailto:a%20#b'),
  valid('mailto 里 ? 之前的两个空格都编码（Node 只编码最后一个）', 'mailto:a  ?b', 'mailto:a%20%20?b'),
  valid('mailto 的地址里的双引号、尖括号、反引号编码（各引擎都原样保留，复制时能改写剪贴板 HTML 的结构）', 'mailto:"a"<b>`c`@example.com', 'mailto:%22a%22%3Cb%3E%60c%60@example.com'),
  valid('mailto 的查询里的单引号编成 %27（Chromium 编码，Node 与 WebKit 不编码），反引号编成 %60', 'mailto:x@y?a\'b`c', 'mailto:x@y?a%27b%60c'),
  valid('mailto 的片段：空白、双引号、尖括号、反引号编码，单引号不编码', 'mailto:x@y#a b"c<d>e\'f`g', 'mailto:x@y#a%20b%22c%3Cd%3Ee\'f%60g'),
  valid('mailto 的单引号只在查询里编码，地址与片段里照样保留', 'mailto:a\'b@y?c\'d#e\'f', 'mailto:a\'b@y?c%27d#e\'f'),
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
  valid('查询里的反引号编成 %60，片段里的空白与反引号编码', '/?a`b#c d`e', '/?a%60b#c%20d%60e'),
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

/**
 * 逐字符扫描用的字符（审查 B 的 make-inputs3 的扩充）：可打印的 ASCII，几种空白、零宽与看不见的字符，几个常见的非 ASCII 字母、全角字符、
 * 汉字与 emoji。不放：孤立的代理项（E2E 经 JSON 交给页面时被换成 U+FFFD，两边判定的不是同一个字符串；随机拼接在 Node 里另放）、
 * 新近分配的 Unicode 字符（各引擎 IDN 的 Unicode 版本不同，主机里收不收不一样——只影响收不收，Node 对 LDH 的主机原样接受，
 * 浏览器给出的结果 Node 照收，见 link-address.ts 的 HOST）、RTL 字符（希伯来文、阿拉伯文等：IDNA 的 Bidi 规则只有浏览器核对到
 * 同一个域名里其余的标签，Node 收、浏览器不收，同样只影响收不收；E2E 里"每个地址的结果与 Node 相同"那一条随之要放宽。
 * U+202E 是方向控制符，不是 RTL 字符，IDNA 本来就不收）。随机拼接的片段（LINK_RANDOM_PIECES）同样不放
 */
const SCAN_CHARACTERS: readonly string[] = [...Array.from({ length: 0x7F - 0x20 }, (_, offset) => String.fromCharCode(0x20 + offset)), '\u00A0', '\u3000', '\u2028', '\u0085', '\u00AD', '\u200B', '\u200C', '\u200D', '\uFEFF', '\u202E', '\u0308', 'é', 'ß', 'ς', 'İ', '例', '😀', '．', '。', 'Ａ', '１']

/** 字符放进的位置：http(s) 的主机（中间、开头、结尾、方括号里）、端口、用户信息、路径、查询、片段，IPv4，mailto 的地址、?、# 之前、查询与片段，本站相对地址，锚点，协议 */
const SCAN_POSITIONS: readonly ((character: string) => string)[] = [
  c => `https://a${c}b.example/`,
  c => `https://${c}.example/`,
  c => `https://example.com${c}/`,
  c => `https://example.com${c}`,
  c => `https://[::1${c}]/`,
  c => `http://example.com:8${c}/`,
  c => `https://${c}@example.com/`,
  c => `https://example.com/a${c}b`,
  c => `https://example.com/?a${c}b`,
  c => `https://example.com/#a${c}b`,
  c => `http://127.0.0.${c}1/`,
  c => `http://127.0.0.1${c}/`,
  c => `http://1${c}/`,
  c => `mailto:a${c}b@example.com`,
  c => `mailto:a${c}?b`,
  c => `mailto:a${c}#b`,
  c => `mailto:x@y?a${c}b`,
  c => `mailto:x@y#a${c}b`,
  c => `mailto:${c}`,
  c => `/a${c}b`,
  c => `/?a${c}b`,
  c => `/#a${c}b`,
  c => `/${c}`,
  c => `#a${c}b`,
  c => `http${c}://example.com/`,
]

/** 逐字符扫描：每个字符放进每个位置（去重） */
export const LINK_SCAN_INPUTS: readonly string[] = [...new Set(SCAN_POSITIONS.flatMap(position => SCAN_CHARACTERS.map(position)))]

/** 随机拼接用的片段：协议、分隔符、各引擎容易不一致的字符与编码、主机与端口的写法 */
export const LINK_RANDOM_PIECES: readonly string[] = ['https:', 'http:', 'mailto:', '//', '/', '\\', '#', '?', '@', ':', '.', '..', '%', '%2e', '%zz', '%20', '%2A', '%22', '%3C', '|', ' ', '\u00A0', '\u3000', '"', '\'', '<', '>', '`', '*', '=', '(', '{', '_', '-', '[', ']', '::1', 'a', 'B', '例', '😀', 'ß', '\t', 'example.com', 'xn--', '0x7f', '1.2', ':443', ':0', 'user:pw@', '&', '+', ',', ';', '~', '!', '$', '^']

/** 确定的伪随机数（mulberry32，32 位整数运算，不受浮点精度影响）：同一个种子给出同一串 [0, 1) 的数 */
function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** 随机拼出的地址：每个从 pieces 里取 1–8 段拼成，共 count 个（同一个种子得到同一批，可能有重复） */
export function randomLinkAddresses(count: number, seed: number, pieces: readonly string[] = LINK_RANDOM_PIECES): string[] {
  const next = pseudoRandom(seed)
  const pick = (size: number): number => Math.floor(next() * size)
  return Array.from({ length: count }, () => Array.from({ length: 1 + pick(8) }, () => pieces[pick(pieces.length)]).join(''))
}
