/**
 * Только для отображения: 8 цифр как "XXXX XXXX" в одной строке.
 * Копирование и API по-прежнему используют код без пробела.
 */
export function formatRegistrationInviteCodeForDisplay(code: string | undefined | null): string {
  const digits = String(code ?? '').replace(/\D/g, '')
  if (!digits) return '---- ----'
  if (digits.length === 8) return `${digits.slice(0, 4)} ${digits.slice(4)}`
  return digits
}
