import { createHash } from 'node:crypto';
import {
  SUPPORTED_MIME_TYPES,
  documentValidationSchema,
  type DocumentValidation,
} from '@job-intel/contracts';

/**
 * Document validation.
 *
 * This runs before a single byte reaches a parser, and it exists because
 * resume upload is the one place in this system where an untrusted binary is
 * handed to complex parsing code. The threats the brief names are real and all
 * of them are cheap to defend against *here* and expensive to defend against
 * later:
 *
 *  - **A lying MIME type.** The declared type comes from the client and means
 *    nothing. Every accepted format is confirmed by its file signature.
 *  - **Oversized files.** A parser given 400MB will happily try.
 *  - **Zip bombs.** DOCX is a ZIP. A 40KB file can declare a 4GB member, and
 *    an inflate loop will oblige. The declared uncompressed size and the
 *    compression ratio are both checked before decompression.
 *  - **Embedded active content.** Macro-enabled documents and PDFs with
 *    `/JavaScript` or `/Launch` actions are rejected rather than parsed.
 *
 * Nothing here executes, renders, or follows anything inside the file.
 */

/** 10MB. Generous for a resume; anything larger is not one. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Maximum bytes any single ZIP member may inflate to. */
export const MAX_MEMBER_BYTES = 40 * 1024 * 1024;
/** Refuse anything claiming to compress better than this. */
export const MAX_COMPRESSION_RATIO = 200;
const MIN_TEXT_BYTES = 32;

export interface ValidationInput {
  bytes: Uint8Array;
  filename: string;
  declaredMimeType: string | null;
  maxBytes?: number;
}

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * File signatures.
 *
 * A DOCX is a ZIP (`PK\x03\x04`), so the signature alone cannot distinguish it
 * from any other zip archive — the ZIP member check below does that.
 */
const SIGNATURES: ReadonlyArray<{ mime: string; magic: number[]; label: string }> = [
  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46], label: '%PDF' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: [0x50, 0x4b, 0x03, 0x04],
    label: 'PK zip',
  },
];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/** Whether the bytes decode as text without control characters or NULs. */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  let suspicious = 0;

  for (const byte of sample) {
    // NUL is the strongest signal a "text" file is not text.
    if (byte === 0) return false;
    // Control characters other than tab, LF, CR.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }

  return suspicious / Math.max(1, sample.length) < 0.02;
}

/**
 * Reads ZIP central-directory entries.
 *
 * Deliberately hand-rolled and read-only: this inspects declared sizes without
 * decompressing anything, which is the only way to catch a zip bomb *before*
 * paying its cost. A library that decompresses to tell you the size has already
 * lost.
 */
export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export function readZipDirectory(bytes: Uint8Array): ZipEntry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End-of-central-directory signature, searched from the end.
  const maxComment = 0xffff;
  const start = Math.max(0, bytes.length - maxComment - 22);
  let eocd = -1;

  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length) break;
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);

    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, compressedSize, uncompressedSize });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** PDF markers that indicate active content rather than a document. */
const PDF_ACTIVE_CONTENT = [/\/JavaScript\b/, /\/JS\s*[(<]/, /\/Launch\b/, /\/EmbeddedFile\b/];

export function validateDocument(input: ValidationInput): DocumentValidation {
  const checks: Check[] = [];
  const maxBytes = input.maxBytes ?? MAX_FILE_BYTES;
  const { bytes } = input;

  /*
   * A rejection still reports what the bytes actually were.
   *
   * "This claims to be a DOCX but is a PDF" is something the candidate can act
   * on; "rejected" is not. The detected type is diagnostic, and reporting it
   * never causes the file to be parsed — that decision was already made.
   */
  const reject = (reason: string, detectedMimeType: string | null = null): DocumentValidation =>
    documentValidationSchema.parse({
      accepted: false,
      detectedMimeType,
      declaredMimeType: input.declaredMimeType,
      sizeBytes: bytes.length,
      checks,
      rejectionReason: reason,
    });

  // ── Size ────────────────────────────────────────────────────────────────
  if (bytes.length === 0) {
    checks.push({ name: 'size', passed: false, detail: 'file is empty' });
    return reject('The file is empty.');
  }
  if (bytes.length > maxBytes) {
    checks.push({
      name: 'size',
      passed: false,
      detail: `${bytes.length} bytes exceeds the ${maxBytes}-byte limit`,
    });
    return reject(
      `The file is ${(bytes.length / 1024 / 1024).toFixed(1)}MB, above the ` +
        `${(maxBytes / 1024 / 1024).toFixed(0)}MB limit.`,
    );
  }
  checks.push({ name: 'size', passed: true, detail: `${bytes.length} bytes` });

  // ── Signature ───────────────────────────────────────────────────────────
  const signature = SIGNATURES.find((entry) => startsWith(bytes, entry.magic));
  let detected: string | null = signature?.mime ?? null;

  if (!signature) {
    // Text is the only accepted format with no signature, so it is inferred
    // rather than detected — and only when the bytes actually look like text.
    if (looksLikeText(bytes) && bytes.length >= MIN_TEXT_BYTES) {
      detected = input.filename.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain';
      checks.push({ name: 'signature', passed: true, detail: 'no signature; content decodes as text' });
    } else {
      checks.push({
        name: 'signature',
        passed: false,
        detail: 'no recognised file signature and content is not text',
      });
      return reject(
        'The file is not a PDF, DOCX or plain-text document. Only those formats are accepted.',
      );
    }
  } else {
    checks.push({ name: 'signature', passed: true, detail: `matched ${signature.label}` });
  }

  // ── Declared vs detected ────────────────────────────────────────────────
  if (
    input.declaredMimeType &&
    detected &&
    input.declaredMimeType !== detected &&
    // Text subtypes are interchangeable enough not to be worth rejecting.
    !(input.declaredMimeType.startsWith('text/') && detected.startsWith('text/'))
  ) {
    checks.push({
      name: 'mime_consistency',
      passed: false,
      detail: `declared ${input.declaredMimeType}, detected ${detected}`,
    });
    return reject(
      `The file claims to be ${input.declaredMimeType} but its contents are ${detected}.`,
      detected,
    );
  }
  checks.push({ name: 'mime_consistency', passed: true, detail: detected ?? 'unknown' });

  if (!SUPPORTED_MIME_TYPES.includes(detected as never)) {
    return reject(`${detected} is not a supported document type.`, detected);
  }

  // ── Format-specific structural checks ───────────────────────────────────
  if (detected === 'application/pdf') {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 512_000)));

    const active = PDF_ACTIVE_CONTENT.find((pattern) => pattern.test(head));
    if (active) {
      checks.push({
        name: 'active_content',
        passed: false,
        detail: `PDF contains ${active.source}`,
      });
      return reject(
        'This PDF contains embedded scripts or attachments. Please export a plain PDF and re-upload.',
        detected,
      );
    }
    checks.push({ name: 'active_content', passed: true, detail: 'no embedded scripts found' });
  }

  if (detected?.endsWith('wordprocessingml.document')) {
    const entries = readZipDirectory(bytes);

    if (!entries || entries.length === 0) {
      checks.push({ name: 'zip_structure', passed: false, detail: 'central directory unreadable' });
      return reject('The DOCX file appears to be corrupt.', detected);
    }

    if (!entries.some((entry) => entry.name === 'word/document.xml')) {
      checks.push({
        name: 'zip_structure',
        passed: false,
        detail: 'no word/document.xml member',
      });
      return reject('The file is a ZIP archive but not a Word document.', detected);
    }

    // Macro-enabled content: present in .docm, and not something to parse.
    const macro = entries.find((entry) => entry.name.startsWith('word/vbaProject'));
    if (macro) {
      checks.push({ name: 'active_content', passed: false, detail: 'contains a VBA project' });
      return reject(
        'This document contains macros. Please save it as a plain .docx and re-upload.',
        detected,
      );
    }

    const declared = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    const ratio = declared / Math.max(1, bytes.length);

    if (declared > MAX_MEMBER_BYTES || ratio > MAX_COMPRESSION_RATIO) {
      checks.push({
        name: 'zip_bomb',
        passed: false,
        detail: `declares ${declared} bytes from ${bytes.length} (ratio ${ratio.toFixed(0)}×)`,
      });
      return reject(
        'The document declares an implausible uncompressed size and was not opened.',
        detected,
      );
    }

    checks.push({
      name: 'zip_bomb',
      passed: true,
      detail: `${entries.length} member(s), ${declared} bytes uncompressed (${ratio.toFixed(1)}×)`,
    });
  }

  return documentValidationSchema.parse({
    accepted: true,
    detectedMimeType: detected,
    declaredMimeType: input.declaredMimeType,
    sizeBytes: bytes.length,
    checks,
    rejectionReason: null,
  });
}

/** Content hash, for detecting a re-upload of the same file. */
export function hashDocument(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
