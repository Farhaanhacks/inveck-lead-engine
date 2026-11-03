import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedRemarks } from '@/components/saved-remarks';

const html = (remark: string, callRemark: string, company = 'Hosur Gears') => renderToStaticMarkup(<SavedRemarks lead={{ company, remark, callRemark }} />);

describe('the remarks on a Today company', () => {
  it('shows the Tracker remark and call remark as saved, labelled, under the right company', () => {
    const out = html('Prefers WhatsApp after 4 pm', 'Asked for the 3PL profile\nCall back Monday');
    expect(out).toContain('aria-label="Remarks for Hosur Gears"');
    expect(out).toContain('Remark');
    expect(out).toContain('Prefers WhatsApp after 4 pm');
    expect(out).toContain('Call remark');
    expect(out).toContain('Asked for the 3PL profile\nCall back Monday');
  });

  it('shows only the one that exists, and nothing at all for a fresh lead (empty or blank)', () => {
    expect(html('', 'Only a call note')).not.toContain('>Remark<');
    expect(html('Only a remark', '   ')).not.toContain('Call remark');
    expect(html('', '')).toBe('');
    expect(html('  \n ', '')).toBe('');
  });

  it('escapes what was typed (a remark is text, never markup)', () => {
    const out = html('<img src=x onerror=alert(1)> & more', '');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; more');
  });
});
