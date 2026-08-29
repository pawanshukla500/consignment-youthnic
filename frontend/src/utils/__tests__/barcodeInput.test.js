import { describe, it, expect } from 'vitest';
import {
  isValidBarcode,
  barcodeValidationMessage,
  normalizeBarcodeInput,
  getMarketplaceBarcode,
  resolveQueueBarcode,
  barcodeMatchesSku,
  createScannerInputGuard,
} from '../barcodeInput';

describe('barcodeInput', () => {
  describe('normalizeBarcodeInput', () => {
    it('trims whitespace and handles nulls', () => {
      expect(normalizeBarcodeInput('  12345  ')).toBe('12345');
      expect(normalizeBarcodeInput(null)).toBe('');
      expect(normalizeBarcodeInput(undefined)).toBe('');
    });
  });

  describe('isValidBarcode', () => {
    it('returns true for valid barcodes', () => {
      expect(isValidBarcode('ABC-123')).toBe(true);
      expect(isValidBarcode('A_B.C')).toBe(true);
      expect(isValidBarcode('1234')).toBe(true); // min length 4
    });

    it('returns false for invalid barcodes', () => {
      expect(isValidBarcode('123')).toBe(false); // too short
      expect(isValidBarcode('123 456')).toBe(false); // contains space
      expect(isValidBarcode('A!B')).toBe(false); // special char
      expect(isValidBarcode(null)).toBe(false);
    });
  });

  describe('barcodeValidationMessage', () => {
    it('returns correct error messages', () => {
      expect(barcodeValidationMessage('')).toBe('Scan a barcode');
      expect(barcodeValidationMessage('A B')).toBe('Spaces are not allowed — use the barcode scanner');
      expect(barcodeValidationMessage('123')).toBe('Barcode too short — scan the full marketplace barcode');
      expect(barcodeValidationMessage('A!B!C!')).toBe('Invalid barcode characters — scan only, do not type manually');
      expect(barcodeValidationMessage('ABCD')).toBe(''); // Valid
    });
  });

  describe('barcodeMatchesSku', () => {
    it('matches against sku fields case-insensitively', () => {
      const sku = { marketplaceBarcode: 'SKU-ABC' };
      expect(barcodeMatchesSku(sku, 'sku-abc')).toBe(true);
      expect(barcodeMatchesSku(sku, 'SKU-DEF')).toBe(false);
    });
  });

  describe('createScannerInputGuard', () => {
    it('detects hardware scanner bursts', () => {
      const guard = createScannerInputGuard();
      expect(guard.isLikelyScanner()).toBe(false);

      // Simulate fast keystrokes
      guard.noteKeyDown();
      guard.noteKeyDown();
      guard.noteKeyDown();
      guard.noteKeyDown();
      
      expect(guard.isLikelyScanner()).toBe(true);
      
      guard.reset();
      expect(guard.isLikelyScanner()).toBe(false);
    });
  });
});
