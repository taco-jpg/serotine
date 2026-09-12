# SIP Format

There is no strict word count or required level of formality. A SIP should contain enough information for another person to understand and evaluate it.

A typical SIP contains:

## Header

- SIP number
- title
- author(s)
- status
- created date
- optional discussion link
- optional dependencies or superseded SIPs

## Summary

A short explanation of the proposal.

## Motivation

What problem are we solving? Why is the current behavior insufficient?

## Proposal

Describe the behavior or design clearly.

For protocol changes, include enough detail to implement compatible behavior.

For UI proposals, screenshots, mockups, examples, or interaction flows may be more useful than formal prose.

## Security & Privacy

Include this when relevant. For sensitive changes, this section should be taken seriously.

Useful questions include:

- Does this expose new metadata?
- Does it create a new trust assumption?
- Can it weaken encryption or authentication?
- What happens when clients disagree or are outdated?
- Can users misunderstand the privacy guarantee?

## Compatibility

Explain migration, older-client behavior, or data-format impact if relevant.

## Alternatives

Optional, but helpful when there were meaningful competing approaches.

## Open Questions

Perfectly acceptable in Draft SIPs.

## Implementation Notes

Optional. Keep low-level implementation details here if they help, but avoid tying a SIP unnecessarily to one temporary code structure.

## What not to do

Do not add sections just to make the document look official. Empty ceremony makes SIPs harder to read.
