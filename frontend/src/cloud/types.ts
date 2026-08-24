export type CloudUserLite = {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
}

export type CloudFileKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'OTHER'

export type CloudFile = {
  id: string
  spaceId: string
  folderId: string | null
  name: string
  mime: string
  size: number
  kind: CloudFileKind
  status: 'PROCESSING' | 'READY' | 'FAILED'
  processingError: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: string
  takenAtSource: string
  createdAt: string
  deletedAt: string | null
  latitude: number | null
  longitude: number | null
  /** Место съёмки: офлайн-геокодирование EXIF-координат, глубже района не идём. */
  geoCountry: string | null
  geoCity: string | null
  geoDistrict: string | null
  geoPath: string | null
  cameraMake: string | null
  cameraModel: string | null
  videoCodec: string | null
  audioCodec: string | null
  bitrate: number | null
  metadata: Record<string, unknown> | null
  uploader: CloudUserLite | null
  favorite: boolean
  commentCount: number
  reactions: Record<string, number>
  myReactions: string[]
  urls: {
    thumb: string | null
    preview: string | null
    poster: string | null
    content: string | null
    playback: string | null
    download: string | null
  }
  playbackSource: 'derived' | 'original' | null
}

export type CloudSpaceMember = CloudUserLite & { role: 'OWNER' | 'EDITOR' | 'VIEWER' }

export type CloudSpace = {
  id: string
  name: string
  description: string | null
  ownerId: string
  encryptionMode: 'STANDARD' | 'E2EE'
  coverFileId: string | null
  coverUrl: string | null
  dateFrom: string | null
  dateTo: string | null
  viewerCanComment: boolean
  createdAt: string
  updatedAt: string
  role: 'OWNER' | 'EDITOR' | 'VIEWER' | null
  members: CloudSpaceMember[]
  stats: { photos: number; videos: number; others: number; bytes: number; files: number } | null
}

export type CloudFolder = {
  id: string
  spaceId: string
  parentId: string | null
  name: string
  createdAt: string
  deletedAt: string | null
  fileCount: number
  childCount: number
}

export type CloudComment = {
  id: string
  spaceId: string
  fileId: string | null
  parentCommentId: string | null
  body: string | null
  videoTimestampMs: number | null
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  author: CloudUserLite | null
  reactions: Record<string, number>
  myReactions: string[]
}

export type CloudActivity = {
  id: string
  type: string
  createdAt: string
  payload: Record<string, unknown> | null
  actor: CloudUserLite | null
}

export type CloudShare = {
  id: string
  publicId: string
  targetType: 'SPACE' | 'FOLDER' | 'FILE' | 'SELECTION'
  targetId: string | null
  fileCount: number
  allowPreview: boolean
  allowDownload: boolean
  allowMetadata: boolean
  hasPassword: boolean
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
  viewCount: number
  downloadCount: number
  label: string | null
  path: string
}

export type CloudInvite = {
  id: string
  publicId: string
  role: string
  maxUses: number
  useCount: number
  expiresAt: string | null
  createdAt: string
  note: string | null
}

export type PresenceEntry = { userId: string; since: number }
