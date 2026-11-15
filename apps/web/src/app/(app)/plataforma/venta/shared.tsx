'use client';

export type StepState = 'done' | 'current' | 'pending' | 'blocked' | 'skipped';
export interface JourneyStep { n: number; key: string; title: string; state: StepState; detail: string; missing: string[]; action: { label: string; href: string } | null }
export interface Journey {
  lead: { id: string; number: number; name: string; company: string | null; email: string | null; status: string };
  tenant: { id: string; name: string; status: string } | null;
  steps: JourneyStep[]; current: number; done: number; mode: 'SAAS' | 'DEDICATED' | 'CUSTOM' | null;
}
export interface OpenSale { leadId: string; number: number; name: string; current: number; total: number; done: number; step: string; missing: string | null }
