import { create } from 'zustand'
import type { AvailabilityChatMessage, AvailabilityProposal, IntervalUTC } from './availability.types'
import { intervalKey } from './availability.time'

type AvailabilityByConversation = Record<string, Record<string, IntervalUTC[]>>
type ChatByKey = Record<string, AvailabilityChatMessage[]>
type ChatsByConversation = Record<string, ChatByKey>
type ProposalsByConversation = Record<string, AvailabilityProposal[]>

interface AvailabilityState {
  availabilityByConversation: AvailabilityByConversation
  chatsByConversation: ChatsByConversation
  proposalsByConversation: ProposalsByConversation
  addIntervals: (conversationId: string, userId: string, intervals: IntervalUTC[]) => void
  removeIntervals: (conversationId: string, userId: string, intervals: IntervalUTC[]) => void
  setIntervals: (conversationId: string, userId: string, intervals: IntervalUTC[]) => void
  addChatMessage: (conversationId: string, key: string, message: AvailabilityChatMessage) => void
  setProposals: (conversationId: string, proposals: AvailabilityProposal[]) => void
  upsertProposal: (conversationId: string, proposal: AvailabilityProposal) => void
  removeProposal: (conversationId: string, proposalId: string) => void
}

const ensureUserIntervals = (
  availabilityByConversation: AvailabilityByConversation,
  conversationId: string,
  userId: string,
) => {
  const conversation = availabilityByConversation[conversationId] ?? {}
  const intervals = conversation[userId] ?? []
  return { conversation, intervals }
}

const mergeIntervals = (base: IntervalUTC[], additions: IntervalUTC[]) => {
  const map = new Map(base.map((interval) => [intervalKey(interval), interval]))
  for (const interval of additions) {
    map.set(intervalKey(interval), interval)
  }
  return Array.from(map.values())
}

const removeIntervals = (base: IntervalUTC[], removals: IntervalUTC[]) => {
  const removeKeys = new Set(removals.map(intervalKey))
  return base.filter((interval) => !removeKeys.has(intervalKey(interval)))
}

export const useAvailabilityStore = create<AvailabilityState>((set) => ({
  availabilityByConversation: {},
  chatsByConversation: {},
  proposalsByConversation: {},
  addIntervals: (conversationId, userId, intervals) => {
    set((state) => {
      const { conversation, intervals: current } = ensureUserIntervals(state.availabilityByConversation, conversationId, userId)
      const nextIntervals = mergeIntervals(current, intervals)
      return {
        availabilityByConversation: {
          ...state.availabilityByConversation,
          [conversationId]: {
            ...conversation,
            [userId]: nextIntervals,
          },
        },
      }
    })
  },
  removeIntervals: (conversationId, userId, intervals) => {
    set((state) => {
      const { conversation, intervals: current } = ensureUserIntervals(state.availabilityByConversation, conversationId, userId)
      const nextIntervals = removeIntervals(current, intervals)
      return {
        availabilityByConversation: {
          ...state.availabilityByConversation,
          [conversationId]: {
            ...conversation,
            [userId]: nextIntervals,
          },
        },
      }
    })
  },
  setIntervals: (conversationId, userId, intervals) => {
    set((state) => ({
      availabilityByConversation: {
        ...state.availabilityByConversation,
        [conversationId]: {
          ...(state.availabilityByConversation[conversationId] ?? {}),
          [userId]: intervals,
        },
      },
    }))
  },
  addChatMessage: (conversationId, key, message) => {
    set((state) => {
      const conversationChats = state.chatsByConversation[conversationId] ?? {}
      const list = conversationChats[key] ?? []
      return {
        chatsByConversation: {
          ...state.chatsByConversation,
          [conversationId]: {
            ...conversationChats,
            [key]: [...list, message],
          },
        },
      }
    })
  },
  setProposals: (conversationId, proposals) => {
    set((state) => ({
      proposalsByConversation: {
        ...state.proposalsByConversation,
        [conversationId]: proposals,
      },
    }))
  },
  upsertProposal: (conversationId, proposal) => {
    set((state) => {
      const list = state.proposalsByConversation[conversationId] ?? []
      const idx = list.findIndex((p) => p.id === proposal.id)
      const next = idx >= 0 ? [...list.slice(0, idx), proposal, ...list.slice(idx + 1)] : [proposal, ...list]
      return {
        proposalsByConversation: {
          ...state.proposalsByConversation,
          [conversationId]: next,
        },
      }
    })
  },
  removeProposal: (conversationId, proposalId) => {
    set((state) => {
      const list = state.proposalsByConversation[conversationId] ?? []
      return {
        proposalsByConversation: {
          ...state.proposalsByConversation,
          [conversationId]: list.filter((p) => p.id !== proposalId),
        },
      }
    })
  },
}))
