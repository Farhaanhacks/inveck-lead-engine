'use client';
import Link from 'next/link';
import { useOptimistic, useState, useTransition, type DragEvent } from 'react';
import { PIPELINE_STAGES, type PipelineStage } from '@/lib/db/schema';
import { moveLeadStageAction } from '../../actions';

export type Card = {
  id: number;
  company: string;
  stage: PipelineStage;
  contact: string;
  score: number | null;
  signal: string;
  email: boolean;
  followUp: { due: boolean; label: string } | null;
};

const HINT: Record<PipelineStage, string> = {
  'Awaiting Approval': 'Drafts to review',
  Approved: 'Ready to send',
  Contacted: 'Sent, waiting for a reply',
  Replied: 'Conversation started',
  'Meeting Booked': 'Demo scheduled',
  Won: 'Added to your client sheet',
  Lost: 'Not now',
};

export function Board({ cards }: { cards: Card[] }) {
  const [shown, move] = useOptimistic(cards, (state, m: { id: number; stage: PipelineStage }) =>
    state.map((c) => (c.id === m.id ? { ...c, stage: m.stage, followUp: m.stage === 'Contacted' ? c.followUp : null } : c)),
  );
  const [, startTransition] = useTransition();
  const [over, setOver] = useState<PipelineStage | null>(null);
  const [error, setError] = useState('');

  const moveTo = (id: number, stage: PipelineStage) => {
    const card = shown.find((c) => c.id === id);
    if (!card || card.stage === stage) return;
    setError('');
    startTransition(async () => {
      move({ id, stage });
      const r = await moveLeadStageAction(id, stage);
      if (!r.ok) setError(`Couldn’t move ${card.company}.`);
    });
  };

  const onDrop = (e: DragEvent, stage: PipelineStage) => {
    e.preventDefault();
    setOver(null);
    const id = Number(e.dataTransfer.getData('text/plain'));
    if (id) moveTo(id, stage);
  };

  return (
    <>
      {error && <p className="mb-3 text-sm text-critical-ink" role="alert">{error}</p>}
      <div className="relative -mx-4 flex gap-3 overflow-x-auto px-4 pb-4 md:mx-0 md:px-0">
        {PIPELINE_STAGES.map((stage) => {
          const list = shown.filter((c) => c.stage === stage);
          return (
            <section
              key={stage}
              aria-label={stage}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (over !== stage) setOver(stage);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(e) => onDrop(e, stage)}
              className={`flex w-64 shrink-0 flex-col rounded-lg border bg-surface-2 transition-colors ${
                over === stage ? 'border-accent ring-2 ring-accent/30' : 'border-line'
              }`}
            >
              <header className="border-b border-line px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold">{stage}</h2>
                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-ink-2 tabular-nums">{list.length}</span>
                </div>
                <p className="text-xs text-muted">{HINT[stage]}</p>
              </header>
              <ul className="flex min-h-24 flex-1 flex-col gap-2 p-2">
                {list.map((c) => (
                  <li
                    key={c.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', String(c.id));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    className="cursor-grab rounded-md border border-line bg-surface p-2.5 shadow-sm active:cursor-grabbing"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link href={`/leads/${c.id}`} className="text-sm font-medium hover:underline">
                        {c.company}
                      </Link>
                      {c.score != null && <span className="text-xs text-ink-2 tabular-nums" title="Lead score">{c.score}</span>}
                    </div>
                    {c.contact && <p className="mt-0.5 truncate text-xs text-ink-2" title={c.contact}>{c.contact}</p>}
                    {c.signal && (
                      <p className="mt-1.5 line-clamp-2 text-xs text-warning-ink" title={c.signal}>
                        {c.signal}
                      </p>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className={`text-xs ${c.followUp?.due ? 'font-medium text-warning-ink' : 'text-muted'}`}>
                        {c.followUp?.label ?? (c.email ? 'Email found' : 'LinkedIn only')}
                      </span>
                      <label className="sr-only" htmlFor={`move-${c.id}`}>Move {c.company} to</label>
                      <select
                        id={`move-${c.id}`}
                        value={c.stage}
                        onChange={(e) => moveTo(c.id, e.target.value as PipelineStage)}
                        className="max-w-[7.5rem] rounded border border-line bg-surface px-1 py-0.5 text-xs text-ink-2"
                      >
                        {PIPELINE_STAGES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  </li>
                ))}
                {!list.length && <li className="px-2 py-6 text-center text-xs text-muted">Drop a lead here</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
