# Calling reliability fix summary

This branch fixes a reliability regression where a missed WSS wakeup could leave call negotiation with no practical recovery window, and adds enough safe ICE diagnostics to locate any remaining physical-network failure.

Changes:

- fallback call resync: 30 s → 10 s;
- offer/answer/ICE signal lifetime: 30 s → 120 s;
- connection diagnostics now report ICE connection state, gathering state, and local/remote candidate counts without exposing network addresses or credentials;
- regression tests enforce recovery margin between polling and negotiation expiry;
- production acceptance documentation explicitly requires real RTP/media on physical devices and explains TURN secret requirements.

The source change cannot provision Cloudflare TURN credentials. A deployed call that still says `TURN fallback is unavailable` requires the Worker TURN secrets to be fixed before restrictive-network fallback can work.
