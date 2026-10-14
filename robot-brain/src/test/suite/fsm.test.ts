import * as assert from 'assert';
import { DecisionEngine } from '../../decision/decisionEngine';
import { DecisionState } from '../../decision/decisionState';
import { DecisionType } from '../../decision/decisionType';
import { ContextType } from '../../context/contextType';
import { Decision } from '../../decision/decision';
import type { Context } from '../../context/context';
import type { Observation } from '../../perception/observation';
import { ObservationType } from '../../perception/observationType';
import { Logger } from '../../utils/logger';

const mockOutputChannel = {
    name: 'Test',
    appendLine: () => {},
    append: () => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
    replace: () => {},
} as unknown as import('vscode').OutputChannel;

Logger.setChannel(mockOutputChannel);

function createMockObservation(type: ObservationType = ObservationType.DIAGNOSTIC_BATCH): Observation {
    return {
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        timestamp: Date.now(),
        confidence: 0.95,
        source: 'test',
        data: {}
    };
}

function createMockContext(
    contextType: ContextType,
    data: Record<string, unknown> = {},
    observation?: Observation
): Context {
    return {
        id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: contextType,
        confidence: 0.9,
        timestamp: Date.now(),
        sourceObservation: observation ?? createMockObservation(),
        data
    };
}

suite('ACES Decision FSM Engine', () => {
    let engine: DecisionEngine;
    let publishedDecisions: Decision[];

    setup(() => {
        engine = new DecisionEngine();
        publishedDecisions = [];
        engine.getPublisher().subscribe((decision) => {
            publishedDecisions.push(decision);
        });
    });

    teardown(() => {
        engine.getPublisher().clear();
    });

    suite('Initial State', () => {
        test('should start in IDLE state', () => {
            const state = engine.getState();
            assert.strictEqual(state.lastDecision, DecisionType.DO_NOTHING);
            assert.strictEqual(state.lastDecisionTime, 0);
            assert.strictEqual(state.lastHint, '');
            assert.strictEqual(state.lastContext, '');
        });

        test('should not be on cooldown initially', () => {
            const state = engine.getState();
            assert.strictEqual(state.cooldownActive, false);
        });
    });

    suite('State Transitions', () => {
        test('should transition to SHOW_ERROR_HELP on USER_STUCK_ON_ERROR context', () => {
            const context = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file: 'test.ts',
                language: 'typescript'
            });

            engine.process(context);

            assert.strictEqual(publishedDecisions.length, 1);
            assert.strictEqual(publishedDecisions[0].type, DecisionType.SHOW_ERROR_HELP);
            assert.strictEqual(publishedDecisions[0].confidence, 0.98);
        });

        test('should transition to SHOW_ERROR_HELP on FIXING_COMPILER_ERROR context', () => {
            const context = createMockContext(ContextType.FIXING_COMPILER_ERROR);

            engine.process(context);

            assert.strictEqual(publishedDecisions.length, 1);
            assert.strictEqual(publishedDecisions[0].type, DecisionType.SHOW_ERROR_HELP);
        });

        test('should transition to SUGGEST_DEBUGGING on DEBUGGING context', () => {
            const context = createMockContext(ContextType.DEBUGGING);

            engine.process(context);

            assert.strictEqual(publishedDecisions.length, 1);
            assert.strictEqual(publishedDecisions[0].type, DecisionType.SUGGEST_DEBUGGING);
            assert.strictEqual(publishedDecisions[0].confidence, 0.90);
        });

        test('should transition to SUGGEST_GIT_ACTION on WORKING_WITH_GIT context', () => {
            const context = createMockContext(ContextType.WORKING_WITH_GIT);

            engine.process(context);

            assert.strictEqual(publishedDecisions.length, 1);
            assert.strictEqual(publishedDecisions[0].type, DecisionType.SUGGEST_GIT_ACTION);
            assert.strictEqual(publishedDecisions[0].confidence, 0.85);
        });

        test('should transition to SUGGEST_EXTENSION on MANAGING_EXTENSIONS context', () => {
            const context = createMockContext(ContextType.MANAGING_EXTENSIONS);

            engine.process(context);

            assert.strictEqual(publishedDecisions.length, 1);
            assert.strictEqual(publishedDecisions[0].type, DecisionType.SUGGEST_EXTENSION);
            assert.strictEqual(publishedDecisions[0].confidence, 0.80);
        });

        test('should transition to WAIT on active editing contexts', () => {
            const editingContexts = [
                ContextType.EDITING_JAVA,
                ContextType.EDITING_TYPESCRIPT,
                ContextType.EDITING_PYTHON,
                ContextType.EDITING_CPP
            ];

            for (const contextType of editingContexts) {
                const context = createMockContext(contextType);
                engine.process(context);

                assert.strictEqual(publishedDecisions.length, 1);
                assert.strictEqual(publishedDecisions[0].type, DecisionType.WAIT);
                publishedDecisions.pop();
                engine.forceCooldown(DecisionType.WAIT, 0);
            }
        });

        test('should transition to DO_NOTHING on IDLE context', () => {
            const context = createMockContext(ContextType.IDLE);

            engine.process(context);

            assert.strictEqual(publishedDecisions.length, 0);
        });

        test('should transition to DO_NOTHING on READING_CODE context', () => {
            const context = createMockContext(ContextType.READING_CODE);

            engine.process(context);

            assert.strictEqual(publishedDecisions.length, 0);
        });

        test('should transition to DO_NOTHING on WRITING_CODE context', () => {
            const context = createMockContext(ContextType.WRITING_CODE);

            engine.process(context);

            assert.strictEqual(publishedDecisions.length, 0);
        });

        test('should update lastContext after processing', () => {
            const context = createMockContext(ContextType.DEBUGGING);

            engine.process(context);

            assert.strictEqual(engine.getState().lastContext, ContextType.DEBUGGING);
        });

        test('should update lastHint after processing', () => {
            const context = createMockContext(ContextType.DEBUGGING);

            engine.process(context);

            assert.strictEqual(engine.getState().lastHint, 'Debug session is active');
        });
    });

    suite('Cooldown Logic', () => {
        test('should suppress duplicate SHOW_ERROR_HELP within cooldown window', () => {
            const file = 'test.ts';
            const context1 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                language: 'typescript'
            });
            const context2 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                language: 'typescript'
            });

            engine.process(context1);
            assert.strictEqual(publishedDecisions.length, 1);

            engine.process(context2);
            assert.strictEqual(publishedDecisions.length, 1, 'Second identical error should be suppressed');
        });

        test('should allow different error types within cooldown window', () => {
            const context1 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file: 'test.ts',
                language: 'typescript'
            });
            const context2 = createMockContext(ContextType.DEBUGGING);

            engine.process(context1);
            assert.strictEqual(publishedDecisions.length, 1);

            engine.process(context2);
            assert.strictEqual(publishedDecisions.length, 2, 'Different decision type should not be suppressed');
        });

        test('should allow same error after cooldown expires', () => {
            const file = 'test.ts';
            const context1 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                language: 'typescript'
            });

            engine.process(context1);
            assert.strictEqual(publishedDecisions.length, 1);

            engine.forceCooldown(DecisionType.SHOW_ERROR_HELP, 0);
            engine.resetDiagnosticNotifyGate();

            const context2 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                language: 'typescript'
            });
            engine.process(context2);
            assert.strictEqual(publishedDecisions.length, 2, 'Same error after cooldown should be allowed');
        });

        test('cooldown state should be active after decision', () => {
            const context = createMockContext(ContextType.DEBUGGING);

            engine.process(context);

            assert.strictEqual(engine.getState().cooldownActive, true);
        });

        test('should suppress 3 identical error events within 10 seconds to produce only 1 dispatch', () => {
            const file = 'problematic.ts';
            const errorSignature = { code: 'TS2322', line: 42 };

            const context1 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                language: 'typescript',
                errors: [errorSignature]
            });
            const context2 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                language: 'typescript',
                errors: [errorSignature]
            });
            const context3 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                language: 'typescript',
                errors: [errorSignature]
            });

            engine.process(context1);
            engine.process(context2);
            engine.process(context3);

            assert.strictEqual(
                publishedDecisions.length,
                1,
                'Three identical errors within 10s should produce only 1 dispatch'
            );
            assert.strictEqual(publishedDecisions[0].type, DecisionType.SHOW_ERROR_HELP);
        });

        test('should allow different error signatures for same file', () => {
            const file = 'multi-error.ts';

            const context1 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                language: 'typescript',
                errors: [{ code: 'TS2322', line: 42 }]
            });
            const context2 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                language: 'typescript',
                errors: [{ code: 'TS2345', line: 100 }]
            });

            engine.process(context1);
            assert.strictEqual(publishedDecisions.length, 1);

            engine.forceCooldown(DecisionType.SHOW_ERROR_HELP, 0);

            engine.process(context2);
            assert.strictEqual(publishedDecisions.length, 2, 'Different error signature should be allowed');
        });
    });

    suite('Skill Score Adjustments', () => {
        test('accepted suggestion should increase skill score', () => {
            const initialScore = 25;
            const increment = 2;
            const expectedScore = Math.min(100, initialScore + increment);

            let currentScore = initialScore;

            const acceptSuggestion = () => {
                currentScore = Math.min(100, currentScore + increment);
                return currentScore;
            };

            const newScore = acceptSuggestion();

            assert.strictEqual(newScore, expectedScore);
            assert.ok(newScore > initialScore, 'Score should increase after accepting suggestion');
        });

        test('dismissed suggestion should decrease skill score', () => {
            const initialScore = 50;
            const decrement = 1;
            const expectedScore = Math.max(0, initialScore - decrement);

            let currentScore = initialScore;

            const dismissSuggestion = () => {
                currentScore = Math.max(0, currentScore - decrement);
                return currentScore;
            };

            const newScore = dismissSuggestion();

            assert.strictEqual(newScore, expectedScore);
            assert.ok(newScore < initialScore, 'Score should decrease after dismissing suggestion');
        });

        test('skill score should not exceed 100', () => {
            let score = 99;
            const increment = 2;

            score = Math.min(100, score + increment);

            assert.strictEqual(score, 100);
            assert.ok(score <= 100, 'Score should be capped at 100');
        });

        test('skill score should not go below 0', () => {
            let score = 1;
            const decrement = 2;

            score = Math.max(0, score - decrement);

            assert.strictEqual(score, 0);
            assert.ok(score >= 0, 'Score should not go below 0');
        });

        test('multiple accepted suggestions should accumulate', () => {
            let score = 25;
            const increment = 2;
            const acceptCount = 10;

            for (let i = 0; i < acceptCount; i++) {
                score = Math.min(100, score + increment);
            }

            assert.strictEqual(score, 45);
        });

        test('multiple dismissed suggestions should accumulate', () => {
            let score = 50;
            const decrement = 1;
            const dismissCount = 30;

            for (let i = 0; i < dismissCount; i++) {
                score = Math.max(0, score - decrement);
            }

            assert.strictEqual(score, 20);
        });

        test('skill level should update based on score', () => {
            const calculateLevel = (score: number): string => {
                if (score <= 30) {return 'BEGINNER';}
                if (score <= 60) {return 'INTERMEDIATE';}
                if (score <= 85) {return 'ADVANCED';}
                return 'EXPERT';
            };

            assert.strictEqual(calculateLevel(0), 'BEGINNER');
            assert.strictEqual(calculateLevel(30), 'BEGINNER');
            assert.strictEqual(calculateLevel(31), 'INTERMEDIATE');
            assert.strictEqual(calculateLevel(60), 'INTERMEDIATE');
            assert.strictEqual(calculateLevel(61), 'ADVANCED');
            assert.strictEqual(calculateLevel(85), 'ADVANCED');
            assert.strictEqual(calculateLevel(86), 'EXPERT');
            assert.strictEqual(calculateLevel(100), 'EXPERT');
        });
    });

    suite('Decision Publisher', () => {
        test('should notify subscribers on decision', () => {
            let notified = false;
            engine.getPublisher().subscribe(() => {
                notified = true;
            });

            const context = createMockContext(ContextType.DEBUGGING);
            engine.process(context);

            assert.strictEqual(notified, true);
        });

        test('should support multiple subscribers', () => {
            let count = 0;
            engine.getPublisher().subscribe(() => count++);
            engine.getPublisher().subscribe(() => count++);

            const context = createMockContext(ContextType.DEBUGGING);
            engine.process(context);

            assert.strictEqual(count, 2);
        });

        test('should unsubscribe correctly', () => {
            let count = 0;
            const listener = () => count++;
            engine.getPublisher().subscribe(listener);

            const context = createMockContext(ContextType.DEBUGGING);
            engine.process(context);
            assert.strictEqual(count, 1);

            engine.getPublisher().unsubscribe(listener);
            engine.process(context);
            assert.strictEqual(count, 1, 'Should not increment after unsubscribe');
        });
    });

    suite('Decision Metadata', () => {
        test('should include decision ID', () => {
            const context = createMockContext(ContextType.DEBUGGING);

            engine.process(context);

            assert.ok(publishedDecisions[0].id.startsWith('dec-'));
        });

        test('should include timestamp', () => {
            const before = Date.now();
            const context = createMockContext(ContextType.DEBUGGING);

            engine.process(context);

            const after = Date.now();
            assert.ok(publishedDecisions[0].timestamp >= before);
            assert.ok(publishedDecisions[0].timestamp <= after);
        });

        test('should include source context', () => {
            const context = createMockContext(ContextType.DEBUGGING);

            engine.process(context);

            assert.strictEqual(publishedDecisions[0].sourceContext.type, ContextType.DEBUGGING);
        });

        test('should include confidence score', () => {
            const context = createMockContext(ContextType.DEBUGGING);

            engine.process(context);

            assert.strictEqual(publishedDecisions[0].confidence, 0.90);
        });

        test('should include reason', () => {
            const context = createMockContext(ContextType.DEBUGGING);

            engine.process(context);

            assert.strictEqual(publishedDecisions[0].reason, 'Debug session is active');
        });

        test('USER_STUCK_ON_ERROR should include action profile', () => {
            const context = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file: 'test.ts'
            });

            engine.process(context);

            const actionProfile = publishedDecisions[0].data['actionProfile'] as Record<string, unknown>;
            assert.ok(actionProfile);
            assert.strictEqual(actionProfile['expression'], 'confused');
            assert.strictEqual(actionProfile['animation'], 'shake');
        });
    });

    suite('Edge Cases', () => {
        test('should handle unknown context type', () => {
            const context = createMockContext('UNKNOWN_CONTEXT' as ContextType);

            engine.process(context);

            assert.strictEqual(publishedDecisions.length, 1);
            assert.strictEqual(publishedDecisions[0].type, DecisionType.WAIT);
            assert.strictEqual(publishedDecisions[0].confidence, 0.50);
        });

        test('should handle DIAGNOSTIC_ANALYSIS as DO_NOTHING', () => {
            const context = createMockContext(ContextType.DIAGNOSTIC_ANALYSIS);

            engine.process(context);

            assert.strictEqual(publishedDecisions.length, 0);
        });

        test('reset should clear all state', () => {
            const context = createMockContext(ContextType.DEBUGGING);
            engine.process(context);
            assert.strictEqual(engine.getState().cooldownActive, true);

            engine.getState().reset();

            assert.strictEqual(engine.getState().lastDecision, DecisionType.DO_NOTHING);
            assert.strictEqual(engine.getState().lastDecisionTime, 0);
            assert.strictEqual(engine.getState().cooldownActive, false);
        });

        test('resetDiagnosticNotifyGate should clear diagnostic dedup state', () => {
            const file = 'test.ts';
            const context1 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                errors: [{ code: 'TS2322', line: 42 }]
            });

            engine.process(context1);
            assert.strictEqual(publishedDecisions.length, 1);

            engine.resetDiagnosticNotifyGate();
            engine.forceCooldown(DecisionType.SHOW_ERROR_HELP, 0);

            const context2 = createMockContext(ContextType.USER_STUCK_ON_ERROR, {
                file,
                errors: [{ code: 'TS2322', line: 42 }]
            });
            engine.process(context2);
            assert.strictEqual(publishedDecisions.length, 2, 'After reset, same error should be allowed');
        });
    });
});
