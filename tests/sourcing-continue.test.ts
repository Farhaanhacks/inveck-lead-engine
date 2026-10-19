import { describe, expect, it, vi } from 'vitest';

// The route outside Next: the run secret, after() and the driver are stand-ins.
const driven: number[] = [];
vi.mock('@/lib/auth', () => ({ runSecret: async () => 'test-run-secret' }));
vi.mock('next/server', () => ({ after: (fn: () => unknown) => void fn() }));
vi.mock('@/lib/sourcing/drive', () => ({ driveSourcingTest: async (id: number) => void driven.push(id) }));

describe('carrying a sourcing test on in a new invocation', () => {
  const call = async (secret: string | null) => {
    const { POST } = await import('@/app/api/sourcing/[id]/continue/route');
    const headers: Record<string, string> = secret === null ? {} : { 'x-run-secret': secret };
    return POST(new Request('https://example.test/api/sourcing/7/continue', { method: 'POST', headers }), { params: Promise.resolve({ id: '7' }) } as never);
  };

  it('only with the run secret', async () => {
    expect((await call(null)).status).toBe(403);
    expect((await call('wrong')).status).toBe(403);
    expect(driven).toEqual([]);
    expect((await call('test-run-secret')).status).toBe(202);
    expect(driven).toEqual([7]);
  });
});
