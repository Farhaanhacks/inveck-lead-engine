import { describe, expect, it } from 'vitest';
import { cleanPhone } from '@/lib/tracker';

describe('the Contact Number cell on the tracker', () => {
  it('takes numbers as people write them, and clears with an empty cell', () => {
    expect(cleanPhone(' +91 98765  43210 ')).toBe('+91 98765 43210');
    expect(cleanPhone('022-2654 1234')).toBe('022-2654 1234');
    expect(cleanPhone('(0422) 2571234 / 9843012345')).toBe('(0422) 2571234 / 9843012345');
    expect(cleanPhone('')).toBe('');
  });
  it('refuses text that is not a number', () => {
    expect(cleanPhone('call reception')).toBeNull();
    expect(cleanPhone('12345')).toBeNull();
    expect(cleanPhone('9876543210 ext 2')).toBeNull();
  });
});
