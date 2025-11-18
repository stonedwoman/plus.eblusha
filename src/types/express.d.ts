type AuthUser = {
  id: string;
  username: string;
  displayName?: string | null;
};

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
    accessTokenId?: string;
  }
}

export {};


