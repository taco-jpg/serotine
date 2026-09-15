# Calling production acceptance

Calling is not production-ready merely because signaling tests pass. Before marking SIP-3 Final, verify media on physical devices.

## Same-network direct call

1. Open the deployed Serotine build in current Chromium-based browsers on two physical devices.
2. Keep both pages open and place a voice call, then a video call.
3. Expand **Connection** while it is connecting.
4. Require a selected route (`Direct P2P`, `STUN-assisted P2P`, or `TURN relay`), nonzero received media, and audible/visible remote media.
5. If the route remains `Checking connection`, record the displayed ICE state, gathering state, and local/remote candidate counts. Do not treat signaling-only success as a pass.

## TURN fallback

Production needs both Worker secrets from the same Cloudflare Realtime TURN key:

- `CALL_TURN_KEY_ID`: the 32-character TURN key uid.
- `CALL_TURN_API_TOKEN`: that TURN key's server-side secret/key, not a general Cloudflare account API token.

A call that says **TURN fallback is unavailable** has not received usable managed TURN credentials. Fix the secrets/provider request before testing restrictive networks.

After TURN is configured, run the browser calling smoke test with direct candidates blocked in a network-capable environment and then repeat on two physical devices on different networks. The selected route must report `TURN relay`, and real audio/video must be received. Gathering a relay candidate by itself is not sufficient.

## Timing contract

WSS `changed` pushes are the fast path. The periodic poll is a recovery path for a missed push. Negotiation packets therefore remain valid for substantially longer than one fallback poll interval; do not reduce the signal TTL to the same duration as the fallback timer or connection deadline.
