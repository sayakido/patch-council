Revise the Markdown design doc using reviewer findings and the lead author response.

Only run this prompt after the lead author response decision is "accept" or "partially_accept".

Current design:
{{design}}

Reviewer findings:
{{findings}}

Author response:
{{author_response}}

Author signal:
{{author_signal}}

Rules:
- Return the full revised Markdown design document.
- Do not output a patch.
- Do not output only changed sections.
- Preserve accurate existing decisions.
- Apply only reviewer findings accepted by the author response.
- Preserve rejected design choices when the author response explains why they should remain.
- Do not generate an implementation plan.
- Do not write code.
