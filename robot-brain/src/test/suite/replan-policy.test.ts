import * as assert from 'assert';
import { beginReplan, MAX_REPLAN_ATTEMPTS, type ReplanState } from '../../workflow/replanPolicy';

suite('Ace.X bounded Fix → Verify → Replan policy', () => {
    const input = { issueKey: 'file.py:7:undefined name', sourceVersion: 4, failureEvidence: 'Diagnostic remains at file.py:7.' };

    test('allows a first revised proposal and carries actual evidence', () => {
        const result = beginReplan(undefined, input);
        assert.ok(result.state);
        assert.strictEqual(result.state?.attempts, 1);
        assert.strictEqual(result.state?.failureEvidence, input.failureEvidence);
    });

    test('allows only the configured bounded number for the same issue and source', () => {
        let state: ReplanState | undefined;
        for (let attempt = 0; attempt < MAX_REPLAN_ATTEMPTS; attempt++) {
            state = beginReplan(state, input).state;
        }
        const blocked = beginReplan(state, input);
        assert.strictEqual(blocked.state, undefined);
        assert.ok(blocked.reason?.includes(String(MAX_REPLAN_ATTEMPTS)));
    });

    test('resets the bound when source version or issue identity changes', () => {
        const first = beginReplan(undefined, input).state;
        const changedSource = beginReplan(first, { ...input, sourceVersion: 5 });
        assert.strictEqual(changedSource.state?.attempts, 1);
        const changedIssue = beginReplan(first, { ...input, issueKey: 'other.py:2:type mismatch' });
        assert.strictEqual(changedIssue.state?.attempts, 1);
    });
});
