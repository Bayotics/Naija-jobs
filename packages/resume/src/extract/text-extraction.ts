/**
 * Text extraction.
 *
 * One entry point per format, all returning the same shape, all failing the
 * same way. The important property is that a parser failure is a *result*, not
 * an exception: an unreadable PDF is a common and expected outcome (scanned
 * images, unusual encodings), and the pipeline must be able to tell the
 * candidate that clearly instead of surfacing a stack trace.
 *
 * Layout preservation matters more here than it might seem. Resume structure is
 * carried almost entirely by line breaks and indentation — "Company | Title |
 * 2021–2023" is three fields only because of the whitespace between them — so
 * these extractors preserve line structure rather than normalising it away.
 */

export interface ExtractionResult {
  ok: boolean;
  text: string;
  /** Pages for PDF, paragraphs elsewhere. Useful for offset reporting. */
  blocks: number;
  /** Extractor used, for the provenance trail. */
  extractor: string;
  /** Present when `ok` is false. Phrased for the candidate. */
  error: string | null;
  /** Non-fatal observations worth showing, e.g. "this looks scanned". */
  warnings: string[];
}

const failure = (extractor: string, error: string): ExtractionResult => ({
  ok: false,
  text: '',
  blocks: 0,
  extractor,
  error,
  warnings: [],
});

/**
 * Normalises whitespace without destroying structure.
 *
 * Collapses runs of spaces and blank lines, strips zero-width characters and
 * normalises unicode, but keeps single newlines — those are the section and
 * bullet boundaries everything downstream depends on.
 */
export function normaliseExtractedText(raw: string): string {
  return raw
    .normalize('NFKC')
    // Zero-width and bidi control characters, which PDF extraction emits and
    // which break every subsequent regex silently.
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    // Bullet glyphs become a consistent marker so list detection is one rule.
    .replace(/^[\t ]*[\u2022\u25aa\u25e6\u2023\u00b7\u2219*\u2013\u2014-]\s+/gm, '\u2022 ')
    .replace(/[ \t]{2,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const document = await getDocumentProxy(bytes);
    const { text, totalPages } = await extractText(document, { mergePages: false });

    const pages = Array.isArray(text) ? text : [String(text)];
    const merged = normaliseExtractedText(pages.join('\n\n'));

    const warnings: string[] = [];
    // A PDF with pages but almost no text is a scan. Saying so is far more
    // useful than returning an empty string and letting extraction "succeed".
    if (merged.length < 200 && totalPages > 0) {
      warnings.push(
        'Very little text was found. If this PDF is a scan or an image export, the text cannot ' +
          'be read — please upload a text-based PDF or a DOCX.',
      );
    }

    return {
      ok: merged.length > 0,
      text: merged,
      blocks: totalPages,
      extractor: 'unpdf',
      error: merged.length > 0 ? null : 'No text could be extracted from this PDF.',
      warnings,
    };
  } catch (error) {
    return failure(
      'unpdf',
      `The PDF could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function extractDocx(bytes: Uint8Array): Promise<ExtractionResult> {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = normaliseExtractedText(result.value ?? '');

    return {
      ok: text.length > 0,
      text,
      blocks: text.split('\n\n').length,
      extractor: 'mammoth',
      error: text.length > 0 ? null : 'No text could be extracted from this document.',
      // Mammoth reports unsupported constructs; they are informative, not fatal.
      warnings: (result.messages ?? [])
        .filter((message) => message.type === 'warning')
        .map((message) => message.message)
        .slice(0, 5),
    };
  } catch (error) {
    return failure(
      'mammoth',
      `The Word document could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function extractPlainText(bytes: Uint8Array): ExtractionResult {
  try {
    const text = normaliseExtractedText(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    return {
      ok: text.length > 0,
      text,
      blocks: text.split('\n\n').length,
      extractor: 'text-decoder',
      error: text.length > 0 ? null : 'The file contained no readable text.',
      warnings: [],
    };
  } catch (error) {
    return failure(
      'text-decoder',
      `The text file could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Dispatches on the *detected* type, never the declared one. */
export async function extractText(
  bytes: Uint8Array,
  detectedMimeType: string,
): Promise<ExtractionResult> {
  if (detectedMimeType === 'application/pdf') return extractPdf(bytes);
  if (detectedMimeType.endsWith('wordprocessingml.document')) return extractDocx(bytes);
  if (detectedMimeType.startsWith('text/')) return Promise.resolve(extractPlainText(bytes));

  return Promise.resolve(
    failure('none', `${detectedMimeType} is not a supported document type.`),
  );
}
