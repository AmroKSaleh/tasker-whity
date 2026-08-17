<?php

declare(strict_types=1);

namespace Tasker\Domain;

/**
 * Thrown when a candidate edge (or a flow's current membership) is found by
 * {@see FlowStepSorter::sort()} to contain a dependency cycle — D5a Task 7.
 *
 * Every throw site sits INSIDE an already-open database transaction (see
 * {@see \Tasker\Api\TaskEdgesApiHandler}'s own docblock for exactly where):
 * this class carries no database access of its own and never rolls anything
 * back itself. The catching method must roll back the SAME transaction the
 * throw happened inside, then turn this into a 422 naming {@see self::cycle()}
 * — never leave the write that triggered the check committed.
 */
final class FlowCycleException extends \RuntimeException
{
    /** @var list<int> */
    private array $cycle;

    /** @param list<int> $cycle */
    public function __construct(array $cycle)
    {
        parent::__construct('Dependency cycle: ' . implode(' -> ', $cycle));
        $this->cycle = $cycle;
    }

    /** @return list<int> */
    public function cycle(): array
    {
        return $this->cycle;
    }
}
