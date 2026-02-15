import crypto from "crypto";
import env from "../config/env";
import prisma from "./prisma";
import {
  decryptBuffer,
  encryptBuffer,
  parseStorageEncKey,
  StorageEncryptionError,
} from "./storageEncryption";

export class NonSecretChatEncryptionError extends Error {}

const getChatKek = (): Buffer => {
  if (!env.CHAT_ENC_KEK) {
    throw new NonSecretChatEncryptionError(
      "CHAT_ENC_KEK is not configured (required for non-secret chat server-side encryption)"
    );
  }
  try {
    return parseStorageEncKey(env.CHAT_ENC_KEK);
  } catch (e: any) {
    throw new NonSecretChatEncryptionError(e?.message || "Invalid CHAT_ENC_KEK");
  }
};

const generateDek = (): Buffer => crypto.randomBytes(32);

const wrapDek = (dek: Buffer, kek: Buffer, conversationId: string): string => {
  const wrapped = encryptBuffer(dek, kek, { aad: conversationId });
  return wrapped.payload.toString("base64");
};

const unwrapDek = (wrappedBase64: string, kek: Buffer, conversationId: string): Buffer => {
  const payload = Buffer.from(wrappedBase64, "base64");
  return decryptBuffer(payload, kek, { aad: conversationId });
};

export async function getNonSecretConversationDek(conversationId: string): Promise<Buffer> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, isSecret: true, nonSecretDekWrapped: true },
  });
  if (!conv) throw new NonSecretChatEncryptionError("Conversation not found");
  if (conv.isSecret) {
    throw new NonSecretChatEncryptionError(
      "Non-secret conversation DEK requested for a secret conversation"
    );
  }
  if (!conv.nonSecretDekWrapped) {
    throw new NonSecretChatEncryptionError("Conversation DEK is not initialized");
  }
  const kek = getChatKek();
  try {
    return unwrapDek(conv.nonSecretDekWrapped, kek, conv.id);
  } catch (e: any) {
    throw new NonSecretChatEncryptionError(e?.message || "Failed to unwrap conversation DEK");
  }
}

export async function getOrCreateNonSecretConversationDek(conversationId: string): Promise<Buffer> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, isSecret: true, nonSecretDekWrapped: true },
  });
  if (!conv) throw new NonSecretChatEncryptionError("Conversation not found");
  if (conv.isSecret) {
    throw new NonSecretChatEncryptionError(
      "Non-secret conversation DEK requested for a secret conversation"
    );
  }

  const kek = getChatKek();

  if (conv.nonSecretDekWrapped) {
    try {
      return unwrapDek(conv.nonSecretDekWrapped, kek, conv.id);
    } catch (e: any) {
      throw new NonSecretChatEncryptionError(
        e?.message || "Failed to unwrap conversation DEK"
      );
    }
  }

  // Create lazily, race-safe: only set if still null.
  const dek = generateDek();
  const wrapped = wrapDek(dek, kek, conv.id);

  const updated = await prisma.conversation.updateMany({
    where: { id: conv.id, isSecret: false, nonSecretDekWrapped: null },
    data: { nonSecretDekWrapped: wrapped },
  });

  if (updated.count === 1) {
    return dek;
  }

  // Someone else created it; refetch and unwrap.
  const conv2 = await prisma.conversation.findUnique({
    where: { id: conv.id },
    select: { id: true, nonSecretDekWrapped: true },
  });
  if (!conv2?.nonSecretDekWrapped) {
    throw new NonSecretChatEncryptionError("Failed to persist conversation DEK");
  }
  return unwrapDek(conv2.nonSecretDekWrapped, kek, conv2.id);
}

export function encryptNonSecretChatText(plaintext: string, dek: Buffer, aad: string): string {
  const encrypted = encryptBuffer(Buffer.from(plaintext, "utf8"), dek, { aad });
  return encrypted.payload.toString("base64");
}

export function decryptNonSecretChatText(ciphertextBase64: string, dek: Buffer, aad: string): string {
  try {
    const payload = Buffer.from(ciphertextBase64, "base64");
    return decryptBuffer(payload, dek, { aad }).toString("utf8");
  } catch (e: any) {
    // Preserve original error class for easier debugging
    if (e instanceof StorageEncryptionError) throw e;
    throw new NonSecretChatEncryptionError(e?.message || "Failed to decrypt chat text");
  }
}

