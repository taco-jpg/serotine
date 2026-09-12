# Contributing SIPs

Anyone with a useful idea for Serotine can write a SIP.

## Before writing one

Ask whether the idea actually needs a proposal document.

Use a SIP for changes that are broad, architectural, security-sensitive, protocol-relevant, user-model-changing, or otherwise worth preserving as a design decision.

For a small bug or obvious cleanup, just fix it.

## Writing style

Prefer clear English over standards-language cosplay.

Good:

> When a user enables private chat, messages expire after both clients acknowledge receipt.

Less useful:

> Implementations MUST undertake compliant expiration semantics pursuant to the requirements herein.

Use MUST/SHOULD/MAY only when the distinction genuinely matters for compatibility or security.

## Keep scope under control

A SIP should usually describe one coherent change. If a proposal becomes five unrelated projects, split it.

## Evidence is welcome

Useful supporting material can include:

- screenshots
- prototypes
- benchmarks
- user feedback
- threat analysis
- interoperability tests
- implementation experiments

## Be willing to change the proposal

The document is a tool, not a contract with your past self.

If discussion or implementation finds a better answer, revise it.

## Naming

Before a permanent number exists, a descriptive draft filename is fine.

After numbering, prefer:

`SIPs/SIP-N-short-title.md`

## Tone

Technical disagreement is expected. Keep criticism focused on the proposal, assumptions, risks, and tradeoffs rather than the person proposing it.
