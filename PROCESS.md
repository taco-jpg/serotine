# SIP Process

The SIP process exists to make important Serotine ideas easier to understand and revisit.

It is deliberately lightweight.

## 1. Start rough

You do not need permission to write a SIP. If an idea feels important enough to explain, write it down.

A first draft can be incomplete. Open questions are fine.

## 2. Explain the problem before the solution

A good SIP should make clear what problem exists today. This makes it easier to judge whether the proposed complexity is worth it.

## 3. Discuss where discussion is easiest

Discussion can happen in GitHub issues, pull requests, chat, or anywhere else that is practical. Important conclusions should eventually be reflected back into the SIP so the document remains useful later.

## 4. Prototype when words are not enough

For UI, protocol, performance, or cryptographic ideas, a prototype may answer questions faster than a long argument.

Experimental implementations are welcome. A prototype does not automatically make a proposal accepted.

## 5. Acceptance is practical

A proposal is ready to move forward when the people maintaining the affected area generally agree that:

- the problem is real enough to solve
- the proposed direction is reasonable
- security and compatibility concerns are understood
- implementation cost is acceptable

No formal vote is required unless the project later decides it needs one.

## 6. Implementation can reshape the SIP

Reality wins. If implementation reveals a better design, update the SIP.

A SIP should describe the intended or actual system, not preserve an outdated plan just because it was written first.

## 7. Final means documented reality

A SIP can become Final when the feature or behavior is implemented, sufficiently stable, and the document matches what Serotine actually does.

## Fast path

Some ideas are obvious, low-risk, and easy to reverse. In those cases the process can be very short:

Draft → prototype → merge → Final.

That is completely acceptable.

## Slow path

Security-sensitive, privacy-sensitive, protocol-level, or hard-to-reverse changes should receive more review and explicit reasoning.

The process should become stricter only when the consequences justify it.
