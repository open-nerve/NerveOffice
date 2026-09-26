/** 一条违规：规则名、对象（包名、文件等）与说明。 */
export interface Violation {
  rule: string
  subject: string
  detail: string
}
