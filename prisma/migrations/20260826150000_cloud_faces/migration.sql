-- Распознавание лиц: персоны и найденные лица с ArcFace-эмбеддингами.
ALTER TABLE "CloudFile" ADD COLUMN "facesScannedAt" TIMESTAMP(3);

CREATE TABLE "CloudPerson" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT NOT NULL,
  "coverFaceId" TEXT,
  CONSTRAINT "CloudPerson_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CloudFace" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fileId" TEXT NOT NULL,
  "x" DOUBLE PRECISION NOT NULL,
  "y" DOUBLE PRECISION NOT NULL,
  "w" DOUBLE PRECISION NOT NULL,
  "h" DOUBLE PRECISION NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "embedding" BYTEA NOT NULL,
  "personId" TEXT,
  "assignedBy" TEXT,
  "matchScore" DOUBLE PRECISION,
  CONSTRAINT "CloudFace_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CloudFace_fileId_idx" ON "CloudFace"("fileId");
CREATE INDEX "CloudFace_personId_idx" ON "CloudFace"("personId");

ALTER TABLE "CloudFace" ADD CONSTRAINT "CloudFace_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "CloudFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CloudFace" ADD CONSTRAINT "CloudFace_personId_fkey" FOREIGN KEY ("personId") REFERENCES "CloudPerson"("id") ON DELETE SET NULL ON UPDATE CASCADE;
