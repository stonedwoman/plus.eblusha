import { api, getUploadUrl } from '../core/api'
import { forceRefreshSession, installSessionInterceptors } from '../core/auth'

installSessionInterceptors()

export { api, forceRefreshSession, getUploadUrl }

