# Pulse ({{NOW}}, Luis is {{MODE}})

Compare the current state (OpenRig queue, open PRs in {{REPOS}}, `qb inbox`)
against the last digest ({{LAST}}).

If nothing meaningful changed, write nothing and reply NOOP.

Otherwise write {{OUT}}: at most 5 lines, one fact per line, links included,
blockers first. Then run: qb notify --level digest --file {{OUT}} "Update"
