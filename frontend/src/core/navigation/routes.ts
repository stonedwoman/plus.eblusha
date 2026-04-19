export function getAppRoutePrefix(pathname: string): '' | '/app' {
  return pathname === '/app' || pathname.startsWith('/app/') ? '/app' : ''
}

export function withAppRoutePrefix(pathname: string, route: string): string {
  const normalizedRoute = route.startsWith('/') ? route : `/${route}`
  return `${getAppRoutePrefix(pathname)}${normalizedRoute}`
}

export function isChatsRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/app' ||
    pathname === '/chats' ||
    pathname === '/app/chats' ||
    pathname.startsWith('/chats/') ||
    pathname.startsWith('/app/chats/')
  )
}
