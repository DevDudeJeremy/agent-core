import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  formatContextBlock,
  NON_NEGOTIABLE_GUARDRAILS,
  type RetrievedChunk,
} from '../src/index.js';
import { MockModelClient } from '../src/testing/mock-model.js';
import { buildAgent } from './harness.js';

const model = () => new MockModelClient([]);

describe('guardrails & prompt composition (SPEC §9.6)', () => {
  it('always starts with the non-negotiable block — with or without extraRules', () => {
    const plain = buildAgent(model(), {
      business: { name: 'Acme', description: 'desc' },
      persona: { name: 'Ace', tone: 'Warm and clear' },
    }).agent;
    expect(buildSystemPrompt(plain).startsWith(NON_NEGOTIABLE_GUARDRAILS.trim())).toBe(true);

    const withRules = buildAgent(model(), {
      business: { name: 'Acme', description: 'desc' },
      persona: { name: 'Ace', tone: 'Warm and clear' },
      guardrails: { extraRules: ['Never quote exact prices.'] },
    }).agent;
    expect(buildSystemPrompt(withRules).startsWith(NON_NEGOTIABLE_GUARDRAILS.trim())).toBe(true);
  });

  it('includes the business name and persona tone, with extra rules after the non-negotiables', () => {
    const agent = buildAgent(model(), {
      business: { name: 'Acme Plumbing', description: 'Family plumbing.' },
      persona: { name: 'Ace', tone: 'Warm, practical, and to the point' },
      guardrails: { extraRules: ['Escalate gas smells immediately.'] },
    }).agent;

    const prompt = buildSystemPrompt(agent);
    expect(prompt).toContain('Acme Plumbing');
    expect(prompt).toContain('Warm, practical, and to the point');
    // Extra rule must appear AFTER the non-negotiable block.
    expect(prompt.indexOf('Escalate gas smells immediately.')).toBeGreaterThan(
      prompt.indexOf(NON_NEGOTIABLE_GUARDRAILS.trim()),
    );
  });

  it('formats the context block with untrusted-data framing and per-chunk source markers', () => {
    const chunks: RetrievedChunk[] = [
      { id: 'a#0', content: 'We are open 9-5.', sourceId: 'hours.md', title: 'Hours', score: 1 },
      {
        id: 'b#0',
        content: 'Free estimates.',
        sourceId: 'pricing.md',
        title: 'Pricing',
        url: 'https://x/p',
        score: 0.5,
      },
    ];
    const block = formatContextBlock(chunks);
    expect(block).toContain('<context>');
    expect(block).toContain('</context>');
    expect(block).toContain('UNTRUSTED');
    expect(block).toContain('source: hours.md');
    expect(block).toContain('source: pricing.md');
    expect(block).toContain('We are open 9-5.');
  });

  it('returns an empty string when there is no context to ground on', () => {
    expect(formatContextBlock([])).toBe('');
  });
});
