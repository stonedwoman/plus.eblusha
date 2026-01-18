export type IntervalUTC = {
  startUtcISO: string
  endUtcISO: string
}

export type AvailabilityChatMessage = {
  id: string
  sender: 'me' | 'system'
  text: string
  createdAt: number
}

export type AvailabilityProposal = {
  id: string
  ranges: IntervalUTC[]
  createdAt: number
  createdById: string
  maxEndUtcISO: string
  note?: string | null
  reactionsByUserId: Record<string, 'YES' | 'MAYBE' | 'NO'>
}
