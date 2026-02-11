declare module 'turndown' {
  interface TurndownRule {
    filter: string | string[]
    replacement: (content: string, node: Node) => string
  }
  export default class TurndownService {
    constructor(options?: { headingStyle?: string })
    addRule(key: string, rule: TurndownRule): void
    turndown(html: string): string
  }
}
