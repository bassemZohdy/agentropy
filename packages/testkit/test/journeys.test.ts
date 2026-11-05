// TASK-023: the runnable M1 journeys, executed offline — AC-01 (J1 with no model provider) and the J2 approval
// path (AC-08 end to end through the public facade).
import { describe, expect, it } from 'vitest';
import { runExpenseApproval } from '../../examples/src/expense-approval.js';
import { runPriceWatch } from '../../examples/src/price-watch.js';

describe('J1 price watch (AC-01)', () => {
  it('AC-01: with no model provider, 3 back-to-back events give 3 ordered activations, 1 notification and a completed task', async () => {
    const r = await runPriceWatch();
    expect(r.activations).toEqual([120, 105, 99]);
    expect(r.monitorStatus).toBe('completed');
    expect(r.notifications.map((n) => [n.title, n.severity])).toEqual([
      ['ACME is at 99 (below 100)', 'high'],
    ]);
    // AC-02 through the example: the second turn repeats the briefed entry.
    expect(r.replies).toEqual([
      'A monitoring agent is watching ACME for you.',
      'ACME is at 99 (below 100)',
    ]);
  });
});

describe('J2 expense approval', () => {
  it('approve → resumes on the resolved outcome, pays out once and completes', async () => {
    const r = await runExpenseApproval();
    expect(r.status).toBe('completed');
    expect(r.output).toEqual({
      riskSummary: 'Risk: medium. Amount above the 1,000 auto-approval limit.',
      paymentId: 'pay-1',
    });
    expect(r.request.status).toBe('resolved');
    expect(r.payouts).toBe(1);
    expect(r.audit).toEqual(
      expect.arrayContaining([
        'task.accept',
        'human-action.decide',
        'tool.invoke',
      ]),
    );
  });

  it('reject → the task fails without any payout', async () => {
    const r = await runExpenseApproval({ decision: 'reject' });
    expect(r.status).toBe('failed');
    expect(r.payouts).toBe(0);
  });
});
