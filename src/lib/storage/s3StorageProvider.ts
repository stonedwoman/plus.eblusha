import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import type { StorageProvider, StorageHeadResult, StorageGetResult } from "./types";

export interface S3StorageProviderOptions {
  bucket: string;
  client: S3Client;
}

export class S3StorageProvider implements StorageProvider {
  constructor(private readonly options: S3StorageProviderOptions) {}

  isAvailable(): boolean {
    return !!this.options.bucket && !!this.options.client;
  }

  async putObject(
    key: string,
    body: Buffer | Readable,
    options?: { contentType?: string; metadata?: Record<string, string> }
  ): Promise<void> {
    await this.options.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: options?.contentType ?? "application/octet-stream",
        Metadata: options?.metadata,
      })
    );
  }

  async headObject(key: string): Promise<StorageHeadResult | null> {
    try {
      const resp = await this.options.client.send(
        new HeadObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
        })
      );
      const out: StorageHeadResult = {
        metadata: (resp.Metadata as Record<string, string>) ?? {},
      };
      if (resp.ContentLength != null) out.contentLength = resp.ContentLength;
      if (resp.ContentType != null) out.contentType = resp.ContentType;
      if (resp.LastModified != null) out.lastModified = resp.LastModified;
      if (resp.ETag != null) out.etag = resp.ETag;
      return out;
    } catch (e: any) {
      if (
        e?.name === "NotFound" ||
        e?.$metadata?.httpStatusCode === 404 ||
        e?.name === "NoSuchKey"
      ) {
        return null;
      }
      throw e;
    }
  }

  async getObject(
    key: string,
    range?: { start: number; end: number }
  ): Promise<StorageGetResult> {
    const params: any = {
      Bucket: this.options.bucket,
      Key: key,
    };
    if (range !== undefined) {
      params.Range = `bytes=${range.start}-${range.end}`;
    }
    const resp = await this.options.client.send(new GetObjectCommand(params));
    const metadata = (resp.Metadata as Record<string, string>) ?? {};
    const result: StorageGetResult = {
      body: resp.Body as Readable,
      metadata,
    };
    if (resp.ContentLength != null) result.contentLength = resp.ContentLength;
    if (resp.ContentType != null) result.contentType = resp.ContentType;
    return result;
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.options.client.send(
        new DeleteObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
        })
      );
    } catch (e: any) {
      if (
        e?.name === "NotFound" ||
        e?.$metadata?.httpStatusCode === 404 ||
        e?.name === "NoSuchKey"
      ) {
        return; // no-op
      }
      throw e;
    }
  }

  async deleteObjects(keys: string[]): Promise<{ deleted: number }> {
    const results = await Promise.allSettled(
      keys.map((Key) =>
        this.options.client.send(
          new DeleteObjectCommand({
            Bucket: this.options.bucket,
            Key,
          })
        )
      )
    );
    const deleted = results.filter((r) => r.status === "fulfilled").length;
    return { deleted };
  }
}
