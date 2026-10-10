import { describe, expect, it } from 'vitest'
import {
  BOT_LIVE_MAP_URL,
  BOT_SECRET_REFUSAL_FALLBACK,
  BOT_THINK_BETTER_TEXT,
  botClarifyTarget,
  botMapCardLink,
  botThinkBetterTarget,
  botThinkBetterText,
  isBotCardKind,
  isThinkBetterRequestText,
  botMessageInfo,
  botReplyAskerId,
  canDeleteBotReply,
  canDeleteMessageForAll,
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

describe('«Удалить» у ответа бота — тому, кто спросил, и владельцу «Чата с Еблушей»', () => {
  const group = { id: 'g1', isGroup: true, participants: [{ user: { id: 'me' } }, { user: { id: 'sanya' } }] }
  const botChat = { id: 'bc1', isGroup: false, isBotChat: true, participants: [{ user: { id: 'me' } }, { user: { id: BOT, isBot: true } }] }
  const q = (id: string, senderId: string) => ({ id, conversationId: 'g1', senderId, isBot: false, content: 'Еблуша, вопрос' })
  const part = (id: string, trig: string | null, extra: Record<string, unknown> = {}, kind = 'answer') => ({
    id,
    conversationId: 'g1',
    senderId: BOT,
    isBot: true,
    metadata: { bot: { v: 1, kind, ...(trig ? { triggerMessageId: trig } : {}) } },
    ...extra,
  })

  it('кто спросил: подсказка сервера askerId важнее всего остального', () => {
    const m = part('a1', 'q1', { replyTo: { id: 'q1', senderId: 'sanya' } })
    ;(m.metadata.bot as any).askerId = 'me'
    expect(botReplyAskerId(m, [q('q1', 'sanya')])).toBe('me')
  })

  it('кто спросил без подсказки: цитата первой части, само обращение в ленте, первая часть того же ответа', () => {
    const first = part('a1', 'q1', { replyTo: { id: 'q1', senderId: 'me' } })
    const second = part('a2', 'q1')
    expect(botReplyAskerId(first, [])).toBe('me')
    // Вторая часть без replyToId: обращение есть в ленте…
    expect(botReplyAskerId(second, [q('q1', 'sanya'), second])).toBe('sanya')
    // …или его не загрузили, но есть первая часть с цитатой.
    expect(botReplyAskerId(second, [first, second])).toBe('me')
    // Цитата не на обращение (replyTo ≠ triggerMessageId) — не признак того, кто спросил.
    expect(botReplyAskerId(part('a3', 'q9', { replyTo: { id: 'other', senderId: 'me' } }), [])).toBeNull()
    expect(botReplyAskerId(part('n1', null, {}, 'notice'), [])).toBeNull()
    // Старый ответ без triggerMessageId: обращение — то, на что бот ответил.
    expect(botReplyAskerId(part('o1', null, { replyTo: { id: 'q0', senderId: 'sanya' } }), [])).toBe('sanya')
    expect(botReplyAskerId(part('o2', null, { replyToId: 'q0' }), [q('q0', 'me')])).toBe('me')
  })

  it('тот, кто спросил, — может; остальные участники — нет', () => {
    const list = [q('q1', 'me'), part('a1', 'q1', { replyTo: { id: 'q1', senderId: 'me' } }), part('a2', 'q1')]
    for (const m of list.slice(1)) {
      expect(canDeleteBotReply(m, { meId: 'me', botId: BOT, conversation: group, list })).toBe(true)
      expect(canDeleteBotReply(m, { meId: 'sanya', botId: BOT, conversation: group, list })).toBe(false)
    }
  })

  it('отчёт о долгой задаче — ответом на «да»: удалить может подтвердивший, а не тот, кто просил план', () => {
    const list = [
      q('q1', 'sanya'),
      part('plan', 'q1', { replyTo: { id: 'q1', senderId: 'sanya' } }, 'confirm'),
      { id: 'yes', conversationId: 'g1', senderId: 'me', content: 'да', replyTo: { id: 'plan', senderId: BOT, isBot: true } },
      part('rep', 'yes', { replyTo: { id: 'yes', senderId: 'me' } }, 'command'),
    ]
    expect(canDeleteBotReply(list[1], { meId: 'me', botId: BOT, conversation: group, list })).toBe(false)
    expect(canDeleteBotReply(list[1], { meId: 'sanya', botId: BOT, conversation: group, list })).toBe(true)
    expect(canDeleteBotReply(list[3], { meId: 'me', botId: BOT, conversation: group, list })).toBe(true)
    expect(canDeleteBotReply(list[3], { meId: 'sanya', botId: BOT, conversation: group, list })).toBe(false)
  })

  it('«Чат с Еблушей»: владелец удаляет любое сообщение бота, даже приветствие и уведомление без обращения', () => {
    const welcome = { ...part('w1', null, {}, 'welcome'), conversationId: 'bc1' }
    const notice = { ...part('n1', null, {}, 'notice'), conversationId: 'bc1' }
    expect(canDeleteBotReply(welcome, { meId: 'me', botId: BOT, conversation: botChat, list: [welcome] })).toBe(true)
    expect(canDeleteBotReply(notice, { meId: 'me', botId: BOT, conversation: botChat, list: [notice] })).toBe(true)
    // Не та беседа — не считается.
    expect(canDeleteBotReply({ ...notice, conversationId: 'g1' }, { meId: 'me', botId: BOT, conversation: botChat, list: [] })).toBe(false)
  })

  it('не ответ бота, удалённое, временное, неизвестный я — нет', () => {
    const list = [q('q1', 'me')]
    expect(canDeleteBotReply(q('q2', 'sanya'), { meId: 'me', botId: BOT, conversation: group, list })).toBe(false)
    expect(canDeleteBotReply(part('a1', 'q1', { deletedAt: '2026-10-10T00:00:00Z' }), { meId: 'me', botId: BOT, conversation: group, list })).toBe(false)
    expect(canDeleteBotReply(part('tmp-1', 'q1'), { meId: 'me', botId: BOT, conversation: group, list })).toBe(false)
    expect(canDeleteBotReply(part('a1', 'q1'), { meId: null, botId: BOT, conversation: botChat, list })).toBe(false)
    // Человек подделал metadata.bot (сервер такое вырезает) — без isBot это не ответ бота.
    expect(canDeleteBotReply({ ...q('q3', 'sanya'), metadata: { bot: { kind: 'answer', askerId: 'me' } } }, { meId: 'me', botId: BOT, conversation: group, list })).toBe(false)
  })

  it('удалить для всех: своё — всегда, ответ бота — по правилам выше, чужое — нет', () => {
    const list = [q('q1', 'me'), part('a1', 'q1', { replyTo: { id: 'q1', senderId: 'me' } })]
    expect(canDeleteMessageForAll(list[0], { meId: 'me', botId: BOT, conversation: group, list })).toBe(true)
    expect(canDeleteMessageForAll(list[1], { meId: 'me', botId: BOT, conversation: group, list })).toBe(true)
    expect(canDeleteMessageForAll(q('q2', 'sanya'), { meId: 'me', botId: BOT, conversation: group, list })).toBe(false)
    expect(canDeleteMessageForAll(list[1], { meId: 'sanya', botId: BOT, conversation: group, list })).toBe(false)
  })
})

describe('«Подумай лучше» под ответом бота', () => {
  const ans = (id: string, trig: string | null, extra: Record<string, unknown> = {}, kind = 'answer') => ({
    id,
    senderId: BOT,
    isBot: true,
    metadata: { bot: { v: 1, kind, ...(trig ? { triggerMessageId: trig } : {}), ...extra } },
  })
  const human = (id: string, sender = 'me', replyToId?: string, content = 'Еблуша, вопрос') => ({
    id,
    senderId: sender,
    isBot: false,
    content,
    ...(replyToId ? { replyTo: { id: replyToId } } : {}),
  })

  it('там же, где «Уточнить»: под последней частью, ответ — на первую часть', () => {
    const list = [human('q1'), ans('a1', 'q1'), ans('a2', 'q1')]
    expect(botThinkBetterTarget(list, 1, BOT, 'me')).toBeNull()
    expect(botThinkBetterTarget(list, 2, BOT, 'me')?.id).toBe('a1')
  })

  it('под ответом depth="deep" (уже подумал лучше) кнопки нет; «Уточнить» — есть', () => {
    const list = [human('q1'), ans('a1', 'q1', { depth: 'deep', model: 'claude-fable-5-1' })]
    expect(botThinkBetterTarget(list, 1, BOT, 'me')).toBeNull()
    expect(botClarifyTarget(list, 1, BOT)?.id).toBe('a1')
    // deep только у второй части — тоже весь ответ «глубокий»
    const list2 = [human('q1'), ans('a1', 'q1'), ans('a2', 'q1', { depth: 'deep' })]
    expect(botThinkBetterTarget(list2, 2, BOT, 'me')).toBeNull()
  })

  it('не под карточками, подтверждениями и уведомлениями', () => {
    const list = [human('q1'), ans('c1', 'q1', {}, 'card'), ans('k1', null, {}, 'confirm'), ans('n1', null, {}, 'notice')]
    expect(botThinkBetterTarget(list, 1, BOT, 'me')).toBeNull()
    expect(botThinkBetterTarget(list, 2, BOT, 'me')).toBeNull()
    expect(botThinkBetterTarget(list, 3, BOT, 'me')).toBeNull()
  })

  it('я уже попросил «подумай лучше» ответом на этот ответ — у меня кнопки нет, у других есть', () => {
    const list = [human('q1'), ans('a1', 'q1'), human('t1', 'me', 'a1', 'Еблуша, подумай лучше')]
    expect(botThinkBetterTarget(list, 1, BOT, 'me')).toBeNull()
    expect(botThinkBetterTarget(list, 1, BOT, 'sanya')?.id).toBe('a1')
    // обычное уточнение ответом — не мешает
    const list2 = [human('q1'), ans('a1', 'q1'), human('t1', 'me', 'a1', 'Еблуша, а подробнее?')]
    expect(botThinkBetterTarget(list2, 1, BOT, 'me')?.id).toBe('a1')
  })

  it('карточка с тем же обращением — не часть ответа: «Уточнить» не цепляется к ней', () => {
    // Карточка «поделиться перепиской» (ответ на вопрос), потом ответ по согласию — на тот же вопрос.
    const list = [human('q1'), ans('card1', 'q1', {}, 'card'), ans('a1', 'q1')]
    expect(botClarifyTarget(list, 2, BOT)?.id).toBe('a1')
    expect(botThinkBetterTarget(list, 2, BOT, 'me')?.id).toBe('a1')
    expect(isBotCardKind(list[1])).toBe(true)
    expect(isBotCardKind({ metadata: { bot: { kind: 'promise' } } })).toBe(true)
    expect(isBotCardKind(list[2])).toBe(false)
  })

  it('текст: «Еблуша, подумай лучше» и в «Чате с Еблушей» — «Подумай лучше»; распознаём варианты', () => {
    expect(botThinkBetterText(false)).toBe(BOT_THINK_BETTER_TEXT)
    expect(botThinkBetterText(false)).toBe('Еблуша, подумай лучше')
    expect(botThinkBetterText(true)).toBe('Подумай лучше')
    for (const t of ['Еблуша, подумай лучше', 'подумай лучше', 'Подумай ещё', 'еблуша: подумай как следует!', 'Подумай глубже.']) {
      expect(isThinkBetterRequestText(t)).toBe(true)
    }
    for (const t of ['подумай', 'Еблуша, подумай о погоде', 'не подумай лучше', 'подумай лучшее']) {
      expect(isThinkBetterRequestText(t)).toBe(false)
    }
  })
})
