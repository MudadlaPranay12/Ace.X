import * as assert from 'assert';
import { buildAdaptiveGuidance, buildGroundedContext, explanationStyle, isArtifactFollowUp, missingContextMessage } from '../../conversation/adaptiveExplanation';

suite('Ace.X adaptive explanations', () => {
    const context = {
        taskId: 'write-1', file: 'prime.py', language: 'python',
        code: 'def is_prime(n):\n    for i in range(2, n):\n        if n % i == 0: return False\n    return n > 1',
        selectedLines: 'for i in range(2, n):', lineStart: 1, lineEnd: 5,
        diff: '(cursor insertion)\n→\ndef is_prime(n):',
    };

    test('maps beginner, intermediate, and advanced styles', () => {
        assert.strictEqual(explanationStyle('BEGINNER'), 'BEGINNER');
        assert.strictEqual(explanationStyle('INTERMEDIATE'), 'INTERMEDIATE');
        assert.strictEqual(explanationStyle('ADVANCED'), 'ADVANCED');
        assert.ok(buildAdaptiveGuidance('BEGINNER').includes('dry run'));
        assert.ok(buildAdaptiveGuidance('ADVANCED').includes('complexity'));
    });

    test('grounds follow-ups in actual artifact, lines, and diff', () => {
        const prompt = buildGroundedContext(context, 'BEGINNER');
        assert.ok(prompt.includes('prime.py'));
        assert.ok(prompt.includes('for i in range(2, n)'));
        assert.ok(prompt.includes('Actual latest diff'));
        assert.ok(prompt.includes('Do not invent'));
    });

    test('recognizes contextual follow-ups but does not classify unrelated chat', () => {
        assert.strictEqual(isArtifactFollowUp('Explain the loop.'), true);
        assert.strictEqual(isArtifactFollowUp('Why did you use this?'), true);
        assert.strictEqual(isArtifactFollowUp('Can you make it faster?'), true);
        assert.strictEqual(isArtifactFollowUp('What is the weather?'), false);
    });

    test('asks targeted clarification when context is missing', () => {
        assert.ok(missingContextMessage('Explain the loop').includes('select the code'));
        assert.ok(missingContextMessage('Why did you use this?').includes('file and line'));
    });
});
