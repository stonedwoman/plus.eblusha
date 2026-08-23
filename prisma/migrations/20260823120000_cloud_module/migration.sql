-- Eblusha Cloud: только новые таблицы Cloud*.
-- Из diff вручную вырезан посторонний дрейф схемы (индексы User_*, PK secret-таблиц),
-- который не относится к Cloud и не должен применяться этой миграцией.

-- CreateEnum
CREATE TYPE "CloudSpaceRole" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "CloudEncryptionMode" AS ENUM ('STANDARD', 'E2EE');

-- CreateEnum
CREATE TYPE "CloudUploadStatus" AS ENUM ('CREATED', 'UPLOADING', 'PAUSED', 'UPLOADED', 'VERIFYING', 'PROCESSING', 'READY', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CloudFileStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "CloudFileKind" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "CloudVariantKind" AS ENUM ('THUMB', 'PREVIEW', 'POSTER', 'PLAYBACK');

-- CreateEnum
CREATE TYPE "CloudVariantStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "CloudShareTargetType" AS ENUM ('SPACE', 'FOLDER', 'FILE', 'SELECTION');

-- CreateEnum
CREATE TYPE "CloudReactionTargetType" AS ENUM ('FILE', 'COMMENT');

-- CreateEnum
CREATE TYPE "CloudActivityType" AS ENUM ('SPACE_CREATED', 'SPACE_UPDATED', 'MEMBER_ADDED', 'MEMBER_REMOVED', 'MEMBER_ROLE_CHANGED', 'FILES_UPLOADED', 'FILES_DELETED', 'FILES_RESTORED', 'FILES_SAVED', 'FOLDER_CREATED', 'FOLDER_RENAMED', 'FOLDER_DELETED', 'COMMENT_CREATED', 'SHARE_CREATED', 'SHARE_REVOKED');

-- CreateTable
CREATE TABLE "CloudSpace" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT NOT NULL,
    "encryptionMode" "CloudEncryptionMode" NOT NULL DEFAULT 'STANDARD',
    "coverFileId" TEXT,
    "dateFrom" TIMESTAMP(3),
    "dateTo" TIMESTAMP(3),
    "viewerCanComment" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CloudSpace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudSpaceMember" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CloudSpaceRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "invitedById" TEXT,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "CloudSpaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudFolder" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "spaceId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CloudFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudStorageObject" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sha256" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "detectedMime" TEXT,
    "refCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CloudStorageObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudFile" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "spaceId" TEXT NOT NULL,
    "folderId" TEXT,
    "storageObjectId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "kind" "CloudFileKind" NOT NULL DEFAULT 'OTHER',
    "uploaderId" TEXT NOT NULL,
    "status" "CloudFileStatus" NOT NULL DEFAULT 'PROCESSING',
    "processingError" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "orientation" INTEGER,
    "durationMs" INTEGER,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "takenAtSource" TEXT NOT NULL DEFAULT 'upload',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "cameraMake" TEXT,
    "cameraModel" TEXT,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "bitrate" INTEGER,
    "directPlayable" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "CloudFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudFileVariant" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileId" TEXT NOT NULL,
    "kind" "CloudVariantKind" NOT NULL,
    "status" "CloudVariantStatus" NOT NULL DEFAULT 'PENDING',
    "storagePath" TEXT,
    "mimeType" TEXT,
    "size" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "error" TEXT,

    CONSTRAINT "CloudFileVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudUploadSession" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "folderId" TEXT,
    "originalName" TEXT NOT NULL,
    "expectedSize" BIGINT NOT NULL,
    "mimeType" TEXT,
    "fingerprint" TEXT NOT NULL,
    "uploadProtocolId" TEXT NOT NULL,
    "bytesReceived" BIGINT NOT NULL DEFAULT 0,
    "status" "CloudUploadStatus" NOT NULL DEFAULT 'CREATED',
    "clientMtime" TIMESTAMP(3),
    "error" TEXT,
    "fileId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudShareLink" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "spaceId" TEXT NOT NULL,
    "targetType" "CloudShareTargetType" NOT NULL,
    "targetId" TEXT,
    "fileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenHash" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "allowPreview" BOOLEAN NOT NULL DEFAULT true,
    "allowDownload" BOOLEAN NOT NULL DEFAULT true,
    "passwordHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,

    CONSTRAINT "CloudShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudInvite" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "role" "CloudSpaceRole" NOT NULL DEFAULT 'EDITOR',
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "CloudInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudComment" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "spaceId" TEXT NOT NULL,
    "fileId" TEXT,
    "authorId" TEXT NOT NULL,
    "parentCommentId" TEXT,
    "body" TEXT NOT NULL,
    "videoTimestampMs" INTEGER,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CloudComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudReaction" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetType" "CloudReactionTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,

    CONSTRAINT "CloudReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudFavorite" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,

    CONSTRAINT "CloudFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudActivityEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" "CloudActivityType" NOT NULL,
    "payload" JSONB,

    CONSTRAINT "CloudActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudAuditEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "spaceId" TEXT,
    "targetId" TEXT,
    "ip" TEXT,
    "detail" JSONB,

    CONSTRAINT "CloudAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CloudSpace_ownerId_deletedAt_idx" ON "CloudSpace"("ownerId", "deletedAt");

-- CreateIndex
CREATE INDEX "CloudSpace_deletedAt_createdAt_idx" ON "CloudSpace"("deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "CloudSpaceMember_userId_idx" ON "CloudSpaceMember"("userId");

-- CreateIndex
CREATE INDEX "CloudSpaceMember_spaceId_role_idx" ON "CloudSpaceMember"("spaceId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "CloudSpaceMember_spaceId_userId_key" ON "CloudSpaceMember"("spaceId", "userId");

-- CreateIndex
CREATE INDEX "CloudFolder_spaceId_parentId_deletedAt_idx" ON "CloudFolder"("spaceId", "parentId", "deletedAt");

-- CreateIndex
CREATE INDEX "CloudFolder_spaceId_deletedAt_idx" ON "CloudFolder"("spaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "CloudFolder_parentId_idx" ON "CloudFolder"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudStorageObject_sha256_key" ON "CloudStorageObject"("sha256");

-- CreateIndex
CREATE INDEX "CloudStorageObject_refCount_idx" ON "CloudStorageObject"("refCount");

-- CreateIndex
CREATE INDEX "CloudStorageObject_createdAt_idx" ON "CloudStorageObject"("createdAt");

-- CreateIndex
CREATE INDEX "CloudFile_spaceId_deletedAt_takenAt_idx" ON "CloudFile"("spaceId", "deletedAt", "takenAt");

-- CreateIndex
CREATE INDEX "CloudFile_spaceId_folderId_deletedAt_originalName_idx" ON "CloudFile"("spaceId", "folderId", "deletedAt", "originalName");

-- CreateIndex
CREATE INDEX "CloudFile_spaceId_deletedAt_createdAt_idx" ON "CloudFile"("spaceId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "CloudFile_spaceId_kind_deletedAt_idx" ON "CloudFile"("spaceId", "kind", "deletedAt");

-- CreateIndex
CREATE INDEX "CloudFile_uploaderId_createdAt_idx" ON "CloudFile"("uploaderId", "createdAt");

-- CreateIndex
CREATE INDEX "CloudFile_storageObjectId_idx" ON "CloudFile"("storageObjectId");

-- CreateIndex
CREATE INDEX "CloudFile_deletedAt_idx" ON "CloudFile"("deletedAt");

-- CreateIndex
CREATE INDEX "CloudFileVariant_kind_status_idx" ON "CloudFileVariant"("kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CloudFileVariant_fileId_kind_key" ON "CloudFileVariant"("fileId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CloudUploadSession_uploadProtocolId_key" ON "CloudUploadSession"("uploadProtocolId");

-- CreateIndex
CREATE INDEX "CloudUploadSession_userId_status_idx" ON "CloudUploadSession"("userId", "status");

-- CreateIndex
CREATE INDEX "CloudUploadSession_spaceId_status_idx" ON "CloudUploadSession"("spaceId", "status");

-- CreateIndex
CREATE INDEX "CloudUploadSession_expiresAt_idx" ON "CloudUploadSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CloudUploadSession_userId_fingerprint_idx" ON "CloudUploadSession"("userId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "CloudShareLink_tokenHash_key" ON "CloudShareLink"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "CloudShareLink_publicId_key" ON "CloudShareLink"("publicId");

-- CreateIndex
CREATE INDEX "CloudShareLink_spaceId_revokedAt_idx" ON "CloudShareLink"("spaceId", "revokedAt");

-- CreateIndex
CREATE INDEX "CloudShareLink_createdById_idx" ON "CloudShareLink"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "CloudInvite_tokenHash_key" ON "CloudInvite"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "CloudInvite_publicId_key" ON "CloudInvite"("publicId");

-- CreateIndex
CREATE INDEX "CloudInvite_spaceId_revokedAt_idx" ON "CloudInvite"("spaceId", "revokedAt");

-- CreateIndex
CREATE INDEX "CloudComment_spaceId_createdAt_idx" ON "CloudComment"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "CloudComment_fileId_createdAt_idx" ON "CloudComment"("fileId", "createdAt");

-- CreateIndex
CREATE INDEX "CloudComment_parentCommentId_idx" ON "CloudComment"("parentCommentId");

-- CreateIndex
CREATE INDEX "CloudComment_authorId_idx" ON "CloudComment"("authorId");

-- CreateIndex
CREATE INDEX "CloudReaction_targetType_targetId_idx" ON "CloudReaction"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "CloudReaction_spaceId_idx" ON "CloudReaction"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudReaction_targetType_targetId_userId_emoji_key" ON "CloudReaction"("targetType", "targetId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "CloudFavorite_userId_createdAt_idx" ON "CloudFavorite"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CloudFavorite_fileId_idx" ON "CloudFavorite"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudFavorite_userId_fileId_key" ON "CloudFavorite"("userId", "fileId");

-- CreateIndex
CREATE INDEX "CloudActivityEvent_spaceId_createdAt_idx" ON "CloudActivityEvent"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "CloudActivityEvent_actorId_createdAt_idx" ON "CloudActivityEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "CloudAuditEvent_createdAt_idx" ON "CloudAuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "CloudAuditEvent_actorId_createdAt_idx" ON "CloudAuditEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "CloudAuditEvent_spaceId_createdAt_idx" ON "CloudAuditEvent"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "CloudAuditEvent_action_createdAt_idx" ON "CloudAuditEvent"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "CloudSpace" ADD CONSTRAINT "CloudSpace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudSpaceMember" ADD CONSTRAINT "CloudSpaceMember_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "CloudSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudSpaceMember" ADD CONSTRAINT "CloudSpaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFolder" ADD CONSTRAINT "CloudFolder_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "CloudSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFolder" ADD CONSTRAINT "CloudFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CloudFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFile" ADD CONSTRAINT "CloudFile_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "CloudSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFile" ADD CONSTRAINT "CloudFile_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "CloudFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFile" ADD CONSTRAINT "CloudFile_storageObjectId_fkey" FOREIGN KEY ("storageObjectId") REFERENCES "CloudStorageObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFile" ADD CONSTRAINT "CloudFile_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFileVariant" ADD CONSTRAINT "CloudFileVariant_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "CloudFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudUploadSession" ADD CONSTRAINT "CloudUploadSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudShareLink" ADD CONSTRAINT "CloudShareLink_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "CloudSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudShareLink" ADD CONSTRAINT "CloudShareLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudInvite" ADD CONSTRAINT "CloudInvite_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "CloudSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudInvite" ADD CONSTRAINT "CloudInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudComment" ADD CONSTRAINT "CloudComment_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "CloudSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudComment" ADD CONSTRAINT "CloudComment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "CloudFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudComment" ADD CONSTRAINT "CloudComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudComment" ADD CONSTRAINT "CloudComment_parentCommentId_fkey" FOREIGN KEY ("parentCommentId") REFERENCES "CloudComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudReaction" ADD CONSTRAINT "CloudReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFavorite" ADD CONSTRAINT "CloudFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudFavorite" ADD CONSTRAINT "CloudFavorite_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "CloudFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudActivityEvent" ADD CONSTRAINT "CloudActivityEvent_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "CloudSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudActivityEvent" ADD CONSTRAINT "CloudActivityEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
