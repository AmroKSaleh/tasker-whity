<?php

declare(strict_types=1);

namespace Tasker\Domain;

use PDO;

/**
 * Derives a project prefix (the TDE in TDE-31) from its name.
 *
 * Mirrors the original app's deriveProjectPrefix() so that a project imported
 * later gets the same prefix it had before, and so short ids agents already
 * know keep resolving. The original scopes collision checks per user; we scope
 * per tenant, which is the equivalent boundary here.
 */
final class PrefixDeriver
{
    /** @var list<string> */
    private const SUFFIXES = ['', 'X', 'Y', 'Z', 'A', 'B', 'C', 'D', 'E', 'F'];

    public static function derive(PDO $db, int $tenantId, string $name): ?string
    {
        $words = array_values(array_filter(preg_split('/[^A-Z]+/', strtoupper($name)) ?: []));

        $base = count($words) >= 2
            ? implode('', array_map(static fn (string $w): string => $w[0], array_slice($words, 0, 4)))
            : substr($words[0] ?? '', 0, 4);

        if (strlen($base) < 2) {
            $base = substr($base . 'PRJ', 0, 3);
        }
        $base = substr($base, 0, 5);

        $taken = self::takenPrefixes($db, $tenantId);

        // Truncate relative to the BASE's own length, not a hardcoded 5: a
        // suffix replaces trailing characters of the base so the candidate
        // stays the same length as the unsuffixed base (e.g. "TDE" + "X"
        // collision candidate is "TDX", not "TDEX") -- confirmed against
        // PrefixDeriverTest::testSuffixesOnCollisionWithinTheTenant. A
        // hardcoded 5 only matches this when $base is already 5 chars long;
        // for anything shorter it silently grows the candidate past the
        // base's own length instead of substituting into it.
        $baseLength = strlen($base);

        foreach (self::SUFFIXES as $suffix) {
            $candidate = substr($base, 0, $baseLength - strlen($suffix)) . $suffix;
            $length    = strlen($candidate);

            if ($length >= 2 && $length <= 5 && !isset($taken[$candidate])) {
                return $candidate;
            }
        }

        // Every candidate taken. Null is a legitimate outcome: the project
        // simply has no prefix, and therefore no short ids.
        return null;
    }

    /**
     * @return array<string, true>
     */
    private static function takenPrefixes(PDO $db, int $tenantId): array
    {
        $stmt = $db->prepare(
            'SELECT prefix FROM tasker_projects WHERE tenant_id = :tenant_id AND prefix IS NOT NULL'
        );
        $stmt->execute([':tenant_id' => $tenantId]);

        $taken = [];
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $prefix) {
            $taken[strtoupper((string) $prefix)] = true;
        }

        return $taken;
    }
}
