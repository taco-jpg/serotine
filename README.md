# Serotine Improvement Proposals (SIPs)

SIPs are a lightweight way to suggest, discuss, and document meaningful changes to Serotine.

The idea is inspired by EIPs, but intentionally less formal. Serotine is still evolving quickly, so the process should help ideas become clear without turning every change into paperwork.

## What belongs here?

A SIP is useful when a change is large enough that it benefits from a durable explanation before implementation. Examples:

- new messaging behavior
- privacy or security features
- protocol or data-format changes
- major UI/UX behavior
- interoperability ideas
- changes that affect many parts of Serotine

Small bug fixes, tiny UI tweaks, refactors, typo fixes, and obvious maintenance work usually do not need a SIP.

## The basic flow

1. Start with an idea.
2. Write a short proposal using `TEMPLATE.md`.
3. Give it a temporary name or number.
4. Discuss it openly.
5. Revise it if useful.
6. Implement it when there is enough agreement and somebody wants to build it.
7. Mark it as Final when it accurately describes what Serotine actually uses.

There is no requirement to make a proposal perfect before sharing it. Early SIPs can be rough.

## Suggested status values

- **Idea** — early thought, possibly incomplete
- **Draft** — written enough for real discussion
- **Review** — actively being considered for implementation
- **Accepted** — direction is agreed upon
- **Final** — implemented and considered stable
- **Deferred** — good idea, not now
- **Rejected** — intentionally not pursuing it
- **Withdrawn** — author no longer wants to pursue it
- **Superseded** — replaced by another SIP

These are guidance, not bureaucracy. Use the status that best communicates reality.

## Numbering

Once a proposal is worth keeping, it can receive a number such as `SIP-1`, `SIP-2`, and so on. Numbers are identifiers, not rankings.

Proposals live in `SIPs/` and should normally use names such as:

`SIPs/SIP-12-private-chat.md`

## Decision making

Serotine does not need a complicated governance system for SIPs. Discussion, working prototypes, user feedback, maintainers, and technical reality all matter.

A SIP is not automatically accepted because it has existed for a long time, has many comments, or sounds formal. Likewise, an experimental idea is allowed to become real quickly if it is clearly useful and safe.

The goal is to preserve good reasoning, not create ceremony.

## Useful files

- `PROCESS.md` — how SIPs move from idea to implementation
- `FORMAT.md` — suggested structure for a SIP
- `STATUS.md` — status meanings
- `TEMPLATE.md` — copy this when writing a new SIP
- `CONTRIBUTING.md` — practical contribution notes

## One rule above all

Keep SIPs readable.

A person should be able to understand what is changing, why it matters, the main tradeoffs, and roughly how it works without reading a dissertation.
