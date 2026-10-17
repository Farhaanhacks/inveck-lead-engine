import { splitPhones, telHref } from '@/lib/phones';

/** Each of a contact's numbers as its own tap-to-call link. */
export function PhoneLinks({ value, className = 'text-accent hover:underline' }: { value: string; className?: string }) {
  const list = splitPhones(value);
  if (!list.length) return null;
  return (
    <>
      {list.map((p) => (
        <a key={p} href={telHref(p)} className={className}>{p}</a>
      ))}
    </>
  );
}
