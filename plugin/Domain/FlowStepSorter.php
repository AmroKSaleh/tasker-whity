<?php

declare(strict_types=1);

namespace Tasker\Domain;

/**
 * Topological sorter for task dependency graphs.
 *
 * Turns a task-dependency graph into flow step positions using Kahn's algorithm
 * with deterministic ordering, or reports a cycle if one exists.
 *
 * This class has no database, no tenant, and no OU scoping — it is a pure function
 * suitable for testing on SQLite while the rest of the flow slice runs on PostgreSQL.
 */
final class FlowStepSorter
{
    /**
     * Computes topological order for a flow's tasks, numbering steps from 1.
     *
     * @param list<int> $taskIds
     * @param list<array{source:int,target:int}> $edges
     * @return array{ok:true,positions:array<int,int>}|array{ok:false,cycle:list<int>}
     */
    public static function sort(array $taskIds, array $edges): array
    {
        $members = [];
        foreach ($taskIds as $id) {
            $members[$id] = true;
        }

        /** @var array<int, list<int>> $out */
        $out = [];
        /** @var array<int, int> $inDegree */
        $inDegree = array_fill_keys($taskIds, 0);

        foreach ($edges as $edge) {
            // An edge may reference a task in the project that is NOT a flow
            // member; it constrains nothing inside this flow, so skip it.
            if (!isset($members[$edge['source']], $members[$edge['target']])) {
                continue;
            }
            $out[$edge['source']][] = $edge['target'];
            $inDegree[$edge['target']]++;
        }

        // Ready set drained in ascending task-id order, so independent siblings
        // get stable positions instead of PHP's array-insertion order.
        $ready = [];
        foreach ($inDegree as $id => $degree) {
            if ($degree === 0) {
                $ready[] = $id;
            }
        }
        sort($ready);

        $positions = [];
        $step      = 1;

        while ($ready !== []) {
            $id             = array_shift($ready);
            $positions[$id] = $step++;
            $freed          = [];

            foreach ($out[$id] ?? [] as $next) {
                if (--$inDegree[$next] === 0) {
                    $freed[] = $next;
                }
            }

            if ($freed !== []) {
                $ready = array_merge($ready, $freed);
                sort($ready);
            }
        }

        if (count($positions) !== count($taskIds)) {
            return ['ok' => false, 'cycle' => self::cyclePath($taskIds, $positions, $out)];
        }

        return ['ok' => true, 'positions' => $positions];
    }

    /**
     * Every task with no assigned position is in, or downstream of, a cycle.
     * Walk from the lowest such id following unassigned successors until a node
     * repeats — that repeat closes the loop, and the slice from its first
     * appearance is the path to name in the 422.
     *
     * @param list<int>              $taskIds
     * @param array<int, int>        $positions
     * @param array<int, list<int>>  $out
     * @return list<int>
     */
    private static function cyclePath(array $taskIds, array $positions, array $out): array
    {
        $stuck = array_values(array_filter($taskIds, static fn(int $id): bool => !isset($positions[$id])));
        sort($stuck);

        $path = [];
        $seen = [];
        $at   = $stuck[0];

        while (!isset($seen[$at])) {
            $seen[$at] = count($path);
            $path[]    = $at;

            $nextUnassigned = null;
            foreach ($out[$at] ?? [] as $candidate) {
                if (!isset($positions[$candidate])) {
                    $nextUnassigned = $candidate;
                    break;
                }
            }

            if ($nextUnassigned === null) {
                return $path;
            }
            $at = $nextUnassigned;
        }

        return array_slice($path, $seen[$at]);
    }
}
