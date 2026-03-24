---
name: code-documenting
description: >
  Code documentation and commenting guidelines. Covers when, where, and how to write comments
  that explain business context, domain rules, external dependencies, and non-obvious decisions.
  Use when writing, reviewing, or refactoring code that involves business logic or system integrations.
user-invocable: false
---

# Code Documentation Guidelines

Comments explain **why**, not **what**. Business context, domain rules, and non-obvious constraints — that's what belongs in comments. The code itself should explain the what.

## When to Comment

Comment when:
- Business logic isn't obvious from the code alone
- An external system has quirks, constraints, or dependencies
- A decision was made for a non-obvious reason
- Code depends on or is depended upon by infrastructure (alerts, metrics, logs)
- A workaround exists for a known issue
- A constant has domain meaning that its name can't fully capture

Do NOT comment when:
- The code is self-explanatory from naming and structure
- You'd just be restating what the code does
- A function is simple and its signature tells the whole story

## Comment Styles

### Block comments for business context inside functions

Use `/** */` blocks inside function bodies to explain **business rules** and **domain logic** before the code that implements them. These are the most valuable comments — they explain _why_ this branch or block exists.

```ts
if (!existingMembership) {
    /**
     * If there is no membership record for an existing user, it means that
     * the user was added outside of the standard enrollment flow and we should not
     * send any welcome or setup emails.
     *
     * This also applies to users created before the self-service enrollment
     * feature was introduced.
     */
    if (user.existingUser) {
        return;
    }

    /**
     * Most users will be handled by this path, as currently there aren't
     * many users that belong to multiple teams simultaneously.
     */
    await db.$transaction(async (tx) => { ... });
}
```

### One-liner block comments for short context

Use `/** */` one-liners when a function or block needs brief context about its purpose or behavior.

```ts
/**
 * Check if a token is the new compact 8-character format
 */
const isCompactToken = (token: string): boolean => { ... };

/**
 * If the record already has a scheduled notification, we should not schedule a new one.
 */
if (record.scheduledNotification) {
    return;
}
```

### Inline comments for implementation details

Use `//` for brief notes about specific lines or small blocks — format details, edge cases, and clarifications.

```ts
// Compact tokens: use clean path format with /t/ prefix
if (isCompactToken(token)) {
    return `${env.APP_URL}/${locale}/t/${token}`;
}

// Legacy tokens: use query parameter format for backward compatibility
return `${env.APP_URL}/${locale}/invite?token=${token}`;
```

### Inline comments for constants with domain meaning

When a constant's name doesn't fully capture its domain context, add an inline comment.

```ts
const partnerId = 'ACME';
// External content distributor
const systemClassificationCode = 'CD';
// Because the md5 hash of the shared secret is 16 bytes
const encryptionAlgorithm = 'aes-128-cbc';
```

## JSDoc on Complex Exported Functions

Use full JSDoc with `@param`, `@returns`, and `@throws` on complex exported functions where the parameter semantics aren't obvious from names alone, or when the function orchestrates multiple steps.

Structure: short summary, numbered step list of what it does, then tags.

```ts
/**
 * Aggregates usage metrics for a group of members within the same billing period.
 *
 * This function:
 * 1. Validates that billing period dates exist
 * 2. Gets usage metrics (active time, completed actions) for all users in the period
 * 3. Formats the metrics into the partner's reporting format
 *
 * @param periodMembers - Array of members with same billing period containing:
 *   - periodStartAt: Start date of the billing period
 *   - periodEndAt: End date of the billing period
 *   - userId: ID of the user
 *   - id: Member assignment ID
 * @param now - Current timestamp
 * @param formattedTimestamp - Formatted timestamp for partner API
 * @returns Array of UsageReport objects formatted for partner reporting
 * @throws Error if billing period dates are missing
 */
```

Do NOT use JSDoc on simple functions where the name and signature tell the whole story.

## Documenting Decisions with Conditions

When a block of logic handles a specific scenario, explain the scenario in business terms — who is affected, what should happen, and why.

```ts
// Users without an active plan (e.g. free-tier users, admins added without a seat)
// should not receive lifecycle campaign emails.
const shouldScheduleLifecycleEvent =
    hasCampaignsEnabled && !!(planId || seatAssignmentId);
```

```ts
/**
 * Considered completed if:
 *  - Actually completed, so there's setup data on the User record.
 *  - Special cases (subject to change):
 *    - Web users: on PROJ-1292 it was decided to not run setup for web signups after initial registration.
 *    - SSO users: considered complete as a mitigation of incident [link to postmortem].
 *    - Enterprise users: if the organization has opted to skip setup, the user will be considered complete.
 */
if (hasSetupResponses || user.signupPlatform === 'WEB' || skipSetup) {
    return 'completed';
}

// Don't re-run setup for users who somehow skipped it but already have usage activity.
if (lifetimeActions > 0) {
    return 'skipped';
}
```

## Documenting Multi-Format or Multi-Strategy Logic

When code handles multiple formats, versions, or strategies, enumerate them in a block comment.

```ts
/**
 * Construct a deep link based on the token format.
 * Compact tokens (8 chars): /{locale}/t/{token}
 * Legacy tokens (72 chars): /{locale}/setup?token={token}
 */
```

```ts
/**
 * Depending on the calculation method, we use different metric sources.
 * - new: Uses the real-time analytics pipeline with local timezone
 * - old: Uses the legacy activity log aggregation with UTC timestamps
 * - combined: Splits at the migration date — old system before, new system after —
 *             then merges the results from both sources.
 */
```

## External System Dependencies and Workarounds

Document quirks, limitations, and dependencies on external systems. Include the reason the workaround exists.

```ts
// The HTTP client doesn't properly handle HTTPS through an HTTP proxy.
// Local testing requires routing through the staging cluster because
// the partner API can only be accessed from whitelisted NAT IPs.
httpAgent: proxyAgent,
httpsAgent: proxyAgent,
// Without this, the client overwrites the custom agent.
proxy: false,
```

```ts
// The API returns an array but we only ever expect a single object within it.
return decryptedPayload[0];
```

## Infrastructure Dependency Chains

When code has downstream dependencies (log-based metrics, alert policies, monitoring), document the chain so nobody accidentally breaks it.

```ts
// The daily-import-count log-based metric in GCP depends on this log message.
// The "No imports in past 12 hours" alert policy depends on the daily-import-count metric.
// https://console.cloud.google.com/monitoring/alerting/policies/12345678
logger.info(`Successfully enqueued ${jobs.length} import jobs`, logMetadata);
```

## Cache Invalidation Context

When invalidating caches, briefly explain what changed and why the cache needs clearing.

```ts
// User's assigned content may have changed, evict the config cache
await deleteUserConfigEtagCache(userId);
```

## Ticket References

Reference ticket IDs in TODOs and removal notes. Keep the format consistent: `TICKET-ID` or `TICKET-ID: description`.

```ts
// TODO: Remove this once we have a proper solution to handle this. See PROJ-801 for more details.

// Removed hardcoded customer abc123 (Acme Corp) - PROJ-1845
```

## Internal Test Exports

When exporting implementation details for unit testing, mark them with `@internal` and list what's exported.

```ts
/**
 * @internal
 * Internal exports for unit testing only. These functions are implementation details
 * and should not be used by external modules. The API may change without notice.
 *
 * - aggregateMetricsForPeriod: Aggregates usage metrics for a billing period
 * - getMetricsLegacy: Fetches metrics using the old activity log aggregation
 */
export const _test = {
    aggregateMetricsForPeriod,
    getMetricsLegacy,
};
```

## Summary

| Situation | Style | Example |
|---|---|---|
| Business rule before code block | `/** */` block | "If there is no membership record for an existing user..." |
| Short context for a function or guard | `/** */` one-liner | "Check if a token is the new compact 8-character format" |
| Implementation detail on a line | `//` inline | "Compact tokens: use clean path format" |
| Constant with domain meaning | `//` inline | "External content distributor" |
| Complex exported function | Full JSDoc with `@param`/`@returns` | Summary + numbered steps + tags |
| Multi-format or multi-strategy | `/** */` with enumerated list | "- new: ...\n- old: ...\n- combined: ..." |
| External system workaround | `//` multi-line | "The HTTP client doesn't properly handle..." |
| Infrastructure dependency | `//` with link | "The GCP metric depends on this log message" |
| Ticket reference | `//` inline | "See PROJ-801 for more details" |
| Test-only exports | `/** @internal */` | List exported functions with descriptions |
