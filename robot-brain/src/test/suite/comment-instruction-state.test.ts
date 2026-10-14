import * as assert from 'assert';
import { parseCommentInstructions } from '../../intent/commentInstruction';
import { CommentInstructionState } from '../../workflow/commentInstructionState';

suite('Ace.X comment instruction lifecycle', () => {
    test('deduplicates unchanged instructions until a new terminal state', () => {
        const instruction = parseCommentInstructions('// Eve: add validation', 'javascript', 'file:///a.js')[0];
        const state = new CommentInstructionState();
        assert.ok(state.detect(instruction, 1));
        assert.strictEqual(state.detect(instruction, 1), undefined);
        assert.ok(state.transition(instruction.id, 'PROPOSED', 1));
        assert.ok(state.transition(instruction.id, 'APPROVED', 1));
        assert.ok(state.transition(instruction.id, 'COMPLETED', 2));
        assert.strictEqual(state.transition(instruction.id, 'APPROVED', 2), undefined);
    });

    test('records cancellation and failure evidence', () => {
        const instruction = parseCommentInstructions('# Eve: write a helper', 'python', 'file:///a.py')[0];
        const state = new CommentInstructionState();
        state.detect(instruction, 4);
        state.transition(instruction.id, 'PROPOSED', 4);
        const failed = state.transition(instruction.id, 'FAILED', 4, 'provider unavailable');
        assert.strictEqual(failed?.failure, 'provider unavailable');
        assert.strictEqual(failed?.status, 'FAILED');
    });
});
