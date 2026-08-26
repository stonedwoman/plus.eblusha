declare module 'turndown' {
  interface TurndownRule {
    filter: string | string[]
    replacement: (content: string, node: Node) => string
  }
  // Настройки, которыми мы реально пользуемся: стиль заголовков и блоков кода,
  // маркер списка и разделитель — от них зависит, поймёт ли отправленное телефон.
  interface TurndownOptions {
    headingStyle?: string
    codeBlockStyle?: string
    fence?: string
    bulletListMarker?: string
    hr?: string
    emDelimiter?: string
    strongDelimiter?: string
  }
  export default class TurndownService {
    constructor(options?: TurndownOptions)
    addRule(key: string, rule: TurndownRule): void
    turndown(html: string): string
  }
}
