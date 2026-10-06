# Morning plan ({{NOW}})

Look at: open issues and PRs for every repo in {{REPOS}}, the OpenRig queue
(`rig queue list -A`), `qb inbox` ({{OPEN_ASKS}} open), and the last digest
({{LAST}}).

Write {{OUT}} in this shape. Max 15 lines. Plain words.

```
## Today
1. <most important thing, who's on it>
2. ...  (3 to 5 items)

## Done overnight
- <PR or result, link>

## Waiting on you
- <decision or review, link>  (or "Nothing.")
```

Also run `qb usage` and add one line: any seat burning far more than the others, any provider limit signal, and the DeepSeek balance if it's under $2.
Then assign today's first items to builders if they're idle.
Finally run: qb notify --level digest --file {{OUT}} "Morning plan ready"
