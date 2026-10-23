import path from 'node:path';

export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 Megabytes

export class UploadValidationError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'UploadValidationError';
    this.statusCode = statusCode;
  }
}

export interface ValidatedFile {
  sanitizedFilename: string;
  detectedMimeType: string;
  extension: string;
  sizeBytes: number;
  buffer: Buffer;
}

const ALLOWED_EXTENSIONS = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.txt', 'text/plain'],
  ['.csv', 'text/csv'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'sh', 'ps1', 'msi', 'dll', 'com', 'vbs', 'js', 'ts', 'scr',
  'jar', 'bin', 'app', 'deb', 'rpm', 'html', 'htm', 'svg', 'xml', 'xhtml', 'php',
  'jsp', 'asp', 'aspx', 'cgi', 'zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'iso',
]);

export class UploadValidationService {
  /**
   * Sanitize an untrusted user-supplied filename.
   * Strips path traversal sequences, control chars, null bytes, and normalizes.
   */
  static sanitizeFilename(rawFilename: string): string {
    if (!rawFilename || typeof rawFilename !== 'string') {
      return 'unnamed_file';
    }

    // 1. Strip null bytes and control characters
    const cleanChars = rawFilename.replace(/[\0\x00-\x1f\x7f-\x9f]/g, '');

    // 2. Extract basename (neutralizes ../ and directory traversal)
    const base = path.basename(cleanChars);

    // 3. Remove characters that are unsafe on file systems or headers
    const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, '_');

    // 4. Ensure non-empty and bounded length
    if (!sanitized || sanitized === '.' || sanitized === '..') {
      return 'unnamed_file';
    }

    return sanitized.slice(0, 200);
  }

  /**
   * Sniff binary buffer to determine true file type from magic bytes.
   */
  static sniffMagicBytes(buffer: Buffer): { mime: string; ext: string } | null {
    if (buffer.length < 4) {
      return null;
    }

    // 1. Executable magic byte traps
    if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
      throw new UploadValidationError('Upload rejected: Windows PE executable detected via magic bytes');
    }
    if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
      throw new UploadValidationError('Upload rejected: Linux ELF binary detected via magic bytes');
    }
    if (buffer[0] === 0xca && buffer[1] === 0xfe && buffer[2] === 0xba && buffer[3] === 0xbe) {
      throw new UploadValidationError('Upload rejected: Java class/Mach-O binary detected via magic bytes');
    }
    if (buffer[0] === 0x23 && buffer[1] === 0x21) {
      throw new UploadValidationError('Upload rejected: Script interpreter shebang (#!) detected via magic bytes');
    }

    // 2. Archive magic byte traps
    if (buffer[0] === 0x37 && buffer[1] === 0x7a && buffer[2] === 0xbc && buffer[3] === 0xaf) {
      throw new UploadValidationError('Upload rejected: 7-Zip archive detected via magic bytes');
    }
    if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21) {
      throw new UploadValidationError('Upload rejected: RAR archive detected via magic bytes');
    }
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      throw new UploadValidationError('Upload rejected: GZIP archive detected via magic bytes');
    }

    // 3. Allowed Magic Signatures
    // PDF: %PDF (0x25 0x50 0x44 0x46)
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return { mime: 'application/pdf', ext: '.pdf' };
    }

    // PNG: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
    ) {
      return { mime: 'image/png', ext: '.png' };
    }

    // JPEG: 0xFF 0xD8 0xFF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { mime: 'image/jpeg', ext: '.jpg' };
    }

    // ZIP container (Used by Office Open XML .docx, .xlsx, .pptx)
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
      const sliceStr = buffer.slice(0, 2048).toString('utf8');
      if (sliceStr.includes('word/')) {
        return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' };
      }
      if (sliceStr.includes('xl/')) {
        return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' };
      }
      if (sliceStr.includes('ppt/')) {
        return { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' };
      }
      if (sliceStr.includes('[Content_Types].xml')) {
        return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' };
      }
      // Generic ZIP archive not recognized as an Office document -> reject
      throw new UploadValidationError('Upload rejected: Generic ZIP archive or decompression bombs are prohibited');
    }

    // 4. Plain text / CSV inspection
    const sampleSize = Math.min(buffer.length, 1024);
    let hasNull = false;
    for (let i = 0; i < sampleSize; i++) {
      if (buffer[i] === 0) {
        hasNull = true;
        break;
      }
    }

    if (!hasNull) {
      const textSample = buffer.slice(0, sampleSize).toString('utf8').toLowerCase();
      // Block SVG / HTML disguised as text
      if (textSample.includes('<html') || textSample.includes('<!doctype') || textSample.includes('<svg') || textSample.includes('<?xml')) {
        throw new UploadValidationError('Upload rejected: HTML/SVG active web markup is prohibited');
      }
      return { mime: 'text/plain', ext: '.txt' };
    }

    return null;
  }

  /**
   * Validate entire file payload:
   * 1. Size bounds
   * 2. Double-extension attack defense
   * 3. Extension allowlist
   * 4. Magic-byte sniffing and claimed extension cross-check
   */
  static validate(rawFilename: string, buffer: Buffer): ValidatedFile {
    // 1. Size check
    if (!buffer || buffer.length === 0) {
      throw new UploadValidationError('File is empty');
    }
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new UploadValidationError(
        `File size exceeds maximum allowed limit (${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB)`,
        413
      );
    }

    // 2. Filename sanitization & double extension check
    const sanitizedFilename = this.sanitizeFilename(rawFilename);
    const parts = sanitizedFilename.toLowerCase().split('.');

    if (parts.length > 2) {
      // Check every segment for dangerous extensions
      for (let i = 1; i < parts.length; i++) {
        if (DANGEROUS_EXTENSIONS.has(parts[i])) {
          throw new UploadValidationError(`Dangerous file extension segment detected: .${parts[i]}`);
        }
      }
    }

    const ext = path.extname(sanitizedFilename).toLowerCase();
    const expectedMime = ALLOWED_EXTENSIONS.get(ext);

    if (!expectedMime) {
      throw new UploadValidationError(
        `File extension '${ext}' is not permitted. Allowed: ${Array.from(ALLOWED_EXTENSIONS.keys()).join(', ')}`
      );
    }

    // 3. Magic-byte sniffing
    const sniffed = this.sniffMagicBytes(buffer);
    if (!sniffed) {
      throw new UploadValidationError('Unable to verify file integrity from header magic bytes');
    }

    // 4. Verify match between claimed extension and sniffed bytes
    if (ext === '.csv' && sniffed.mime === 'text/plain') {
      // CSV is validated text
      return {
        sanitizedFilename,
        detectedMimeType: 'text/csv',
        extension: ext,
        sizeBytes: buffer.length,
        buffer,
      };
    }

    if (ext === '.jpeg' && sniffed.mime === 'image/jpeg') {
      return {
        sanitizedFilename,
        detectedMimeType: 'image/jpeg',
        extension: ext,
        sizeBytes: buffer.length,
        buffer,
      };
    }

    if (sniffed.mime !== expectedMime) {
      throw new UploadValidationError(
        `File signature mismatch: claimed '${ext}' (${expectedMime}) but magic bytes indicate '${sniffed.mime}'`
      );
    }

    return {
      sanitizedFilename,
      detectedMimeType: sniffed.mime,
      extension: ext,
      sizeBytes: buffer.length,
      buffer,
    };
  }
}
