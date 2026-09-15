# Calling ICE failure analysis

Observed production symptom on two physical Chromium clients on the same Wi-Fi:

- call acceptance succeeds and UI reaches `Connecting`;
- `Connection: Checking connection` remains selected;
- selected candidate types remain unknown and media byte counters stay at zero;
- the UI reports `TURN fallback is unavailable`.

This places the failure after invitation/claim/accept signaling and before a successful ICE candidate pair, DTLS, or RTP.

## Concrete defects addressed by this branch

### Fallback poll and signal expiry had no recovery margin

The authenticated WSS `changed` frame is the fast path. If one wakeup is delayed or missed, `CallEngine` falls back to polling. The provider had stretched that fallback to 30 seconds while negotiation packets also expired after 30 seconds and the connection deadline was 30 seconds. A missed wakeup could therefore consume the entire recovery window.

This branch uses a 10-second fallback poll and 120-second offer/answer/ICE lifetime. WSS remains the normal path; polling is only a bounded recovery mechanism.

### ICE diagnostics hid the failure boundary

The connection UI previously exposed only the selected pair. With no selected pair it showed `Unknown ↔ Unknown`, which could not distinguish zero local candidates, zero received candidates, or candidates that failed connectivity checks.

The safe diagnostics now show ICE connection/gathering states plus local and remote candidate counts without exposing addresses, ports, SDP, credentials, candidate IDs, or TURN URLs.

## Deployment dependency not fixed by source code

`TURN fallback is unavailable` means the deployed Worker did not return usable managed TURN credentials. Production must configure `CALL_TURN_KEY_ID` and `CALL_TURN_API_TOKEN` from the same Cloudflare Realtime TURN key. The API token here is the TURN key's server-side secret, not a general account token.

After deployment, repeat the physical-device test. If direct ICE still fails, the new diagnostics should identify whether gathering (`0 local`), signaling (`local > 0`, `remote = 0`), or connectivity checks (`local > 0`, `remote > 0`, no selected pair) are the remaining fault.
