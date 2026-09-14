ALTER TABLE "Automation"
ADD COLUMN "dmRecoveryEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "dmRecoveryMessage" TEXT NOT NULL DEFAULT 'Mesaj ulaşmadıysa bana DM’den {keyword} yaz.';

ALTER TABLE "DmLog"
ADD COLUMN "recoveryCommentSentAt" TIMESTAMP(3),
ADD COLUMN "recoveryCommentError" TEXT;
