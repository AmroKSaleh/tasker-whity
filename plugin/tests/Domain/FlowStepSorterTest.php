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

    public function testACycleWithADownstreamSuccessorReportsOnlyTheCycle(): void
    {
        // 1 -> 2 -> 3 -> 1 is the cycle; 4 hangs off 3 and is NOT in it. The
        // 3->4 edge is listed BEFORE 3->1 on purpose: a greedy first-successor
        // walk dead-ends at 4 and reports a path that closes no loop.
        $r = FlowStepSorter::sort([1, 2, 3, 4], [
            ['source' => 1, 'target' => 2],
            ['source' => 2, 'target' => 3],
            ['source' => 3, 'target' => 4],
            ['source' => 3, 'target' => 1],
        ]);

        self::assertFalse($r['ok']);
        self::assertSame([1, 2, 3], $r['cycle']);
        self::assertNotContains(4, $r['cycle'], '4 is downstream of the cycle, not in it');
    }

    public function testALowerIdSinkDownstreamOfACycleDoesNotMaskIt(): void
    {
        // The cycle is 2 -> 3 -> 4 -> 2. Node 1 is an innocent sink reached via
        // 4 -> 1 and has the LOWEST id, so a walk that simply starts at the
        // lowest stuck id fabricates a single-node "cycle" and never finds the
        // real one.
        $r = FlowStepSorter::sort([1, 2, 3, 4], [
            ['source' => 2, 'target' => 3],
            ['source' => 3, 'target' => 4],
            ['source' => 4, 'target' => 2],
            ['source' => 4, 'target' => 1],
        ]);

        self::assertFalse($r['ok']);
        self::assertSame([2, 3, 4], $r['cycle']);
    }

    public function testTwoDisjointCyclesReportTheLowestIdOneInFull(): void
    {
        $r = FlowStepSorter::sort([1, 2, 3, 4], [
            ['source' => 1, 'target' => 2],
            ['source' => 2, 'target' => 1],
            ['source' => 3, 'target' => 4],
            ['source' => 4, 'target' => 3],
        ]);

        self::assertFalse($r['ok']);
        self::assertSame([1, 2], $r['cycle']);
    }

    public function testEveryReportedCycleNodeGenuinelyClosesTheLoop(): void
    {
        $edges = [
            ['source' => 5, 'target' => 6],
            ['source' => 6, 'target' => 7],
            ['source' => 7, 'target' => 5],
        ];

        $r = FlowStepSorter::sort([5, 6, 7], $edges);
        self::assertFalse($r['ok']);

        $lookup = [];
        foreach ($edges as $e) {
            $lookup[$e['source']][$e['target']] = true;
        }

        $cycle = $r['cycle'];
        $n     = count($cycle);
        self::assertGreaterThan(1, $n, 'a single node is not a cycle without a self-edge');

        for ($i = 0; $i < $n; $i++) {
            $from = $cycle[$i];
            $to   = $cycle[($i + 1) % $n];
            self::assertTrue(isset($lookup[$from][$to]), "reported cycle must use the real edge {$from}->{$to}");
        }
    }

    public function testFreedNodesRejoinTheReadySetInIdOrderNotArrivalOrder(): void
    {
        // Draining 1 frees 2. Without the post-freeing re-sort, the ready set
        // is [50, 2] and 50 wrongly takes position 2.
        $r = FlowStepSorter::sort([1, 50, 2], [
            ['source' => 1, 'target' => 2],
        ]);

        self::assertTrue($r['ok']);
        self::assertSame([1 => 1, 2 => 2, 50 => 3], $r['positions']);
    }

    public function testMemoryUsageOnALongCycleIsLinearNotQuadratic(): void
    {
        // A stuck chain of 5000 nodes should use O(N) memory with backtracking,
        // not O(N^2) with copy-on-write. Previous by-value implementation used
        // 30MB at N=1000, 66MB at N=1500, 102MB at N=2000, and would fatall
        // uncatchably at N=5000. Backtracking version should stay well under 10MB.
        $n       = 5000;
        $taskIds = range(1, $n);
        $edges   = [];
        for ($i = 1; $i < $n; $i++) {
            $edges[] = ['source' => $i, 'target' => $i + 1];
        }
        // Close the cycle: n -> 1
        $edges[] = ['source' => $n, 'target' => 1];

        $startMem = memory_get_usage(true);
        $r = FlowStepSorter::sort($taskIds, $edges);
        $peakMem = memory_get_peak_usage(true);

        self::assertFalse($r['ok'], 'a cycle of 1..n->1 must be detected');
        self::assertCount($n, $r['cycle'], "the full cycle path of {$n} nodes must be reported");

        $memUsedMb = ($peakMem - $startMem) / 1024 / 1024;
        self::assertLessThan(15, $memUsedMb, "memory usage {$memUsedMb}MB exceeds linear budget; quadratic blowup may have returned");
    }
}
