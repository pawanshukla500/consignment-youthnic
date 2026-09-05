import { describe, it, expect } from 'vitest';
import {
  isValidBarcode,
  barcodeValidationMessage,
  normalizeBarcodeInput,
  barcodeMatchesSku,
  getScanKeys,
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
    it('matches against marketplace scan fields case-insensitively', () => {
      const sku = { marketplaceBarcode: 'SKU-ABC', internalSku: 'INT-ABC' };
      expect(barcodeMatchesSku(sku, 'sku-abc')).toBe(true);
      expect(barcodeMatchesSku(sku, 'SKU-DEF')).toBe(false);
    });

    it('does not treat internal SKU as a packing barcode', () => {
      const sku = {
        marketplaceBarcode: 'X001234567',
        marketplaceSku: 'MKT-1',
        internalSku: 'INT-1',
      };
      expect(barcodeMatchesSku(sku, 'INT-1')).toBe(false);
      expect(barcodeMatchesSku(sku, 'X001234567')).toBe(true);
      expect(getScanKeys(sku)).toEqual(['X001234567', 'MKT-1']);
    });
  });

  describe('createScannerInputGuard', () => {
    it('accepts keydown/form submission only once for one input generation', () => {
      const guard = createScannerInputGuard();
      guard.noteInput();
      expect(guard.consumeSubmission('ABC-123')).toBe(true); // keydown Enter
      expect(guard.consumeSubmission('ABC-123')).toBe(false); // duplicate form submit / LF
      expect(guard.consumeSubmission('ABC-123')).toBe(false); // duplicate CRLF terminator
    });

    it('never debounces a legitimate repeated barcode value', () => {
      const guard = createScannerInputGuard();
      for (let i = 0; i < 100; i += 1) {
        guard.noteInput();
        expect(guard.consumeSubmission('SAME-123')).toBe(true);
      }
    });

    it('allows one TAB-terminated submission and blocks its duplicate submit', () => {
      const guard = createScannerInputGuard();
      guard.noteInput();
      expect(guard.consumeSubmission('TAB-123')).toBe(true);
      expect(guard.consumeSubmission('TAB-123')).toBe(false);
    });
  });
});
