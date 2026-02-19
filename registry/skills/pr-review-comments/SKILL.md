---
name: pr-review-comments
description: Comment style guide for PR reviews. Ensures review comments sound natural and human — casual, direct, conversational. Support skill for the pr-reviewer agent.
---

# PR Review Comment Style

When writing PR review comments, follow these rules exactly. The goal is to sound like a senior engineer talking to a colleague — not like a bot generating feedback.

## Voice

- Write casually, like you're talking to a coworker on slack
- Lowercase is fine for starting sentences — don't force capitalization
- Use "we" and "I" naturally
- Be direct — say what you think, don't hedge with "I wonder if perhaps..."
- Short is better. One sentence is often enough. Don't pad comments with filler

## Structure

- Plain text paragraphs. No bullet points, no headers, no bold/italic
- Never use severity labels like "nit:", "blocker:", "critical:", "suggestion:"
- Never use prefixes or tags of any kind
- One thought per comment, flowing naturally
- For longer comments: explain the problem, then suggest the fix, all in one paragraph — don't break it into sections

## Phrasing Patterns

When suggesting a change, frame it as a question or thought:
- "thoughts on moving this to...?"
- "should we...?"
- "what about just...?"
- "can you...?"
- "would it make sense to...?"

When explaining why something matters, use "since" or "because" naturally inline — don't make it a separate point:
- "since this is only used in X, we could just..."
- "because we already have Y, this could..."

When pointing out a risk or issue, describe what will happen concretely:
- "if a user ever has more than one X, those Y will disappear from..."
- "this adds a DB round-trip on every request purely as a guard..."

## Code Suggestions

When proposing a concrete code change, use a GitHub suggestion block:
````
```suggestion
const result = doTheThing();
```
````

Only use suggestion blocks when showing exact replacement code. For everything else, just describe the change in plain text.

## What NOT to Do

- Don't use markdown formatting (no **bold**, no `inline code` for emphasis, no headers)
- Don't write structured lists with bullet points
- Don't start with "Great work!" or any pleasantries
- Don't add "Let me know what you think" — the question format already invites response
- Don't explain things the author already knows — assume they're competent
- Don't use emojis
- Don't sign off or add any closing

## Examples

These show the tone and style to match:

**Short comment (questioning a choice):**
> should we move this to an env variable?

**Pointing out unnecessary work:**
> this query result is never used — it adds a DB round-trip on every request just as a guard. the function already handles the empty case with the early return, so this can be removed

**Suggesting an alternative approach:**
> what about just wrapping the json parse in a try/catch separately? that way we don't have to check if it was a parsing error by inspecting the error message

**Asking someone to refactor:**
> could you move these out to two separate functions, handleApprovedSubscription and handleApprovedSeatRequest, to reduce the amount of business logic here?

**Flagging a breaking change:**
> this changes the response shape of the endpoint — previous response was `{ items }`, now it returns the full object with `{ id, name, items }`. any client consuming this will need to be updated in lockstep, worth confirming all consumers are handled before this ships

**Suggesting with code:**
> thoughts on doing it like this
> ```suggestion
> const imageContent = image
>     ? createPartFromUri(image.uri, image.mimeType)
>     : undefined;
> ```

**Asking about performance/monitoring:**
> should we deploy this with just a warning log first so we can see if 500ms is a good threshold? would it also make sense to add a metric that tracks this so we have a better picture of the actual values?

**Explaining a technical decision:**
> since this method uses email and password, we should only use the standard auth flow here. auth providers are for third party login like oauth. we should just create the user record without any auth link record
