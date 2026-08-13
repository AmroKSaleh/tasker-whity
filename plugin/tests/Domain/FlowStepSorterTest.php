<?php

declare(strict_types=1);

namespace Tasker\Tests\Domain;

use PHPUnit\Framework\TestCase;
use Tasker\Domain\FlowStepSorter;

final class FlowStepSorterTest extends TestCase
{
    public function testOrdersAChainAndNumbersFromOne(): void
    {
        $r = FlowStepSorter::sort([10, 20, 30], [
            ['source' => 10, 'target' => 20],
            ['source' => 20, 'target' => 30],
        ]);

        self::assertTrue($r['ok']);
        self::assertSame([10 => 1, 20 => 2, 30 => 3], $r['positions']);
    }

    public function testADiamondPutsTheJoinLast(): void
    {
        $r = FlowStepSorter::sort([1, 2, 3, 4], [
            ['source' => 1, 'target' => 2],
            ['source' => 1, 'target' => 3],
            ['source' => 2, 'target' => 4],
            ['source' => 3, 'target' => 4],
        ]);

        self::assertTrue($r['ok']);
        self::assertSame(1, $r['positions'][1]);
        self::assertSame(4, $r['positions'][4]);
        self::assertGreaterThan($r['positions'][1], $r['positions'][2]);
        self::assertGreaterThan($r['positions'][3], $r['positions'][4]);
    }

    public function testIndependentSiblingsOrderStablyByTaskId(): void
    {
        // No edges at all: order must be deterministic, not hash order.
        $r = FlowStepSorter::sort([30, 10, 20], []);

        self::assertTrue($r['ok']);
        self::assertSame([10 => 1, 20 => 2, 30 => 3], $r['positions']);
    }

    public function testDisconnectedComponentsAreBothOrdered(): void
    {
        $r = FlowStepSorter::sort([1, 2, 3, 4], [
            ['source' => 1, 'target' => 2],
            ['source' => 3, 'target' => 4],
        ]);

        self::assertTrue($r['ok']);
        self::assertCount(4, $r['positions']);
        self::assertGreaterThan($r['positions'][1], $r['positions'][2]);
        self::assertGreaterThan($r['positions'][3], $r['positions'][4]);
    }

    public function testASingleNodeFlowIsPositionOne(): void
    {
        $r = FlowStepSorter::sort([99], []);

        self::assertTrue($r['ok']);
        self::assertSame([99 => 1], $r['positions']);
    }

    public function testACycleIsReportedWithItsPath(): void
    {
        $r = FlowStepSorter::sort([1, 2, 3], [
            ['source' => 1, 'target' => 2],
            ['source' => 2, 'target' => 3],
            ['source' => 3, 'target' => 1],
        ]);

        self::assertFalse($r['ok']);
        self::assertNotEmpty($r['cycle'], 'the caller needs the path to name it in a 422');
    }

    public function testAnEdgeTouchingATaskOutsideTheFlowIsIgnored(): void
    {
        // Edges may reference tasks in the project that are not flow members.
        $r = FlowStepSorter::sort([1, 2], [
            ['source' => 1, 'target' => 2],
            ['source' => 999, 'target' => 2],
        ]);

        self::assertTrue($r['ok']);
        self::assertSame([1 => 1, 2 => 2], $r['positions']);
        self::assertArrayNotHasKey(999, $r['positions']);
    }
}
