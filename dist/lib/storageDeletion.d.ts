export declare function extractS3KeyCandidatesFromUrl(url: string): string[];
export declare function deleteS3ObjectsByUrls(urls: string[], opts?: {
    reason?: string;
}): Promise<{
    ok: false;
    reason: "s3_not_configured";
    deleted?: never;
    skipped?: never;
    candidates?: never;
} | {
    ok: true;
    deleted: number;
    skipped: number;
    reason?: never;
    candidates?: never;
} | {
    ok: true;
    deleted: number;
    candidates: number;
    reason?: never;
    skipped?: never;
}>;
//# sourceMappingURL=storageDeletion.d.ts.map