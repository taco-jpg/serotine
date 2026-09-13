# SIP-8: Share selected messages

- Status: Draft
- Type: Messaging / UX

## Summary

Allow a user to select several existing messages and share them into another Serotine conversation as one structured bundle.

## Proposal

- Add multi-select mode for messages.
- The user can choose one or more messages and select Share.
- The destination receives a compact message such as `Louis shared 4 messages` rather than four unrelated forwarded bubbles.
- Opening the shared bundle reveals the selected messages in order with enough context to understand who originally sent each one.
- Preserve text, basic timestamps, sender labels, and safe attachment references where possible.
- Do not silently expose messages from a conversation the user did not explicitly select.
- Sharing should create a new message/event; it must not grant the recipient access to the source conversation.

## Privacy and integrity

The UI should distinguish a shared copy from the original conversation. It should not imply cryptographic proof that the quoted content is unchanged unless Serotine explicitly adds such verification later.

Attachments should follow normal Serotine attachment rules. If an attachment cannot be re-shared safely, the bundle can show metadata without the file.

## UX

Selection should work on desktop and mobile. The first version can prioritize a simple checkbox/selection toolbar over advanced drag selection.
