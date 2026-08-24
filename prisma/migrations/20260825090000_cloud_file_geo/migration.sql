-- Обратное геокодирование снимков: страна / город / район из EXIF-координат.
ALTER TABLE "CloudFile" ADD COLUMN "geoCountryCode" TEXT;
ALTER TABLE "CloudFile" ADD COLUMN "geoCountry" TEXT;
ALTER TABLE "CloudFile" ADD COLUMN "geoCity" TEXT;
ALTER TABLE "CloudFile" ADD COLUMN "geoDistrict" TEXT;
ALTER TABLE "CloudFile" ADD COLUMN "geoPath" TEXT;
ALTER TABLE "CloudFile" ADD COLUMN "geoResolvedAt" TIMESTAMP(3);

-- Группы мест идут подряд и листаются тем же двухполевым курсором.
CREATE INDEX "CloudFile_spaceId_deletedAt_geoPath_idx" ON "CloudFile"("spaceId", "deletedAt", "geoPath");
