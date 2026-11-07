/*
 * The guided tour, as data.
 *
 * Each step names a route, a `[data-tour]` anchor that really exists in the
 * page source, and its copy. Keeping this a plain module means the walkthrough
 * can be unit-tested without a DOM, and the copy is reviewed in one place —
 * which matters, because the tour makes claims about scoring that must stay
 * as honest as the pages it points at.
 */

/** Where a step lives. Agent-scoped routes are resolved against a real agent
 *  id at tour time, because the registry decides which agents exist, not us. */
export type TourRoute = 'dashboard' | 'agents' | 'agent-details' | 'review' | 'demo' | 'docs';

export interface TourStepDef {
  readonly id: string;
  readonly route: TourRoute;
  /** `[data-tour="…"]` anchor, or null for a centered dialog step. */
  readonly anchor: string | null;
  readonly title: string;
  readonly description: string;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly align?: 'start' | 'center' | 'end';
}

/** Fallback when no agent link is on screen to borrow an id from. Agent ids
 *  are minted from 1, so this is the oldest agent if any exists at all. */
export const FALLBACK_AGENT_ID = '1';

export const TOUR_STEPS: readonly TourStepDef[] = [
  {
    id: 'dashboard',
    route: 'dashboard',
    anchor: 'dashboard-overview',
    title: 'Welcome to Receipts',
    description:
      'This is your starting point for exploring agent identity, reputation and trust. ' +
      'Every figure here is read live from the chain and the Record Server — nothing is hardcoded.',
    side: 'bottom',
    align: 'start',
  },
  {
    id: 'agent-directory',
    route: 'agents',
    anchor: 'agent-directory',
    title: 'Agent Directory',
    description:
      'Explore agents registered on ERC-8004 and inspect their on-chain identity information. ' +
      'The registry has no name index, so agents are listed by id, newest first.',
    side: 'bottom',
    align: 'start',
  },
  {
    id: 'agent-reputation',
    route: 'agent-details',
    anchor: 'agent-reputation',
    title: 'Reputation and evidence',
    description:
      'Inspect an agent’s reputation, review the evidence behind it, and see whether it has ' +
      'enough eligible human reviews for a published score. Below five verified humans, ' +
      'Receipts publishes no score at all — an unpublished score is not a score.',
    side: 'bottom',
    align: 'start',
  },
  {
    id: 'review-entry',
    route: 'review',
    anchor: 'review-wizard',
    title: 'Submitting a review',
    description:
      'Humans can submit feedback after completing the verification process. Receipts uses ' +
      'World ID nullifiers to prevent duplicate reviews for the same agent. This tour only ' +
      'shows the wizard — it never verifies, signs or submits anything.',
    side: 'bottom',
    align: 'center',
  },
  {
    id: 'attack-gauntlet',
    route: 'demo',
    anchor: 'attack-gauntlet',
    title: 'Attack Gauntlet',
    description:
      'See how easily a conventional average is manipulated by coordinated wallets, and compare ' +
      'it against Receipts’ weighted median. Everything on this page is synthetic — run the ' +
      '10,000 trials yourself whenever you choose.',
    side: 'bottom',
    align: 'center',
  },
  {
    id: 'scenario-explorer',
    route: 'demo',
    anchor: 'scenario-explorer',
    title: 'Scenario Explorer',
    description:
      'Experiment with different numbers of honest reviewers and attackers to understand the ' +
      'strengths and limitations of the weighted median — including where the guarantee ends.',
    side: 'top',
    align: 'start',
  },
  {
    id: 'finish',
    route: 'demo',
    anchor: null,
    title: 'You’re all set!',
    description:
      'You now know the main parts of Receipts. Replay this walkthrough any time with ' +
      '“Product tour” at the bottom of the sidebar.',
  },
];

export function selectorFor(step: TourStepDef): string | null {
  return step.anchor === null ? null : `[data-tour="${step.anchor}"]`;
}

export function routeForStep(step: TourStepDef, agentId: string): string {
  switch (step.route) {
    case 'dashboard':
      return '/';
    case 'agents':
      return '/agents';
    case 'agent-details':
      return `/agents/${agentId}`;
    case 'review':
      return `/review/${agentId}`;
    case 'demo':
      return '/demo';
    case 'docs':
      return '/docs';
  }
}
