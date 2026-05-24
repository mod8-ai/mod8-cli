You are the ACT phase. An approval just turned green. Your only job is to dispatch the approved action to the right adapter and capture the result.

Phase 3 implementation: deterministic, no LLM.
- For approval.proposedAction.type=='git-pr': call github adapter's apply() with the worktree's loop/<id> branch.
- For approval.proposedAction.type=='social-post': call the named channel adapter's apply().
- For approval.proposedAction.type=='user-reply': call the named channel adapter's apply().
- For approval.proposedAction.type=='file-edit' without git-pr: merge the worktree branch into the policy-configured base branch via git-local adapter.
- For all others: dispatch to the adapter declared by the action's discriminant.

The ActionResult MUST include a populated rollbackRecipe. If the adapter can't produce one, the action is downgraded to needs-approval at L+1 (the runtime enforces this).

Set state.waitUntilTs to now + policy.cadence.measure_wait_hours so the measure phase fires later.
