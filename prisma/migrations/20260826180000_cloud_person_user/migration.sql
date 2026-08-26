-- Персона может быть связана с аккаунтом Еблуши (один аккаунт — одна персона).
ALTER TABLE "CloudPerson" ADD COLUMN "userId" TEXT;
CREATE UNIQUE INDEX "CloudPerson_userId_key" ON "CloudPerson"("userId");
ALTER TABLE "CloudPerson" ADD CONSTRAINT "CloudPerson_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
