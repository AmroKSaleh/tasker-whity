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
     * ONE ENTRY PER CONSUMER, and a consumer's identity here is its POSITION in
     * this list — never its label (REVIEW ROUND 1, Minor b). Labels are not
     * unique: {@see \Tasker\Api\TaskEdgesApiHandler::consumerLabel()} falls back
     * to the task's own text for a task with no short id, and two tasks can
     * share text. Comparing labels made a genuine two-consumer merge report
     * itself as one consumer repeating itself — the exact false note that this
     * class's own duplicate-note split was written to prevent, arriving by
     * another route. The one-edge-per-consumer premise is the caller's to keep
     * and the schema enforces it for the only caller there is:
     * `tasker_task_edges` is unique on (target_task_id, source_task_id), so for
     * a fixed producer there is at most one edge per consumer.
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
        /** @var array<string, array{index: int, label: string}> $declaredBy dedupe key => who declared it FIRST */
        $declaredBy = [];
        /** @var list<string> $contributors consumers that declared at least one usable rule */
        $contributors = [];
        /** @var list<string> $lossNotes per-consumer losses, in edge order */
        $lossNotes = [];

        foreach ($consumerEdges as $index => $edge) {
            $label = $edge['consumer_label'];
            $read = self::readRules($edge['contract']);

            if ($read['refused']) {
                $lossNotes[] = sprintf(
                    'Consumer %s declared its input rules as a JSON object rather than an array, so nothing could be '
                    . 'derived from it: a contract is an ORDERED list of rules, and an object has no order to carry '
                    . 'over (jsonb normalises its keys, so even the order it was written in is already gone). '
                    . 'Re-author that edge with set_task_input, passing rules as an array.',
                    $label
                );
                continue;
            }

            foreach ($read['rules'] as $rule) {
                $key = self::dedupeKey($rule);
                if (array_key_exists($key, $declaredBy)) {
                    // NAMES BOTH SIDES, and distinguishes the two ways a
                    // duplicate arrives. "Demanded by more than one consumer" is
                    // simply FALSE when one consumer listed the same rule twice
                    // on its own edge, and a merge note a human cannot trust is
                    // worse than none. Compared by POSITION, not by label -- see
                    // this method's own docblock for why labels cannot decide it.
                    $lossNotes[] = $declaredBy[$key]['index'] === $index
                        ? sprintf(
                            'Consumer %s declared rule "%s" more than once on its own edge; the duplicates were '
                            . 'merged into a single output rule.',
                            $label,
                            self::ruleName($rule)
                        )
                        : sprintf(
                            'Rule "%s" is demanded by more than one consumer (%s and %s) and was merged into a '
                            . 'single output rule -- verify they really mean the same thing.',
                            self::ruleName($rule),
                            $declaredBy[$key]['label'],
                            $label
                        );
                    continue;
                }

                $merged[$key] = $rule;
                $declaredBy[$key] = ['index' => $index, 'label' => $label];
            }

            if ($read['unusable'] > 0) {
                $lossNotes[] = self::skipNote(
                    $label,
                    $read['unusable'],
                    'that is not a JSON object',
                    'that are not JSON objects'
                );
            }
            if ($read['contentless'] > 0) {
                $lossNotes[] = self::skipNote(
                    $label,
                    $read['contentless'],
                    'with nothing in it to derive from (an empty object, or nothing but an id)',
                    'with nothing in them to derive from (an empty object, or nothing but an id)'
                );
            }

            // GATED ON NOTHING HAVING BEEN SKIPPED EITHER (REVIEW ROUND 1, Minor
            // a): a consumer whose every rule was skipped above HAS declared
            // input rules, so saying it "declares no input rules" here would
            // contradict the note directly above it. Only a consumer that
            // declared literally nothing -- a null contract, `{}`, or
            // `rules: []` -- reaches this.
            if ($read['rules'] === []) {
                if ($read['unusable'] === 0 && $read['contentless'] === 0) {
                    $lossNotes[] = sprintf(
                        'Consumer %s declares no input rules on its edge from this task, so there is nothing to '
                        . 'derive from it -- the bar for that handoff would be a guess, not a requirement. Author it '
                        . 'with set_task_input, or leave the handoff deliberately ungated.',
                        $label
                    );
                }

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
     * Reads one edge contract's `rules` into the rules that can actually be
     * derived from, plus a count of everything that could not — so
     * {@see self::derive()} can report each loss instead of dropping it. Nothing
     * here is silent by design: every return path either yields a rule or
     * increments something the caller turns into an assumption.
     *
     * AN EDGE CONTRACT IS VALIDATED ONLY AS "some JSON object"
     * ({@see \Tasker\Api\TaskEdgesApiHandler::setInput()} checks nothing else),
     * so every shape below is real input a caller can store, not a defensive
     * hypothetical.
     *
     *   - `rules` absent or null → no rules, nothing refused. The edge declares
     *     a handoff and no bar, which is legitimate and common.
     *   - `rules` not a LIST (a string, a number, or a JSON OBJECT such as
     *     `{"a": {...}}`) → `refused`. Deliberately NOT read by taking the
     *     object's values (REVIEW ROUND 1, Minor d — which is how it behaved
     *     before): a contract is an ORDERED list of rules, and an object's order
     *     is not the caller's. jsonb normalises object keys, so the authoring
     *     order is already gone by the time it is read back — verified
     *     empirically, a `{"b": …, "a": …}` rules object came back b-then-a
     *     regardless of how it went in. Reading it would invent an order and
     *     present the invention as the human's own bar.
     *   - a candidate that is not a JSON object (a scalar, or a non-empty list
     *     like `["a", "b"]`) → `unusable`.
     *   - a candidate that is an object with NOTHING IN IT once its own `id` is
     *     stripped — `{}`, or `{"id": "r1"}` → `contentless` (REVIEW ROUND 1,
     *     THE IMPORTANT FINDING). The id strip happens before this check
     *     precisely because it can EMPTY a rule that passed the object test: an
     *     id-only rule used to survive as `{"id": "r1"}` with no content and no
     *     assumption, and on `apply: true` that draft is a non-empty object, so
     *     it cleared setOutput()'s own guard and left confirm_contract able to
     *     bless a definition-of-done whose only rule said nothing.
     *
     * `contentless` rather than folding those into `unusable`: an empty object
     * IS a JSON object, so a note calling it "not a JSON object" would be false,
     * and this class's whole contract with its reader is that the notes are
     * true.
     *
     * @param array<array-key, mixed>|null $contract
     * @return array{rules: list<array<array-key, mixed>>, unusable: int, contentless: int, refused: bool}
     */
    private static function readRules(?array $contract): array
    {
        $declared = $contract !== null ? ($contract['rules'] ?? null) : null;
        if ($declared === null) {
            return ['rules' => [], 'unusable' => 0, 'contentless' => 0, 'refused' => false];
        }
        if (!is_array($declared) || !array_is_list($declared)) {
            return ['rules' => [], 'unusable' => 0, 'contentless' => 0, 'refused' => true];
        }

        $rules = [];
        $unusable = 0;
        $contentless = 0;

        foreach ($declared as $candidate) {
            // A non-empty LIST (`["a", "b"]`) or a scalar can never be a rule.
            // `[]` is excluded from this arm on purpose: `array_is_list([])` is
            // TRUE, but `{}` and `[]` are the same value after json_decode(), and
            // an empty rule is better described by the contentless arm below.
            if (!is_array($candidate) || (array_is_list($candidate) && $candidate !== [])) {
                $unusable++;
                continue;
            }

            // The consumer's own `id` is dropped BEFORE the dedupe key is taken:
            // it is that consumer's local handle on a rule in ITS edge contract,
            // so carrying it into the producer's contract would both split the
            // dedupe (two identical demands, two ids) and let two consumers
            // collide on one id. Ids for the derived contract are this class's to
            // assign, and are assigned only once the dedupe has finished.
            $rule = $candidate;
            unset($rule['id']);

            if ($rule === []) {
                $contentless++;
                continue;
            }

            $rules[] = $rule;
        }

        return ['rules' => $rules, 'unusable' => $unusable, 'contentless' => $contentless, 'refused' => false];
    }

    /**
     * "Consumer TDE-2 declared 2 input rules that are not JSON objects; they
     * were skipped, so nothing was derived from them."
     *
     * Shared by both skip buckets so the two notes cannot drift into differently
     * phrased versions of the same sentence, and so the singular/plural
     * agreement is written once. $singularWhy/$pluralWhy are the only part that
     * differs — a `%s`-and-hope approach reads "1 input rule that are not JSON
     * objects", which is the kind of thing that makes a caller distrust the rest
     * of the message.
     */
    private static function skipNote(string $label, int $count, string $singularWhy, string $pluralWhy): string
    {
        return $count === 1
            ? sprintf(
                'Consumer %s declared 1 input rule %s; it was skipped, so nothing was derived from it.',
                $label,
                $singularWhy
            )
            : sprintf(
                'Consumer %s declared %d input rules %s; they were skipped, so nothing was derived from them.',
                $label,
                $count,
                $pluralWhy
            );
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
     * TRUNCATION IS MARKED (REVIEW ROUND 1, Minor c). `mb_substr()` alone made a
     * cut name read as a complete one, inside a note whose whole job is to send a
     * human to look at a specific rule — and `Rule "Has a summary of the source
     * mater" is demanded by…` invites them to go hunting for a rule of that name.
     * The marker is counted against the 40, so a name never grows past the
     * budget, and the cut is right-trimmed first: `mb_strimwidth()` does this
     * whole job in one call but leaves the space it cut on, printing
     * `"…source material ..."`. ASCII "..." rather than an ellipsis character,
     * matching every other runtime string in this class (its dashes are "--" for
     * the same reason: these end up in JSON, where a non-ASCII character is
     * escaped to \uXXXX in the raw body).
     *
     * @param array<array-key, mixed> $rule
     */
    private static function ruleName(array $rule): string
    {
        foreach (['label', 'rule'] as $field) {
            $value = $rule[$field] ?? null;
            if (!is_string($value) || trim($value) === '') {
                continue;
            }

            $name = trim($value);

            return mb_strlen($name) > 40 ? rtrim(mb_substr($name, 0, 37)) . '...' : $name;
        }

        return '(unlabelled)';
    }
}
