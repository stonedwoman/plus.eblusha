/**
 * Push-уведомления: общий контракт для всех платформ.
 *
 * Сегодня реализован только FCM (Android), APNs добавляется сюда же вторым провайдером —
 * ради этого отправка описана в терминах «что случилось», а не «какой JSON слать Google».
 */

/** Чем доставляем. Токен привязан к устройству (UserDevice.pushProvider). */
export type PushProvider = "fcm" | "apns" | "apns-voip";

/** Данные летят БЕЗ текста сообщения: сервер не должен раскрывать переписку через Google/Apple. */
export type PushPayload =
  | {
      kind: "message";
      conversationId: string;
      messageId: string;
      senderId: string;
      /** Имя отправителя — единственное, что показываем до открытия приложения. */
      senderName: string;
      /** Короткая пометка вида «Фото»/«Голосовое»; для текста — пусто, клиент подтянет сам. */
      preview?: string;
      /** Секретные беседы: клиент обязан сходить за содержимым сам. */
      secret?: boolean;
    }
  | {
      kind: "call";
      conversationId: string;
      callerId: string;
      callerName: string;
      video: boolean;
    }
  | {
      kind: "call-cancel";
      conversationId: string;
    }
  | {
      /**
       * «Беседа прочитана на другом устройстве»: тихий пуш только для iOS (APNs background),
       * по нему приложение снимает уже доставленные баннеры этой беседы. Ни текста, ни имён —
       * только conversationId (для секретных бесед так же). На Android/FCM не уходит никогда.
       */
      kind: "read";
      conversationId: string;
      /**
       * Когда беседу прочитали (мс, часы сервера; подставляет воркер из Redis, см. push/readSync.ts).
       * Пуш может прийти позже — «хвост» дребезга, телефон без сети, — и снимать надо только баннеры,
       * пришедшие до прочтения, а не те, что показаны после него: они ещё не прочитаны. Нет поля
       * (старый сервер, сбой Redis) — приложение снимает все баннеры беседы.
       */
      readAt?: number;
    };

export type PushTarget = {
  userId: string;
  deviceId: string;
  token: string;
  provider: PushProvider;
};

export type PushSendResult = {
  sent: number;
  /** Токены, которые больше не существуют — их надо снять с устройств. */
  dead: string[];
  /**
   * Сбой временный (сеть, таймаут, 429/5xx у провайдера) — job имеет смысл повторить.
   * Отсутствие = false: либо всё доставлено, либо ошибка наша (кривой запрос, ключ,
   * мёртвый токен), и повтор ничего не изменит.
   */
  retryable?: boolean;
};

/**
 * Звонок «горит»: доставлять немедленно, будить уснувшее приложение.
 * Обычное сообщение может подождать — иначе система быстро урежет нам лимиты.
 */
export function isUrgent(payload: PushPayload): boolean {
  return payload.kind === "call" || payload.kind === "call-cancel";
}
