<?php

declare(strict_types=1);

namespace Tasker\Tests\Domain;

use PHPUnit\Framework\TestCase;
use Tasker\Domain\ContractDeriver;

/**
 * D5a Task 9. SQLite tier (in fact no database at all) because
 * {@see ContractDeriver} is pure — no PDO, no tenant, no OU. The ROUTE that
 * feeds it is none of those things, so its coverage lives in
 * {@see \Tasker\Tests\TenantIsolationOuTest} instead.
 */
final class ContractDeriverTest extends TestCase
{
    public function testASingleConsumerYieldsItsRulesWithNoAssumptions(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [['label' => 'Has a summary', 'kind' => 'check']]]],
        ]);

        self::assertCount(1, $r['rules']);
        self::assertSame([], $r['assumptions']);
    }

    public function testTwoConsumersMergeAndTheMergeIsDeclaredAnAssumption(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [['label' => 'Has a summary', 'kind' => 'check']]]],
            ['consumer_label' => 'TDE-3', 'contract' => ['rules' => [['label' => 'Cites a source', 'kind' => 'judgment']]]],
        ]);

        self::assertCount(2, $r['rules']);
        self::assertNotEmpty($r['assumptions'], 'a multi-consumer merge is exactly what a human must review');
    }

    public function testIdenticalRulesFromTwoConsumersDeduplicate(): void
    {
        $rule = ['label' => 'Has a summary', 'kind' => 'check'];
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [$rule]]],
            ['consumer_label' => 'TDE-3', 'contract' => ['rules' => [$rule]]],
        ]);

        self::assertCount(1, $r['rules']);
    }

    public function testAConsumerWithNoContractIsReportedAsMissingCriteria(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => null],
        ]);

        self::assertSame([], $r['rules']);
        self::assertNotEmpty($r['assumptions']);
        self::assertStringContainsString('TDE-2', implode(' ', $r['assumptions']),
            'the human needs to know WHICH consumer declared nothing');
    }

    public function testNoConsumersAtAllIsReportedRatherThanReturningAnEmptyDraft(): void
    {
        $r = ContractDeriver::derive([]);

        self::assertSame([], $r['rules']);
        self::assertNotEmpty($r['assumptions']);
    }

    /**
     * The dedupe of the test above is the single LOSSIEST thing this class does
     * — two consumers' separately-authored demands collapse into one row of the
     * producer's contract — so it may not happen silently. The original surfaces
     * exactly this ("Rule … is demanded by more than one consumer — merged into
     * a single output rule; verify they mean the same thing").
     */
    public function testADeduplicatedRuleIsNamedInTheAssumptionsRatherThanMergedSilently(): void
    {
        $rule = ['label' => 'Has a summary', 'kind' => 'check'];
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [$rule]]],
            ['consumer_label' => 'TDE-3', 'contract' => ['rules' => [$rule]]],
        ]);

        self::assertStringContainsString('Has a summary', implode(' ', $r['assumptions']),
            'the merged rule must be named, or a human cannot check the two consumers meant the same bar');
        self::assertStringContainsString('TDE-2 and TDE-3', implode(' ', $r['assumptions']),
            'and BOTH consumers must be named -- "somebody else also wants this" is not checkable');
    }

    /**
     * ONE consumer listing the same rule twice on its own edge is also a merge,
     * but it is NOT "demanded by more than one consumer" — and a merge note that
     * says something false about who demanded what is worse than none, because
     * the human would go looking for a second consumer that does not exist.
     */
    public function testADuplicateWithinOneConsumersOwnEdgeIsNotReportedAsATwoConsumerMerge(): void
    {
        $rule = ['label' => 'Has a summary', 'kind' => 'check'];
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [$rule, $rule]]],
        ]);

        self::assertCount(1, $r['rules']);
        self::assertCount(1, $r['assumptions']);
        self::assertStringContainsString('more than once on its own edge', $r['assumptions'][0]);
        self::assertStringNotContainsString('more than one consumer', $r['assumptions'][0]);
    }

    /**
     * THE DEDUPE IS KEY-ORDER INSENSITIVE, deliberately (see
     * ContractDeriver::dedupeKey()'s own docblock). Consumer edge contracts are
     * stored in a jsonb column, which normalises the key order WITHIN an object
     * — so key order is not a property a caller controls or can rely on, and a
     * key-order-SENSITIVE dedupe would make the merge depend on something the
     * storage layer is free to change under it.
     */
    public function testTheDedupeIgnoresKeyOrderBecauseJsonbDoesNotPreserveIt(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [['label' => 'Has a summary', 'kind' => 'check']]]],
            ['consumer_label' => 'TDE-3', 'contract' => ['rules' => [['kind' => 'check', 'label' => 'Has a summary']]]],
        ]);

        self::assertCount(1, $r['rules'], 'the same pairs in a different key order are the same demand');
    }

    /**
     * Rule ids are assigned AFTER the dedupe, and a consumer's own id is dropped
     * on the way in. Both halves matter: assigning first would give two
     * identical rules two different ids and defeat the dedupe entirely, and
     * carrying a consumer's id through would put a handle on a rule in a
     * DIFFERENT contract into the producer's own — where, as the fixture below
     * shows, two consumers can trivially collide on one.
     */
    public function testRuleIdsAreAssignedAfterTheDedupeSoAConsumersOwnIdCannotSplitOrCollideThem(): void
    {
        $shared = ['label' => 'Has a summary', 'rule' => 'one paragraph, under 80 words'];
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [['id' => 'a1'] + $shared]]],
            ['consumer_label' => 'TDE-3', 'contract' => ['rules' => [
                ['id' => 'zz'] + $shared,
                ['id' => 'a1', 'label' => 'Cites a source', 'rule' => 'at least one primary source'],
            ]]],
        ]);

        self::assertSame(['Has a summary', 'Cites a source'], array_column($r['rules'], 'label'),
            'differing ids must not split one shared demand into two rules');
        self::assertSame(['r1', 'r2'], array_column($r['rules'], 'id'),
            'ids are this class\'s to assign: sequential over the DEDUPED list, and unique');
    }

    /**
     * A contract that exists but declares an empty rule list says exactly as
     * much as no contract at all: the handoff is declared, the BAR is not. Same
     * assumption, and the original treats the two identically too.
     */
    public function testAnEmptyRuleListIsReportedTheSameWayAMissingContractIs(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => []]],
            ['consumer_label' => 'TDE-3', 'contract' => []],
        ]);

        self::assertSame([], $r['rules']);
        $joined = implode(' ', $r['assumptions']);
        self::assertStringContainsString('TDE-2', $joined);
        self::assertStringContainsString('TDE-3', $joined);
    }

    /**
     * A rule must be a JSON OBJECT WITH SOMETHING IN IT, and every candidate
     * that is neither is counted and reported. Dropping a caller's declared
     * demand without saying so is the exact failure mode this class's
     * assumptions exist to prevent.
     *
     * The two buckets are reported separately because they are different facts:
     * `{}` and `{"id": "r1"}` ARE JSON objects, so a note calling them "not a
     * JSON object" would be false.
     */
    public function testEveryCandidateThatCannotBecomeARuleIsCountedAndReportedByReason(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [
                'just a string',
                ['not', 'an', 'object'],
                [],
                ['id' => 'r1'],
                ['label' => 'The one real rule'],
            ]]],
        ]);

        self::assertSame(['The one real rule'], array_column($r['rules'], 'label'));
        self::assertSame(['r1'], array_column($r['rules'], 'id'),
            'and the ids are this class\'s own, so the skipped id-only rule cannot have leaked one');

        $joined = implode(' ', $r['assumptions']);
        self::assertCount(2, $r['assumptions'], 'one note per reason, and no "declares no input rules" -- it did');
        // '2 input rules' rather than a bare '2': the label itself is "TDE-2",
        // so asserting on the digit alone would pass without the count ever
        // being reported.
        self::assertStringContainsString('TDE-2 declared 2 input rules that are not JSON objects', $joined);
        self::assertStringContainsString('TDE-2 declared 2 input rules with nothing in them', $joined);
    }

    /**
     * REVIEW ROUND 1, THE IMPORTANT FINDING. An id-only rule is a JSON object,
     * so it passes the object guard — and then the id strip empties it. It used
     * to survive as `{"id": "r1"}`: a rule with no content at all, and no
     * assumption recorded.
     *
     * Reachable, not hypothetical: set_task_input validates only that an edge
     * contract IS a JSON object, so `{"rules":[{"id":"r1"}]}` is real, storable
     * input. And on `apply: true` the resulting draft is a non-empty object, so
     * it cleared setOutput()'s own non-empty guard, leaving confirm_contract able
     * to bless a definition-of-done whose only rule said nothing.
     */
    public function testAnIdOnlyRuleIsRefusedRatherThanEmittedAsARuleWithNoContent(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [['id' => 'r1']]]],
        ]);

        self::assertSame([], $r['rules'], 'a rule that is empty once its id is stripped is not a rule');
        self::assertCount(1, $r['assumptions']);
        self::assertStringContainsString('TDE-2 declared 1 input rule with nothing in it', $r['assumptions'][0]);
    }

    /**
     * REVIEW ROUND 1, Minor (a). A consumer whose every rule was skipped HAS
     * declared input rules, so the "declares no input rules" note must not fire
     * alongside the skip note and contradict it.
     */
    public function testAConsumerWhoseEveryRuleWasSkippedIsNotAlsoToldItDeclaredNone(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => ['just a string']]],
        ]);

        self::assertSame([], $r['rules']);
        self::assertCount(1, $r['assumptions'], 'one note about the skip, not a second one contradicting it');
        self::assertStringNotContainsString('declares no input rules', $r['assumptions'][0]);
    }

    /**
     * REVIEW ROUND 1, Minor (b). Labels are NOT unique — the route falls back to
     * the task's own text for a task with no short id — so consumer identity
     * here is the edge's POSITION. Comparing labels turned a genuine
     * two-consumer merge into "one consumer repeated itself", the same false
     * note the self-vs-cross split exists to prevent, arriving by another route.
     */
    public function testTwoConsumersSharingALabelAreStillTwoConsumers(): void
    {
        $rule = ['label' => 'Has a summary'];
        $r = ContractDeriver::derive([
            ['consumer_label' => 'Review the draft', 'contract' => ['rules' => [$rule]]],
            ['consumer_label' => 'Review the draft', 'contract' => ['rules' => [$rule]]],
        ]);

        $joined = implode(' ', $r['assumptions']);
        self::assertCount(1, $r['rules']);
        self::assertStringContainsString('demanded by more than one consumer', $joined);
        self::assertStringNotContainsString('more than once on its own edge', $joined);
    }

    /**
     * REVIEW ROUND 1, Minor (d). A `rules` that arrived as a JSON OBJECT is
     * REFUSED with a note, not silently read by taking its values: a contract is
     * an ordered list, and an object's order is not the caller's — jsonb
     * normalises object keys, so the authoring order is already gone. Reading it
     * would invent an order and present the invention as the human's own bar.
     *
     * The fixture is deliberately keyed b-then-a, which is how the old
     * array_values() behaviour was caught: it derived "Second" before "First".
     */
    public function testRulesDeclaredAsAJsonObjectAreRefusedRatherThanSilentlyReordered(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [
                'b' => ['label' => 'Second'],
                'a' => ['label' => 'First'],
            ]]],
        ]);

        self::assertSame([], $r['rules']);
        self::assertCount(1, $r['assumptions']);
        self::assertStringContainsString('TDE-2 declared its input rules as a JSON object', $r['assumptions'][0]);
        self::assertStringContainsString('set_task_input', $r['assumptions'][0], 'and how to fix it');
    }

    /**
     * REVIEW ROUND 1, Minor (c). A truncated rule name must not read as a
     * complete one, inside a note whose whole job is to send a human to look at
     * one specific rule.
     */
    public function testALongRuleNameIsTruncatedWithAVisibleMarker(): void
    {
        $long = ['label' => 'Has a summary of the source material that covers every section of the outline'];
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [$long]]],
            ['consumer_label' => 'TDE-3', 'contract' => ['rules' => [$long]]],
        ]);

        $joined = implode(' ', $r['assumptions']);
        self::assertStringContainsString('Has a summary of the source material...', $joined);
        self::assertStringNotContainsString('every section', $joined, 'the name is cut, and says so');
        self::assertSame(
            $long['label'],
            $r['rules'][0]['label'],
            'only the NAME in the prose is shortened -- the rule itself keeps the label the consumer wrote'
        );
    }

    /**
     * The merge assumption is about CONTRIBUTING consumers, not about how many
     * edges were looked at: one consumer with rules plus one with none is not a
     * merge, and calling it one would train a human to ignore the word.
     */
    public function testASingleContributingConsumerIsNotReportedAsAMerge(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [['label' => 'Has a summary']]]],
            ['consumer_label' => 'TDE-3', 'contract' => null],
        ]);

        self::assertCount(1, $r['rules']);
        self::assertCount(1, $r['assumptions'], 'only TDE-3\'s missing criteria, not a merge that never happened');
        self::assertStringContainsString('TDE-3', $r['assumptions'][0]);
    }

    /**
     * Rule ORDER is consumer order, then declaration order within a consumer —
     * a contract is "an ordered list of rules the artifact must satisfy" (the
     * set_task_output route's own words), so the order has to come from
     * somewhere stated rather than from PHP's hash order.
     */
    public function testRulesKeepConsumerOrderThenDeclarationOrder(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [['label' => 'First'], ['label' => 'Second']]]],
            ['consumer_label' => 'TDE-3', 'contract' => ['rules' => [['label' => 'Third']]]],
        ]);

        self::assertSame(['First', 'Second', 'Third'], array_column($r['rules'], 'label'));
    }
}
