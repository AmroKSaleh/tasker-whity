<?php

declare(strict_types=1);

namespace Tasker\Tests\Access;

use PHPUnit\Framework\TestCase;
use Tasker\Access\IdentifierResolver;

final class IdentifierResolverTest extends TestCase
{
    /**
     * Precedence is fixed and documented: integer, UUID, short id, prefix,
     * slug. The first match wins. Ambiguity resolves silently rather than
     * erroring, so that a caller who works today keeps working.
     */
    public function testClassifiesEachIdentifierForm(): void
    {
        self::assertSame('empty', IdentifierResolver::classify(null));
        self::assertSame('empty', IdentifierResolver::classify(''));
        self::assertSame('empty', IdentifierResolver::classify('   '));

        self::assertSame('integer', IdentifierResolver::classify(42));
        self::assertSame('integer', IdentifierResolver::classify('42'));

        self::assertSame('uuid', IdentifierResolver::classify('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));

        self::assertSame('short_id', IdentifierResolver::classify('TDE-31'));
        self::assertSame('short_id', IdentifierResolver::classify('AB-1'));
        self::assertSame('short_id', IdentifierResolver::classify('ABCDE-9999'));

        self::assertSame('prefix', IdentifierResolver::classify('TDE'));
        self::assertSame('prefix', IdentifierResolver::classify('AB'));

        self::assertSame('slug', IdentifierResolver::classify('website-redesign'));
        self::assertSame('slug', IdentifierResolver::classify('backlog'));
    }

    public function testRejectsAMalformedShortIdRatherThanTreatingItAsASlug(): void
    {
        // TDE-abc looks like a short id and is not one. Silently falling
        // through to a slug lookup would turn a typo into a confusing 404;
        // this is the one case that earns a 400.
        self::assertSame('malformed_short_id', IdentifierResolver::classify('TDE-abc'));
        self::assertSame('malformed_short_id', IdentifierResolver::classify('TDE-'));
        self::assertSame('malformed_short_id', IdentifierResolver::classify('TDE-0031x'));
    }

    public function testLowercasePrefixShapedInputIsASlugNotAPrefix(): void
    {
        // Prefixes are uppercase by construction (^[A-Z]{2,5}$). "tde" is a
        // plausible slug, so it must not be mistaken for prefix TDE.
        self::assertSame('slug', IdentifierResolver::classify('tde'));
    }

    public function testAnOverlongUppercaseTokenIsASlugNotAPrefix(): void
    {
        // 6+ uppercase letters cannot be a prefix (cap is 5).
        self::assertSame('slug', IdentifierResolver::classify('ABCDEF'));
    }

    public function testNegativeAndZeroIntegersAreNotValidIdentifiers(): void
    {
        self::assertSame('slug', IdentifierResolver::classify('-5'));
        self::assertSame('integer', IdentifierResolver::classify('0'));
    }
}
