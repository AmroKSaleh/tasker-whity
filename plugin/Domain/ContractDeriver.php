<?php

declare(strict_types=1);

namespace Tasker\Domain;

/**
 * D5a Task 9: derives a PRODUCER's draft output contract from what its
 * CONSUMERS already demanded of it, and surfaces every place that merge lost
 * information.
 *
 * The direction of governance is the whole point, and it is the opposite of the
 * intuitive one: a producer's definition-of-done is not something authored in
 * isolation and then imposed downstream — it is the union of what the tasks
 * consuming its output declared they need in order to build on it safely (the
 * original's own TDE-287 note: "the consumer's input-edge rules ARE the
 * acceptance criteria the output must satisfy"). So a human does not have to
 * hand-author what the downstream tasks already said.
 *
 * PURE — no PDO, no tenant, no OU, no clock, no randomness. That is why its
 * tests run on the SQLite tier ({@see \Tasker\Tests\Domain\ContractDeriverTest}
 * does not touch a database at all) while the route that feeds it
 * ({@see \Tasker\TaskerPlugin::deriveOutputContract()} →
 * {@see \Tasker\Api\TaskEdgesApiHandler::deriveOutput()}) is OU-aware and takes
 * all of its coverage in the PostgreSQL tier. Same split
 * {@see FlowStepSorter} already established for this slice.
 *
 * ASSUMPTIONS ARE THE OTHER HALF OF THE OUTPUT, not a diagnostic afterthought.
 * A merge across several consumers is lossy in ways only a human can adjudicate
 * — two consumers may demand the "same" bar and mean different things, and a
 * consumer that declared nothing leaves a handoff whose bar would be a guess.
 * Every such loss is named, with the consumer that caused it, so the caller can
 * put it in front of a person instead of persisting a draft that looks
 * authoritative.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, verified against the original
 * (supabase/functions/mcp/contract_gate.ts::deriveOutputFromConsumers):
 *
 *   - IT DOES NOT LINT RULE QUALITY. The original appends a further assumption
 *     for every derived rule whose text trips its vagueness linter (lintRule()'s
 *     VAGUE_RULE_WORDS list, plus a minimum length). Nothing in this plugin
 *     ports that linter yet — set_task_input/set_task_output do not lint at
 *     authoring time either, and inventing a second, differently-worded copy of
 *     it here would put the vocabulary in the wrong place: it belongs wherever
 *     rules are AUTHORED, applied uniformly, not only to the ones that happen
 *     to arrive through derivation.
 *   - IT DOES NOT DEDUPE ON THE RULE TEXT ALONE. The original's dedupe key is
 *     `(r.rule || '').trim().toLowerCase()`, which ALSO silently discards every
 *     rule with no `rule` text at all (an empty key is skipped outright) — so a
 *     `{label, kind}` rule with the prose still to be written contributes
 *     nothing there and vanishes without an assumption. This class dedupes on
 *     the whole rule instead (see {@see self::dedupeKey()}), so no declared
 *     demand is dropped for lacking one particular field.
 */
final class ContractDeriver
{
    /**
     * Merges $consumerEdges into one draft contract plus the assumptions the
     * merge rests on.
     *
     * Each entry is ONE edge from the producer to one consumer:
     * `consumer_label` identifies that CONSUMER to a human (its short id, e.g.
     * "TDE-2" — see {@see \Tasker\Api\TaskEdgesApiHandler::deriveOutput()},
     * which builds these), and `contract` is that edge's own decoded contract:
     * the consumer's DEMAND on this producer, or null when the edge declares
     * none.
     *
     * The returned `rules` are ready to be persisted as an output contract
     * (`{"rules": [...]}`) exactly as they stand; `assumptions` is never
     * anything but human-readable prose, and an EMPTY `rules` with a non-empty
     * `assumptions` is a perfectly good answer to a read — it says, precisely,
     * that there was nothing downstream to derive from.
     *
     * @param list<array{consumer_label: string, contract: array<array-key, mixed>|null}> $consumerEdges
     * @return array{rules: list<array<array-key, mixed>>, assumptions: list<string>}
     */
    public static function derive(array $consumerEdges): array
    {
        /** @var array<string, array<array-key, mixed>> $merged keyed by dedupe key, so insertion order is rule order */
        $merged = [];
        /** @var list<string> $contributors consumers that declared at least one real rule */
        $contributors = [];
        /** @var list<string> $lossNotes per-consumer losses, in edge order */
        $lossNotes = [];

        foreach ($consumerEdges as $edge) {
            $label = $edge['consumer_label'];
            $declared = self::declaredRules($edge['contract']);

            $unusable = 0;
            $contributed = 0;
            foreach ($declared as $candidate) {
                // A rule must be a JSON OBJECT. `array_is_list([])` is TRUE, so
                // this ONE check refuses BOTH shapes that cannot be a rule: a
                // genuine JSON array (a non-empty list, e.g. `["a", "b"]`) and
                // an empty object/array (`{}` / `[]`, indistinguishable once
                // json_decode() has run) -- the same single-check reasoning
                // {@see \Tasker\Api\TaskEdgesApiHandler::setOutput()}'s own
                // guard spells out for a whole contract.
                if (!is_array($candidate) || array_is_list($candidate)) {
                    $unusable++;
                    continue;
                }

                // The consumer's own `id` is dropped BEFORE the dedupe key is
                // taken: it is that consumer's local handle on a rule in ITS
                // edge contract, so carrying it into the producer's contract
                // would both split the dedupe (two identical demands, two ids)
                // and let two consumers collide on one id. Ids for the derived
                // contract are this class's to assign, and are assigned only
                // once the dedupe has finished -- see below.
                $rule = $candidate;
                unset($rule['id']);

                $key = self::dedupeKey($rule);
                $contributed++;
                if (array_key_exists($key, $merged)) {
                    $lossNotes[] = sprintf(
                        'Rule "%s" is demanded by more than one consumer and was merged into a single output rule '
                        . '-- verify they really mean the same thing.',
                        self::ruleName($rule)
                    );
                    continue;
                }

                $merged[$key] = $rule;
            }

            if ($unusable > 0) {
                $lossNotes[] = $unusable === 1
                    ? sprintf(
                        'Consumer %s declared 1 input rule that is not a JSON object; it was skipped, so nothing '
                        . 'was derived from it.',
                        $label
                    )
                    : sprintf(
                        'Consumer %s declared %d input rules that are not JSON objects; they were skipped, so '
                        . 'nothing was derived from them.',
                        $label,
                        $unusable
                    );
            }

            if ($contributed === 0) {
                $lossNotes[] = sprintf(
                    'Consumer %s declares no input rules on its edge from this task, so there is nothing to derive '
                    . 'from it -- the bar for that handoff would be a guess, not a requirement. Author it with '
                    . 'set_task_input, or leave the handoff deliberately ungated.',
                    $label
                );
                continue;
            }

            $contributors[] = $label;
        }

        // Whole-merge assumptions first, then the per-consumer detail: a human
        // reading this list wants "what am I being asked to trust" before "and
        // here is each thing that went missing".
        $assumptions = [];
        if ($consumerEdges === []) {
            $assumptions[] = 'No task consumes this one\'s output, so there is nothing to derive an output contract '
                . 'from. Wire a consumer edge first (set_task_input), or author the definition-of-done directly '
                . 'with set_task_output.';
        }
        if (count($contributors) > 1) {
            $assumptions[] = sprintf(
                'Merged the input rules of %d consumers (%s) into ONE output contract -- a producer has a single '
                . 'definition-of-done, so check these demands really are the same bar and that what is written down '
                . 'is the strictest reading of them.',
                count($contributors),
                implode(', ', $contributors)
            );
        }

        // Ids assigned HERE, over the DEDUPED list, so they are sequential,
        // gap-free and stable for a human to refer to ("drop r3"). Assigning
        // them any earlier would give two identical demands two different ids
        // and defeat the dedupe entirely.
        /** @var list<array<array-key, mixed>> $rules */
        $rules = [];
        $position = 1;
        foreach ($merged as $rule) {
            $rules[] = ['id' => 'r' . $position] + $rule;
            $position++;
        }

        return [
            'rules' => $rules,
            'assumptions' => [...$assumptions, ...$lossNotes],
        ];
    }

    /**
     * The rule candidates $contract declares, read PERMISSIVELY: an edge
     * contract is stored as any JSON object at all
     * ({@see \Tasker\Api\TaskEdgesApiHandler::setInput()} validates only that
     * it IS an object), so `rules` may be absent, null, or something other than
     * a list. Anything that is not an array of candidates yields none, and the
     * per-candidate shape check in {@see self::derive()} handles the rest.
     *
     * `array_values()` so a `rules` that arrived as a JSON OBJECT rather than an
     * array (`{"a": {...}}`) still yields its values in declaration order,
     * rather than being discarded wholesale for the shape of its keys.
     *
     * @param array<array-key, mixed>|null $contract
     * @return list<mixed>
     */
    private static function declaredRules(?array $contract): array
    {
        if ($contract === null || !is_array($contract['rules'] ?? null)) {
            return [];
        }

        return array_values($contract['rules']);
    }

    /**
     * The identity of a rule for dedupe purposes: its whole content, KEY-ORDER
     * INSENSITIVE.
     *
     * That choice is deliberate rather than incidental, and the storage layer
     * decides it. Edge contracts live in a `jsonb` column, and jsonb does not
     * preserve the key order within an object — it normalises it. So two
     * consumers who declared the byte-identical rule can have it read back in
     * different key orders, and a key-order-SENSITIVE key (a plain
     * `serialize()`/`===` on the array as it arrives) would then fail to merge
     * two rules that are the same demand. `ksort()` recursively first, and the
     * question becomes "the same pairs?" rather than "the same pairs written in
     * the same order?".
     *
     * LIST ORDER IS PRESERVED, which is the other half of getting this right:
     * `ksort()` over a list is a no-op (its keys are already 0..n-1 in order),
     * so a rule carrying an ordered nested array — `{"params": {"steps": [1,
     * 2]}}` — still differs from the same rule with that array reversed. Only
     * OBJECT key order is normalised, exactly as jsonb does it.
     *
     * `serialize()` rather than `json_encode()`: it cannot fail (json_encode()
     * returns false on invalid UTF-8, and every failing rule would then collapse
     * onto the one empty key and be merged into a single rule), and it
     * distinguishes types, so `{"severity": 1}` and `{"severity": "1"}` are
     * correctly two different demands.
     *
     * @param array<array-key, mixed> $rule
     */
    private static function dedupeKey(array $rule): string
    {
        return serialize(self::keySortedDeeply($rule));
    }

    /**
     * @param array<array-key, mixed> $value
     * @return array<array-key, mixed>
     */
    private static function keySortedDeeply(array $value): array
    {
        ksort($value);

        foreach ($value as $key => $inner) {
            if (is_array($inner)) {
                $value[$key] = self::keySortedDeeply($inner);
            }
        }

        return $value;
    }

    /**
     * How to refer to a rule in prose: its label, else its rule text, else a
     * placeholder — truncated to 40 characters, matching the original's own
     * `r.rule?.toString().slice(0, 40)` label fallback, so one pathological
     * 2000-character rule cannot swamp the assumption list it appears in.
     *
     * @param array<array-key, mixed> $rule
     */
    private static function ruleName(array $rule): string
    {
        foreach (['label', 'rule'] as $field) {
            $value = $rule[$field] ?? null;
            if (is_string($value) && trim($value) !== '') {
                return mb_substr(trim($value), 0, 40);
            }
        }

        return '(unlabelled)';
    }
}
