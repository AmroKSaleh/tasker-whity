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
     * A rule must be a JSON OBJECT. `rules: ["just a string"]` or a nested
     * array cannot be merged into a producer contract, and dropping a caller's
     * declared demand without saying so is the exact failure mode this class's
     * assumptions exist to prevent. `array_is_list([])` being TRUE means the one
     * check also refuses `{}` — a rule with nothing in it — the same way
     * {@see \Tasker\Api\TaskEdgesApiHandler::setOutput()}'s own guard does.
     */
    public function testARuleThatIsNotAJsonObjectIsSkippedAndSaidSoRatherThanDroppedSilently(): void
    {
        $r = ContractDeriver::derive([
            ['consumer_label' => 'TDE-2', 'contract' => ['rules' => [
                'just a string',
                [],
                ['label' => 'The one real rule'],
            ]]],
        ]);

        self::assertSame(['The one real rule'], array_column($r['rules'], 'label'));
        self::assertCount(1, $r['assumptions'], 'the consumer DID contribute a rule, so only the skip is worth saying');
        // '2 input rules' rather than a bare '2': the label itself is "TDE-2",
        // so asserting on the digit alone would pass without the count ever
        // being reported.
        self::assertStringContainsString('TDE-2 declared 2 input rules', $r['assumptions'][0],
            'the human must be told WHICH consumer and HOW MANY declared rules were unusable');
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
