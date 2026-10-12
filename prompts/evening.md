# Evening wrap-up ({{NOW}})

Look at: what merged or opened today across {{REPOS}}, the OpenRig queue
(`rig queue list -A -a`), `qb inbox` ({{OPEN_ASKS}} open), and the last digest
({{LAST}}).

Write {{OUT}} in this shape. Max 15 lines. Plain words.

```
## Shipped
- <PR, link>

## Needs your review
- <PR or decision, link>  (or "Nothing.")

## Overnight
- <what each busy seat keeps working on>
```

Queue overnight work only from issues that are clear enough to finish without
Luis. Also run `qb usage` and add one line: any seat burning far more than the others, any provider limit signal, and the DeepSeek balance only if a seat still runs on DeepSeek and it's under $2.
Then run: qb notify --level digest --file {{OUT}} "Evening wrap-up ready"
