-- Публичная ссылка по умолчанию больше не раздаёт EXIF.
-- Координаты съёмки в публичной галерее — это адрес дома, школы и работы;
-- отдавать их вместе с картинкой «за компанию» нельзя.
ALTER TABLE "CloudShareLink" ADD COLUMN "allowMetadata" BOOLEAN NOT NULL DEFAULT false;
