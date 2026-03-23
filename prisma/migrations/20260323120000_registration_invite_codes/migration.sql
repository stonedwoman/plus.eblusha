CREATE TABLE "RegistrationInviteCode" (
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "minuteBucket" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationInviteCode_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "RegistrationInviteCode_code_key" ON "RegistrationInviteCode"("code");

ALTER TABLE "RegistrationInviteCode"
ADD CONSTRAINT "RegistrationInviteCode_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
