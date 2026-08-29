import { describe, it, expect } from 'vitest';
import {
  shouldUseMultipart,
  missingMultipartParts,
  mergeCompletedParts,
  decideMultipartRecovery,
} from '../videoUploadPipeline';

describe('videoUploadPipeline', () => {
  describe('shouldUseMultipart', () => {
    it('returns true if size exceeds threshold', () => {
      expect(shouldUseMultipart(10 * 1024 * 1024, 8 * 1024 * 1024)).toBe(true);
    });
    it('returns false if size is under threshold', () => {
      expect(shouldUseMultipart(5 * 1024 * 1024, 8 * 1024 * 1024)).toBe(false);
    });
  });

  describe('missingMultipartParts', () => {
    it('calculates missing parts correctly', () => {
      const fileSize = 15 * 1024 * 1024;
      const partSize = 5 * 1024 * 1024;
      // 3 parts total. We have part 2 completed.
      const completed = [{ partNumber: 2, etag: 'abc' }];
      
      const missing = missingMultipartParts(fileSize, completed, partSize);
      expect(missing.length).toBe(2);
      expect(missing[0].partNumber).toBe(1);
      expect(missing[0].start).toBe(0);
      expect(missing[0].end).toBe(5 * 1024 * 1024);
      
      expect(missing[1].partNumber).toBe(3);
      expect(missing[1].start).toBe(10 * 1024 * 1024);
      expect(missing[1].end).toBe(fileSize);
    });
  });

  describe('mergeCompletedParts', () => {
    it('merges parts and prefers newer etags', () => {
      const existing = [{ partNumber: 1, etag: 'old' }];
      const incoming = [{ partNumber: 1, etag: 'new' }, { partNumber: 2, etag: 'abc' }];
      const merged = mergeCompletedParts(existing, incoming);
      expect(merged.length).toBe(2);
      const p1 = merged.find(p => p.partNumber === 1);
      expect(p1.etag).toBe('new');
    });
  });

  describe('decideMultipartRecovery', () => {
    it('restarts multipart if head succeeds (implying another process finished it)', () => {
      const result = decideMultipartRecovery({
        expectedSize: 100,
        expectedPath: 'path/to/video.webm',
        listResult: { ok: false, code: 'NoSuchUpload' },
        headResult: { ok: true, size: 100, etag: 'final_etag', storagePath: 'path/to/video.webm' }
      });
      // Should finalize metadata without uploading again
      expect(result.action).toBe('finalize_metadata');
    });
    
    it('restarts multipart if list fails and head fails', () => {
      const result = decideMultipartRecovery({
        listResult: { ok: false, code: 'NoSuchUpload' },
        headResult: { ok: false }
      });
      expect(result.action).toBe('restart_multipart');
    });
  });
});
