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
};

/**
 * Звонок «горит»: доставлять немедленно, будить уснувшее приложение.
 * Обычное сообщение может подождать — иначе система быстро урежет нам лимиты.
 */
export function isUrgent(payload: PushPayload): boolean {
  return payload.kind === "call" || payload.kind === "call-cancel";
}
