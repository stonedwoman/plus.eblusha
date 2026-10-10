import { describe, expect, it } from 'vitest'
import {
  BOT_LIVE_MAP_URL,
  BOT_SECRET_REFUSAL_FALLBACK,
  botClarifyTarget,
  botMapCardLink,
  botMessageInfo,
  computeBotAsk,
  detectBotAddressPrefix,
  isBotChatConversation,
  isBotConfirmAnswered,
  isBotMessage,
  normalizeSystemBotInfo,
  replyDraftTargetsBot,
  startsWithBotCommand,
  stripMarkdownForPreview,
  startsWithBotName,
  withBotAskMeta,
  type BotAskInput,
} from './systemBot'

const BOT = 'cbot000000000000000000001'

describe('обращение в начале текста — те же правила, что у сервера (src/lib/systemBot.ts)', () => {
  it('«Еблуша,» «Еблуша:» «Еблуша!» в начале — да', () => {
    expect(startsWithBotName('Еблуша, Как дела у паука?')).toBe(true)
    expect(startsWithBotName('Еблуша: сервер жив?')).toBe(true)
    expect(startsWithBotName('Еблуша! привет')).toBe(true)
    expect(startsWithBotName('  @Еблуша , что там')).toBe(true)
    expect(startsWithBotName('ЕБЛУША,')).toBe(true)
    expect(startsWithBotName('Ёблуша, ё = е')).toBe(true)
    // похожая латиница: E a y b 6 w
    expect(startsWithBotName('Eблушa, latin')).toBe(true)
    expect(startsWithBotName('E6лушa: цифра')).toBe(true)
    // неразрывный пробел из contenteditable
    expect(startsWithBotName(' Еблуша, привет')).toBe(true)
  })

  it('имя без знака, в середине, другое слово — нет', () => {
    expect(startsWithBotName('Еблуша привет')).toBe(false)
    expect(startsWithBotName('привет, Еблуша, как дела')).toBe(false)
    expect(startsWithBotName('Еблушка, ты чего')).toBe(false)
    expect(startsWithBotName('Еблу')).toBe(false)
    expect(startsWithBotName('')).toBe(false)
  })

  it('/eb и /еб (любой регистр), дальше пробел или конец', () => {
    expect(startsWithBotCommand('/eb')).toBe(true)
    expect(startsWithBotCommand('/eb сервер')).toBe(true)
    expect(startsWithBotCommand('/ЕБ как дела')).toBe(true)
    expect(startsWithBotCommand('  /Eb\nвторая строка')).toBe(true)
    expect(startsWithBotCommand('/ebx')).toBe(false)
    expect(startsWithBotCommand('/ебать')).toBe(false)
    expect(startsWithBotCommand('текст /eb')).toBe(false)
  })

  it('detectBotAddressPrefix = имя или команда', () => {
    expect(detectBotAddressPrefix('Еблуша, x')).toBe(true)
    expect(detectBotAddressPrefix('/eb x')).toBe(true)
    expect(detectBotAddressPrefix('просто болтаем')).toBe(false)
  })
})

describe('кто бот', () => {
  it('isBotMessage: isBot сообщения, sender.isBot или id бота; metadata не считается', () => {
    expect(isBotMessage({ isBot: true })).toBe(true)
    expect(isBotMessage({ sender: { isBot: true } })).toBe(true)
    expect(isBotMessage({ senderId: BOT }, BOT)).toBe(true)
    expect(isBotMessage({ senderId: 'u1', metadata: { bot: { v: 1, kind: 'answer' }, isBot: true } })).toBe(false)
    expect(isBotMessage(null)).toBe(false)
  })

  it('botMessageInfo читает metadata.bot (и строкой JSON)', () => {
    expect(botMessageInfo({ metadata: { bot: { v: 1, kind: 'answer', triggerMessageId: 'q1' } } })).toEqual({ kind: 'answer', triggerMessageId: 'q1' })
    expect(botMessageInfo({ metadata: JSON.stringify({ bot: { v: 1, kind: 'confirm' } }) })).toEqual({ kind: 'confirm', triggerMessageId: null })
    expect(botMessageInfo({ metadata: { bot: { kind: 'weird' } } })).toEqual({ kind: null, triggerMessageId: null })
  })

  it('«Чат с Еблушей»: isBotChat сервера или 1:1 с ботом-участником; не группа и не секретка', () => {
    const bot = { id: BOT, isBot: true }
    expect(isBotChatConversation({ isBotChat: true })).toBe(true)
    expect(isBotChatConversation({ isGroup: false, participants: [{ user: { id: 'me' } }, { user: bot }] })).toBe(true)
    expect(isBotChatConversation({ isGroup: true, participants: [{ user: { id: 'me' } }, { user: bot }] })).toBe(false)
    expect(isBotChatConversation({ type: 'SECRET', participants: [{ user: { id: 'me' } }, { user: bot }] })).toBe(false)
    expect(isBotChatConversation({ isGroup: false, participants: [{ user: { id: 'me' } }, { user: { id: 'peer' } }] })).toBe(false)
  })

  it('normalizeSystemBotInfo: профиль, чат выключен по умолчанию, запасной отказ', () => {
    const info = normalizeSystemBotInfo({ bot: { id: BOT, displayName: 'Еблуша', isBot: true }, botChat: { botChatEnabled: false, conversationId: null } })
    expect(info?.bot.id).toBe(BOT)
    expect(info?.botChat).toEqual({ botChatEnabled: false, conversationId: null })
    expect(info?.secretChatRefusal).toBe(BOT_SECRET_REFUSAL_FALLBACK)
    expect(normalizeSystemBotInfo({})).toBeNull()
  })
})

describe('режим «Спросить» в поле ввода', () => {
  const base: BotAskInput = {
    botAvailable: true,
    hasConversation: true,
    isSecret: false,
    isBotChat: false,
    editing: false,
    forwarding: false,
    prefix: false,
    replyToBot: false,
    dismissed: false,
  }

  it('без повода — плашки нет и botAsk не шлём', () => {
    const s = computeBotAsk(base)
    expect(s.active).toBe(false)
    expect(s.meta).toBeNull()
  })

  it('«Еблуша,» в начале или ответ боту → плашка и botAsk:true', () => {
    expect(computeBotAsk({ ...base, prefix: true })).toMatchObject({ active: true, meta: { botAsk: true } })
    expect(computeBotAsk({ ...base, replyToBot: true })).toMatchObject({ active: true, meta: { botAsk: true } })
  })

  it('Backspace по плашке → обычное сообщение с botAsk:false', () => {
    expect(computeBotAsk({ ...base, prefix: true, dismissed: true })).toMatchObject({ active: false, meta: { botAsk: false } })
  })

  it('в «Чате с Еблушей» плашки нет и botAsk:false не шлём (там всё — боту)', () => {
    const s = computeBotAsk({ ...base, isBotChat: true, prefix: true, dismissed: true })
    expect(s.active).toBe(false)
    expect(s.meta).toBeNull()
  })

  it('секретный чат: плашки нет, ничего не шлём, но показываем локальный отказ на обращение', () => {
    const s = computeBotAsk({ ...base, isSecret: true, prefix: true })
    expect(s.active).toBe(false)
    expect(s.meta).toBeNull()
    expect(s.secretRefusal).toBe(true)
    expect(computeBotAsk({ ...base, isSecret: true }).secretRefusal).toBe(false)
  })

  it('правка, пересылка, бот не заведён — плашки нет', () => {
    expect(computeBotAsk({ ...base, prefix: true, editing: true }).active).toBe(false)
    expect(computeBotAsk({ ...base, prefix: true, forwarding: true }).active).toBe(false)
    expect(computeBotAsk({ ...base, prefix: true, botAvailable: false })).toMatchObject({ active: false, meta: null, secretRefusal: false })
  })

  it('withBotAskMeta добавляет botAsk, не трогая остальное', () => {
    expect(withBotAskMeta(undefined, null)).toBeUndefined()
    expect(withBotAskMeta({ replyQuoteBundle: [] }, { botAsk: true })).toEqual({ replyQuoteBundle: [], botAsk: true })
    expect(withBotAskMeta(undefined, { botAsk: false })).toEqual({ botAsk: false })
  })

  it('replyDraftTargetsBot: смотрит на replyToId (последнее цитируемое)', () => {
    expect(replyDraftTargetsBot({ replyToId: 'b1', quoted: [{ id: 'b1', senderId: BOT }] }, BOT)).toBe(true)
    expect(replyDraftTargetsBot({ replyToId: 'b1', quoted: [{ id: 'b1', senderId: 'x', isBot: true }] })).toBe(true)
    expect(replyDraftTargetsBot({ replyToId: 'h1', quoted: [{ id: 'b1', senderId: BOT }, { id: 'h1', senderId: 'u' }] }, BOT)).toBe(false)
    expect(replyDraftTargetsBot(null, BOT)).toBe(false)
  })
})

describe('превью/цитата ответа бота без маркеров разметки', () => {
  it('снимает жирный, курсив, код, ссылки, заголовки, цитаты; слова и списки остаются', () => {
    const src = [
      '### Итог',
      '**Ответ** на «вопрос»',
      '',
      '- пункт _первый_',
      '- пункт `второй`',
      '> цитата',
      '',
      '[живая карта](https://v.koban.uk/map/) и ~~старое~~',
    ].join('\n')
    expect(stripMarkdownForPreview(src)).toBe(
      ['Итог', 'Ответ на «вопрос»', '', '- пункт первый', '- пункт второй', 'цитата', '', 'живая карта и старое'].join('\n'),
    )
  })
  it('не трогает обычный текст и snake_case', () => {
    expect(stripMarkdownForPreview('файл ld_src_x и 2*3*4')).toBe('файл ld_src_x и 2*3*4')
  })
})

describe('кнопки под сообщениями бота', () => {
  const ans = (id: string, trig: string | null, kind = 'answer') => ({
    id,
    senderId: BOT,
    isBot: true,
    metadata: { bot: { v: 1, kind, ...(trig ? { triggerMessageId: trig } : {}) } },
  })
  const human = (id: string, replyToId?: string) => ({ id, senderId: 'me', isBot: false, ...(replyToId ? { replyTo: { id: replyToId } } : {}) })

  it('«Уточнить» — под последней частью ответа, ответ ставится на первую часть', () => {
    const list = [human('q1'), ans('a1', 'q1'), ans('a2', 'q1'), ans('a3', 'q1')]
    expect(botClarifyTarget(list, 1, BOT)).toBeNull()
    expect(botClarifyTarget(list, 2, BOT)).toBeNull()
    expect(botClarifyTarget(list, 3, BOT)?.id).toBe('a1')
  })

  it('разные обращения — разные ответы; notice/confirm/welcome без «Уточнить»', () => {
    const list = [human('q1'), ans('a1', 'q1'), human('q2'), ans('b1', 'q2'), ans('n1', null, 'notice'), ans('c1', null, 'confirm')]
    expect(botClarifyTarget(list, 1, BOT)?.id).toBe('a1')
    expect(botClarifyTarget(list, 3, BOT)?.id).toBe('b1')
    expect(botClarifyTarget(list, 4, BOT)).toBeNull()
    expect(botClarifyTarget(list, 5, BOT)).toBeNull()
    expect(botClarifyTarget(list, 0, BOT)).toBeNull()
  })

  it('подтверждение: «Да/Нет» прячутся, когда я уже ответил на него', () => {
    const list = [ans('c1', null, 'confirm'), human('x1')]
    expect(isBotConfirmAnswered(list, 0, 'me')).toBe(false)
    list.push(human('x2', 'c1'))
    expect(isBotConfirmAnswered(list, 0, 'me')).toBe(true)
  })

  it('карточка карты: ссылка из вложения (https) или по имени karta-….png; у людей — нет', () => {
    const msg = { senderId: BOT, isBot: true }
    expect(botMapCardLink({ type: 'IMAGE', metadata: { originalName: 'karta-valheim.png' } }, msg)).toBe(BOT_LIVE_MAP_URL)
    expect(botMapCardLink({ type: 'IMAGE', metadata: { link: 'https://v.koban.uk/map/#p=1', originalName: 'x.png' } }, msg)).toBe('https://v.koban.uk/map/#p=1')
    expect(botMapCardLink({ type: 'IMAGE', metadata: { link: 'javascript:alert(1)', originalName: 'x.png' } }, msg)).toBeNull()
    expect(botMapCardLink({ type: 'IMAGE', metadata: { originalName: 'wiki.png' } }, msg)).toBeNull()
    expect(botMapCardLink({ type: 'IMAGE', metadata: { originalName: 'karta-valheim.png' } }, { senderId: 'u', isBot: false })).toBeNull()
  })
})
