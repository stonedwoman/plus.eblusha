import { filterUnackedTargets, hasKeyReceipt } from '../../secret/secretKeyShareState'

export function threadHasReceiptFromDevice(threadId: string, deviceId: string): boolean {
  return hasKeyReceipt(threadId, deviceId)
}

export function getUnackedTargetDevices(threadId: string, allDeviceIds: string[]): string[] {
  return filterUnackedTargets(threadId, allDeviceIds)
}

