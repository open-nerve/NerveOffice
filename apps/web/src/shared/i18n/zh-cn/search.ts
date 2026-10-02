// 搜索结果页的文案（M2-P4）：只由按需加载的搜索结果页（features/search）引用，不进平台页面的首屏（lint 的模块边界限定）。
// 页头的搜索框在首屏：它的文案在 messages.searchBox
export const searchMessages = {
  title: '搜索文档',
  heading: (keyword: string) => `“${keyword}”的搜索结果`,
  noKeyword: '输入关键词后按“搜索”，按标题查找你能访问的文档。',
  sortNote: '按标题匹配，最近更新在前。',
  listLabel: '搜索结果',
  loading: '正在搜索…',
  loadFailed: '搜索失败',
  empty: (keyword: string) => `没有找到标题包含“${keyword}”的文档（回收站里的不算）`,
  /**
   * 结果里的位置：空间（界面上的名字由 SpaceLabel 给出：团队空间的名称、"我的空间"或所有者的人名）之后，从空间根目录到它所在文件夹的路径；
   * 在根目录下、或者凭授权命中（看不到目录结构，M2-P5）时没有这一段
   */
  folderPath: (folderPath: readonly string[]) => folderPath.map(name => ` / ${name}`).join(''),
} as const
