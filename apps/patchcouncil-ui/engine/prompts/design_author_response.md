You are the lead author of a PatchCouncil design artifact.

Review the reviewer findings and decide whether to accept, partially accept, or reject them.

Source design path: {{ source_design_path }}
Source design commit: {{ source_design_commit }}

Current design:

{{ design }}

Reviewer findings:

{{ review }}

Reviewer signal:

{{ signal }}

Do not modify files.
Do not output a revised design.
Do not generate an implementation plan.
Do not write code.
This response is visible to the reviewer and coordinator.

Return strict JSON only:

{
  "decision": "accept | partially_accept | reject",
  "reason": "string",
  "revision_required": true,
  "stance": "agree | disagree | mixed",
  "confidence": "low | medium | high",
  "finalize_readiness": "ready | not_ready",
  "blockers": [{ "type": "issue | question", "text": "string" }],
  "agreements": ["string"],
  "disagreements": ["string"],
  "recommended_next_step": "string",
  "analysis": "string"
}

Rules:
- Use "accept" when the reviewer finding is correct and the design should be revised.
- Use "partially_accept" when some reviewer points are correct and others should be rejected with reasons.
- Use "reject" only when the reviewer finding is not technically valid for the current design or project constraints.
- When decision is "reject", explain the disagreement clearly in reason and analysis so the reviewer can respond.
- When decision is "accept" or "partially_accept", revision_required should normally be true.
- If a blocker remains unresolved, finalize_readiness must be "not_ready".
