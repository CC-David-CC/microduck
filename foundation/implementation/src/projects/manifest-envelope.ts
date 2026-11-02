import { readManifestJson } from './manifest-json.ts';
import type { JsonObject, JsonValue, ManifestJsonDocument, ManifestJsonLimits } from './manifest-json.ts';
import type { ExpectedFile } from './file-snapshot.ts';
import { safeProjectPath } from './project-path.ts';

export interface ManifestEnvelope {
  readonly document: Readonly<ManifestJsonDocument>;
  readonly files: Readonly<Record<string, Readonly<ExpectedFile>>>;
}

function object(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate declarations only. File contents, closure and run readiness remain unverified. */
export async function readManifestEnvelope(
  content: Blob, limits: ManifestJsonLimits,
): Promise<Readonly<ManifestEnvelope>> {
  try {
    const document = await readManifestJson(content, limits);
    const data = document.data;
    const token = (path: readonly string[]): string | undefined => {
      const span = document.numberSpan(path);
      return span ? document.source.slice(span.start, span.end) : undefined;
    };
    if (!Object.hasOwn(data, 'schema_version') || data.schema_version !== 2 ||
        token(['schema_version']) !== '2') throw new Error('Manifest requires literal schema_version 2');
    const files = data.files;
    if (!Object.hasOwn(data, 'files') || !object(files) || Object.keys(files).length === 0) {
      throw new Error('Manifest requires a nonempty files object');
    }
    for (const [path, record] of Object.entries(files)) {
      safeProjectPath(path);
      if (path === 'manifest.json') throw new Error('Manifest must not list itself');
      if (!object(record) || Object.keys(record).length !== 2 ||
          !Object.hasOwn(record, 'bytes') || !Object.hasOwn(record, 'sha256')) {
        throw new Error(`File record must contain exactly bytes and sha256: ${path}`);
      }
      const count = record.bytes, spelling = token(['files', path, 'bytes']);
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 ||
          spelling === undefined || !/^(0|[1-9][0-9]*)$/.test(spelling)) {
        throw new Error(`File bytes require an unsigned safe integer token: ${path}`);
      }
      const digest = record.sha256;
      if (typeof digest !== 'string' || digest.length !== 64 || !/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`File sha256 requires 64 lowercase hexadecimal characters: ${path}`);
      }
    }
    return Object.freeze({document,
      files: files as unknown as Readonly<Record<string, Readonly<ExpectedFile>>>});
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Manifest envelope validation failed';
    throw new Error(reason.slice(0, 500));
  }
}
