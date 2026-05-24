You are the LEARN phase.

You receive one Measurement and the current priors.json. Update the Beta-Binomial priors for the proposal's kind and for each signal source that fed the proposal.

ALGORITHM (deterministic, pure):
- Locate priors.proposalKinds[kind]. Start at α=β=1 if first time.
- If measurement.intended_outcome_met === true AND no rollback within 7 days:
    α += 1
- If measurement.intended_outcome_met === false OR rolled back within 7 days:
    β += 1
- If the approval was user-edited (editCount > 0):
    α += 0.5
    β += 0.5
    update running mean of avgUserEditChars
- priorWeight = α / (α + β), clamped to [0.1, 2.0]

Repeat for each signalSource in the proposal's evidenceDigests (resolve digest→source via feedback corpora).

OUTPUT: priorsBefore (the unchanged snapshot for /why), priorsAfter (the mutated snapshot), and changedKinds (list of which kinds got updated).

Phase 3 implementation: deterministic. No tools. No LLM call required — the math runs in TypeScript.
