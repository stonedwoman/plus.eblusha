import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
  }
}

type AuthUser = {
  id: string;
  username: string;
  displayName?: string | null;
};

type CloudUser = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

type CloudShareContext = {
  share: import("@prisma/client").CloudShareLink;
  space: import("@prisma/client").CloudSpace;
};

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
    accessTokenId?: string;
    deviceId?: string;
    rawBody?: Buffer;
    // Eblusha Cloud: своя сессия, независимая от Bearer мессенджера.
    cloudUser?: CloudUser;
    cloudSessionId?: string;
    cloudCsrf?: string;
    // Контекст публичной share-ссылки (см. src/cloud/routes/public.ts).
    shareLink?: CloudShareContext | null;
  }
}

export {};


