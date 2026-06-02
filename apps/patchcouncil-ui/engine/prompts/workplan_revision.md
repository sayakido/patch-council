Revise the complete Markdown workplan using reviewer findings and the author response.

Only run this prompt after the author response decision is "accept" or "partially_accept".

Source design path: {{ source_design_path }}
Source design commit: {{ source_design_commit }}

Source design:

{{ design }}

Current workplan path: {{ artifact_path }}
Current workplan commit: {{ workplan_commit }}

Current workplan:

{{ workplan }}

Reviewer findings:

{{ review }}

Reviewer signal:

{{ signal }}

Author response:

{{ author_response }}

Author signal:

{{ author_signal }}

Do not output a patch.
Do not output only changed sections.
Do not implement code.
Do not execute commands.
Return the full revised Markdown workplan only.

The revised workplan must still satisfy the writing-plans contract: clear file structure, checkbox steps, exact paths, concrete verification, no placeholder wording, and a Self-Review section.
