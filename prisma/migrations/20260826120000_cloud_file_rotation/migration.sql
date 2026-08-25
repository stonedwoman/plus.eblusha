-- Поворот фото и видео. Оригиналы неприкосновенны (контент-адресуемое
-- хранилище с дедупликацией по хэшу) — храним угол и перегенерируем превью.
ALTER TABLE "CloudFile" ADD COLUMN "rotation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CloudFileVariant" ADD COLUMN "rotation" INTEGER NOT NULL DEFAULT 0;
